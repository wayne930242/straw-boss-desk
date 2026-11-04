import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { forgeEnv, loginLine, parseDeviceCode } from "../src/main/accounts/cli.ts";
import { readAccountsRecord } from "../src/main/accounts/existing.ts";
import { ForgeAccounts, githubDeviceUrl, gitlabTokenUrl } from "../src/main/accounts/session.ts";
import { scan } from "../src/main/accounts/token-search.ts";
import type { ForgeFlow } from "../src/shared/accounts.ts";
import { scratchRoot, testLayout } from "./harness/engine-fixture.ts";
import { fakeRun, fakeSpawn, FakeStore, type FakeCliOptions } from "./harness/fake-forge.ts";

// The code-host sign-in with a store and two CLIs that are stand-ins (task 10): the order of the checks, what stops a login before any token or code, the record and its times, the verdict, and the
// removal of a login. Nothing here touches a real credential store or a real login.

const scratch: string[] = [];
after(() => {
	for (const d of scratch) removeTree(d);
});

const CURRENT = { node: "1", git: "1", herdr: "1", gh: "2.103.3", glab: "1.124.0" };
const TOKEN = "glpat-TESTTOKEN-0123456789abcdef";

function rig(cli: FakeCliOptions = {}, extra: { appEnv?: Record<string, string>; loginWaitMs?: number } = {}) {
	const made = scratchRoot("sbd-acct-");
	scratch.push(made.base);
	const layout = testLayout(made.root);
	const store = new FakeStore();
	const fake = fakeRun(store, cli);
	const sp = fakeSpawn();
	const log: Array<Record<string, unknown>> = [];
	const opened: string[] = [];
	const clipboard: string[] = [];
	const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
	const accounts = new ForgeAccounts({
		layout,
		credentials: store,
		run: fake.run,
		spawn: sp.spawn,
		appEnv: extra.appEnv ?? {},
		current: () => CURRENT,
		log: (f) => log.push(f as Record<string, unknown>),
		openExternal: (u) => opened.push(u),
		writeClipboard: (t) => clipboard.push(t),
		...(extra.loginWaitMs !== undefined ? { loginWaitMs: extra.loginWaitMs } : {}),
		setTimer: (fn, ms) => {
			const t = { fn, ms, cleared: false };
			timers.push(t);
			return t;
		},
		clearTimer: (t) => {
			(t as { cleared: boolean }).cleared = true;
		},
	});
	return { made, layout, store, cli: fake, spawned: sp.started, spawn: sp, log, opened, clipboard, timers, accounts };
}

const until = async (what: string, probe: () => boolean): Promise<void> => {
	for (let i = 0; i < 400; i++) {
		if (probe()) return;
		await new Promise((r) => setImmediate(r));
	}
	throw new Error(`timed out waiting for ${what}`);
};
const phase = (r: ReturnType<typeof rig>, host: string): string => r.accounts.flowOf(host).phase;
const flow = <P extends ForgeFlow["phase"]>(r: ReturnType<typeof rig>, host: string, p: P): Extract<ForgeFlow, { phase: P }> => {
	const f = r.accounts.flowOf(host);
	assert.equal(f.phase, p, `the flow of ${host}`);
	return f as Extract<ForgeFlow, { phase: P }>;
};
const logins = (r: ReturnType<typeof rig>) => r.cli.calls.filter((c) => c.args[0] === "auth" && c.args[1] === "login");
const logouts = (r: ReturnType<typeof rig>) => r.cli.calls.filter((c) => c.args[0] === "auth" && c.args[1] === "logout");

