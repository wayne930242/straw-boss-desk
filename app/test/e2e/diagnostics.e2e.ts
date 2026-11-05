// The task 14 anchor, Diagnostics (`updates.yml`, job `diagnostics`, both hosted runners): the packaged development build on an installed root with a running stack.
//   - Check status reads `cli.mjs status` through the installed Node and shows the state, the version and whether the desk started it, never the page's address or token;
//   - Collect diagnostics writes a zip that holds no file from the excluded folders (`agent/`, `claude/`, `config/`, `secrets/`, Chromium's `electron/`, `start.json`) and no planted token: files with known
//     markers and credential-shaped text are planted in every one of those folders and in `logs/`, and the zip is read back entry by entry;
//   - Repair, after a pi package is deleted and (Windows) the user PATH entry is removed, installs the package again, puts the entry back, and the stack runs: the GUI answers.
// Every state is shot in zh-TW and English. The user PATH on Windows is the real one: a guarded fixture, GitHub-hosted runners only.
//   SBD_E2E=1 SBD_E2E_KIND=dev node --test test/e2e/diagnostics.e2e.ts
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it as nodeIt } from "node:test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { agentPackageDir } from "../../src/main/bootstrap/pi-cli.ts";
import { writeWizardFile } from "../../src/main/wizard/state-file.ts";
import { createWorld, disposeWorld, noteUserPath, runWorld, type World } from "../harness/e2e-light.ts";
import { assertElevatedRunner } from "../harness/elevation.ts";
import { hostedCase } from "../harness/hosted.ts";
import { appRoot, locatePackaged, type Packaged } from "../harness/packaged.ts";
import { readZip } from "../harness/unzip.ts";

const kind = process.env.SBD_E2E_KIND === "release" ? "release" : "dev";
const enabled = process.env.SBD_E2E === "1";
const hosted = hostedCase("the Diagnostics e2e (task 14)");
const skip = !enabled ? "opens real windows and starts a real stack: runs on the CI runners only (SBD_E2E=1)" : kind !== "dev" ? "the data root is the development build's" : hosted.run ? false : hosted.reason;
const packaged: Packaged | undefined = enabled && kind === "dev" ? locatePackaged(kind) : undefined;
const screenshotDir = process.env.SBD_SCREENSHOT_DIR ?? join(appRoot, "test-results", "screenshots");

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

const isWin = process.platform === "win32";
const nonce = randomBytes(4).toString("hex");
const RECIPE = { forges: [{ kind: "github", host: "github.com" }], tools: [] as string[], id: "ci-diagnostics", name: "CI diagnostics", version: "1.0.0", instructions: "- the CI rule" };
const PACKAGE = "pi-lens";
/** Credential-shaped text the redactor must mask, in the forms the app's own tokens take. */
const TOKENS = [`ghp_${"a1B2c3D4e5".repeat(4)}`, `glpat-${"Zy9Xw8Vu7T".repeat(2)}`, `sk-ant-api03-${"Qq1Ww2Ee3R".repeat(4)}`];
const MARKER = `SBD-EXCLUDED-${nonce}`;

