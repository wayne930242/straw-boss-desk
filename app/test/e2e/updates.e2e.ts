// The task 13 anchor, packaged-app half (`updates.yml`, both runners): the packaged development build, installed root and running stack, takes keys and a feed from its environment and drives
// the Updates card through a local feed (test/fixtures/feed). Every state is shot in zh-TW and English.
//   - up to date: the feed offers nothing newer than the app and the stack in force;
//   - refused, each with its reason: a wrong signature, a lower generation, a `minShell` above the app, and a key that is not in the list (the app's list holds two test keys);
//   - the second key of the list verifies;
//   - the app channel: an installer (Windows) or a dmg (macOS) signed by the test key is offered; one with a byte changed and its `latest*.yml` SHA512 regenerated is refused, deleted, and never offered;
//   - available, applying, applied: a signed candidate that changes Node is applied with the stack stopped and started again, and the stack is back (GUI 200);
//   - rolled back: a candidate whose pi stage fails is undone, the report names the stage, and the stack in force is the old one.
// The keys are made for this run and never written to disk. The Windows install and update (0.0.1 to 0.0.2 through the NSIS installer) is `updates-windows.e2e.ts`.
//   SBD_E2E=1 SBD_E2E_KIND=dev node --test test/e2e/updates.e2e.ts        (a GitHub-hosted runner only; the six-signal check refuses anywhere else)
import assert from "node:assert/strict";
import { request } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it as nodeIt } from "node:test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { platformKey } from "../../src/main/bootstrap/stack.ts";
import { stackFiles } from "../../src/main/update/stack.ts";
import { compareVersions } from "../../src/main/update/verify.ts";
import { ALT_NODE_VERSION, altStack } from "../harness/alt-pins.ts";
import { createWorld, disposeWorld, noteUserPath, realStack, runWorld, type World } from "../harness/e2e-light.ts";
import { assertElevatedRunner } from "../harness/elevation.ts";
import { hostedCase } from "../harness/hosted.ts";
import { startTrouble } from "../harness/start-trouble.ts";
import { appRoot, locatePackaged, type Packaged } from "../harness/packaged.ts";
import { FeedServer, latestYml, makeTestKey, type TestKey } from "../fixtures/feed/feed-server.ts";

const kind = process.env.SBD_E2E_KIND === "release" ? "release" : "dev";
const enabled = process.env.SBD_E2E === "1";
const hosted = hostedCase("the updaters e2e (task 13)");
const skip = !enabled ? "opens real windows and starts a real stack: runs on the CI runners only (SBD_E2E=1)" : kind !== "dev" ? "the keys and the feed come from the environment of the development build" : hosted.run ? false : hosted.reason;
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
const key = platformKey(process.platform, process.arch);
const RECIPE = { forges: [{ kind: "github", host: "github.com" }], tools: [] as string[], id: "ci-updates", name: "CI updates", version: "1.0.0", instructions: "- the CI rule" };
const generation = realStack.generation as number;
/** The installer or dmg the feed offers as 0.0.2: bytes of no program, which the app only downloads and checks, never runs. */
const INSTALLER_NAME = isWin ? "straw-boss-desk-Setup-0.0.2.exe" : "Straw Boss Desk Dev-0.0.2-arm64.dmg";
const LATEST = isWin ? "latest.yml" : "latest-mac.yml";
const installerBytes = (tag: string): Buffer => Buffer.concat([Buffer.from(`not an installer: ${tag}\n`), Buffer.alloc(300_000, 7)]);