describe("the checks before a sign-in", () => {
	it("run the store probe first and the listing second; a failed probe stops the step with no listing and no CLI call", async () => {
		const r = rig();
		r.store.probeResult = { ok: false, reason: "the keychain did not answer within 10 s" };
		await r.accounts.begin("gitlab", "gitlab.com");
		assert.deepEqual(r.store.calls, ["probe"]);
		assert.match(flow(r, "gitlab.com", "store-unavailable").detail, /did not answer/);
		assert.equal(r.cli.calls.length, 0);
		assert.equal(r.accounts.views([{ kind: "gitlab", host: "gitlab.com" }])[0]?.state, "unknown");
	});

	it("a listing that fails is a failed probe, not 'no entry'", async () => {
		const r = rig();
		r.store.listError = "security dump-keychain exited 1";
		await r.accounts.begin("github", "github.com");
		assert.deepEqual(r.store.calls, ["probe", "list"]);
		assert.equal(phase(r, "github.com"), "store-unavailable");
		// A token or a code can not be asked for from here.
		await r.accounts.signInGitlab("github.com", TOKEN);
		await r.accounts.startGithub("github.com");
		assert.equal(r.spawned.length + r.cli.calls.length, 0);
	});

	it("a clear store passes: the host is ready, and the log says what was found", async () => {
		const r = rig();
		await r.accounts.begin("gitlab", "gitlab.com");
		flow(r, "gitlab.com", "ready");
		assert.ok(r.log.some((l) => l.event === "forge-probe" && l.ok === true));
		assert.ok(r.log.some((l) => l.event === "forge-existing-check" && l.found === 0 && l.foreign === 0));
	});

	it("a foreign gh:github.com entry stops GitHub before any device code, and the entry is unchanged", async () => {
		const r = rig();
		r.store.write("gh:github.com", "someone");
		const before = JSON.stringify(r.store.entries);
		await r.accounts.begin("github", "github.com");
		const f = flow(r, "github.com", "foreign");
		assert.deepEqual(f.entries, [{ name: "gh:github.com", account: "someone" }]);
		assert.deepEqual(f.changed, [], "another program's, not the app's own lost entry");
		// Asking to start anyway starts nothing.
		await r.accounts.act({ type: "forge-start", kind: "github", host: "github.com" });
		assert.equal(r.spawned.length, 0);
		assert.equal(JSON.stringify(r.store.entries), before);
		assert.ok(!r.store.calls.some((c) => c.startsWith("delete")));
		assert.equal(r.accounts.views([{ kind: "github", host: "github.com" }])[0]?.state, "foreign");
	});

	it("a foreign glab:<host>:token entry stops GitLab before the token field", async () => {
		const r = rig();
		r.store.write("glab:gitlab.com:token", "");
		await r.accounts.begin("gitlab", "gitlab.com");
		flow(r, "gitlab.com", "foreign");
		await r.accounts.signInGitlab("gitlab.com", TOKEN);
		assert.equal(logins(r).length, 0, "no login ran, so the token went nowhere");
		assert.equal(JSON.stringify(r.log).includes(TOKEN), false);
	});

	it("a legacy glab:<host> entry and a gh:_refreshable:<host> entry count as sign-ins too", async () => {
		for (const [kind, host, name] of [["gitlab", "gitlab.com", "glab:gitlab.com"], ["github", "github.com", "gh:_refreshable:github.com"]] as const) {
			const r = rig();
			r.store.write(name, "");
			await r.accounts.begin(kind, host);
			flow(r, host, "foreign");
		}
	});

	it("the check runs again right before the login: an entry that appeared while the token field was open stops it", async () => {
		const r = rig();
		await r.accounts.begin("gitlab", "gitlab.com");
		flow(r, "gitlab.com", "ready");
		r.store.write("glab:gitlab.com:token", "");
		await r.accounts.signInGitlab("gitlab.com", TOKEN);
		flow(r, "gitlab.com", "foreign");
		assert.equal(logins(r).length, 0);
	});
});

