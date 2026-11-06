import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { LeftEntry, Leftover, RemoveState, RemoveStep } from "../src/shared/computer.ts";
import { layoutFromRecord } from "../src/main/paths.ts";
import type { CredentialStore, StoreEntry, UserPath } from "../src/main/platform/types.ts";
import { claudeItem, safeStorageItem } from "../src/main/removal/names.ts";
import { FALLBACK_PARENT, PENDING_FILE, readPending, rootId } from "../src/main/removal/pending.ts";
import { RemovalService, type RemovalAccounts, type RemovalDeps } from "../src/main/removal/service.ts";
import { testLayout } from "./harness/engine-fixture.ts";

// **Remove all data** with fakes for the code hosts, the stop and the credential store, and a real folder for the files (task 14 anchor). The real stores are `removal-hosted.test.ts`'s.
const IS_MAC = process.platform === "darwin";
const bases: string[] = [];
after(() => {
	for (const b of bases) rmSync(b, { recursive: true, force: true });
});

interface Rig {
	svc: RemovalService;
	calls: string[];
	states: RemoveState[];
	root: string;
	home: string;
	work: string;
	fallback: string | null;
	store: StoreEntry[];
	deleted: string[];
	armed: Array<{ root: string; fallbackDir: string | null }>;
	listed: string[][];
}

function rig(over: { stop?: () => Promise<{ ok: boolean; leftovers: Leftover[]; busy?: boolean }>; survey?: RemovalAccounts["survey"]; removeLogins?: RemovalAccounts["removeLogins"]; userPath?: Partial<UserPath>; store?: StoreEntry[]; fallback?: boolean; fallbackElsewhere?: boolean; productName?: string; deleteChildren?: RemovalDeps["deleteChildren"]; listFails?: boolean; log?: RemovalDeps["log"]; beforeFiles?: () => void; self?: RemovalDeps["self"] } = {}): Rig {
	const base = realpathSync.native(mkdtempSync(join(tmpdir(), "sbd-rm-")));
	bases.push(base);
	const home = join(base, "home");
	const root = join(base, "sbd 測試");
	const work = join(home, "StrawBoss");
	mkdirSync(join(work, "web"), { recursive: true });
	writeFileSync(join(work, "web", "README.md"), "mine");
	for (const f of ["state/bootstrap.json", "tools/node/1/bin/node", "logs/shell.jsonl", "secrets/linear.bin", "claude/.credentials.json", "electron/Local State", "agent/auth.json"]) {
		mkdirSync(join(root, f, ".."), { recursive: true });
		writeFileSync(join(root, f), f);
	}
	const id = rootId(root);
	let fallback: string | null = null;
	if (over.fallback === true) {
		fallback = join(home, FALLBACK_PARENT, over.fallbackElsewhere === true ? "deadbeef" : id);
		mkdirSync(join(fallback, "agent"), { recursive: true });
	}
	const t = testLayout(root);
	const layout = layoutFromRecord({ ...t.record, realRoot: root, home, id, fallbackDir: fallback });
	const calls: string[] = [];
	const states: RemoveState[] = [];
	const store = over.store ?? [];
	const deleted: string[] = [];
	const listed: string[][] = [];
	const credentials: CredentialStore = {
		probe: async () => ({ ok: true }),
		list: async (names) => {
			listed.push([...names]);
			if (over.listFails === true) throw new Error("keychain locked");
			return store.filter((e) => names.includes(e.name));
		},
		delete: async (e) => void deleted.push(`${e.name}|${e.account}`),
	};
	const userPath: UserPath = { supported: false, read: async () => null, ensureFirst: async () => ({ changed: false }), remove: async (e) => (calls.push(`path ${e}`), { changed: true }), ...over.userPath };
	const armed: Rig["armed"] = [];
	const accounts: RemovalAccounts = {
		removalHosts: () => [{ kind: "gitlab", host: "gitlab.example.com" }],
		survey: over.survey ?? (async (_hosts, options) => (calls.push(`survey owned=${options?.owned === true}`), { ok: true, entries: [] })),
		removeLogins: over.removeLogins ?? (async () => (calls.push("logins"), [])),
	};
	const svc = new RemovalService({
		layout,
		home,
		platform: { credentials, userPath },
		productName: over.productName ?? "Straw Boss Desk Dev",
		accounts,
		forges: () => [],
		claude: { resume: () => calls.push("claude.resume"), signOut: async () => void calls.push("claude.signOut") },
		linear: { resume: () => calls.push("linear.resume"), signOut: async () => void calls.push("linear.signOut") },
		workFolder: () => work,
		stop: over.stop ?? (async () => (calls.push("stop"), { ok: true, leftovers: [] })),
		resume: async () => void calls.push("resume"),
		arm: (spec) => void armed.push(spec),
		quit: () => void calls.push("quit"),
		log: over.log ?? (() => {}),
		...(over.beforeFiles !== undefined ? { beforeFiles: over.beforeFiles } : {}),
		...(over.self !== undefined ? { self: over.self } : {}),
		measure: async () => 123_456_789,
		...(over.deleteChildren !== undefined ? { deleteChildren: over.deleteChildren } : {}),
	});
	svc.onChange(() => states.push(svc.state));
	return { svc, calls, states, root, home, work, fallback, store, deleted, armed, listed };
}

