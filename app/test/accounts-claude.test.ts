import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, describe, it } from "node:test";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { asksForCode, ClaudeAccounts, parseSignInUrl, parseStatus, stripAnsi, testClaudeCommand, type ClaudeChild } from "../src/main/accounts/claude.ts";
import type { CommandRunner, RunResult } from "../src/main/platform/types.ts";
import { scratchRoot, testLayout } from "./harness/engine-fixture.ts";

// The Claude sign-in with a stand-in `claude` (task 11): the order of its steps, what the code field may do, where the code goes and where it must not, and the verdict. No real account, no real credential store.

const scratch: string[] = [];
after(() => {
	for (const d of scratch) removeTree(d);
});

const CURRENT = { node: "1", git: "1", herdr: "1", gh: "2.103.3", glab: "1.124.0" };
const CODE = "planted-code-Zx81QwErTy-9f3b";

class FakeClaudeChild extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	readonly written: string[] = [];
	stdinEnded = false;
	killed = false;
	readonly stdin = {
		write: (chunk: string, callback?: (error?: Error | null) => void): boolean => {
			this.written.push(chunk);
			callback?.(null);
			return true;
		},
		end: (): void => {
			this.stdinEnded = true;
		},
		on: (): unknown => undefined,
	};
	kill(): boolean {
		this.killed = true;
		return true;
	}
	say(text: string): void {
		this.stdout.emit("data", Buffer.from(text));
	}
	finish(code: number | null): void {
		this.emit("exit", code, null);
	}
}

interface Call {
	file: string;
	args: string[];
	env?: Record<string, string>;
}

function rig(options: { statuses?: string[]; logoutCode?: number } = {}) {
	const made = scratchRoot("sbd-claude-");
	scratch.push(made.base);
	const layout = testLayout(made.root);
	const calls: Call[] = [];
	const statuses = [...(options.statuses ?? ['{"loggedIn":true}'])];
	const run: CommandRunner = async (file, args, o): Promise<RunResult> => {
		calls.push({ file, args: [...args], ...(o?.env !== undefined ? { env: o.env } : {}) });
		if (args.includes("status")) return { code: 0, stdout: statuses.length > 1 ? (statuses.shift() as string) : (statuses[0] as string), stderr: "" };
		if (args.includes("logout")) return { code: options.logoutCode ?? 0, stdout: "", stderr: options.logoutCode ? "logout failed" : "" };
		return { code: 1, stdout: "", stderr: "unexpected" };
	};
	const started: Array<{ file: string; args: string[]; env: Record<string, string>; child: FakeClaudeChild }> = [];
	const log: Array<Record<string, unknown>> = [];
	const opened: string[] = [];
	const clipboard: string[] = [];
	const held: string[] = [];
	const released: string[] = [];
	const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
	const claude = new ClaudeAccounts({
		layout,
		run,
		spawn: (file, args, o) => {
			const child = new FakeClaudeChild();
			started.push({ file, args: [...args], env: o.env, child });
			return child as unknown as ClaudeChild;
		},
		appEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/somewhere/else", CLAUDE_CONFIG_DIR: "/the/pms/own" },
		current: () => CURRENT,
		command: () => ({ file: "/fake/claude", args: ["--lead"] }),
		log: (f) => log.push(f as Record<string, unknown>),
		openExternal: (u) => opened.push(u),
		writeClipboard: (t) => clipboard.push(t),
		hold: (v) => held.push(v),
		release: (v) => released.push(v),
		setTimer: (fn, ms) => {
			const t = { fn, ms, cleared: false };
			timers.push(t);
			return t;
		},
		clearTimer: (t) => {
			(t as { cleared: boolean }).cleared = true;
		},
	});
	return { layout, claude, calls, started, log, opened, clipboard, held, released, timers };
}
const until = async (what: string, probe: () => boolean): Promise<void> => {
	for (let i = 0; i < 400; i++) {
		if (probe()) return;
		await new Promise((r) => setImmediate(r));
	}
	throw new Error(`timed out waiting for ${what}`);
};