describe("GitHub: the device code", () => {
	it("runs gh with --expiring=false, shows the code, and records both entries it created after the verdict passes", async () => {
		const r = rig({}, { appEnv: { GH_TOKEN: "dummy-gh-token", GITHUB_TOKEN: "dummy", GH_HOST: "evil.example.org" } });
		const signedIn: string[] = [];
		r.accounts.onSignedIn((k, h) => signedIn.push(`${k}:${h}`));
		await r.accounts.begin("github", "github.com");
		await r.accounts.act({ type: "forge-start", kind: "github", host: "github.com" });
		assert.equal(r.spawned.length, 1);
		const started = r.spawned[0] as (typeof r.spawned)[number];
		assert.deepEqual(started.args, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--expiring=false"]);
		assert.match(started.file, /gh(\.exe)?$/);
		assert.equal(started.env.GH_CONFIG_DIR, r.layout.ghConfig, "the app's own gh folder");
		for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "CI"]) assert.equal(started.env[name], undefined, `${name} does not reach gh`);
		assert.equal(started.env.GH_TELEMETRY, "disabled");
		flow(r, "github.com", "waiting-code");
		started.child.say("! First copy your one-time code: ABCD-1234\nOpen this URL to continue in your web browser: https://github.com/login/device\n");
		const code = flow(r, "github.com", "code");
		assert.deepEqual([code.code, code.deviceUrl], ["ABCD-1234", "https://github.com/login/device"]);
		r.accounts.copyCode("github.com");
		r.accounts.open("github", "github.com");
		assert.deepEqual(r.clipboard, ["ABCD-1234"]);
		assert.deepEqual(r.opened, ["https://github.com/login/device"]);
		// gh finishes: its keyring entries are there.
		r.store.write("gh:github.com", "");
		r.store.write("gh:github.com", "someone");
		started.child.finish(0);
		await until("the sign-in to finish", () => phase(r, "github.com") === "done");
		const record = readAccountsRecord(r.layout);
		assert.deepEqual(record.entries.map((e) => [e.name, e.account, e.modified]).sort(), [["gh:github.com", "", r.store.get("gh:github.com", "")?.modified], ["gh:github.com", "someone", r.store.get("gh:github.com", "someone")?.modified]].sort());
		assert.deepEqual(signedIn, ["github:github.com"]);
		assert.equal(r.accounts.views([{ kind: "github", host: "github.com" }])[0]?.state, "signed-in");
		assert.equal(JSON.stringify(r.log).includes("ABCD-1234"), false, "the code is in no log line");
		assert.ok(r.log.some((l) => l.event === "forge-login-start" && JSON.stringify(l.args).includes("--expiring=false")));
	});

	it("opens the device page only while the code shows, and copies only a code it holds", async () => {
		const r = rig();
		r.accounts.open("github", "github.com");
		r.accounts.copyCode("github.com");
		assert.deepEqual([r.opened, r.clipboard], [[], []]);
	});

	it("a code that is not approved within 15 minutes ends the login: gh is stopped and the step offers Try again", async () => {
		const r = rig({}, { loginWaitMs: 15 * 60_000 });
		await r.accounts.begin("github", "github.com");
		await r.accounts.startGithub("github.com");
		const started = r.spawned[0] as (typeof r.spawned)[number];
		started.child.say("! First copy your one-time code: WXYZ-9876\n");
		assert.equal(r.timers.at(-1)?.ms, 15 * 60_000);
		r.timers.at(-1)?.fn();
		assert.equal(started.child.killed, true);
		flow(r, "github.com", "timeout");
		// Whatever gh does after it was stopped changes nothing.
		started.child.finish(1);
		flow(r, "github.com", "timeout");
	});

	it("Cancel and Later stop gh, and an exit that comes after is ignored", async () => {
		const r = rig();
		await r.accounts.begin("github", "github.com");
		await r.accounts.startGithub("github.com");
		const started = r.spawned[0] as (typeof r.spawned)[number];
		started.child.say("! First copy your one-time code: WXYZ-9876\n");
		r.accounts.cancel("github.com");
		assert.equal(started.child.killed, true);
		flow(r, "github.com", "ready");
		started.child.finish(0);
		await new Promise((r2) => setImmediate(r2));
		flow(r, "github.com", "ready");
		assert.deepEqual(readAccountsRecord(r.layout).entries, []);
	});

	it("gh that exits with an error fails the step with its line, and records nothing", async () => {
		const r = rig();
		await r.accounts.begin("github", "github.com");
		await r.accounts.startGithub("github.com");
		const started = r.spawned[0] as (typeof r.spawned)[number];
		started.child.say("failed to authenticate via web browser: the code expired\n");
		started.child.finish(1);
		assert.match(flow(r, "github.com", "failed").detail, /code expired/);
		assert.deepEqual(readAccountsRecord(r.layout).entries, []);
	});

	it("gh saying it saved the token in plain text, or a token in hosts.yml, removes the login and refuses with the store sentence", async () => {
		const r = rig({ tokenSource: "keyring" });
		await r.accounts.begin("github", "github.com");
		await r.accounts.startGithub("github.com");
		const started = r.spawned[0] as (typeof r.spawned)[number];
		started.child.say("! First copy your one-time code: WXYZ-9876\n");
		mkdirSync(r.layout.ghConfig, { recursive: true });
		writeFileSync(join(r.layout.ghConfig, "hosts.yml"), "github.com:\n    oauth_token: fake_token_value_x\n");
		r.store.write("gh:github.com", "");
		started.child.finish(0);
		await until("the refusal", () => phase(r, "github.com") === "plain-text");
		assert.equal(logouts(r).length, 1, "the app's own login is logged out");
		assert.deepEqual(readAccountsRecord(r.layout), { schema: 1, entries: [], left: [] });
	});

	it("a status gh cannot give is 'could not verify': the step fails and the login stays", async () => {
		const r = rig({ tokenSource: null });
		await r.accounts.begin("github", "github.com");
		await r.accounts.startGithub("github.com");
		const started = r.spawned[0] as (typeof r.spawned)[number];
		started.child.say("! First copy your one-time code: WXYZ-9876\n");
		r.store.write("gh:github.com", "");
		started.child.finish(0);
		await until("the verdict", () => phase(r, "github.com") === "unverified");
		assert.equal(logouts(r).length, 0, "no logout without evidence");
		assert.equal(readAccountsRecord(r.layout).entries.length, 1, "the login stays recorded as the app's");
	});
});