describe("the updaters against a local feed (e2e, task 13)", { skip }, () => {
	assert.ok(!enabled || kind !== "dev" || packaged, "no packaged development build in app/out/dev");
	let world: World;
	let feed: FeedServer;
	let app: ElectronApplication;
	let settings: Page;
	let appVersion = "0.0.1";
	/** Every case below runs through this: a failure carries the cards' text, the update record, the tool versions in force and the app's logs. */
	const it = (name: string, body: () => Promise<void>) =>
		nodeIt(name, async () => {
			try {
				await body();
			} catch (error) {
				const parts: string[] = [];
				try {
					parts.push(`cards: ${(await settings.locator("#update-cards").innerText({ timeout: 3000 })).replace(/\s+/g, " ")}`);
				} catch {
					parts.push("cards: (unreadable)");
				}
				for (const file of ["current.json", "update.json"]) {
					try {
						parts.push(`${file}: ${readFileSync(join(world.layout.state, file), "utf8").replace(/\s+/g, " ").slice(0, 700)}`);
					} catch {
						parts.push(`${file}: (missing)`);
					}
				}
				parts.push(...logTails(world.layout.logs));
				parts.push(`feed requests: ${feed.requests.slice(-12).join(", ")}`);
				(error as Error).message = `${(error as Error).message}\n--- diagnostics --- ${parts.join(" ;; ").slice(0, 5000)}`;
				throw error;
			}
		});
	const keyA = makeTestKey();
	const keyB = makeTestKey();
	const outsider = makeTestKey();

	const env = (): Record<string, string> => {
		const base: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(PI_|HERDR_|ELECTRON_RUN_AS_NODE$)/.test(k)) base[k] = v;
		return { ...base, ...world.appEnv, STRAW_BOSS_DESK_ROOT: world.root, SBD_UPDATE_KEYS: JSON.stringify([keyA.publicKey, keyB.publicKey]), SBD_UPDATE_FEED: feed.url };
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
	const stackCard = () => settings.locator('li.update-card[data-role="stack"]');
	const appCard = () => settings.locator('li.update-card[data-role="app"]');
	const noteOf = (role: "stack" | "app") => settings.locator(`#update-${role}-note`);
	const checkNow = async (): Promise<void> => {
		await settings.locator("#update-check").click();
		await settings.locator('li.update-card[data-role="check"][data-state="idle"]').waitFor({ timeout: 120_000 });
		await until("a checked time", 30_000, async () => !/Never|尚未/.test((await settings.locator("#update-checked").textContent()) ?? ""));
	};
	const toUpdates = async (): Promise<void> => {
		await settings.locator('button.nav-item[data-section="updates"]').click();
		await settings.locator("#update-cards").waitFor({ timeout: 10_000 });
	};
	/** Settings in one language: the language buttons live in Computer, so the page goes there and back. */
	const updatesIn = async (locale: "en" | "zh-TW"): Promise<void> => {
		await settings.locator('button.nav-item[data-section="computer"]').click();
		await settings.locator(`.language-button[data-locale="${locale}"]`).click();
		await until(`${locale} in settings`, 10_000, async () => (await settings.evaluate(() => document.documentElement.lang)) === locale, 100);
		await toUpdates();
	};
	const shotBoth = async (name: string): Promise<void> => {
		await updatesIn("zh-TW");
		await shot(settings, `updates-${name}-zh-TW`);
		await updatesIn("en");
		await shot(settings, `updates-${name}-en`);
	};
	const checkedStack = async (value: unknown, signer: TestKey = keyA): Promise<void> => {
		feed.putSigned("stack.json", `${JSON.stringify(value, null, "\t")}\n`, signer.privateKey);
		await checkNow();
	};
	const stackState = (): Promise<string | null> => stackCard().getAttribute("data-state");
	const stackReason = (): Promise<string | null> => noteOf("stack").getAttribute("data-reason");
	const activeText = (): string => readFileSync(stackFiles(world.layout).active, "utf8");
	/** The feed offers the app itself (nothing newer), so the shell channel is quiet. */
	const offerShell = (version: string, bytes: Buffer, signer: TestKey | null, listed: Buffer = bytes, signedVersion: string = version): void => {
		feed.put(LATEST, latestYml({ version, file: INSTALLER_NAME, bytes: listed }));
		if (signer === null) feed.put(INSTALLER_NAME, bytes);
		else feed.putShellSigned(INSTALLER_NAME, bytes, signedVersion, signer.privateKey);
	};
	/** Files of that name under the scratch home: where electron-updater keeps what it downloaded. */
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

	before(async () => {
		assertElevatedRunner();
		world = createWorld("upd");
		await noteUserPath(world);
		feed = await FeedServer.start();
		const installed = await runWorld(world, { profile: true, recipe: RECIPE });
		assert.ok(installed.ok, `the install failed: ${JSON.stringify(installed.error ?? Object.values(installed.outcomes).filter((o) => o.failure).map((o) => o.failure))}`);
		// The app has no wizard record for this root, so it knows no code host: the update changes Node, which every stack has. The stack in force is the shipped one (the app's bundled file has the same generation), so nothing is applied at the start.
		mkdirSync(world.layout.stack, { recursive: true });
		writeFileSync(stackFiles(world.layout).active, `${JSON.stringify(realStack, null, "\t")}\n`);
		app = await electron.launch({ executablePath: packaged?.executable, args: ["--lang=en-US"], env: env(), timeout: 60_000 });
		appVersion = await app.evaluate(({ app: electronApp }) => electronApp.getVersion());
		// A start that never reaches the GUI (task 15: a Windows runner) carries what the app logged and what ran.
		const url = await until("the GUI view to load the server's address", 240_000, guiUrl, 500).catch(async (error: Error) => {
			throw new Error(`${error.message}\n--- diagnostics --- ${await startTrouble(world, { app })}`, { cause: error });
		});
		assert.equal(await guiStatus(url), 200);
		// The reveal of a dmg must not open a Finder window on the runner.
		await app.evaluate(({ shell }) => {
			(globalThis as { __revealed?: string[] }).__revealed = [];
			shell.showItemInFolder = (file: string) => void (globalThis as { __revealed?: string[] }).__revealed?.push(file);
		});
		await app.evaluate(({ Menu }) => void Menu.getApplicationMenu()?.getMenuItemById("settings-updates")?.click());
		settings = await until("the settings page", 60_000, () => app.windows().find((w) => w.url().endsWith("settings.html")), 250);
		await settings.waitForLoadState("domcontentloaded");
		await toUpdates();
	});

	after(async () => {
		await app?.close().catch(() => undefined);
		await feed?.close().catch(() => undefined);
		const before = world.userPathBefore;
		const real = world.realUserPath;
		const userPath = world.userPath;
		await disposeWorld(world);
		if (real) assert.deepEqual(await userPath.read(), before ?? null, "the user PATH is as it was before the run");
	});

	it("shows three cards with ids that do not repeat, and Check now as the only action of the first", async () => {
		assert.deepEqual(await settings.locator("li.update-card").evaluateAll((els) => els.map((e) => e.getAttribute("data-role"))), ["check", "app", "stack"]);
		assert.equal(await settings.evaluate(() => { const ids = [...document.querySelectorAll("[id]")].map((e) => e.id); return ids.length === new Set(ids).size; }), true);
		assert.deepEqual(await settings.locator('li.update-card[data-role="check"] button').evaluateAll((els) => els.map((e) => e.id)), ["update-check"]);
		assert.equal(await settings.locator("#app-version").textContent(), `Version ${appVersion}`);
		assert.equal(await settings.locator("#stack-generation").textContent(), `Generation ${generation}`);
	});

	it("is up to date when the feed offers nothing newer", async () => {
		offerShell(appVersion, installerBytes("same"), keyA);
		await checkedStack(realStack);
		assert.equal(await stackState(), "idle");
		assert.equal(await appCard().getAttribute("data-state"), "idle");
		await shotBoth("up-to-date");
	});

	it("refuses a wrong signature, a lower generation, a minShell above the app, and a key that is not in the list, and says why", async () => {
		await checkedStack({ ...realStack, generation: generation + 1 }, outsider);
		assert.equal(await stackState(), "refused");
		assert.equal(await stackReason(), "bad-signature");
		await shotBoth("refused-key-not-in-list");

		feed.putSigned("stack.json", `${JSON.stringify({ ...realStack, generation: generation + 1 }, null, "\t")}\n`, keyA.privateKey);
		feed.put("stack.json.sig", Buffer.from(`${Buffer.alloc(64, 1).toString("base64")}\n`));
		await checkNow();
		assert.equal(await stackReason(), "bad-signature", "a signature that fits no key");

		await checkedStack({ ...realStack, generation: generation - 1 });
		assert.equal(await stackState(), "refused");
		assert.equal(await stackReason(), "older");

		await checkedStack({ ...realStack, generation: generation + 1, minShell: "99.0.0" });
		assert.equal(await stackState(), "refused");
		assert.equal(await stackReason(), "min-shell");
		assert.match((await noteOf("stack").textContent()) ?? "", /99\.0\.0/);
		await shotBoth("refused-min-shell");
		assert.equal(activeText(), `${JSON.stringify(realStack, null, "\t")}\n`, "nothing was applied");
	});

	it("verifies a candidate signed by the second key of the list", async () => {
		await checkedStack({ ...altStack(realStack, { node: true }), generation: generation + 1 }, keyB);
		assert.equal(await stackState(), "available");
	});

	it("refuses an installer or dmg with a byte changed after its latest file was regenerated: deleted, never offered", async () => {
		// One byte changed, the latest file written to match the new bytes (so electron-updater's SHA512 passes), and the signed manifest of the original file, made by a key of the list: only the check against the signed SHA512 can tell.
		const original = installerBytes("0.0.3");
		const tampered = Buffer.from(original);
		tampered[40] = (tampered[40] as number) ^ 0xff;
		feed.clear();
		feed.put(LATEST, latestYml({ version: "0.0.3", file: INSTALLER_NAME, bytes: tampered }));
		feed.putShellSigned(INSTALLER_NAME, tampered, "0.0.3", keyA.privateKey, original);
		feed.putSigned("stack.json", `${JSON.stringify(realStack, null, "\t")}\n`, keyA.privateKey);
		await checkNow();
		if (!isWin) {
			await until("the app card to offer the version", 60_000, async () => (await appCard().getAttribute("data-state")) === "available");
			await settings.locator("#update-download").click();
		}
		await until("the app card to refuse the file", 120_000, async () => (await appCard().getAttribute("data-state")) === "refused");
		assert.equal(await noteOf("app").getAttribute("data-reason"), "hash-mismatch");
		assert.equal(await settings.locator("#update-restart, #update-download, #update-reveal").count(), 0, "no action is left for a refused file");
		assert.deepEqual(findFiles(world.home, INSTALLER_NAME).filter((f) => readFileSync(f).equals(tampered)), [], "the file that failed the check is deleted");
		assert.equal(await app.evaluate(() => ((globalThis as { __revealed?: string[] }).__revealed ?? []).length), 0, "nothing was revealed");
		await shotBoth("app-refused");
	});

	it("refuses a genuine, signed installer of an older release that latest.yml announces as the newer version: the version comes from the signed manifest (R13-F002)", async () => {
		const older = installerBytes("0.0.0");
		feed.clear();
		// The key signed this file as 0.0.0; the unsigned latest file says 0.0.4.
		offerShell("0.0.4", older, keyA, older, "0.0.0");
		feed.putSigned("stack.json", `${JSON.stringify(realStack, null, "\t")}\n`, keyA.privateKey);
		await checkNow();
		if (!isWin) {
			await until("the app card to offer the version", 60_000, async () => (await appCard().getAttribute("data-state")) === "available");
			await settings.locator("#update-download").click();
		}
		await until("the app card to refuse the file", 120_000, async () => (await appCard().getAttribute("data-state")) === "refused");
		assert.equal(await noteOf("app").getAttribute("data-reason"), "bad-manifest");
		assert.deepEqual(findFiles(world.home, INSTALLER_NAME).filter((f) => readFileSync(f).equals(older)), [], "the file is deleted");
		assert.equal(await app.evaluate(() => ((globalThis as { __revealed?: string[] }).__revealed ?? []).length), 0, "nothing was revealed");
	});

	it("offers an installer or dmg signed by the test key", async () => {
		const good = installerBytes("0.0.2");
		feed.clear();
		offerShell("0.0.2", good, keyA);
		feed.putSigned("stack.json", `${JSON.stringify(realStack, null, "\t")}\n`, keyA.privateKey);
		await checkNow();
		await until("the app card to offer the update", 120_000, async () => ((await appCard().getAttribute("data-state")) ?? "") === (isWin ? "ready" : "available"));
		assert.equal(await settings.locator(isWin ? "#update-restart" : "#update-download").count(), 1);
		await shotBoth("app-offered");
		if (!isWin) {
			await settings.locator("#update-download").click();
			await appCard().and(settings.locator('[data-state="downloaded"]')).waitFor({ timeout: 120_000 });
			const revealed = await app.evaluate(() => (globalThis as { __revealed?: string[] }).__revealed ?? []);
			assert.equal(revealed.length, 1, "revealed once, never opened");
			assert.equal(readFileSync(revealed[0] as string).equals(good), true);
			await shotBoth("app-downloaded");
		}
	});

	it("applies a signed candidate that changes Node: the card goes through applying to applied, the stack is back, and the Node in force is the new one", async () => {
		feed.clear();
		feed.put(LATEST, latestYml({ version: appVersion, file: INSTALLER_NAME, bytes: installerBytes("same"), }));
		await checkedStack({ ...altStack(realStack, { node: true }), generation: generation + 1 });
		assert.equal(await stackState(), "available");
		assert.equal(await settings.locator("#update-changes li").count(), 1);
		const change = (await settings.locator("#update-changes li").first().textContent()) ?? "";
		assert.match(change, new RegExp(`${ALT_NODE_VERSION.replace(/\./g, "\\.")}`));
		// SA-T13-1: the change list reads as an update, a rising version, not a downgrade.
		const [from, to] = change.match(/\d+\.\d+\.\d+/g) ?? [];
		assert.ok(from !== undefined && to !== undefined && compareVersions(to, from) > 0, `the Node in the change list rises: ${change}`);
		await shotBoth("available");

		// Applied in zh-TW: the page is left in that language while the apply runs, so the applying shot is a Chinese one.
		await updatesIn("zh-TW");
		await settings.locator("#update-apply").click();
		await stackCard().and(settings.locator('[data-state="applying"]')).waitFor({ timeout: 120_000 });
		assert.equal(await settings.locator("#update-apply").isDisabled(), true);
		assert.equal(await settings.locator("#update-check").isDisabled(), true, "Check now waits while an update applies");
		await shot(settings, "updates-applying-zh-TW");
		await stackCard().and(settings.locator('[data-state="applied"]')).waitFor({ timeout: 600_000 });
		await shot(settings, "updates-applied-zh-TW");
		await updatesIn("en");
		await shot(settings, "updates-applied-en");
		assert.equal(await settings.locator("#stack-generation").textContent(), `Generation ${generation + 1}`);
		const active = JSON.parse(activeText()) as { generation: number };
		assert.equal(active.generation, generation + 1);
		const current = JSON.parse(readFileSync(join(world.layout.state, "current.json"), "utf8")) as { versions: Record<string, string> };
		assert.equal(current.versions.node, ALT_NODE_VERSION);
		const url = await until("the GUI view to load again", 240_000, guiUrl, 500);
		assert.equal(await guiStatus(url), 200, "the stack is back");
	});

	it("rolls back a candidate whose pi stage fails: the card names the stage, the old stack is in force, and the stack is back", async () => {
		const before = activeText();
		const bad = altStack(realStack, {});
		const pi = (bad.npmGlobal as Array<{ version: string }>)[0] as { version: string };
		pi.version = "0.0.1";
		await checkedStack({ ...bad, generation: generation + 2 });
		assert.equal(await stackState(), "available");
		await updatesIn("en");
		await settings.locator("#update-apply").click();
		await stackCard().and(settings.locator('[data-state="applying"]')).waitFor({ timeout: 120_000 });
		await shot(settings, "updates-applying-en");
		// Not a Playwright wait: a timeout there carries none of the diagnostics below (the cards, the records, the logs).
		await until("the stack card to be rolled back", 480_000, async () => (await stackState()) === "rolled-back", 1000);
		assert.equal(await stackReason(), "pi", "the report names the stage");
		await shotBoth("rolled-back");
		assert.equal(activeText(), before, "the stack in force is the old one");
		assert.equal(await settings.locator("#stack-generation").textContent(), `Generation ${generation + 1}`);
		const current = JSON.parse(readFileSync(join(world.layout.state, "current.json"), "utf8")) as { versions: Record<string, string> };
		assert.equal(current.versions.node, ALT_NODE_VERSION, "the Node of the old stack is in force");
		const url = await until("the GUI view to load again", 240_000, guiUrl, 500);
		assert.equal(await guiStatus(url), 200, "the stack is back on the old generation");
	});

	it("keeps a downloaded stack whose generation is higher than the one the app ships: the next launch applies nothing over it", async () => {
		const active = JSON.parse(activeText()) as { generation: number };
		assert.ok(active.generation > generation, "the stack in force is newer than the bundled one");
		const text = activeText();
		await app.close();
		app = await electron.launch({ executablePath: packaged?.executable, args: ["--lang=en-US"], env: env(), timeout: 60_000 });
		const url = await until("the GUI view to load the server's address", 240_000, guiUrl, 500);
		assert.equal(await guiStatus(url), 200);
		assert.equal(activeText(), text, "stack/active.json is the downloaded one still");
	});
});
