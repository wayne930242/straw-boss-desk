import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { buildEnv, bunCacheDir, bunHome } from "../src/main/env.ts";
import { computeLayout, type AppPlatform, type Layout } from "../src/main/paths.ts";
import { createPlatform } from "../src/main/platform/index.ts";
import { execRunner } from "../src/main/platform/exec.ts";
import { assertEngineIdle, repairEngineLock } from "../src/main/runtime/engine-lock.ts";
import { loadStartConfig } from "../src/main/runtime/config.ts";
import { packageBlocks, readInstalled, isInstalled } from "../src/main/runtime/readiness.ts";
import { resolveShortNames, shortPathOf } from "../src/main/runtime/short-names.ts";
import { scratchRoot, testLayout } from "./harness/engine-fixture.ts";
import { FakeProcesses, installFake } from "./harness/runtime-fakes.ts";

const scratch: string[] = [];
after(() => {
	for (const d of scratch) removeTree(d);
});
const fresh = () => {
	const made = scratchRoot("sbd-rs-");
	scratch.push(made.base);
	return { ...made, layout: testLayout(made.root) };
};
const isWindows = process.platform === "win32";

describe("bun's 8.3 short names in the constructed environment (build notes: task 5)", () => {
	const win = (): Layout => {
		const home = "C:\\h";
		return computeLayout({ root: "C:\\h\\data", home, platform: "win32", realpath: (p) => { if (p === home) return p; throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } });
	};
	const current = { node: "24.22.1", git: "2.56.0.3", herdr: "0.9.5" };

	it("gives bun the short names when it has them, and the long names when it has none", () => {
		const layout = win();
		const short = { bunHome: "C:\\h\\data\\tools\\BUN-HO~1", bunCache: "C:\\h\\data\\tools\\BUN-HO~1\\install\\cache" };
		const withShort = buildEnv({ layout, current, appEnv: { SystemRoot: "C:\\Windows" }, optionalTools: ["bun"], shortNames: short });
		assert.equal(withShort.BUN_INSTALL, short.bunHome);
		assert.equal(withShort.BUN_INSTALL_CACHE_DIR, short.bunCache);
		assert.equal(withShort.DO_NOT_TRACK, "1");
		const without = buildEnv({ layout, current, appEnv: { SystemRoot: "C:\\Windows" }, optionalTools: ["bun"] });
		assert.equal(without.BUN_INSTALL, bunHome(layout));
		assert.equal(without.BUN_INSTALL_CACHE_DIR, bunCacheDir(layout));
	});

	it("sets nothing of bun's for a recipe that does not name it, whatever short names exist", () => {
		const env = buildEnv({ layout: win(), current, appEnv: {}, optionalTools: [], shortNames: { bunHome: "C:\\x", bunCache: "C:\\y" } });
		assert.equal("BUN_INSTALL" in env, false);
	});

	it("macOS has none to give: resolveShortNames answers null and runs nothing", async () => {
		const { layout } = fresh();
		if (isWindows) return;
		let ran = 0;
		const found = await resolveShortNames({ layout, run: async () => (ran++, { code: 0, stdout: "", stderr: "" }), locate: createPlatform().locate, appEnv: {} });
		assert.equal(found, null);
		assert.equal(ran, 0);
	});

	it("Windows: resolves ASCII short names of bun's folders under a root with CJK characters, records them once, and reuses the record", { skip: isWindows ? false : "Windows only" }, async () => {
		const parent = realpathSync(mkdtempSync(join(tmpdir(), "sbd-sn-")));
		scratch.push(parent);
		const home = join(parent, "h 測試");
		mkdirSync(home);
		const layout = computeLayout({ root: join(home, "sbd 測試"), home, platform: "win32" });
		const platform = createPlatform();
		let calls = 0;
		const real = execRunner();
		const run: typeof real = (...args) => (calls++, real(...args));
		const found = await resolveShortNames({ layout, run, locate: platform.locate, appEnv: process.env });
		assert.ok(found, "the volume has 8.3 names (windows-2025 does)");
		assert.match(found.bunHome, /^[\x20-\x7e]+$/);
		assert.match(found.bunCache, /^[\x20-\x7e]+$/);
		assert.ok(existsSync(found.bunHome) && existsSync(found.bunCache));
		assert.ok(existsSync(join(layout.state, "short-names.json")));
		const before = calls;
		assert.deepEqual(await resolveShortNames({ layout, run, locate: platform.locate, appEnv: process.env }), found);
		assert.equal(calls, before, "the second start runs nothing");
		assert.ok(await shortPathOf(real, platform.locate, process.env, home), "the same call works on the profile folder");
	});
});