describe("GitLab: the token", () => {
	it("goes to glab's standard input and nowhere else; the entry is recorded and the verdict passes", async () => {
		const r = rig();
		await r.accounts.begin("gitlab", "gitlab.com");
		await r.accounts.act({ type: "forge-token", host: "gitlab.com", token: `  ${TOKEN}\n` });
		const login = logins(r)[0];
		assert.deepEqual(login?.args, ["auth", "login", "--hostname", "gitlab.com", "--git-protocol", "https", "--api-protocol", "https", "--stdin"]);
		assert.equal(login?.stdin, `${TOKEN}\n`);
		assert.equal(JSON.stringify(r.cli.calls.map((c) => c.args)).includes(TOKEN), false, "not on a command line");
		assert.equal(JSON.stringify(r.log).includes(TOKEN), false, "not in a log line");
		assert.equal(login?.env?.GLAB_CONFIG_DIR, r.layout.glabConfig);
		assert.equal(phase(r, "gitlab.com"), "done");
		assert.deepEqual(readAccountsRecord(r.layout).entries.map((e) => [e.name, e.host, e.kind]), [["glab:gitlab.com:token", "gitlab.com", "gitlab"]]);
		assert.equal(readAccountsRecord(r.layout).entries[0]?.modified, r.store.get("glab:gitlab.com:token")?.modified);
		// Nothing under the root holds the token (the search of the anchor, over a root the sign-in wrote to).
		const found = scan([r.made.root], TOKEN);
		assert.deepEqual(found.hits, []);
	});

	it("a failed login shows glab's line with the token hidden, and records nothing", async () => {
		const r = rig({ glabLogin: { code: 1, stderr: `401 Unauthorized: bad token ${TOKEN}` } });
		await r.accounts.begin("gitlab", "gitlab.com");
		await r.accounts.signInGitlab("gitlab.com", TOKEN);
		const f = flow(r, "gitlab.com", "failed");
		assert.ok(!f.detail.includes(TOKEN), f.detail);
		assert.match(f.detail, /401/);
		assert.deepEqual(readAccountsRecord(r.layout).entries, []);
	});

	it("an empty token, or a token before the checks passed, runs nothing", async () => {
		const r = rig();
		await r.accounts.signInGitlab("gitlab.com", TOKEN);
		await r.accounts.begin("gitlab", "gitlab.com");
		await r.accounts.signInGitlab("gitlab.com", "   ");
		assert.equal(logins(r).length, 0);
	});

	it("glab config.yml holding a token removes the login: logout runs on the app's own entry, the record empties, and the refusal is the store sentence", async () => {
		const r = rig({
			onGlabLogin: () => {
				mkdirSync(r.layout.glabConfig, { recursive: true });
				writeFileSync(join(r.layout.glabConfig, "config.yml"), "hosts:\n  gitlab.com:\n    token: fake_token_value_y\n");
			},
		});
		await r.accounts.begin("gitlab", "gitlab.com");
		await r.accounts.signInGitlab("gitlab.com", TOKEN);
		flow(r, "gitlab.com", "plain-text");
		assert.equal(logouts(r).length, 1);
		assert.deepEqual(readAccountsRecord(r.layout), { schema: 1, entries: [], left: [] });
		assert.equal(r.store.entries.length, 0);
	});

	it("a status glab fails is 'could not verify': the login stays and the step fails", async () => {
		const r = rig({ glabStatusExit: 1 });
		await r.accounts.begin("gitlab", "gitlab.com");
		await r.accounts.signInGitlab("gitlab.com", TOKEN);
		flow(r, "gitlab.com", "unverified");
		assert.equal(logouts(r).length, 0);
		assert.equal(readAccountsRecord(r.layout).entries.length, 1);
	});

	it("opens the token page with the name and the scope filled in, while the token field shows", async () => {
		const r = rig();
		await r.accounts.begin("gitlab", "gitlab.example.org");
		r.accounts.open("gitlab", "gitlab.example.org");
		assert.deepEqual(r.opened, ["https://gitlab.example.org/-/user_settings/personal_access_tokens?name=Straw%20Boss&scopes=api"]);
		assert.equal(gitlabTokenUrl("gitlab.com"), "https://gitlab.com/-/user_settings/personal_access_tokens?name=Straw%20Boss&scopes=api");
		assert.equal(githubDeviceUrl("github.com"), "https://github.com/login/device");
	});
});

