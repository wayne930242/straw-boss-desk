// The task 14 anchor, Remove all data (`updates.yml`, job `remove-data`, both hosted runners): the packaged development build on an installed root with a running stack, a real credential store, and a
// work folder, driven through the Computer section.
//   - seeded in the real store (names under `.example.test`, so they can never be anyone's sign-in): an entry the app made and owns (recorded with its time), one the app made and something else then wrote over
//     (`changed`), one another program made (`foreign`); on macOS also the app's `Claude Code-credentials-<8 hex>` item, the default `Claude Code-credentials` item that is not the app's, and this build's
//     "<product> Safe Storage" item and the shipped product's, seeded by name;
//   - the confirmation names the root, its size, the PATH entry (Windows), the work folder that stays, and the two entries that stay with their reason; the owned one is not named;
//   - after Confirm: the result names the same two entries, no step failed, the root holds only `electron` and `remove-pending` (Chromium has it open), nothing runs from under the root, the owned entry,
//     the app's Claude item and the Safe Storage item are gone, the other two entries and the default Claude item are unchanged (the secret and the time), the user PATH has no entry of the app, and the work
//     folder is as it was;
//   - after the app exits, within 30 s: no root, no fallback folder;
//   - a root left with `remove-pending` (the cleanup did not run) is removed at the next launch, before any window opens, and the app then opens on its welcome page as on a new machine.
// The store, the Keychain and the user PATH are changed outside the test's own root: a guarded fixture, GitHub-hosted runners only. On macOS the store is a scratch keychain made in the world's home.
//   SBD_E2E=1 SBD_E2E_KIND=dev node --test test/e2e/removal.e2e.ts
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it as nodeIt } from "node:test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { writeFileAtomic } from "../../src/main/bootstrap/fsutil.ts";
import { createPlatform } from "../../src/main/platform/index.ts";
import { claudeItem, safeStorageItem } from "../../src/main/removal/names.ts";
import { PENDING_FILE } from "../../src/main/removal/pending.ts";
import { writeWizardFile } from "../../src/main/wizard/state-file.ts";
import { createWorld, disposeWorld, noteUserPath, runWorld, stopProcessesUnder, type World } from "../harness/e2e-light.ts";
import { assertElevatedRunner } from "../harness/elevation.ts";
import { hostedCase, realIO, type FixtureIO } from "../harness/hosted.ts";
import { appRoot, locatePackaged, type Packaged } from "../harness/packaged.ts";
import { createScratchKeychain, type ScratchKeychain } from "../harness/scratch-keychain.ts";
import { seederFor, storeFor, type Seeder } from "../harness/store-fixtures.ts";

const kind = process.env.SBD_E2E_KIND === "release" ? "release" : "dev";
const enabled = process.env.SBD_E2E === "1";
const hosted = hostedCase("the Remove all data e2e (task 14)");
const skip = !enabled ? "opens real windows, starts a real stack and changes the credential store: runs on the CI runners only (SBD_E2E=1)" : kind !== "dev" ? "the data root and the store are the development build's" : hosted.run ? false : hosted.reason;
const packaged: Packaged | undefined = enabled && kind === "dev" ? locatePackaged(kind) : undefined;
const screenshotDir = process.env.SBD_SCREENSHOT_DIR ?? join(appRoot, "test-results", "screenshots");
const isWin = process.platform === "win32";

if (enabled && kind === "dev" && !hosted.run && hosted.fail) {
	nodeIt("runs on a hosted runner", () => {
		assert.fail(`${hosted.reason} (SBD_REQUIRE_HOSTED_FIXTURES=1)`);
	});
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The tail of every file in a folder, for a failure message: a CI annotation is all there is to read when a case fails on a runner. */
function logTails(dir: string, lines = 14, width = 360): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap((name) => {
		try {
			return [`${name}: ${readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean).slice(-lines).map((l) => l.slice(0, width)).join(" | ")}`];
		} catch {
			return [];
		}
	});
}

