// Fixture for the code-host sign-in against a real OS credential store (task 10, spec: Fixtures that change the machine): foreign entries seeded under host names that can never be anyone's real
// sign-in (`*.example.test`), a foreign write over an entry the app owns, and the removals, all through the guard. No gh or glab runs: the checks and the removal of a login read and
// compare the store alone, so the CLI stand-ins here throw if the code under test ever calls one.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ForgeAccounts } from "../../src/main/accounts/session.ts";
import { readAccountsRecord, writeAccountsRecord } from "../../src/main/accounts/existing.ts";
import type { StoreEntry } from "../../src/main/platform/types.ts";
import { scratchRoot, testLayout } from "./engine-fixture.ts";
import { defineFixture, type FixtureIO } from "./hosted.ts";
import { removeTree } from "../../src/main/bootstrap/fsutil.ts";
import { seederFor, storeFor } from "./store-fixtures.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const CURRENT = { node: "1", git: "1", herdr: "1", gh: "2.103.3", glab: "1.124.0" };

export const foreignEntries = defineFixture({
	name: "forge sign-in: a foreign entry stops the step, Sign out leaves it, and a foreign write over an owned entry makes it left (real store)",
	platforms: ["darwin", "win32"],
	scratch: "keychain",
	async body(io: FixtureIO): Promise<void> {
		const platform = process.platform;
		const nonce = randomBytes(5).toString("hex");
		const ghHost = `sbd-${nonce}.example.test`;
		const glHost = `sbd-gl-${nonce}.example.test`;
		const seeder = seederFor(platform, io);
		const store = storeFor(io, platform);
		const made = scratchRoot("sbd-forge-fx-");
		const layout = testLayout(made.root);
		const refused = (what: string) => async (): Promise<never> => {
			throw new Error(`${what} was called, and no CLI may run in this scenario`);
		};
		const log: Array<Record<string, unknown>> = [];
		const accounts = new ForgeAccounts({
			layout,
			credentials: store,
			run: refused("run"),
			spawn: refused("spawn") as never,
			appEnv: {},
			current: () => CURRENT,
			log: (f) => log.push(f as Record<string, unknown>),
			openExternal: () => undefined,
			writeClipboard: () => undefined,
		});
		const names = { gh: `gh:${ghHost}`, gl: `glab:${glHost}:token` };
		const snapshot = async (name: string, account: string) => ({ secret: await seeder.read(name, account), modified: (await store.list([name])).find((e) => e.account === account)?.modified ?? null });
		try {
			// 1. A foreign sign-in the app did not make stops each step before the code or the token field, and Sign out leaves it as it is.
			await seeder.write(names.gh, "someone", `dummy-secret-gh-${nonce}`);
			await seeder.write(names.gl, "", `dummy-secret-gl-${nonce}`);
			const before = { gh: await snapshot(names.gh, "someone"), gl: await snapshot(names.gl, "") };
			assert.equal(before.gh.secret, `dummy-secret-gh-${nonce}`, "the seeder can read back what it wrote");
			assert.match(before.gl.modified ?? "", /^\d{4}-\d\d-\d\dT/);

			await accounts.begin("github", ghHost);
			const gh = accounts.flowOf(ghHost);
			assert.equal(gh.phase, "foreign");
			assert.deepEqual(gh.phase === "foreign" ? gh.entries : [], [{ name: names.gh, account: "someone" }]);
			await accounts.begin("gitlab", glHost);
			assert.equal(accounts.flowOf(glHost).phase, "foreign");
			await accounts.act({ type: "forge-start", kind: "github", host: ghHost });
			await accounts.act({ type: "forge-token", host: glHost, token: "dummy-token-never-sent" });

			await accounts.signOut("github", ghHost);
			await accounts.signOut("gitlab", glHost);
			assert.equal(accounts.flowOf(ghHost).phase, "left-alone");
			assert.equal(accounts.flowOf(glHost).phase, "left-alone");
			assert.deepEqual(log.filter((l) => l.event === "forge-logout"), [], "no logout ran");
			assert.equal(log.filter((l) => l.event === "forge-logout-skipped").length, 2);
			assert.deepEqual({ gh: await snapshot(names.gh, "someone"), gl: await snapshot(names.gl, "") }, before, "both entries are as they were: the same secret and the same modification time");
			assert.deepEqual(readAccountsRecord(layout), { schema: 1, entries: [], left: [] });

			// 2. An entry the app made is owned while its time is the recorded one. A foreign write at least 2 s later changes the time, so the entry turns foreign, is kept as left, and a
			// Sign in again stops at the check. After the entry is deleted the check passes.
			await seeder.remove(names.gl, "");
			await seeder.write(names.gl, "", `app-secret-${nonce}`);
			const mine = (await store.list([names.gl]))[0] as StoreEntry;
			mkdirSync(layout.state, { recursive: true });
			writeAccountsRecord(layout, { schema: 1, entries: [{ name: names.gl, account: "", host: glHost, kind: "gitlab", modified: mine.modified }], left: [] });
			await accounts.begin("gitlab", glHost);
			assert.equal(accounts.flowOf(glHost).phase, "ready", "an entry whose time is the recorded one is the app's own");
			await sleep(2200);
			await seeder.write(names.gl, "", `pm-own-secret-${nonce}`);
			const rewritten = await snapshot(names.gl, "");
			assert.notEqual(rewritten.modified, mine.modified, "a write by someone else changes the time the store reports");
			await accounts.begin("gitlab", glHost);
			const changed = accounts.flowOf(glHost);
			assert.equal(changed.phase, "foreign");
			assert.deepEqual(changed.phase === "foreign" ? changed.changed : [], [{ name: names.gl, account: "" }]);
			assert.deepEqual(readAccountsRecord(layout).left.map((e) => e.name), [names.gl]);
			assert.equal(accounts.views([{ kind: "gitlab", host: glHost }])[0]?.state, "left");
			await accounts.signOut("gitlab", glHost);
			assert.equal(accounts.flowOf(glHost).phase, "left-alone");
			assert.deepEqual(await snapshot(names.gl, ""), rewritten, "Sign out left the entry with the PM's secret and its time");
			assert.deepEqual(log.filter((l) => l.event === "forge-logout"), []);
			await seeder.remove(names.gl, "");
			await accounts.begin("gitlab", glHost);
			assert.equal(accounts.flowOf(glHost).phase, "ready", "once the entry is gone, Sign in again passes the check");
			assert.deepEqual(readAccountsRecord(layout), { schema: 1, entries: [], left: [] });

			// 3. A mixed host (one entry the app owns, one foreign) runs no logout and marks the owned one left.
			await seeder.write(names.gh, "", `app-secret-${nonce}`);
			const owned = (await store.list([names.gh])).find((e) => e.account === "") as StoreEntry;
			writeAccountsRecord(layout, { schema: 1, entries: [{ name: names.gh, account: "", host: ghHost, kind: "github", modified: owned.modified }], left: [] });
			await accounts.signOut("github", ghHost);
			const out = accounts.flowOf(ghHost);
			assert.equal(out.phase, "left-alone");
			assert.deepEqual(out.phase === "left-alone" ? out.left : [], [{ name: names.gh, account: "" }]);
			assert.deepEqual(readAccountsRecord(layout).entries, []);
			assert.equal((await store.list([names.gh])).length, 2, "both entries stay in the store");
			assert.deepEqual(log.filter((l) => l.event === "forge-logout"), []);
		} finally {
			for (const [name, account] of [[names.gh, "someone"], [names.gh, ""], [names.gl, ""]] as const) await seeder.remove(name, account).catch(() => undefined);
			removeTree(made.base);
		}
	},
});