describe("removing a login", () => {
	async function signedInGitlab(r: ReturnType<typeof rig>) {
		await r.accounts.begin("gitlab", "gitlab.com");
		await r.accounts.signInGitlab("gitlab.com", TOKEN);
		assert.equal(phase(r, "gitlab.com"), "done");
	}

	it("with only owned entries, Sign out logs out and empties the record", async () => {
		const r = rig();
		await signedInGitlab(r);
		await r.accounts.signOut("gitlab", "gitlab.com");
		flow(r, "gitlab.com", "signed-out");
		assert.equal(logouts(r).length, 1);
		assert.deepEqual(readAccountsRecord(r.layout), { schema: 1, entries: [], left: [] });
		assert.equal(r.accounts.views([{ kind: "gitlab", host: "gitlab.com" }])[0]?.state, "not-signed-in");
	});

	it("a foreign write into the same slot after the login: Sign out runs no logout and the entry keeps its dummy secret's time; the entry is marked left", async () => {
		const r = rig();
		await signedInGitlab(r);
		r.store.write("glab:gitlab.com:token", "");
		const foreignTime = r.store.get("glab:gitlab.com:token")?.modified;
		await r.accounts.signOut("gitlab", "gitlab.com");
		const out = flow(r, "gitlab.com", "left-alone");
		assert.equal(logouts(r).length, 0, "no logout");
		assert.ok(r.log.some((l) => l.event === "forge-logout-skipped"));
		assert.equal(r.store.get("glab:gitlab.com:token")?.modified, foreignTime, "the entry is unchanged");
		assert.deepEqual(out.foreign, [{ name: "glab:gitlab.com:token", account: "" }]);
		assert.deepEqual(readAccountsRecord(r.layout), { schema: 1, entries: [], left: [{ name: "glab:gitlab.com:token", account: "", host: "gitlab.com", kind: "gitlab" }] });
		assert.equal(r.accounts.views([{ kind: "gitlab", host: "gitlab.com" }])[0]?.state, "left");
	});

	it("Sign in again then stops at the existing-sign-in check, names the changed entry, and passes once the entry is gone", async () => {
		const r = rig();
		await signedInGitlab(r);
		r.store.write("glab:gitlab.com:token", "");
		await r.accounts.begin("gitlab", "gitlab.com");
		const f = flow(r, "gitlab.com", "foreign");
		assert.deepEqual(f.changed, [{ name: "glab:gitlab.com:token", account: "" }], "the sentence about a sign-in changed afterwards");
		assert.equal(readAccountsRecord(r.layout).left.length, 1, "kept as left");
		// The test deletes it, as a PM would.
		r.store.entries = [];
		await r.accounts.begin("gitlab", "gitlab.com");
		flow(r, "gitlab.com", "ready");
		assert.deepEqual(readAccountsRecord(r.layout), { schema: 1, entries: [], left: [] }, "a left entry the store no longer holds leaves the record");
	});

	it("a mixed host (one owned entry, one foreign) runs no logout and marks the owned one left", async () => {
		const r = rig();
		await r.accounts.begin("github", "github.com");
		await r.accounts.startGithub("github.com");
		const started = r.spawned[0] as (typeof r.spawned)[number];
		started.child.say("! First copy your one-time code: WXYZ-9876\n");
		r.store.write("gh:github.com", "");
		started.child.finish(0);
		await until("done", () => phase(r, "github.com") === "done");
		// Another program adds its own item under the same service (a PM's own account).
		r.store.write("gh:github.com", "someone");
		mkdirSync(r.layout.ghConfig, { recursive: true });
		const hosts = join(r.layout.ghConfig, "hosts.yml");
		writeFileSync(hosts, "github.com:\n    user: someone\nghe.example.org:\n    user: other\n");
		await r.accounts.signOut("github", "github.com");
		const out = flow(r, "github.com", "left-alone");
		assert.equal(logouts(r).length, 0);
		assert.deepEqual(out.left, [{ name: "gh:github.com", account: "" }]);
		assert.deepEqual(out.foreign, [{ name: "gh:github.com", account: "someone" }]);
		assert.deepEqual(readAccountsRecord(r.layout).entries, []);
		assert.deepEqual(readAccountsRecord(r.layout).left.map((e) => e.account), [""]);
		assert.equal(r.store.entries.length, 2, "both stay in the store");
		assert.equal(readFileSync(hosts, "utf8"), "ghe.example.org:\n    user: other\n", "the host left the app's own file, the other host stayed");
	});

	it("Sign out with a seeded foreign entry and nothing of the app's runs no logout and leaves it unchanged", async () => {
		const r = rig();
		r.store.write("gh:github.com", "someone");
		const before = JSON.stringify(r.store.entries);
		await r.accounts.signOut("github", "github.com");
		flow(r, "github.com", "left-alone");
		assert.equal(logouts(r).length, 0);
		assert.equal(JSON.stringify(r.store.entries), before);
	});

	it("a listing that fails before a logout stops it: no logout runs on a store nobody could read", async () => {
		const r = rig();
		await signedInGitlab(r);
		r.store.listError = "keychain did not answer";
		await r.accounts.signOut("gitlab", "gitlab.com");
		flow(r, "gitlab.com", "store-unavailable");
		assert.equal(logouts(r).length, 0);
		assert.equal(readAccountsRecord(r.layout).entries.length, 1);
	});

	it("a logout that fails, or leaves an entry behind, keeps what the store still holds in the record", async () => {
		const failing = rig({ logoutExit: 1 });
		await signedInGitlab(failing);
		await failing.accounts.signOut("gitlab", "gitlab.com");
		flow(failing, "gitlab.com", "failed");
		assert.equal(readAccountsRecord(failing.layout).entries.length, 1);
		const stuck = rig({ logoutKeepsEntries: true });
		await signedInGitlab(stuck);
		await stuck.accounts.signOut("gitlab", "gitlab.com");
		flow(stuck, "gitlab.com", "signed-out");
		assert.equal(readAccountsRecord(stuck.layout).entries.length, 1, "still owned, still recorded");
	});
});

