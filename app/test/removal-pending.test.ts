import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { assertDeletableRoot, fallbackIsOurs, FALLBACK_PARENT, finishPending, PENDING_FILE, readPending, rootId, writePending } from "../src/main/removal/pending.ts";

// `remove-pending` and the checks around deleting a root (task 14 anchor: a root left with `remove-pending` is removed at the next launch; T3-F006: the fallback folder is checked).
const bases: string[] = [];
after(() => {
	for (const b of bases) rmSync(b, { recursive: true, force: true });
});
function world() {
	const base = realpathSync.native(mkdtempSync(join(tmpdir(), "sbd-pend-")));
	bases.push(base);
	const home = join(base, "home");
	const root = join(base, "root 測試");
	mkdirSync(join(root, "electron"), { recursive: true });
	mkdirSync(home, { recursive: true });
	writeFileSync(join(root, "electron", "Local State"), "x");
	const id = rootId(realpathSync.native(root));
	const fallback = join(home, FALLBACK_PARENT, id);
	mkdirSync(join(fallback, "agent"), { recursive: true });
	return { base, home, root, id, fallback, platform: process.platform };
}

describe("remove-pending at the next launch", () => {
	it("deletes the root and the fallback folder the marker names, and then the empty ~/.straw-boss-desk", () => {
		const w = world();
		writePending(w.root, { schema: 1, id: w.id, fallbackDir: w.fallback });
		const done = finishPending({ root: w.root, home: w.home, platform: w.platform });
		assert.deepEqual(done, { found: true, removed: true, fallbackRemoved: true });
		assert.ok(!existsSync(w.root) && !existsSync(w.fallback) && !existsSync(join(w.home, FALLBACK_PARENT)));
	});

	it("finds nothing to do when there is no marker, and touches nothing", () => {
		const w = world();
		assert.deepEqual(finishPending({ root: w.root, home: w.home, platform: w.platform }), { found: false });
		assert.ok(existsSync(join(w.root, "electron", "Local State")) && existsSync(w.fallback));
	});

	it("leaves another root's fallback folder alone: a marker naming a folder that is not this root's id is ignored for that folder", () => {
		const w = world();
		const other = join(w.home, FALLBACK_PARENT, "deadbeef");
		mkdirSync(other, { recursive: true });
		writePending(w.root, { schema: 1, id: w.id, fallbackDir: other });
		const done = finishPending({ root: w.root, home: w.home, platform: w.platform });
		assert.equal(done.found && done.removed, true);
		assert.ok(existsSync(other), "another root's fallback folder stays");
		assert.ok(existsSync(w.fallback), "this root's own is not named, so it stays too");
	});

	it("never deletes a folder outside ~/.straw-boss-desk that a damaged marker names", () => {
		const w = world();
		const precious = join(w.base, "precious");
		mkdirSync(precious);
		writePending(w.root, { schema: 1, id: w.id, fallbackDir: precious });
		finishPending({ root: w.root, home: w.home, platform: w.platform });
		assert.ok(existsSync(precious));
	});

	it("still deletes the root when the marker cannot be read, and names no fallback folder", () => {
		const w = world();
		writeFileSync(join(w.root, PENDING_FILE), "not json");
		assert.equal(readPending(w.root), "unreadable");
		const done = finishPending({ root: w.root, home: w.home, platform: w.platform });
		assert.deepEqual(done, { found: true, removed: true, fallbackRemoved: false });
		assert.ok(existsSync(w.fallback));
	});

	it("keeps the marker and reports the error when the deletion fails, so the next launch tries again", () => {
		const w = world();
		writePending(w.root, { schema: 1, id: w.id, fallbackDir: null });
		const done = finishPending({ root: w.root, home: w.home, platform: w.platform, remove: () => { throw new Error("EBUSY: resource busy"); } });
		assert.equal(done.found && !done.removed, true);
		assert.match(done.found && !done.removed ? (done.error ?? "") : "", /EBUSY/);
		assert.ok(existsSync(join(w.root, PENDING_FILE)));
	});
});

describe("the fallback folder check (T3-F006)", () => {
	const home = "/home/pm";
	const real = "/home/pm/Library/Application Support/straw-boss-desk";
	const id = rootId(real);
	it("accepts exactly ~/.straw-boss-desk/<this root's id>, with or without a trailing slash", () => {
		assert.ok(fallbackIsOurs({ fallbackDir: `${home}/.straw-boss-desk/${id}`, home, realRoot: real, platform: "darwin" }));
		assert.ok(fallbackIsOurs({ fallbackDir: `${home}/.straw-boss-desk/${id}/`, home, realRoot: real, platform: "darwin" }));
	});
	it("refuses another id, a folder outside ~/.straw-boss-desk, the parent itself, the home, a relative path and a path with .. in it", () => {
		for (const bad of [`${home}/.straw-boss-desk/deadbeef`, `${home}/Documents/${id}`, `${home}/.straw-boss-desk`, home, `.straw-boss-desk/${id}`, `${home}/.straw-boss-desk/${id}/../..`, `${home}/.straw-boss-desk/${id}/agent`]) {
			assert.equal(fallbackIsOurs({ fallbackDir: bad, home, realRoot: real, platform: "darwin" }), false, bad);
		}
	});
	it("compares without regard to case on Windows, as the file system does", () => {
		const winHome = "C:\\Users\\PM";
		const winId = rootId("C:\\Users\\PM\\AppData\\Local\\straw-boss-desk");
		assert.ok(fallbackIsOurs({ fallbackDir: `c:\\users\\pm\\.STRAW-BOSS-DESK\\${winId}`, home: winHome, realRoot: "C:\\Users\\PM\\AppData\\Local\\straw-boss-desk", platform: "win32" }));
	});
});

describe("assertDeletableRoot", () => {
	it("refuses a relative root, a filesystem root, the home folder and a folder that contains it", () => {
		assert.throws(() => assertDeletableRoot("data", "/home/pm", "darwin"), /not an absolute/);
		assert.throws(() => assertDeletableRoot("/", "/home/pm", "darwin"), /filesystem root/);
		assert.throws(() => assertDeletableRoot("/home/pm", "/home/pm", "darwin"), /home folder/);
		assert.throws(() => assertDeletableRoot("/home", "/home/pm", "darwin"), /home folder/);
		assert.throws(() => assertDeletableRoot("C:\\", "C:\\Users\\pm", "win32"), /filesystem root/);
		assert.throws(() => assertDeletableRoot("C:\\Users", "C:\\Users\\pm", "win32"), /home folder/);
	});
	it("accepts a data root beside or below the home", () => {
		assertDeletableRoot("/home/pm/Library/Application Support/straw-boss-desk", "/home/pm", "darwin");
		assertDeletableRoot("D:\\data\\straw-boss-desk", "C:\\Users\\pm", "win32");
	});
});