describe("reading what the CLI prints", () => {
	it("takes the address after 'visit:', else the first https address, and nothing that is not https", () => {
		assert.equal(parseSignInUrl("Opening browser to sign in…\nIf the browser did not open, visit: https://claude.ai/oauth/authorize?code=true&x=1\nPaste code here if prompted >"), "https://claude.ai/oauth/authorize?code=true&x=1");
		assert.equal(parseSignInUrl("go to https://example.com/a now"), "https://example.com/a");
		assert.equal(parseSignInUrl("visit: http://example.com/a"), null);
		assert.equal(parseSignInUrl("nothing here"), null);
		assert.equal(parseSignInUrl("\u001b[1mvisit:\u001b[0m https://claude.ai/x"), "https://claude.ai/x");
	});

	it("knows when the CLI asks for a code, and reads the JSON of the status", () => {
		assert.equal(asksForCode("Paste code here if prompted >"), true);
		assert.equal(asksForCode("\u001b[2mPASTE CODE HERE\u001b[0m"), true);
		assert.equal(asksForCode("Opening browser"), false);
		assert.equal(stripAnsi("\u001b[31mred\u001b[0m"), "red");
		assert.equal(parseStatus('{"loggedIn":true,"authMethod":"claude.ai"}'), true);
		assert.equal(parseStatus('note\n{"loggedIn":false}'), false);
		assert.equal(parseStatus("not json"), null);
		assert.equal(parseStatus('{"loggedIn":"yes"}'), null);
	});

	it("takes the stand-in command from a development build's variable only when it is a JSON array of strings", () => {
		assert.deepEqual(testClaudeCommand({ SBD_TEST_CLAUDE_CMD: '["node","/x/fake.mjs"]' }), { file: "node", args: ["/x/fake.mjs"] });
		assert.equal(testClaudeCommand({}), null);
		assert.equal(testClaudeCommand({ SBD_TEST_CLAUDE_CMD: "[]" }), null);
		assert.equal(testClaudeCommand({ SBD_TEST_CLAUDE_CMD: '["a",1]' }), null);
		assert.equal(testClaudeCommand({ SBD_TEST_CLAUDE_CMD: "{" }), null);
	});
});

describe("the status row", () => {
	it("reads the CLI's own status, with the app's config folder and never the variable that moves the Keychain item", async () => {
		const r = rig({ statuses: ['{"loggedIn":false}'] });
		await r.claude.refresh();
		assert.equal(r.claude.state, "not-signed-in");
		const call = r.calls[0] as Call;
		assert.deepEqual(call.args, ["--lead", "auth", "status", "--json"]);
		assert.equal(call.env?.CLAUDE_CONFIG_DIR, r.layout.claude, "the app's own folder, not the one in the app's environment");
		assert.equal("CLAUDE_SECURESTORAGE_CONFIG_DIR" in (call.env ?? {}), false);
	});

	it("an answer that is not the status JSON is 'unknown', never 'signed in'", async () => {
		const r = rig({ statuses: ["garbage"] });
		await r.claude.refresh();
		assert.equal(r.claude.state, "unknown");
	});

	it("storage is the keychain on macOS and the app's file on Windows", () => {
		const r = rig();
		assert.equal(r.claude.view().storage, process.platform === "win32" ? "file" : "keychain");
	});
});