describe("the rows of settings", () => {
	it("refresh reads the store: signed in, changed, found, none, and unknown when the listing fails", async () => {
		const r = rig();
		const forges = [{ kind: "gitlab" as const, host: "gitlab.com" }, { kind: "github" as const, host: "github.com" }];
		await r.accounts.refresh(forges);
		assert.deepEqual(r.accounts.views(forges).map((v) => v.state), ["not-signed-in", "not-signed-in"]);
		r.store.write("gh:github.com", "someone");
		await r.accounts.refresh(forges);
		assert.deepEqual(r.accounts.views(forges).map((v) => v.state), ["not-signed-in", "foreign"]);
		assert.deepEqual(r.accounts.views(forges)[1]?.entries, [{ name: "gh:github.com", account: "someone" }]);
		r.store.listError = "x";
		await r.accounts.refresh(forges);
		assert.deepEqual(r.accounts.views(forges).map((v) => v.state), ["unknown", "unknown"]);
	});

	it("a row follows the record before the store has been read", async () => {
		const r = rig();
		mkdirSync(r.layout.state, { recursive: true });
		writeFileSync(join(r.layout.state, "accounts.json"), JSON.stringify({ schema: 1, entries: [{ name: "glab:gitlab.com:token", account: "", host: "gitlab.com", kind: "gitlab", modified: "2026-11-04T01:00:02Z" }], left: [] }));
		assert.equal(r.accounts.views([{ kind: "gitlab", host: "gitlab.com" }])[0]?.state, "signed-in");
	});

	it("dispose ends a login that waits", async () => {
		const r = rig();
		await r.accounts.begin("github", "github.com");
		await r.accounts.startGithub("github.com");
		r.accounts.dispose();
		assert.equal(r.spawned[0]?.child.killed, true);
		assert.ok(r.timers.every((t) => t.cleared));
	});

	it("the state file is the only place the app writes, and holds no code and no token", async () => {
		const r = rig();
		await r.accounts.begin("gitlab", "gitlab.com");
		await r.accounts.signInGitlab("gitlab.com", TOKEN);
		const text = readFileSync(join(r.layout.state, "accounts.json"), "utf8");
		assert.ok(existsSync(join(r.layout.state, "accounts.json")));
		assert.ok(!text.includes(TOKEN));
	});
});