describe("Diagnostics against an installed root (e2e, task 14)", { skip }, () => {
	assert.ok(!enabled || kind !== "dev" || packaged, "no packaged development build in app/out/dev");
	let world: World;
	let app: ElectronApplication;
	let page: Page;

	/** Every case below runs through this: a failure carries the cards' text, the app's logs and the state records. */
	const it = (name: string, body: () => Promise<void>) =>
		nodeIt(name, async () => {
			try {
				await body();
			} catch (error) {
				const parts: string[] = [];
				try {
					parts.push(`cards: ${(await page.locator("#diag-cards").innerText({ timeout: 3000 })).replace(/\s+/g, " ")}`);
				} catch {
					parts.push("cards: (unreadable)");
				}
				parts.push(...logTails(world.layout.logs));
				(error as Error).message = `${(error as Error).message}\n--- diagnostics --- ${parts.join(" ;; ").slice(0, 5000)}`;
				throw error;
			}
		});

	const env = (): Record<string, string> => {
		const base: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(PI_|HERDR_|ELECTRON_RUN_AS_NODE$)/.test(k)) base[k] = v;
		return { ...base, ...world.appEnv, STRAW_BOSS_DESK_ROOT: world.root };
	};
	const guiUrl = (): Promise<string | undefined> => app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getURL()).find((u) => /^http:\/\/127\.0\.0\.1:\d+\//.test(u)));
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
	const pathHasEntry = async (): Promise<boolean> => ((await world.userPath.read())?.value ?? "").split(";").some((p) => p.toLowerCase() === world.layout.tools.shims.toLowerCase());
	const toDiagnostics = async (): Promise<void> => {
		await page.locator('button.nav-item[data-section="diagnostics"]').click();
		await page.locator("#diag-cards").waitFor({ timeout: 10_000 });
	};
	/** Settings in one language: the language buttons live in Computer, so the page goes there and back. */
	const diagnosticsIn = async (locale: "en" | "zh-TW"): Promise<void> => {
		await page.locator('button.nav-item[data-section="computer"]').click();
		await page.locator(`.language-button[data-locale="${locale}"]`).click();
		await until(`${locale} in settings`, 10_000, async () => (await page.evaluate(() => document.documentElement.lang)) === locale, 100);
		await toDiagnostics();
	};
	const shotBoth = async (name: string): Promise<void> => {
		await diagnosticsIn("zh-TW");
		await shot(page, `diagnostics-${name}-zh-TW`);
		await diagnosticsIn("en");
		await shot(page, `diagnostics-${name}-en`);
	};
	const plant = (relative: string, text: string): void => {
		const file = join(world.root, ...relative.split("/"));
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, text);
	};

	before(async () => {
		assertElevatedRunner();
		world = createWorld("diag");
		await noteUserPath(world);
		const installed = await runWorld(world, { profile: true, recipe: RECIPE });
		assert.ok(installed.ok, `the install failed: ${JSON.stringify(installed.error ?? Object.values(installed.outcomes).filter((o) => o.failure).map((o) => o.failure))}`);
		writeWizardFile(world.layout, { schema: 1, step: "done", done: true, later: [], hostsIndex: 0, locale: "en" });
		app = await electron.launch({ executablePath: packaged?.executable, args: ["--lang=en-US"], env: env(), timeout: 60_000 });
		const url = await until("the GUI view to load the server's address", 300_000, guiUrl, 500);
		assert.equal(await guiStatus(url), 200);
		// A zip is shown in its folder: the reveal must not open a window on the runner, and the test learns the zip's name from the call.
		await app.evaluate(({ shell }) => {
			(globalThis as { __revealed?: string[] }).__revealed = [];
			shell.showItemInFolder = (file: string) => void (globalThis as { __revealed?: string[] }).__revealed?.push(file);
		});
		await app.evaluate(({ Menu }) => void Menu.getApplicationMenu()?.getMenuItemById("settings-diagnostics")?.click());
		page = await until("the settings page", 60_000, () => app.windows().find((w) => w.url().endsWith("settings.html")), 250);
		await page.waitForLoadState("domcontentloaded");
		await toDiagnostics();
	});

	after(async () => {
		await app?.close().catch(() => undefined);
		const userPathBefore = world?.userPathBefore;
		const real = world?.realUserPath;
		const userPath = world?.userPath;
		if (world) await disposeWorld(world);
		if (real) assert.deepEqual(await userPath.read(), userPathBefore ?? null, "the user PATH is as it was before the run");
	});

	it("shows four cards with ids that do not repeat, and Check status as the first action", async () => {
		assert.deepEqual(await page.locator("li.update-card").evaluateAll((els) => els.map((e) => e.getAttribute("data-role"))), ["status", "logs", "collect", "repair"]);
		assert.equal(await page.evaluate(() => { const ids = [...document.querySelectorAll("[id]")].map((e) => e.id); return ids.length === new Set(ids).size; }), true);
		assert.match(await page.locator("#diag-logs-where").innerText(), /logs/);
		await shotBoth("idle");
	});

	it("reads the status of the running stack: live, started by the desk, and the version; never the address or the token", async () => {
		await page.locator("#diag-status").click();
		await page.locator('li.update-card[data-role="status"][data-state="ok"]').waitFor({ timeout: 90_000 });
		const fields = await page.locator("#diag-status-fields li").evaluateAll((els) => els.map((e) => [e.getAttribute("data-field"), (e.textContent ?? "").trim()]));
		assert.deepEqual(fields.map((f) => f[0]), ["state", "primary", "desk", "version"]);
		assert.match(fields[0]?.[1] ?? "", /live/i);
		assert.doesNotMatch(await page.locator("#diag-cards").innerText(), /127\.0\.0\.1|http:\/\//, "no address on the page");
		await shotBoth("status-ok");
	});

	it("collects a zip with no file from the excluded folders and no planted token", async () => {
		// Planted in every place the zip must not read, and in the places it reads, where only the redactor stands between the text and the zip.
		for (const place of ["agent/planted.txt", "claude/planted.txt", "config/gh/hosts.yml", "config/glab-cli/config.yml", "secrets/planted.txt", "electron/planted.txt", "gitconfig"]) plant(place, `${MARKER} ${TOKENS.join(" ")}\n`);
		plant("state/start.json", `${MARKER} {"pid":1}\n`);
		plant("logs/planted.jsonl", `{"event":"planted","token":"${TOKENS[0]}","note":"glab ${TOKENS[1]} claude ${TOKENS[2]}"}\n`);
		plant("state/planted.json", `{"remember":"${TOKENS[1]}"}\n`);
		await page.locator("#diag-collect").click();
		await page.locator('li.update-card[data-role="collect"][data-state="done"]').waitFor({ timeout: 120_000 });
		const revealed = await app.evaluate(() => (globalThis as { __revealed?: string[] }).__revealed ?? []);
		assert.equal(revealed.length, 1, "the zip was shown in its folder once");
		const file = revealed[0] as string;
		assert.match(file, /straw-boss-diagnostics-\d{8}-\d{6}\.zip$/);
		const entries = readZip(file);
		const names = entries.map((e) => e.name);
		assert.ok(names.includes("diagnostics.txt"), "the summary is in the zip");
		assert.ok(names.some((n) => n.startsWith("logs/")), "the logs are in the zip");
		assert.ok(names.some((n) => n.startsWith("state/")), "the state is in the zip");
		for (const n of names) assert.doesNotMatch(n, /^(agent|claude|config|secrets|electron)\//i, `${n} is from an excluded folder`);
		assert.ok(!names.some((n) => n.toLowerCase() === "gitconfig" || n.toLowerCase() === "state/start.json"), "no gitconfig, no start.json");
		for (const e of entries) {
			const text = e.data.toString("utf8");
			assert.ok(!text.includes(MARKER), `${e.name} holds text of an excluded file`);
			for (const t of TOKENS) assert.ok(!text.includes(t), `${e.name} holds a planted token`);
		}
		assert.ok(names.includes("logs/planted.jsonl") && names.includes("state/planted.json"), "the planted files that are read made it in, masked");
		assert.match(await page.locator("#diag-collect-done").innerText(), /straw-boss-diagnostics-/);
		await shotBoth("collect-done");
	});

	it("repairs a deleted pi package and a removed PATH entry, and the stack runs", async () => {
		const dir = agentPackageDir(world.layout, PACKAGE);
		assert.ok(existsSync(join(dir, "package.json")), `${PACKAGE} is installed`);
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
		assert.equal(existsSync(dir), false);
		if (isWin) {
			assert.equal(await pathHasEntry(), true, "the entry is there before it is removed");
			await world.userPath.remove(world.layout.tools.shims);
			assert.equal(await pathHasEntry(), false);
		}
		await page.locator("#diag-repair").click();
		await page.locator('li.update-card[data-role="repair"][data-state="working"]').waitFor({ timeout: 30_000 });
		await shot(page, "diagnostics-repair-working-en");
		await page.locator('li.update-card[data-role="repair"][data-state="done"]').waitFor({ timeout: 900_000 });
		assert.equal(existsSync(join(dir, "package.json")), true, `${PACKAGE} is installed again`);
		if (isWin) assert.equal(await pathHasEntry(), true, "the PATH entry is back");
		const url = await until("the stack to run again", 300_000, guiUrl, 500);
		assert.equal(await guiStatus(url), 200, "the GUI answers");
		await shotBoth("repair-done");
	});
});