describe("the login", () => {
	it("starts `claude auth login` with no code on the command line, shows the CLI's address, and opens only that address", async () => {
		const r = rig();
		await r.claude.start();
		const s = r.started[0] as (typeof r.started)[number];
		assert.deepEqual(s.args, ["--lead", "auth", "login"]);
		assert.equal("CLAUDE_SECURESTORAGE_CONFIG_DIR" in s.env, false);
		r.claude.open();
		assert.deepEqual(r.opened, [], "nothing to open before the CLI printed an address");
		s.child.say("If the browser did not open, visit: https://claude.ai/oauth/authorize?x=1\n");
		const flow = r.claude.flow;
		assert.equal(flow.phase, "browser");
		assert.equal(flow.phase === "browser" && flow.url, "https://claude.ai/oauth/authorize?x=1");
		r.claude.open();
		r.claude.copyUrl();
		assert.deepEqual(r.opened, ["https://claude.ai/oauth/authorize?x=1"]);
		assert.deepEqual(r.clipboard, ["https://claude.ai/oauth/authorize?x=1"]);
	});

	it("the code is refused before the CLI asks for one, written once to standard input with a line end, and held for the redactor until the login ends", async () => {
		const r = rig();
		await r.claude.start();
		const s = r.started[0] as (typeof r.started)[number];
		s.child.say("visit: https://claude.ai/x\n");
		r.claude.sendCode(CODE);
		assert.deepEqual(s.child.written, [], "no prompt yet, nothing sent");
		s.child.say("Paste code here if prompted > ");
		r.claude.sendCode("   ");
		assert.deepEqual(s.child.written, [], "an empty field sends nothing");
		r.claude.sendCode(` ${CODE} `);
		r.claude.sendCode(CODE);
		assert.deepEqual(s.child.written, [`${CODE}\n`], "once, trimmed");
		assert.deepEqual(r.held, [CODE]);
		const flow = r.claude.flow;
		assert.equal(flow.phase === "browser" && flow.codeSent, true);
		// Nothing carries it: not the arguments, not the environment, not the log, not the view.
		assert.equal(JSON.stringify([s.args, s.env, r.log, r.claude.view(), r.calls]).includes(CODE), false);
		s.child.finish(0);
		await until("the verdict", () => r.claude.flow.phase === "done");
		assert.deepEqual(r.released, [CODE]);
		assert.equal(JSON.stringify([r.log, r.claude.view()]).includes(CODE), false);
	});

	it("is done only when the CLI's own status says signed in; an exit 0 with a status of 'not logged in' is unverified", async () => {
		const r = rig({ statuses: ['{"loggedIn":false}'] });
		await r.claude.start();
		(r.started[0] as (typeof r.started)[number]).child.finish(0);
		await until("the verdict", () => r.claude.flow.phase === "unverified");
		assert.equal(r.claude.state, "not-signed-in");

		const ok = rig();
		let signedIn = 0;
		ok.claude.onSignedIn(() => signedIn++);
		await ok.claude.start();
		(ok.started[0] as (typeof ok.started)[number]).child.finish(0);
		await until("the verdict", () => ok.claude.flow.phase === "done");
		assert.equal(ok.claude.state, "signed-in");
		assert.equal(signedIn, 1);
	});

	it("a login that exits with an error fails with the CLI's last line, the code hidden if the CLI echoed it", async () => {
		const r = rig();
		await r.claude.start();
		const s = r.started[0] as (typeof r.started)[number];
		s.child.say("Paste code here if prompted > ");
		r.claude.sendCode(CODE);
		s.child.say(`Invalid code ${CODE}\n`);
		s.child.finish(1);
		const flow = r.claude.flow;
		assert.equal(flow.phase, "failed");
		assert.equal(flow.phase === "failed" && flow.detail.includes(CODE), false);
		assert.match(flow.phase === "failed" ? flow.detail : "", /Invalid code/);
	});

	it("a login that waits too long is stopped and says so; Cancel kills the child and frees the code", async () => {
		const r = rig();
		await r.claude.start();
		const s = r.started[0] as (typeof r.started)[number];
		s.child.say("Paste code here if prompted > ");
		r.claude.sendCode(CODE);
		(r.timers[0] as (typeof r.timers)[number]).fn();
		assert.equal(r.claude.flow.phase, "timeout");
		assert.equal(s.child.killed, true);
		assert.deepEqual(r.released, [CODE]);

		const c = rig();
		await c.claude.start();
		c.claude.cancel();
		assert.equal((c.started[0] as (typeof c.started)[number]).child.killed, true);
		assert.equal(c.claude.flow.phase, "idle");
	});

	it("a second Start while one waits starts nothing", async () => {
		const r = rig();
		await r.claude.start();
		await r.claude.start();
		assert.equal(r.started.length, 1);
	});
});

describe("signing out and the end", () => {
	it("signs out through the CLI and reads the status again; a status that still says signed in is a failure", async () => {
		const r = rig({ statuses: ['{"loggedIn":false}'] });
		await r.claude.signOut();
		assert.equal(r.claude.flow.phase, "signed-out");
		assert.deepEqual((r.calls[0] as Call).args, ["--lead", "auth", "logout"]);

		const still = rig({ statuses: ['{"loggedIn":true}'] });
		await still.claude.signOut();
		assert.equal(still.claude.flow.phase, "failed");

		const bad = rig({ logoutCode: 1 });
		await bad.claude.signOut();
		assert.equal(bad.claude.flow.phase, "failed");
	});

	it("a quit ends a login that waits, and a login whose verdict is being read is left to settle", async () => {
		const r = rig();
		await r.claude.start();
		r.claude.dispose();
		assert.equal((r.started[0] as (typeof r.started)[number]).child.killed, true);
		await r.claude.start();
		assert.equal(r.started.length, 1, "no login starts after the quit began");
	});
});