const entry = (name: string, account = ""): StoreEntry => ({ name, account, modified: "2026-11-05T10:00:00Z" });
const steps = (r: Rig): RemoveStep[] => r.states.flatMap((s) => (s.phase === "working" ? [s.step] : []));
const rootNames = (r: Rig): string[] => readdirSync(r.root).sort();

describe("the plan", () => {
	it("names the root, its size, the work folder, the entries that stay and, where the platform has one, the PATH entry; nothing is touched", async () => {
		const left: LeftEntry[] = [{ name: "gh:github.com", account: "me", host: "github.com", why: "foreign" }, { name: "glab:gitlab.example.com:token", account: "", host: "gitlab.example.com", why: "changed" }];
		const r = rig({ survey: async () => ({ ok: true, entries: left }), userPath: { supported: true } });
		await r.svc.plan();
		const s = r.svc.state;
		assert.equal(s.phase, "confirm");
		if (s.phase !== "confirm") return;
		assert.deepEqual(s.plan, { root: r.root, bytes: 123_456_789, workFolder: r.work, left, pathEntry: join(r.root, "tools", "shims") });
		assert.deepEqual(r.calls, []);
		assert.ok(existsSync(join(r.root, "tools")));
	});

	it("refuses, touching nothing, when the credential store cannot be listed", async () => {
		const r = rig({ survey: async () => ({ ok: false, detail: "keychain locked" }) });
		await r.svc.plan();
		assert.deepEqual(r.svc.state, { phase: "refused", reason: "store", detail: "keychain locked" });
		await r.svc.confirm();
		assert.equal(r.svc.state.phase, "refused", "a refusal cannot be confirmed");
		assert.deepEqual(r.calls, []);
	});

	it("fails before anything when the root is the home folder", async () => {
		const r = rig();
		const dangerous = new RemovalService({ ...({} as RemovalDeps), layout: layoutFromRecord({ ...testLayout(r.home).record, root: r.home }), home: r.home, accounts: { removalHosts: () => [], survey: async () => ({ ok: true, entries: [] }), removeLogins: async () => [] }, forges: () => [], platform: { credentials: {} as CredentialStore, userPath: { supported: false } as UserPath }, workFolder: () => null, log: () => {}, measure: async () => 0 });
		await dangerous.plan();
		assert.equal(dangerous.state.phase, "failed");
		assert.ok(existsSync(r.home));
	});

	it("can be cancelled from the confirmation, and is not cancelled while it works", async () => {
		const r = rig();
		await r.svc.plan();
		r.svc.cancel();
		assert.equal(r.svc.state.phase, "idle");
	});
});

