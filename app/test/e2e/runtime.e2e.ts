// The task 8a anchor, app half: the packaged app starts the stack at launch and stops it at quit. From a root tasks 5 to 7 filled, the app's main process is killed (the stack
// keeps running), the next launch reaches the GUI in under 30 s without a second Herdr and adopts the recorded processes, a second instance with `--stop-stack` stops the
// stack through the running app, and a plain quit stops everything. The supervisor half (restarts, the bare-name pi) is test/e2e-runtime.test.ts.
//   SBD_E2E=1 SBD_E2E_KIND=dev npm run test:e2e        (a GitHub-hosted runner only; the six-signal check refuses anywhere else)
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import { createPlatform } from "../../src/main/platform/index.ts";
import { childEnvOf, createWorld, disposeWorld, noteUserPath, run, runWorld, type World } from "../harness/e2e-light.ts";
import { hostedCase } from "../harness/hosted.ts";
import { locatePackaged, type Packaged } from "../harness/packaged.ts";

const kind = process.env.SBD_E2E_KIND === "release" ? "release" : "dev";
const enabled = process.env.SBD_E2E === "1";
const hosted = hostedCase("the app lifecycle e2e (task 8a)");
// The lifecycle code is the same in both builds, and each run installs a whole root: the development build carries it.
const skip = !enabled ? "opens real windows and starts a real stack: runs on the CI runners only (SBD_E2E=1)" : kind !== "dev" ? "the lifecycle is exercised by the development build" : hosted.run ? false : hosted.reason;
const packaged: Packaged | undefined = enabled && kind === "dev" ? locatePackaged(kind) : undefined;

