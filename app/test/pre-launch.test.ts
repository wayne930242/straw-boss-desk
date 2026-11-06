import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { earlyLaunch } from "../src/main/pre-launch.ts";
import { electronDir } from "../src/main/paths.ts";
import { PENDING_FILE, writePending } from "../src/main/removal/pending.ts";
import type { UserPath } from "../src/main/platform/types.ts";

// The early check with the handover inside it (T14R2-F001, T14R2-F002): the folder the lock is asked on, and a lock that turns out free. These run on real folders, so a root that is recreated or left
// behind shows up as a file.

const bases: string[] = [];
after(() => {
	for (const b of bases) rmSync(b, { recursive: true, force: true });
});
const scratch = (): string => {
	const b = mkdtempSync(join(tmpdir(), "sbd-early-"));
	bases.push(b);
	return b;
};

const userPath: UserPath = { supported: true, read: async () => null, ensureFirst: async () => ({ changed: false }), remove: async () => ({ changed: true }) };
const OWNER = { pid: 777, startTime: "S1" };
const alive = async () => [{ pid: OWNER.pid, startTime: OWNER.startTime, executable: null }];

/** A root that **Remove all data** left behind: the marker naming the owner, `electron/` that the owner keeps, and one file the cleanup has not reached. */
function removedRoot(): { root: string; home: string } {
	const parent = scratch();
	const root = join(parent, "sbd 測試");
	const home = join(parent, "home");
	mkdirSync(join(root, "electron"), { recursive: true });
	mkdirSync(home, { recursive: true });
	writeFileSync(join(root, "left-over.txt"), "x");
	writePending(root, { schema: 1, id: null, fallbackDir: null, owner: OWNER });
	return { root, home };
}

function rig(root: string, home: string, lockResult: (calls: string[]) => boolean, processes: { inspect: () => Promise<Array<{ pid: number; startTime: string | null; executable: string | null }>> } = { inspect: alive }) {
	const calls: string[] = [];
	const deps = {
		argv: ["app"],
		root,
		home,
		platform: process.platform,
		userPath,
		processes,
		instanceLock: {
			setUserData: (path: string) => void calls.push(`setUserData ${path}`),
			lock: () => lockResult(calls),
			release: () => void calls.push("release"),
		},
	};
	return { deps, calls };
}

describe("earlyLaunch: the handover", () => {
	it("T14R2-F002: asks for the lock on the owner's user data folder, `<root>/electron`, and never on the root; a held lock ends the launch with 0 and leaves the root as it is", async () => {
		const { root, home } = removedRoot();
		const r = rig(root, home, (calls) => (calls.push("lock"), false));
		assert.deepEqual(await earlyLaunch(r.deps), { action: "exit", code: 0 });
		assert.deepEqual(r.calls, [`setUserData ${electronDir(root)}`, "lock"]);
		assert.notEqual(r.calls[0], `setUserData ${root}`);
		assert.ok(existsSync(join(root, PENDING_FILE)) && existsSync(join(root, "left-over.txt")), "the owner's root is left alone");
	});

	it("T14R2-F001: a lock that turns out free (the owner ended after the marker check) goes on with the launch, with the pending root finished, and not with an exit and no window", async () => {
		const { root, home } = removedRoot();
		const r = rig(root, home, (calls) => (calls.push("lock"), true));
		assert.deepEqual(await earlyLaunch(r.deps), { action: "continue" });
		assert.deepEqual(r.calls, [`setUserData ${electronDir(root)}`, "lock", "release"], "the lock is let go again");
		assert.equal(existsSync(root), false, "the marker's root is deleted before the normal launch makes its own folders in it");
	});

	it("T14R2-F001: the lock call re-creates `electron/` in a root the owner's cleanup is deleting: the launch that goes on finishes that root, so no empty folder and no marker are left under it", async () => {
		const { root, home } = removedRoot();
		const r = rig(root, home, (calls) => {
			calls.push("lock");
			// What Chromium's lock call does when `electron/` was deleted between the check and the call.
			rmSync(electronDir(root), { recursive: true, force: true });
			mkdirSync(electronDir(root), { recursive: true });
			return true;
		});
		assert.deepEqual(await earlyLaunch(r.deps), { action: "continue" });
		assert.equal(existsSync(root), false);
	});

	it("T14R2-F001: the owner's cleanup finished while the check ran, so there is no `electron/` to ask on: nothing is asked, nothing is created, and the launch goes on", async () => {
		const { root, home } = removedRoot();
		const r = rig(root, home, (calls) => (calls.push("lock"), true), {
			inspect: async () => {
				// The inspect (a PowerShell start on Windows) is slow: by the time it answers, the owner is gone and the root with it.
				const answer = await alive();
				rmSync(root, { recursive: true, force: true });
				return answer;
			},
		});
		assert.deepEqual(await earlyLaunch(r.deps), { action: "continue" });
		assert.deepEqual(r.calls, [], "no lock was asked, so Chromium made no folder");
		assert.equal(existsSync(root), false, "the root that is being deleted is not recreated");
	});

	it("T14R2-F001: a free lock does not hide a failed deletion: the launch stops with the folder named, as a launch with no owner does", async () => {
		const { root, home } = removedRoot();
		const r = rig(root, home, (calls) => (calls.push("lock"), true));
		assert.deepEqual(await earlyLaunch({ ...r.deps, finish: () => ({ found: true, removed: false, fallbackRemoved: false, error: "EBUSY" }) }), { action: "stop", code: 1, folder: root, detail: "EBUSY" });
	});

	it("a launch with no pending removal never touches the lock, and one whose owner is gone finishes the root as before", async () => {
		const plain = scratch();
		const none = rig(join(plain, "root"), join(plain, "home"), (calls) => (calls.push("lock"), true));
		assert.deepEqual(await earlyLaunch(none.deps), { action: "continue" });
		assert.deepEqual(none.calls, []);
		const { root, home } = removedRoot();
		const gone = rig(root, home, (calls) => (calls.push("lock"), true), { inspect: async () => [{ pid: OWNER.pid, startTime: null, executable: null }] });
		assert.deepEqual(await earlyLaunch(gone.deps), { action: "continue" });
		assert.deepEqual(gone.calls, []);
		assert.equal(existsSync(root), false);
	});
});