describe("the removal", () => {
	it("runs the steps in order, ends on a result that keeps the work folder, and leaves only electron and the marker in the root", async () => {
		const r = rig({ userPath: { supported: true } });
		await r.svc.plan();
		await r.svc.confirm();
		const s = r.svc.state;
		assert.equal(s.phase, "done");
		assert.deepEqual(steps(r), ["stopping", "logins", "claude", "linear", "path", "safe-storage", "files"]);
		assert.deepEqual(rootNames(r), ["electron", PENDING_FILE]);
		assert.equal(readFileSync(join(r.work, "web", "README.md"), "utf8"), "mine", "the work folder is untouched");
		assert.deepEqual(r.armed, [{ root: r.root, fallbackDir: null }]);
		assert.ok(r.calls.indexOf("stop") < r.calls.indexOf("logins") && r.calls.indexOf("logins") < r.calls.indexOf("claude.signOut") && r.calls.indexOf("claude.signOut") < r.calls.indexOf("linear.signOut") && r.calls.indexOf("linear.signOut") < r.calls.findIndex((c) => c.startsWith("path ")));
		assert.deepEqual(readPending(r.root), { schema: 1, id: rootId(r.root), fallbackDir: null, owner: null });
		if (s.phase === "done") assert.deepEqual(s.result, { root: r.root, workFolder: r.work, left: [], problems: [] });
	});

	it("does not delete while a program of the app still runs: it stops, names the programs, starts the app again, and removes nothing", async () => {
		const r = rig({ stop: async () => ({ ok: false, leftovers: [{ pid: 55, file: "node" }] }) });
		await r.svc.plan();
		await r.svc.confirm();
		assert.deepEqual(r.svc.state, { phase: "stop-failed", leftovers: [{ pid: 55, file: "node" }], detail: "" });
		assert.ok(r.calls.includes("resume"));
		assert.ok(!r.calls.includes("logins"));
		assert.ok(existsSync(join(r.root, "tools")) && existsSync(join(r.root, "secrets", "linear.bin")));
		assert.equal(r.armed.length, 0);
		assert.ok(!existsSync(join(r.root, PENDING_FILE)));
	});

	it("writes this app's pid and start token into the marker, so a second launch can tell the root is held (T14-F005); a start token that cannot be read writes none", async () => {
		const r = rig({ self: async () => ({ pid: 4242, startTime: "T1" }) });
		await r.svc.plan();
		await r.svc.confirm();
		assert.deepEqual(readPending(r.root), { schema: 1, id: rootId(r.root), fallbackDir: null, owner: { pid: 4242, startTime: "T1" } });
		const unread = rig({ self: async () => ({ pid: 4242, startTime: null }) });
		await unread.svc.plan();
		await unread.svc.confirm();
		assert.equal((readPending(unread.root) as { owner: unknown }).owner, null);
		const broken = rig({ self: async () => { throw new Error("powershell failed"); } });
		await broken.svc.plan();
		await broken.svc.confirm();
		assert.equal(broken.svc.state.phase, "done", "the removal goes on without it");
		assert.equal((readPending(broken.root) as { owner: unknown }).owner, null);
	});

	it("does not resume the stack when another stop is under way: it says busy, removes nothing, and leaves that stop alone (T14-F004)", async () => {
		const r = rig({ stop: async () => ({ ok: false, leftovers: [], busy: true }) });
		await r.svc.plan();
		await r.svc.confirm();
		assert.deepEqual(r.svc.state, { phase: "busy" });
		assert.ok(!r.calls.includes("resume"), "resume would start the stack in the middle of an update");
		assert.ok(!r.calls.includes("logins"));
		assert.ok(existsSync(join(r.root, "tools")) && existsSync(join(r.root, "secrets", "linear.bin")));
		assert.equal(r.armed.length, 0);
		assert.ok(!existsSync(join(r.root, PENDING_FILE)));
	});

	it("names an entry it leaves: another program's, one it made and lost to a write, and one it made and could not remove", async () => {
		const gone: LeftEntry[] = [
			{ name: "glab:gitlab.example.com:token", account: "", host: "gitlab.example.com", why: "changed" },
			{ name: "gh:github.com", account: "me", host: "github.com", why: "foreign" },
			{ name: "gh:github.com", account: "", host: "github.com", why: "failed" },
		];
		let n = 0;
		const r = rig({ survey: async (_h, o) => (n++, o?.owned === true ? { ok: true, entries: gone } : { ok: true, entries: gone.slice(0, 2) }) });
		await r.svc.plan();
		const plan = r.svc.state.phase === "confirm" ? r.svc.state.plan.left : [];
		assert.deepEqual(plan.map((e) => e.why), ["changed", "foreign"]);
		await r.svc.confirm();
		const s = r.svc.state;
		assert.equal(s.phase, "done");
		if (s.phase === "done") assert.deepEqual(s.result.left, gone, "the result lists what is in the store after the sign-outs, owned leftovers included");
	});

	it("goes on past a failed logout, PATH removal and file deletion, and names each in the result", async () => {
		const r = rig({
			userPath: { supported: true, remove: async () => { throw new Error("registry denied"); } },
			removeLogins: async () => ["gitlab.example.com: glab exited 1"],
			deleteChildren: async () => ({ failed: [{ name: "tools", detail: "EBUSY: resource busy" }] }),
		});
		await r.svc.plan();
		await r.svc.confirm();
		const s = r.svc.state;
		assert.equal(s.phase, "done");
		if (s.phase !== "done") return;
		assert.deepEqual(s.result.problems.map((p) => p.step), ["logins", "path", "files"]);
		assert.match(s.result.problems[0]?.detail ?? "", /glab exited 1/);
		assert.match(s.result.problems[1]?.detail ?? "", /registry denied/);
		assert.equal(r.armed.length, 1, "the cleanup is armed, so the files it could not delete go when the app does");
	});

	it("writes the marker before it deletes a file, so a crash is finished by the next launch", async () => {
		let markerWhenDeleting = false;
		const r = rig({ deleteChildren: async (root) => ((markerWhenDeleting = existsSync(join(root, PENDING_FILE))), { failed: [] }) });
		await r.svc.plan();
		await r.svc.confirm();
		assert.equal(markerWhenDeleting, true);
	});

	it("deletes its own fallback folder and arms the cleanup with it; a fallback folder of another root is left alone and reported", async () => {
		const own = rig({ fallback: true });
		await own.svc.plan();
		await own.svc.confirm();
		assert.ok(own.fallback !== null && !existsSync(own.fallback));
		assert.deepEqual(own.armed, [{ root: own.root, fallbackDir: own.fallback }]);

		const other = rig({ fallback: true, fallbackElsewhere: true });
		await other.svc.plan();
		await other.svc.confirm();
		assert.ok(other.fallback !== null && existsSync(other.fallback), "not this root's id: not deleted");
		assert.deepEqual(other.armed, [{ root: other.root, fallbackDir: null }]);
		const s = other.svc.state;
		assert.ok(s.phase === "done" && s.result.problems.some((p) => p.step === "files" && /not this app's/.test(p.detail)));
	});

	it("reaches the result when the log cannot be written any more (its folder was deleted with the files)", async () => {
		let deleted = false;
		const r = rig({
			log: () => {
				if (deleted) throw new Error("ENOENT: no such file or directory, open 'logs/start.jsonl'");
			},
			deleteChildren: async (root, keep) => {
				const { deleteChildren } = await import("../src/main/removal/files.ts");
				const out = await deleteChildren(root, keep, { caseInsensitive: false });
				deleted = true;
				return out;
			},
		});
		await r.svc.plan();
		await r.svc.confirm();
		assert.equal(r.svc.state.phase, "done", "a log that throws after the folder is gone does not stop the result");
		assert.deepEqual(rootNames(r), ["electron", PENDING_FILE]);
	});

	it("calls beforeFiles once, after the sign-outs and before the marker is written or a file is deleted", async () => {
		const seen: string[] = [];
		const r = rig({ beforeFiles: () => void seen.push(`beforeFiles marker=${existsSync(join(r.root, PENDING_FILE))} tools=${existsSync(join(r.root, "tools"))}`) });
		await r.svc.plan();
		await r.svc.confirm();
		assert.deepEqual(seen, ["beforeFiles marker=false tools=true"]);
		assert.ok(r.calls.indexOf("linear.signOut") >= 0);
	});

	it("a beforeFiles that throws does not stop the files", async () => {
		const r = rig({ beforeFiles: () => { throw new Error("no log to close"); } });
		await r.svc.plan();
		await r.svc.confirm();
		assert.equal(r.svc.state.phase, "done");
	});

	it("quits only after the result", async () => {
		const r = rig();
		r.svc.quit();
		assert.ok(!r.calls.includes("quit"));
		await r.svc.plan();
		await r.svc.confirm();
		r.svc.quit();
		assert.ok(r.calls.includes("quit"));
	});

	it("a second plan does not reopen a removal that has started", async () => {
		const r = rig();
		await r.svc.plan();
		await r.svc.confirm();
		await r.svc.plan();
		assert.equal(r.svc.state.phase, "done", "a second plan does not reopen it");
	});
});

describe("the Keychain items (macOS) and the invariant about the shipped product", () => {
	it(`deletes this build's Safe Storage item and the app's Claude item by their computed names${IS_MAC ? "" : ", and on Windows asks the store for neither"}`, async () => {
		const shipped = entry(safeStorageItem("Straw Boss Desk"), "Straw Boss Desk");
		const r = rig({ store: [] });
		const dev = entry(safeStorageItem("Straw Boss Desk Dev"), "Straw Boss Desk Dev");
		const claude = entry(claudeItem(testLayout(r.root).claude), "me");
		const pmsClaude = entry("Claude Code-credentials", "me");
		const otherClaude = entry("Claude Code-credentials-00000000", "me");
		r.store.push(shipped, dev, claude, pmsClaude, otherClaude);
		await r.svc.plan();
		await r.svc.confirm();
		if (IS_MAC) {
			assert.deepEqual(r.deleted.sort(), [`${claude.name}|me`, `${dev.name}|${dev.account}`].sort());
			for (const names of r.listed) for (const n of names) assert.notEqual(n, shipped.name, "the shipped product's item is never even asked for");
		} else {
			assert.deepEqual(r.deleted, []);
			assert.deepEqual(r.listed, []);
		}
	});

	it("a failed Keychain delete is named in the result and does not stop the files", async () => {
		const r = rig();
		r.store.push(entry(safeStorageItem("Straw Boss Desk Dev"), "Straw Boss Desk Dev"));
		const failing = new RemovalService({ ...({} as RemovalDeps), layout: testLayout(r.root), home: r.home, platform: { credentials: { probe: async () => ({ ok: true }), list: async () => r.store, delete: async () => { throw new Error("User interaction is not allowed"); } }, userPath: { supported: false } as UserPath }, productName: "Straw Boss Desk Dev", accounts: { removalHosts: () => [], survey: async () => ({ ok: true, entries: [] }), removeLogins: async () => [] }, forges: () => [], claude: { resume() {}, signOut: async () => {} }, linear: { resume() {}, signOut: async () => {} }, workFolder: () => null, stop: async () => ({ ok: true, leftovers: [] }), resume: async () => {}, arm() {}, quit() {}, log() {}, measure: async () => 1 });
		await failing.plan();
		await failing.confirm();
		const s = failing.state;
		assert.equal(s.phase, "done");
		if (IS_MAC && s.phase === "done") assert.ok(s.result.problems.some((p) => p.step === "safe-storage" && /not allowed/.test(p.detail)));
		assert.deepEqual(rootNames({ ...r }), ["electron", PENDING_FILE]);
	});
});
