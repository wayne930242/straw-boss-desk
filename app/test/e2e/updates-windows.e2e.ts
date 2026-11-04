// The task 13 anchor, Windows half (`updates.yml`, job `windows-installer`): the real NSIS installers of 0.0.1 and 0.0.2, built by the job, installed and updated through a local feed.
//   - 0.0.1 installs silently (`/S`) into a scratch folder, starts, and reaches the GUI on a root the test installed;
//   - a 0.0.2 installer with one byte changed, its `latest.yml` SHA512 regenerated, is refused by the Ed25519 check, deleted, and never offered;
//   - the signed 0.0.2 is downloaded and checked; **Restart to update** stops the stack, runs the installer silently, and starts 0.0.2, which reaches the GUI with the stack back;
//   - the signing is done by `scripts/sign-stack.mjs` with a key made for this run (passed as a JWK in the environment, never a file).
// The install writes the per-user uninstall entry and the app's own sign-in-free setup writes the user PATH entry: a guarded fixture, GitHub-hosted runners only.
//   SBD_E2E=1 SBD_UPDATE_INSTALLERS=<folder with straw-boss-desk-Setup-0.0.1.exe and -0.0.2.exe> node --test test/e2e/updates-windows.e2e.ts
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { createPlatform } from "../../src/main/platform/index.ts";
import { stackFiles } from "../../src/main/update/stack.ts";
import { childEnvOf, createWorld, disposeWorld, noteUserPath, realStack, run, runWorld, type World } from "../harness/e2e-light.ts";
import { assertElevatedRunner } from "../harness/elevation.ts";
import { hostedCase } from "../harness/hosted.ts";
import { appRoot, readAsarFile } from "../harness/packaged.ts";
import { buildIdentity } from "../../src/main/build.ts";
import { FeedServer, latestYml, makeTestKey } from "../fixtures/feed/feed-server.ts";

const enabled = process.env.SBD_E2E === "1";
const installers = process.env.SBD_UPDATE_INSTALLERS ?? "";
const hosted = hostedCase("the Windows install and update (task 13)");
const skip = !enabled
	? "installs a real program: runs on the CI runners only (SBD_E2E=1)"
	: process.platform !== "win32"
		? "Windows only: the NSIS installer"
		: installers === ""
			? "SBD_UPDATE_INSTALLERS names no folder of built installers"
			: hosted.run
				? false
				: hosted.reason;
const screenshotDir = process.env.SBD_SCREENSHOT_DIR ?? join(appRoot, "test-results", "screenshots");