describe("how gh and glab are run", () => {
	it("the environment is the launcher's: the private folder, the switches, and none of the variables that replace a stored login", () => {
		const r = rig();
		const dirty = { GH_TOKEN: "a", GITHUB_TOKEN: "b", GITLAB_TOKEN: "c", GITLAB_HOST: "evil", GLAB_SKIP_TLS_VERIFY: "1", CI: "true", HTTPS_PROXY: "http://proxy.example:3128" };
		const gh = forgeEnv({ layout: r.layout, current: CURRENT, appEnv: dirty, kind: "github" });
		const glab = forgeEnv({ layout: r.layout, current: CURRENT, appEnv: dirty, kind: "gitlab" });
		for (const env of [gh, glab]) {
			for (const name of Object.keys(dirty).filter((k) => k !== "HTTPS_PROXY")) assert.equal(env[name], undefined, `${name} is removed`);
			assert.equal(env.HTTPS_PROXY, "http://proxy.example:3128", "a proxy the PM set stays");
			assert.equal(env.DO_NOT_TRACK, "1");
		}
		assert.equal(gh.GH_CONFIG_DIR, r.layout.ghConfig);
		assert.equal(gh.GH_TELEMETRY, "disabled");
		assert.equal(glab.GLAB_CONFIG_DIR, r.layout.glabConfig);
		assert.equal(glab.GLAB_NO_PROMPT, "1");
	});

	it("reads the device code and the line that says how a login ended", () => {
		assert.equal(parseDeviceCode("! First copy your one-time code: ABCD-1234\nPress Enter"), "ABCD-1234");
		assert.equal(parseDeviceCode("no code here, 12-34"), null);
		assert.match(loginLine("a\n✓ Logged in as someone\nb"), /Logged in/);
		assert.equal(loginLine(""), "");
	});
});