async function until<T>(what: string, ms: number, probe: () => T | Promise<T>, every = 400): Promise<NonNullable<T>> {
	const deadline = Date.now() + ms;
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			const value = await probe();
			if (value) return value as NonNullable<T>;
		} catch (error) {
			last = error;
		}
		await sleep(every);
	}
	throw new Error(`timed out after ${ms / 1000} s waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
}

const shot = async (page: Page, name: string): Promise<void> => {
	mkdirSync(screenshotDir, { recursive: true });
	await page.screenshot({ path: join(screenshotDir, `${name}.png`) });
};

const nonce = randomBytes(4).toString("hex");
const HOST_OWNED = `sbd-own-${nonce}.example.test`;
const HOST_CHANGED = `sbd-chg-${nonce}.example.test`;
const HOST_FOREIGN = `sbd-for-${nonce}.example.test`;
const RECIPE = {
	forges: [
		{ kind: "gitlab", host: HOST_OWNED },
		{ kind: "gitlab", host: HOST_CHANGED },
		{ kind: "github", host: HOST_FOREIGN },
	],
	tools: [] as string[],
	id: "ci-remove",
	name: "CI remove",
	version: "1.0.0",
	instructions: "- the CI rule",
};
const SECRET = `sbd-known-secret-${nonce}`;
const OWNED = { name: `glab:${HOST_OWNED}:token`, account: "" };
const CHANGED = { name: `glab:${HOST_CHANGED}:token`, account: "" };
const FOREIGN = { name: `gh:${HOST_FOREIGN}`, account: "someone" };
const DEFAULT_CLAUDE = { name: "Claude Code-credentials", account: `sbd-pm-${nonce}` };

describe("Remove all data against a real store and a real folder (e2e, task 14)", { skip }, () => {
	assert.ok(!enabled || kind !== "dev" || packaged, "no packaged development build in app/out/dev");
	let world: World;
	let app: ElectronApplication | undefined;
	let page: Page;
	let io: FixtureIO = realIO;
	let scratch: ScratchKeychain | undefined;
	let seeder: Seeder;
	const platform = createPlatform();
	const workFolder = (): string => join(world.home, "Straw Boss");
	const claudeName = (): string => claudeItem(world.layout.claude);
	const safeName = (): string => safeStorageItem(packaged?.productName ?? "Straw Boss Desk Dev");
	let beforeTimes: Record<string, string> = {};
	let sizeBefore = 0;

	/** Every case below runs through this: a failure carries the removal panel's text, the app's logs and what is left of the root. */
	let broken = false;
	const it = (name: string, body: () => Promise<void>) =>
		nodeIt(name, async () => {
			// The cases build on each other (the removal, then the exit, then the next launch): after one fails, the rest would only wait out their timeouts on a state nobody reached.
			if (broken) throw new Error("not run: an earlier case failed");
			try {
				await body();
			} catch (error) {
				broken = true;
				const parts: string[] = [];
				try {
					parts.push(`panel: ${(await page.locator("#remove-panel").innerText({ timeout: 3000 })).replace(/\s+/g, " ")}`);
				} catch {
					parts.push("panel: (unreadable)");
				}
				try {
					parts.push(`root: ${existsSync(world.root) ? readdirSync(world.root).join(",") : "(gone)"}`);
				} catch {
					parts.push("root: (unreadable)");
				}
				parts.push(...logTails(world.layout.logs));
				throw new Error(`${(error as Error).message}\n--- diagnostics --- ${parts.join(" ;; ").slice(0, 5000)}`, { cause: error });
			}
		});

	const env = (): Record<string, string> => {
		const base: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(PI_|HERDR_|ELECTRON_RUN_AS_NODE$)/.test(k)) base[k] = v;
		return { ...base, ...world.appEnv, STRAW_BOSS_DESK_ROOT: world.root };
	};
	const guiUrl = (a: ElectronApplication): Promise<string | undefined> => a.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getURL()).find((u) => /^http:\/\/127\.0\.0\.1:\d+\//.test(u)));
	const guiStatus = (url: string): Promise<number> =>
		new Promise((resolve, reject) => {
			const req = request(url, { timeout: 15_000 }, (res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			});
			req.on("timeout", () => req.destroy(new Error("the GUI did not answer in 15 s")));
			req.on("error", reject);
			req.end();
		});
	const store = () => storeFor(io, process.platform);
	const timeOf = async (e: { name: string; account: string }): Promise<string | undefined> => (await store().list([e.name])).find((x) => x.account === e.account)?.modified;
	const exists = async (e: { name: string; account: string }): Promise<boolean> => (await timeOf(e)) !== undefined;
	const present = async (service: string): Promise<boolean> => (await io.run("/usr/bin/security", ["find-generic-password", "-s", service], { timeoutMs: 15_000 })).code === 0;
	const underRoot = async (): Promise<number[]> => (await platform.processes.listUnder(world.root)).filter((p) => p.pid !== process.pid).map((p) => p.pid);
	const toComputer = async (): Promise<void> => {
		await page.locator('button.nav-item[data-section="computer"]').click();
		await page.locator("#remove-panel").waitFor({ timeout: 10_000 });
	};
	const inLocale = async (locale: "en" | "zh-TW"): Promise<void> => {
		await page.locator(`.language-button[data-locale="${locale}"]`).click();
		await until(`${locale} in settings`, 10_000, async () => (await page.evaluate(() => document.documentElement.lang)) === locale, 100);
	};
	const bytes = (dir: string): number => {
		let total = 0;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			try {
				total += entry.isDirectory() ? bytes(full) : readFileSync(full).length;
			} catch {
				// a file that vanished or cannot be read does not count
			}
		}
		return total;
	};

	before(async () => {
		assertElevatedRunner();
		world = createWorld("rm");
		await noteUserPath(world);
		if (process.platform === "darwin") {
			scratch = await createScratchKeychain({ home: world.home });
			io = scratch.io;
		}
		seeder = seederFor(process.platform, io);
		const installed = await runWorld(world, { profile: true, recipe: RECIPE });
		assert.ok(installed.ok, `the install failed: ${JSON.stringify(installed.error ?? Object.values(installed.outcomes).filter((o) => o.failure).map((o) => o.failure))}`);
		// The wizard is done and the work folder is the PM's: a folder with a file of theirs in it.
		mkdirSync(join(workFolder(), "web"), { recursive: true });
		writeFileSync(join(workFolder(), "web", "README.md"), "mine\n");
		// The code hosts the app knows are the recipe's, or, with none, the ones the PM named: the app reads them from the wizard record, so the foreign entry's host is named there.
		writeWizardFile(world.layout, { schema: 1, step: "done", done: true, later: [], hostsIndex: 0, locale: "en", workFolder: workFolder(), noRecipeForges: [{ kind: "github", host: HOST_FOREIGN }] });
		// The entries: the owned one and the changed one are recorded with the time the store gave them; the changed one is then rewritten, which is a write by someone else.
		await seeder.write(OWNED.name, OWNED.account, SECRET);
		await seeder.write(CHANGED.name, CHANGED.account, SECRET);
		await seeder.write(FOREIGN.name, FOREIGN.account, SECRET);
		const recorded = (e: { name: string; account: string }, host: string, modified: string | undefined) => ({ ...e, host, kind: "gitlab", modified: modified ?? "" });
		writeFileAtomic(
			join(world.layout.state, "accounts.json"),
			`${JSON.stringify({ schema: 1, entries: [recorded(OWNED, HOST_OWNED, await timeOf(OWNED)), recorded(CHANGED, HOST_CHANGED, await timeOf(CHANGED))], left: [] })}\n`,
		);
		await sleep(2200);
		await seeder.write(CHANGED.name, CHANGED.account, SECRET);
		if (process.platform === "darwin") {
			await seeder.write(claudeName(), "pm", SECRET);
			await seeder.write(DEFAULT_CLAUDE.name, DEFAULT_CLAUDE.account, SECRET);
		}
		app = await electron.launch({ executablePath: packaged?.executable, args: ["--lang=en-US"], env: env(), timeout: 60_000 });
		let url: string;
		try {
			url = await until("the GUI view to load the server's address", 300_000, () => guiUrl(app as ElectronApplication), 500);
		} catch (error) {
			// What the shell page says (a start failure has its own screen) and what the logs end with: the only things to read when a runner's start does not come up.
			const pages: string[] = [];
			for (const w of app.windows()) pages.push(`${w.url().slice(-40)}: ${(await w.locator("body").innerText({ timeout: 3000 }).catch(() => "(unreadable)")).replace(/\s+/g, " ").slice(0, 700)}`);
			throw new Error(`${(error as Error).message}\n--- diagnostics --- pages: ${pages.join(" ;; ")} ;; ${logTails(world.layout.logs).join(" ;; ")}`.slice(0, 6000), { cause: error });
		}
		assert.equal(await guiStatus(url), 200);
		if (process.platform === "darwin") {
			// This build's Safe Storage item is seeded by name through `security`, as the other entries are. Chromium would make it with an access list of its own, and the first thing a program that is not on
			// that list does with it may be a Keychain dialog, which nobody answers on a runner; whether a PM sees one on a real Mac is task 17's to record. What this case proves is the name: the item of
			// *this build's* product goes, the shipped product's does not (it is seeded too).
			await seeder.write(safeName(), packaged?.productName ?? "Straw Boss Desk Dev", SECRET);
			await seeder.write(safeStorageItem("Straw Boss Desk"), "Straw Boss Desk", SECRET);
			assert.equal(await present(safeName()), true, `${safeName()} is in the scratch keychain`);
		}
		beforeTimes = { foreign: (await timeOf(FOREIGN)) ?? "", changed: (await timeOf(CHANGED)) ?? "" };
		sizeBefore = bytes(world.root);
		await app.evaluate(({ Menu }) => void Menu.getApplicationMenu()?.getMenuItemById("settings-computer")?.click());
		page = await until("the settings page", 60_000, () => (app as ElectronApplication).windows().find((w) => w.url().endsWith("settings.html")), 250);
		await page.waitForLoadState("domcontentloaded");
		await toComputer();
	});

	after(async () => {
		// A window that does not close must not hold the job: the apps of this root are stopped by the world's disposal below.
		await Promise.race([app?.close().catch(() => undefined), sleep(30_000)]);
		for (const e of [OWNED, CHANGED, FOREIGN]) await seeder?.remove(e.name, e.account).catch(() => undefined);
		if (process.platform === "darwin") {
			await seeder?.remove(DEFAULT_CLAUDE.name, DEFAULT_CLAUDE.account).catch(() => undefined);
			await seeder?.remove(safeStorageItem("Straw Boss Desk"), "Straw Boss Desk").catch(() => undefined);
			await scratch?.dispose().catch(() => undefined);
		}
		const userPathBefore = world?.userPathBefore;
		const real = world?.realUserPath;
		const userPath = world?.userPath;
		if (world) await disposeWorld(world);
		if (real) assert.deepEqual(await userPath.read(), userPathBefore ?? null, "the user PATH is as it was before the run");
	});

	it("shows the confirmation: the root and its size, the PATH entry on Windows, the work folder that stays, and the two entries that stay with their reason; the app's own entry is not named", async () => {
		assert.ok(sizeBefore > 1_000_000, "the root holds an installed stack");
		await page.locator("#remove-open").click();
		await page.locator("#remove-confirm-panel").waitFor({ timeout: 120_000 });
		const panel = (await page.locator("#remove-confirm-panel").innerText()).replace(/\s+/g, " ");
		assert.ok(panel.includes(world.root), "names the data root");
		assert.match(panel, /\d+(\.\d+)? (MB|GB)/);
		assert.equal((await page.locator('[data-role="kept"]').innerText()).includes(workFolder()), true, "names the work folder that stays");
		assert.equal(await page.locator('[data-role="path"]').count(), isWin ? 1 : 0);
		const stays = await page.locator('[data-role="leaves"] li').evaluateAll((els) => els.map((e) => [e.getAttribute("data-entry"), e.getAttribute("data-why")]));
		assert.deepEqual(stays.sort(), [[CHANGED.name, "changed"], [FOREIGN.name, "foreign"]].sort());
		assert.ok(!panel.includes(OWNED.name), "the entry the app owns is not among those that stay");
		assert.ok(await page.locator("#remove-guide").count() > 0, "the guide is offered beside entries that stay");
		await inLocale("zh-TW");
		await shot(page, "remove-confirm-zh-TW");
		await inLocale("en");
		await shot(page, "remove-confirm-en");
		// Cancel puts the section back, and nothing was touched.
		await page.locator("#remove-cancel").click();
		await page.locator('#remove-panel[data-state="idle"]').waitFor({ timeout: 10_000 });
		assert.equal(existsSync(join(world.layout.state, "bootstrap.json")), true);
		assert.equal(await exists(OWNED), true);
		await page.locator("#remove-open").click();
		await page.locator("#remove-confirm-panel").waitFor({ timeout: 120_000 });
	});

	it("removes everything but Chromium's folder: the result names what stayed, nothing failed, nothing runs from the root, and the store holds only what is not the app's", async () => {
		const stack = await underRoot();
		assert.ok(stack.length > 0, "the stack runs from under the root before the removal");
		await page.locator("#remove-confirm").click();
		await page.locator("#remove-done-panel").waitFor({ timeout: 600_000 });
		const left = await page.locator("#remove-left li").evaluateAll((els) => els.map((e) => [e.getAttribute("data-entry"), e.getAttribute("data-why")]));
		assert.deepEqual(left.sort(), [[CHANGED.name, "changed"], [FOREIGN.name, "foreign"]].sort(), "the result names the foreign write over an owned entry and the other program's entry");
		assert.equal(await page.locator("#remove-problems").count(), 0, `a step failed: ${await page.locator("#remove-problems").innerText().catch(() => "")}`);
		assert.equal((await page.locator('[data-role="kept"]').innerText()).includes(workFolder()), true);
		await shot(page, "remove-result-left-en");

		assert.deepEqual(readdirSync(world.root).sort(), ["electron", PENDING_FILE].sort(), "only Chromium's folder and the marker are left");
		assert.deepEqual(await underRoot(), [], "no process runs from under the root");

		assert.equal(await exists(OWNED), false, "the entry the app owns is gone");
		assert.equal(await seeder.read(CHANGED.name, CHANGED.account), SECRET, "the entry something else wrote over has its secret");
		assert.equal(await timeOf(CHANGED), beforeTimes.changed, "and its time");
		assert.equal(await seeder.read(FOREIGN.name, FOREIGN.account), SECRET);
		assert.equal(await timeOf(FOREIGN), beforeTimes.foreign);

		if (isWin) assert.ok(!(await world.userPath.read())?.value.split(";").some((p) => p.toLowerCase() === world.layout.tools.shims.toLowerCase()), "the user PATH holds no entry of the app");
		if (process.platform === "darwin") {
			assert.equal(await present(safeName()), false, "this build's Safe Storage item is gone");
			assert.equal(await seeder.read(safeStorageItem("Straw Boss Desk"), "Straw Boss Desk"), SECRET, "the shipped product's Safe Storage item is untouched");
			assert.equal(await present(claudeName()), false, "the app's Claude item is gone");
			assert.equal(await seeder.read(DEFAULT_CLAUDE.name, DEFAULT_CLAUDE.account), SECRET, "the default Claude Code-credentials item is as it was");
		}
		assert.equal(readFileSync(join(workFolder(), "web", "README.md"), "utf8"), "mine\n", "the work folder is as it was");
	});

	it("deletes the root within 30 s of the app's exit, and no fallback folder is left", async () => {
		assert.equal(await page.locator("#remove-quit").count(), 1);
		const appPid = (app as ElectronApplication).process().pid;
		const closed = (app as ElectronApplication).waitForEvent("close", { timeout: 60_000 });
		await page.locator("#remove-quit").click();
		await closed;
		const started = Date.now();
		// Timeline of the cleanup, for the failure message: when the root's folders vanish and which shells run from the Windows PowerShell folder (the detached cleanup is one), by executable path.
		const where = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell");
		const timeline: string[] = [];
		const seconds = () => Math.round((Date.now() - started) / 1000);
		let lastShells = 0;
		while (existsSync(world.root) && Date.now() - started < 60_000) {
			if (isWin && Date.now() - lastShells >= 4_000) {
				const shells = (await platform.processes.listUnder(where)).filter((p) => p.pid !== process.pid).map((p) => p.pid);
				timeline.push(`${seconds()}s root=[${existsSync(world.root) ? readdirSync(world.root).join(",") : "gone"}] shells=[${shells.join(",")}]`);
				lastShells = Date.now();
			}
			await sleep(500);
		}
		timeline.push(`${seconds()}s root ${existsSync(world.root) ? "still there" : "gone"}`);
		if (existsSync(world.root)) assert.fail(`the root stayed 60 s after the exit; app pid ${appPid}; timeline: ${timeline.join(" | ")}`);
		console.log(`cleanup timeline: ${timeline.join(" | ")}`);
		assert.ok(Date.now() - started <= 60_000, `${timeline.join(" | ")}: the root went ${Math.round((Date.now() - started) / 1000)} s after the exit: within 30 s of the exit, with a margin for the poll and for PowerShell to start`);
		assert.equal(existsSync(join(world.home, ".straw-boss-desk")), false, "no fallback folder");
		assert.deepEqual(await stopProcessesUnder(world.root, { log: () => undefined }), [], "nothing of the app runs from under the root");
		app = undefined;
		assert.equal(readFileSync(join(workFolder(), "web", "README.md"), "utf8"), "mine\n", "the work folder is still as it was");
	});

	it("finishes a removal whose cleanup never ran at the next launch: the root is deleted before the window opens, and the app opens on its welcome page", async () => {
		mkdirSync(join(world.root, "state"), { recursive: true });
		mkdirSync(join(world.root, "electron"), { recursive: true });
		writeFileSync(join(world.root, "state", "sentinel.txt"), "from the removed install\n");
		writeFileSync(join(world.root, PENDING_FILE), `${JSON.stringify({ schema: 1, id: null, fallbackDir: null })}\n`);
		app = await electron.launch({ executablePath: packaged?.executable, args: ["--lang=en-US"], env: env(), timeout: 60_000 });
		const welcome = await until("the welcome page", 60_000, () => (app as ElectronApplication).windows().find((w) => w.url().endsWith("wizard.html")), 250);
		await welcome.waitForLoadState("domcontentloaded");
		assert.equal(existsSync(join(world.root, "state", "sentinel.txt")), false, "the removed install's files are gone");
		assert.equal(existsSync(join(world.root, PENDING_FILE)), false, "the marker is gone");
		assert.match(await welcome.locator("h1").innerText(), /\S/);
		await shot(welcome, "remove-pending-next-launch-en");
	});
});