if (enabled && process.platform === "win32" && !hosted.run && hosted.fail) {
	it("runs on a hosted runner", () => {
		assert.fail(`${hosted.reason} (SBD_REQUIRE_HOSTED_FIXTURES=1)`);
	});
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(what: string, ms: number, probe: () => T | Promise<T>, every = 500): Promise<NonNullable<T>> {
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

const productName = buildIdentity({}).productName;
const SETUP_1 = "straw-boss-desk-Setup-0.0.1.exe";
const SETUP_2 = "straw-boss-desk-Setup-0.0.2.exe";

describe("the Windows install and update, 0.0.1 to 0.0.2 (e2e, task 13)", { skip }, () => {
	let world: World;
	let feed: FeedServer;
	let app: ElectronApplication | undefined;
	const key = makeTestKey();
	const platform = createPlatform();
	let installDir = "";
	let exe = "";
	const RECIPE = { forges: [{ kind: "github", host: "github.com" }], tools: [] as string[], id: "ci-updates-win", name: "CI updates", version: "1.0.0", instructions: "- the CI rule" };

	const installedVersion = (): string => (JSON.parse(readAsarFile(join(installDir, "resources", "app.asar"), "package.json").toString("utf8")) as { version: string }).version;
	const env = (): Record<string, string> => {
		const base: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(PI_|HERDR_|ELECTRON_RUN_AS_NODE$|SBD_SIGNING)/.test(k)) base[k] = v;
		return { ...base, ...world.appEnv, STRAW_BOSS_DESK_ROOT: world.root, SBD_UPDATE_KEYS: JSON.stringify([key.publicKey]), SBD_UPDATE_FEED: feed.url };
	};
	const startRecord = () => JSON.parse(readFileSync(join(world.layout.state, "start.json"), "utf8")) as { herdr: { pid: number } | null; sb: { pid: number } | null };
	const herdrAnswers = async (): Promise<boolean> => (await run(childEnvOf(world).HERDR_BIN_PATH as string, ["workspace", "list"], { env: childEnvOf(world), timeoutMs: 15_000 })).code === 0;
	/** Signs `file` with `scripts/sign-stack.mjs` and the run's key (a JWK in the environment) and returns the signature text. */
	const signWithScript = (file: string): Buffer => {
		const out = join(world.base, "signed");
		const r = spawnSync(process.execPath, [join(appRoot, "..", "scripts", "sign-stack.mjs"), "--key-env", "SBD_TEST_SIGNING_KEY", "--out-dir", out, file], {
			env: { ...process.env, SBD_TEST_SIGNING_KEY: JSON.stringify(key.privateKey.export({ format: "jwk" })) },
			encoding: "utf8",
		});
		assert.equal(r.status, 0, r.stderr);
		return readFileSync(join(out, `${file.slice(Math.max(file.lastIndexOf("\\"), file.lastIndexOf("/")) + 1)}.sig`));
	};
	const findFiles = (dir: string, name: string, found: string[] = []): string[] => {
		if (!existsSync(dir)) return found;
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			let isDir = false;
			try {
				isDir = statSync(full).isDirectory();
			} catch {
				continue;
			}
			if (isDir) findFiles(full, name, found);
			else if (entry === name || entry.endsWith(`-${name}`)) found.push(full);
		}
		return found;
	};
	const guiUp = async (): Promise<boolean> => {
		const record = startRecord();
		return record.sb !== null && (await platform.processes.inspect([record.sb.pid]))[0]?.startTime !== null && (await herdrAnswers());
	};

	before(async () => {
		assertElevatedRunner();
		for (const name of [SETUP_1, SETUP_2]) assert.ok(existsSync(join(installers, name)), `${name} is in ${installers}`);
		world = createWorld("updwin");
		await noteUserPath(world);
		feed = await FeedServer.start();
		const installed = await runWorld(world, { profile: true, recipe: RECIPE });
		assert.ok(installed.ok, `the install failed: ${JSON.stringify(installed.error ?? Object.values(installed.outcomes).filter((o) => o.failure).map((o) => o.failure))}`);
		mkdirSync(world.layout.stack, { recursive: true });
		writeFileSync(stackFiles(world.layout).active, `${JSON.stringify(realStack, null, "\t")}\n`);
		installDir = join(world.base, "program");
		exe = join(installDir, `${productName}.exe`);
	});

	after(async () => {
		await app?.close().catch(() => undefined);
		// A running copy is stopped the way the uninstaller does it, by the second instance, then the program is uninstalled and the scratch folder deleted.
		if (existsSync(exe)) {
			await new Promise<void>((resolve) => {
				const child = spawn(exe, ["--stop-stack"], { env: env(), stdio: "ignore", windowsHide: true });
				const timer = setTimeout(() => {
					child.kill();
					resolve();
				}, 120_000);
				child.on("exit", () => {
					clearTimeout(timer);
					resolve();
				});
			});
			const uninstaller = join(installDir, `Uninstall ${productName}.exe`);
			if (existsSync(uninstaller)) spawnSync(uninstaller, ["/S", `_?=${installDir}`], { timeout: 120_000 });
		}
		await feed?.close().catch(() => undefined);
		const before = world.userPathBefore;
		const real = world.realUserPath;
		const userPath = world.userPath;
		await disposeWorld(world);
		if (real) assert.deepEqual(await userPath.read(), before ?? null, "the user PATH is as it was before the run");
	});

	it("installs 0.0.1 silently into a folder of the test's and starts it on the installed root", async () => {
		// `/D=` must be the last argument and is not quoted; the folder has no space on purpose, since NSIS reads the rest of the line.
		const r = spawnSync(join(installers, SETUP_1), ["/S", `/D=${installDir}`], { timeout: 300_000 });
		assert.equal(r.status, 0, `the installer exited ${r.status}: ${r.stderr?.toString()}`);
		await until("the installed program", 120_000, () => existsSync(exe));
		assert.equal(installedVersion(), "0.0.1");
		app = await electron.launch({ executablePath: exe, args: ["--lang=en-US"], env: env(), timeout: 90_000 });
		await until("the stack", 300_000, guiUp);
		assert.equal(await app.evaluate(({ app: electronApp }) => electronApp.getVersion()), "0.0.1");
	});

	let settings: Page;
	const stateOf = async (): Promise<string | null> => settings.locator('li.update-card[data-role="app"]').getAttribute("data-state");

	it("refuses a 0.0.2 installer with one byte changed and its latest.yml regenerated: deleted, never offered", async () => {
		const original = readFileSync(join(installers, SETUP_2));
		const tampered = Buffer.from(original);
		tampered[Math.floor(tampered.length / 2)] = (tampered[Math.floor(tampered.length / 2)] as number) ^ 0xff;
		feed.put(SETUP_2, tampered);
		feed.put("latest.yml", latestYml({ version: "0.0.2", file: SETUP_2, bytes: tampered }));
		// The signature is the original file's, made by the script and the run's key.
		feed.put(`${SETUP_2}.sig`, signWithScript(join(installers, SETUP_2)));
		await (app as ElectronApplication).evaluate(({ Menu }) => void Menu.getApplicationMenu()?.getMenuItemById("settings-updates")?.click());
		settings = await until("the settings page", 60_000, () => (app as ElectronApplication).windows().find((w) => w.url().endsWith("settings.html")), 250);
		await settings.waitForLoadState("domcontentloaded");
		await settings.locator('button.nav-item[data-section="updates"]').click();
		await settings.locator("#update-cards").waitFor({ timeout: 10_000 });
		await settings.locator("#update-check").click();
		await until("the app card to refuse the installer", 300_000, async () => (await stateOf()) === "refused");
		assert.equal(await settings.locator("#update-app-note").getAttribute("data-reason"), "bad-signature");
		assert.equal(await settings.locator("#update-restart").count(), 0, "never offered");
		assert.deepEqual(findFiles(world.home, SETUP_2).filter((f) => readFileSync(f).equals(tampered)), [], "the file that failed the check is deleted");
		await shot(settings, "updates-windows-installer-refused");
	});

	it("updates to 0.0.2: Restart to update stops the stack, the installer runs silently, and 0.0.2 starts with the stack back", async () => {
		const original = readFileSync(join(installers, SETUP_2));
		feed.put(SETUP_2, original);
		feed.put("latest.yml", latestYml({ version: "0.0.2", file: SETUP_2, bytes: original }));
		feed.put(`${SETUP_2}.sig`, signWithScript(join(installers, SETUP_2)));
		// 0.0.2 is the version that was refused for the first file: a new file for the same version is checked again only by a new start, so this case restarts the app first.
		await (app as ElectronApplication).close();
		app = await electron.launch({ executablePath: exe, args: ["--lang=en-US"], env: env(), timeout: 90_000 });
		await until("the stack", 300_000, guiUp);
		const before = startRecord();
		await (app as ElectronApplication).evaluate(({ Menu }) => void Menu.getApplicationMenu()?.getMenuItemById("settings-updates")?.click());
		settings = await until("the settings page", 60_000, () => (app as ElectronApplication).windows().find((w) => w.url().endsWith("settings.html")), 250);
		await settings.waitForLoadState("domcontentloaded");
		await settings.locator('button.nav-item[data-section="updates"]').click();
		await settings.locator("#update-cards").waitFor({ timeout: 10_000 });
		await settings.locator("#update-check").click();
		await until("the app card to be ready", 300_000, async () => (await stateOf()) === "ready");
		await shot(settings, "updates-windows-installer-ready");
		await settings.locator("#update-restart").click();
		// The old program quits; the installer replaces the files; 0.0.2 starts by itself (`--force-run`).
		await until("0.0.2 installed", 300_000, () => installedVersion() === "0.0.2");
		await until("the new program to run from the install folder", 300_000, async () => (await platform.processes.listUnder(installDir)).length > 0);
		await until("the stack back under 0.0.2", 300_000, async () => (await guiUp()) && startRecord().sb?.pid !== before.sb?.pid);
		assert.equal(existsSync(world.layout.state), true, "the data root is kept");
		const log = readFileSync(join(world.layout.logs, "start.jsonl"), "utf8");
		assert.match(log, /"event":"update-stop"/);
	});
});
