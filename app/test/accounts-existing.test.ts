import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	classify,
	dropHost,
	entryNames,
	markHostLeft,
	parseAccountsRecord,
	readAccountsRecord,
	reconcile,
	recordLogin,
	stateOf,
	writeAccountsRecord,
	type AccountsRecord,
} from "../src/main/accounts/existing.ts";
import { listHostEntries, probeStore } from "../src/main/accounts/probe.ts";
import { FakeStore } from "./harness/fake-forge.ts";

// Existing sign-ins and Ownership (task 10, boss decision K1): an entry belongs to the app only while its name and account are in `state/accounts.json` and its time equals the recorded one.

const tmp = mkdtempSync(join(tmpdir(), "sbd-existing-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const T1 = "2026-11-04T01:00:02Z";
const T2 = "2026-11-04T01:00:04Z";
const glabName = "glab:gitlab.com:token";
const rec = (over: Partial<AccountsRecord> = {}): AccountsRecord => ({
	schema: 1,
	entries: [{ name: glabName, account: "", host: "gitlab.com", kind: "gitlab", modified: T1 }],
	left: [],
	...over,
});

describe("the names a host's sign-in uses in the store", () => {
	it("gh: the host's item and the refreshable one; glab: the token item and the legacy one", () => {
		assert.deepEqual(entryNames("github", "github.com"), ["gh:github.com", "gh:_refreshable:github.com"]);
		assert.deepEqual(entryNames("gitlab", "gitlab.example.org"), ["glab:gitlab.example.org:token", "glab:gitlab.example.org"]);
	});
});

describe("Ownership", () => {
	it("an entry whose name, account and time are recorded is owned", () => {
		const out = classify([{ name: glabName, account: "", modified: T1 }], rec());
		assert.deepEqual([out.owned.length, out.foreign.length, out.changed.length], [1, 0, 0]);
	});
	it("a recorded name with another time is foreign, and counts as changed (the app made it)", () => {
		const out = classify([{ name: glabName, account: "", modified: T2 }], rec());
		assert.deepEqual([out.owned.length, out.foreign.length, out.changed.length], [0, 1, 1]);
	});
	it("a recorded name whose time cannot be read is foreign; an empty time never matches, not even an empty recorded one", () => {
		assert.equal(classify([{ name: glabName, account: "", modified: "" }], rec()).foreign.length, 1);
		const emptyRecorded = rec({ entries: [{ name: glabName, account: "", host: "gitlab.com", kind: "gitlab", modified: "" }] });
		assert.equal(classify([{ name: glabName, account: "", modified: "" }], emptyRecorded).foreign.length, 1);
		// Such a line in the file is not even read back as a record.
		assert.deepEqual(parseAccountsRecord(JSON.stringify({ schema: 1, entries: [{ name: glabName, account: "", host: "gitlab.com", kind: "gitlab", modified: "" }], left: [] })).entries, []);
	});
	it("an unrecorded name is foreign, and not changed (another program made it)", () => {
		const out = classify([{ name: "gh:github.com", account: "someone", modified: T1 }], rec());
		assert.deepEqual([out.owned.length, out.foreign.length, out.changed.length], [0, 1, 0]);
	});
	it("a recorded name under another account is foreign", () => {
		assert.equal(classify([{ name: glabName, account: "someone", modified: T1 }], rec()).foreign.length, 1);
	});
	it("a `left` name whose time matches again is still foreign: a left entry never counts as owned again", () => {
		const left = { name: glabName, account: "", host: "gitlab.com", kind: "gitlab" as const };
		const out = classify([{ name: glabName, account: "", modified: T1 }], rec({ entries: [], left: [left] }));
		assert.deepEqual([out.owned.length, out.foreign.length, out.changed.length], [0, 1, 1]);
		// Even when the record lists the same entry under both (a hand-edited file), `left` wins.
		assert.equal(classify([{ name: glabName, account: "", modified: T1 }], rec({ left: [left] })).owned.length, 0);
	});
	it("a record that does not parse owns nothing", () => {
		assert.deepEqual(parseAccountsRecord("not json"), { schema: 1, entries: [], left: [] });
		assert.deepEqual(parseAccountsRecord(JSON.stringify({ schema: 2, entries: [{}] })), { schema: 1, entries: [], left: [] });
	});
});

describe("the record on disk", () => {
	it("is written under state/accounts.json and read back; a missing file is an empty record", () => {
		const layout = { state: join(tmp, "state") };
		assert.deepEqual(readAccountsRecord(layout), { schema: 1, entries: [], left: [] });
		writeAccountsRecord(layout, rec());
		assert.deepEqual(readAccountsRecord(layout), rec());
		assert.ok(existsSync(join(tmp, "state", "accounts.json")));
		assert.ok(!/token|secret/i.test(readFileSync(join(tmp, "state", "accounts.json"), "utf8").replace(glabName, "")), "no secret, and nothing named like one");
	});
	it("a file that is not a record owns nothing", () => {
		const layout = { state: join(tmp, "bad") };
		mkdirSync(layout.state, { recursive: true });
		writeFileSync(join(layout.state, "accounts.json"), "{ not json");
		assert.deepEqual(readAccountsRecord(layout), { schema: 1, entries: [], left: [] });
	});
});

describe("reconcile: what a listing does to the record", () => {
	it("an owned entry that turned foreign moves to `left`, by name and account, without a time", () => {
		const out = reconcile(rec(), [{ name: glabName, account: "", modified: T2 }], "gitlab", "gitlab.com");
		assert.deepEqual(out.record.entries, []);
		assert.deepEqual(out.record.left, [{ name: glabName, account: "", host: "gitlab.com", kind: "gitlab" }]);
		assert.equal(out.movedToLeft.length, 1);
		assert.equal(out.changed, true);
	});
	it("an entry the listing no longer finds leaves the record; so does a `left` one (the PM removed it)", () => {
		assert.deepEqual(reconcile(rec(), [], "gitlab", "gitlab.com").record, { schema: 1, entries: [], left: [] });
		const left = { name: glabName, account: "", host: "gitlab.com", kind: "gitlab" as const };
		assert.deepEqual(reconcile(rec({ entries: [], left: [left] }), [], "gitlab", "gitlab.com").record.left, []);
	});
	it("a `left` entry still there stays `left`, and an owned one stays owned: nothing changes", () => {
		assert.equal(reconcile(rec(), [{ name: glabName, account: "", modified: T1 }], "gitlab", "gitlab.com").changed, false);
		const left = { name: glabName, account: "", host: "gitlab.com", kind: "gitlab" as const };
		assert.equal(reconcile(rec({ entries: [], left: [left] }), [{ name: glabName, account: "", modified: T2 }], "gitlab", "gitlab.com").changed, false);
	});
	it("leaves the entries of other hosts and kinds alone", () => {
		const other = { name: "gh:github.com", account: "", host: "github.com", kind: "github" as const, modified: T1 };
		const out = reconcile({ ...rec(), entries: [...rec().entries, other] }, [], "gitlab", "gitlab.com");
		assert.deepEqual(out.record.entries, [other]);
	});
});

describe("recordLogin: what the app records right after its own login", () => {
	const gh = (account: string, modified = T1) => ({ name: "gh:github.com", account, modified });
	it("records each entry that was not there before, with the time just read", () => {
		const out = recordLogin({ schema: 1, entries: [], left: [] }, { kind: "github", host: "github.com", before: [], after: [gh(""), gh("someone")] });
		assert.deepEqual(out.entries.map((e) => [e.name, e.account, e.modified]), [["gh:github.com", "", T1], ["gh:github.com", "someone", T1]]);
	});
	it("a Sign in again records an entry it owned before, with its new time", () => {
		const before = { schema: 1 as const, entries: [{ name: "gh:github.com", account: "", host: "github.com", kind: "github" as const, modified: T1 }], left: [] };
		const out = recordLogin(before, { kind: "github", host: "github.com", before: [gh("", T1)], after: [gh("", T2)] });
		assert.deepEqual(out.entries.map((e) => e.modified), [T2]);
	});
	it("does not record an entry that was there before and was not the app's, nor one with no readable time", () => {
		const out = recordLogin({ schema: 1, entries: [], left: [] }, { kind: "github", host: "github.com", before: [gh("someone")], after: [gh("someone", T2), gh("")] });
		assert.deepEqual(out.entries.map((e) => e.account), [""]);
		const none = recordLogin({ schema: 1, entries: [], left: [] }, { kind: "github", host: "github.com", before: [], after: [gh("", "")] });
		assert.deepEqual(none.entries, []);
	});
	it("replaces the host's earlier entries and leaves other hosts alone", () => {
		const keep = { name: glabName, account: "", host: "gitlab.com", kind: "gitlab" as const, modified: T1 };
		const out = recordLogin({ schema: 1, entries: [keep], left: [] }, { kind: "github", host: "github.com", before: [], after: [gh("")] });
		assert.deepEqual(out.entries.map((e) => e.host).sort(), ["github.com", "gitlab.com"]);
	});
});

describe("dropping, marking left, and the state of a row", () => {
	it("dropHost removes the host's entries and `left` entries only", () => {
		const other = { name: "gh:github.com", account: "", host: "github.com", kind: "github" as const, modified: T1 };
		const out = dropHost({ ...rec(), entries: [...rec().entries, other], left: [{ name: glabName, account: "x", host: "gitlab.com", kind: "gitlab" }] }, "gitlab", "gitlab.com");
		assert.deepEqual(out, { schema: 1, entries: [other], left: [] });
	});
	it("markHostLeft moves every owned entry of the host to `left` with the time it has (T14-F001: that is how a later look tells beside from changed)", () => {
		const out = markHostLeft(rec(), "gitlab", "gitlab.com");
		assert.deepEqual(out.record.entries, []);
		assert.deepEqual(out.left, [{ name: glabName, account: "", host: "gitlab.com", kind: "gitlab", modified: T1 }]);
		assert.deepEqual(out.record.left, out.left);
		const listed = (modified: string) => [{ name: glabName, account: "", modified }];
		assert.deepEqual(classify(listed(T1), out.record).beside.map((e) => e.name), [glabName], "the same time: still intact, left beside");
		assert.deepEqual(classify(listed(T1), out.record).changed, []);
		assert.deepEqual(classify(listed(T2), out.record).beside, [], "another time: something wrote over it");
		assert.deepEqual(classify(listed(T2), out.record).changed.map((e) => e.name), [glabName]);
		// a `left` entry written without a time (the old record, or one that turned foreign) is never "beside"
		const old = { schema: 1 as const, entries: [], left: [{ name: glabName, account: "", host: "gitlab.com", kind: "gitlab" as const }] };
		assert.deepEqual(classify(listed(T1), old).beside, []);
		assert.equal(classify(listed(T1), old).changed.length, 1);
	});
	it("parses a `left` entry's time when it has one", () => {
		const raw = JSON.stringify({ schema: 1, entries: [], left: [{ name: glabName, account: "", host: "gitlab.com", kind: "gitlab", modified: T1 }, { name: "gh:github.com", account: "me", host: "github.com", kind: "github" }] });
		const parsed = parseAccountsRecord(raw);
		assert.equal(parsed.left[0]?.modified, T1);
		assert.equal("modified" in (parsed.left[1] ?? {}), false);
	});
	it("stateOf: left first, then the app's own sign-in, then a foreign one, else none", () => {
		const left = { name: glabName, account: "", host: "gitlab.com", kind: "gitlab" as const };
		assert.equal(stateOf(rec(), [{ name: glabName, account: "", modified: T1 }], "gitlab", "gitlab.com"), "signed-in");
		assert.equal(stateOf(rec({ entries: [], left: [left] }), [{ name: glabName, account: "", modified: T2 }], "gitlab", "gitlab.com"), "left");
		assert.equal(stateOf({ schema: 1, entries: [], left: [] }, [{ name: glabName, account: "", modified: T2 }], "gitlab", "gitlab.com"), "foreign");
		assert.equal(stateOf({ schema: 1, entries: [], left: [] }, [], "gitlab", "gitlab.com"), "not-signed-in");
	});
	it("stateOf (D1): an entry left intact beside a foreign one shows the foreign state, not `left` (whose note says something wrote over it); once written over it is `left` again", () => {
		const marked = markHostLeft(rec(), "gitlab", "gitlab.com").record;
		assert.equal(stateOf(marked, [{ name: glabName, account: "", modified: T1 }], "gitlab", "gitlab.com"), "foreign", "the same time: as the app left it");
		assert.equal(stateOf(marked, [{ name: glabName, account: "", modified: T2 }], "gitlab", "gitlab.com"), "left", "another time: changed");
	});
});

describe("the probe and the listing", () => {
	it("a failed probe, a throwing probe and a timed-out probe all say not available", async () => {
		const store = new FakeStore();
		store.probeResult = { ok: false, reason: "the keychain did not answer within 10 s (it may be locked and waiting for a password)" };
		const failed = await probeStore(store);
		assert.equal(failed.ok, false);
		assert.match(failed.ok ? "" : failed.detail, /did not answer within 10 s/);
		store.probe = async () => {
			throw new Error("spawn failed");
		};
		assert.deepEqual(await probeStore(store), { ok: false, detail: "spawn failed" });
	});
	it("a listing that fails is a failed listing, never an empty one", async () => {
		const store = new FakeStore();
		store.listError = "security dump-keychain exited 1";
		const out = await listHostEntries(store, "gitlab", "gitlab.com");
		assert.equal(out.ok, false);
		store.listError = null;
		assert.deepEqual(await listHostEntries(store, "gitlab", "gitlab.com"), { ok: true, entries: [] });
	});
	it("lists exactly the host's names", async () => {
		const store = new FakeStore();
		store.write(glabName);
		store.write("glab:other.example.org:token");
		const out = await listHostEntries(store, "gitlab", "gitlab.com");
		assert.deepEqual(out.ok && out.entries.map((e) => e.name), [glabName]);
	});
});