if (enabled && kind === "dev" && !hosted.run && hosted.fail) {
	it("runs on a hosted runner", () => {
		assert.fail(`${hosted.reason} (SBD_REQUIRE_HOSTED_FIXTURES=1)`);
	});
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(what: string, ms: number, probe: () => T | Promise<T>): Promise<NonNullable<T>> {
	const deadline = Date.now() + ms;
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			const value = await probe();
			if (value) return value as NonNullable<T>;
		} catch (error) {
			last = error;
		}
		await sleep(500);
	}
	throw new Error(`timed out after ${ms / 1000} s waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
}

describe("the packaged app's lifecycle against the real stack (e2e, task 8a)", { skip }, () => {
	assert.ok(!enabled || kind !== "dev" || packaged, "no packaged development build in app/out/dev");
	let world: World;
	const platform = createPlatform();
	const apps: ElectronApplication[] = [];
	// Playwright cannot answer `process()` once the app is closed, so the handle is kept from the launch.
	const processes = new Map<ElectronApplication, ChildProcess>();

	const env = (): Record<string, string> => {
		const base: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(PI_|HERDR_|ELECTRON_RUN_AS_NODE$)/.test(k)) base[k] = v;
		return { ...base, ...world.appEnv, STRAW_BOSS_DESK_ROOT: world.root };
	};
	const launch = async (): Promise<ElectronApplication> => {
		const app = await electron.launch({ executablePath: packaged?.executable, args: ["--lang=en-US"], env: env(), timeout: 60_000 });
		apps.push(app);
		processes.set(app, app.process());
		return app;
	};
	const guiUrl = (app: ElectronApplication): Promise<string | undefined> =>
		app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getURL()).find((u) => /^http:\/\/127\.0\.0\.1:\d+\//.test(u)));
	const startRecord = () => JSON.parse(readFileSync(join(world.layout.state, "start.json"), "utf8")) as { herdr: { pid: number; startTime: string | null } | null; sb: { pid: number; startTime: string | null } | null };
	const underTools = () => platform.processes.listUnder(world.layout.tools.root);
	const herdrCount = async () => (await underTools()).filter((p) => /^herdr(\.exe)?$/i.test(basename(p.executable ?? ""))).length;
	const herdrAnswers = async () => (await run(childEnvOf(world).HERDR_BIN_PATH as string, ["workspace", "list"], { env: childEnvOf(world), timeoutMs: 15_000 })).code === 0;
	const logLines = (): Array<Record<string, unknown>> => {
		const file = join(world.layout.logs, "start.jsonl");
		return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
	};
	const exited = (app: ElectronApplication, ms: number): Promise<boolean> => {
		const child = processes.get(app) as ChildProcess;
		if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(false), ms);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve(true);
			});
		});
	};
	const stopStackSecondInstance = (): Promise<number | null> =>
		new Promise((resolve) => {
			const child = spawn(packaged?.executable as string, ["--stop-stack"], { env: env(), stdio: "ignore", windowsHide: true });
			const timer = setTimeout(() => {
				child.kill();
				resolve(-1);
			}, 180_000);
			child.on("exit", (code) => {
				clearTimeout(timer);
				resolve(code);
			});
		});

	before(async () => {
		world = createWorld("app");
		await noteUserPath(world);
		const installed = await runWorld(world, { profile: true, recipe: { forges: [{ kind: "github", host: "github.com" }], tools: [], id: "ci-lifecycle", name: "CI lifecycle", version: "1.0.0", instructions: "- the CI rule" } });
		assert.ok(installed.ok, `the install failed: ${JSON.stringify(installed.error ?? Object.values(installed.outcomes).filter((o) => o.failure).map((o) => o.failure))}`);
	});

	after(async () => {
		for (const app of apps) await app.close().catch(() => undefined);
		// Whatever a failed test left: the second-instance stop, which is the thing under test and also the cleanup the uninstaller runs.
		if ((await underTools().catch(() => [])).length > 0) await stopStackSecondInstance().catch(() => undefined);
		const before = world.userPathBefore;
		const real = world.realUserPath;
		const userPath = world.userPath;
		await disposeWorld(world);
		if (real) assert.deepEqual(await userPath.read(), before ?? null, "the user PATH is as it was before the run");
	});

	let firstHerdr = 0;
	let firstSb = 0;
	let herdrProcesses = 0;
	let first: ElectronApplication;

	it("starts the stack at launch and loads the GUI in its view (200)", async () => {
		first = await launch();
		const url = await until("the GUI view to load the server's address", 240_000, () => guiUrl(first));
		assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{16,}\/?/);
		const status = await new Promise<number>((resolve, reject) => {
			const req = request(url, { timeout: 15_000 }, (res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			});
			req.on("timeout", () => req.destroy(new Error("the GUI did not answer in 15 s")));
			req.on("error", reject);
			req.end();
		});
		assert.equal(status, 200);
		const record = await until("both start times in start.json", 120_000, () => {
			const r = startRecord();
			return r.herdr?.startTime && r.sb?.startTime ? r : undefined;
		});
		firstHerdr = record.herdr?.pid as number;
		firstSb = record.sb?.pid as number;
		herdrProcesses = await herdrCount();
		assert.ok(herdrProcesses >= 1, "Herdr runs from the tools folder");
	});

	it("leaves the stack running when the app's main process is killed, and the next launch reaches the GUI in under 30 s with no second Herdr", async () => {
		const pid = await first.evaluate(() => process.pid);
		process.kill(pid, "SIGKILL");
		await exited(first, 60_000);
		await sleep(2000);
		assert.equal(await herdrAnswers(), true, "Herdr keeps running");
		assert.equal((await platform.processes.inspect([firstSb]))[0]?.startTime !== null, true, "the sb server keeps running");

		const began = Date.now();
		const second = await launch();
		const url = await until("the GUI view to load the server's address", 30_000, () => guiUrl(second));
		const ms = Date.now() - began;
		console.log(`relaunch reached the GUI in ${(ms / 1000).toFixed(1)} s`);
		assert.ok(url && ms < 30_000);
		assert.equal(await herdrCount(), herdrProcesses, "no second Herdr");
		const record = await until("the deferred start-time read", 60_000, () => {
			const r = startRecord();
			return r.herdr?.startTime && r.sb?.startTime ? r : undefined;
		});
		assert.equal(record.herdr?.pid, firstHerdr);
		assert.equal(record.sb?.pid, firstSb);
		// The recorded start times were compared with the current ones (spec: Adopting).
		await until("the adoption to be logged", 60_000, () => {
			const adopted = logLines().filter((l) => l.event === "start-time-adopted").map((l) => l.kind);
			return adopted.includes("herdr") && adopted.includes("sb") ? true : undefined;
		});
	});

	it("stops the stack and quits the running app when a second instance starts with --stop-stack", async () => {
		const running = apps.at(-1) as ElectronApplication;
		const code = await stopStackSecondInstance();
		assert.equal(code, 0, "the second instance exits 0 on its own");
		assert.equal(await exited(running, 180_000), true, "the running app quit");
		assert.deepEqual((await underTools()).map((p) => `${p.pid} ${p.executable}`), []);
		assert.equal(await herdrAnswers(), false);
		const quit = logLines().filter((l) => l.event === "quit-stop").at(-1);
		assert.equal(quit?.ok, true);
	});

	it("starts the stack again, and a plain quit stops everything", async () => {
		const app = await launch();
		await until("the GUI view to load the server's address", 240_000, () => guiUrl(app));
		assert.equal(await herdrAnswers(), true);
		await app.close();
		assert.equal(await exited(app, 180_000), true);
		assert.deepEqual((await underTools()).map((p) => `${p.pid} ${p.executable}`), []);
		assert.equal(await herdrAnswers(), false);
		assert.equal(existsSync(join(world.layout.state, "start.json")), false, "nothing is left, so start.json goes");
	});
});