describe("the engine lock at a start and at Repair (R4-F002)", () => {
	const lock = (layout: Layout, body: unknown) => {
		mkdirSync(layout.state, { recursive: true });
		writeFileSync(join(layout.state, "engine.lock"), typeof body === "string" ? body : `${JSON.stringify(body)}\n`);
	};

	it("is idle with no lock file, reading no process", async () => {
		const { layout } = fresh();
		const procs = new FakeProcesses();
		await assertEngineIdle(layout, procs, () => false);
		assert.deepEqual(procs.inspectCalls, []);
	});

	it("is held by a live owner with the recorded start time, and by a live pid when no start time can be read; free when the owner is gone or another process", async () => {
		const { layout } = fresh();
		const procs = new FakeProcesses().add(10, { startTime: "T", executable: null }).add(11, { startTime: null, executable: null });
		lock(layout, { pid: 10, startTime: "T", token: "x" });
		await assert.rejects(assertEngineIdle(layout, procs, () => false), /pid 10/);
		lock(layout, { pid: 10, startTime: "OTHER", token: "x" });
		await assertEngineIdle(layout, procs, () => false);
		lock(layout, { pid: 11, startTime: "T", token: "x" });
		await assert.rejects(assertEngineIdle(layout, procs, () => true), /pid 11/, "unreadable start time, pid alive: fail closed");
		await assertEngineIdle(layout, procs, () => false);
		lock(layout, { pid: 12, startTime: null, token: "x" });
		await assertEngineIdle(layout, procs, () => false);
	});

	it("an unreadable lock younger than 2 s is being written; an older one is stale", async () => {
		const { layout } = fresh();
		lock(layout, "{ half");
		await assert.rejects(assertEngineIdle(layout, new FakeProcesses(), () => false), /writing/);
	});

	it("Repair removes a lock whose owner is not an engine of this app, a lock that does not parse, and keeps the lock of an engine it holds", () => {
		const { layout } = fresh();
		const file = join(layout.state, "engine.lock");
		assert.deepEqual(repairEngineLock(layout), { result: "none" });
		lock(layout, { pid: 50, startTime: null, token: "x" });
		assert.deepEqual(repairEngineLock(layout, { isOurEngine: (pid) => pid === 50 }), { result: "engine-running", pid: 50 });
		assert.equal(existsSync(file), true);
		assert.deepEqual(repairEngineLock(layout, { isOurEngine: () => false }), { result: "removed", owner: 50 });
		assert.equal(existsSync(file), false);
		lock(layout, "garbage");
		assert.deepEqual(repairEngineLock(layout), { result: "removed", owner: null });
		assert.equal(existsSync(file), false);
	});
});

describe("what a start reads from the install", () => {
	it("finds the active tools and pi-straw-boss's CLI, and names every piece that is missing", () => {
		const { layout } = fresh();
		const missing = readInstalled(layout);
		assert.equal(isInstalled(missing), false);
		const files = installFake(layout);
		const found = readInstalled(layout);
		assert.ok(isInstalled(found));
		assert.equal(found.node, files.node);
		assert.equal(found.sbCli, files.sbCli);
		assert.deepEqual(found.current, { node: "24.0.0", git: "2.0.0", herdr: "0.9.5" });
		removeTree(files.herdr);
		const gone = readInstalled(layout);
		assert.ok(!isInstalled(gone) && gone.missing.some((m) => m.includes("herdr")));
	});

	it("reads the startBlock of a stage record from the raw state file, and treats one that does not parse as a block", () => {
		const { layout } = fresh();
		assert.deepEqual(packageBlocks(layout), []);
		mkdirSync(layout.state, { recursive: true });
		const write = (stages: unknown) => writeFileSync(join(layout.state, "bootstrap.json"), JSON.stringify({ schema: 1, stages }));
		write({ "pkg:a": { status: "ok" }, "team-pkg:@acme/skills": { status: "failed", startBlock: { kind: "package-may-load", package: "@acme/skills", sentence: "Run Repair." } }, profile: {} });
		assert.deepEqual(packageBlocks(layout), [{ stage: "team-pkg:@acme/skills", package: "@acme/skills", sentence: "Run Repair." }]);
		write({ "team-pkg:@x/y": { startBlock: "garbage" }, "pkg:z": { startBlock: {} }, other: { startBlock: null } });
		assert.deepEqual(packageBlocks(layout), [{ stage: "team-pkg:@x/y", package: "@x/y", sentence: "" }, { stage: "pkg:z", package: "pkg:z", sentence: "" }]);
		writeFileSync(join(layout.state, "bootstrap.json"), "not json");
		assert.deepEqual(packageBlocks(layout), []);
	});
});

describe("the start configuration", () => {
	it("defaults to ~/StrawBoss with the home base `Straw Boss` and no recipe", () => {
		const { layout, base } = fresh();
		const config = loadStartConfig(layout, base);
		assert.deepEqual(config, { workFolder: join(base, "StrawBoss"), homeBaseLabel: "Straw Boss", forges: [], optionalTools: [] });
	});

	it("takes the work folder from state/wizard.json and the forges and tools from the one recipe", () => {
		const { layout, base } = fresh();
		mkdirSync(layout.state, { recursive: true });
		mkdirSync(layout.recipe, { recursive: true });
		writeFileSync(join(layout.state, "wizard.json"), JSON.stringify({ workFolder: join(base, "elsewhere") }));
		writeFileSync(join(layout.recipe, "team.json"), JSON.stringify({ forges: [{ kind: "github", host: "GitHub.com" }, { kind: "svn", host: "x" }, { kind: "gitlab", host: "git.corp.example" }], tools: ["bun", 3] }));
		const config = loadStartConfig(layout, base);
		assert.equal(config.workFolder, join(base, "elsewhere"));
		assert.deepEqual(config.forges, [{ kind: "github", host: "github.com" }, { kind: "gitlab", host: "git.corp.example" }]);
		assert.deepEqual(config.optionalTools, ["bun"]);
		writeFileSync(join(layout.recipe, "second.json"), "{}");
		assert.deepEqual(loadStartConfig(layout, base).forges, [], "two recipes and no choice yet: none is guessed");
	});
});
