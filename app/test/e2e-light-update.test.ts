import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { platformKey } from "../src/main/bootstrap/stack.ts";
import { StateStore } from "../src/main/bootstrap/state.ts";
import { createPlatform } from "../src/main/platform/index.ts";
import { StackUpdater, stackFiles, type EngineRunResult } from "../src/main/update/stack.ts";
import { ALT_GH_VERSION, ALT_GIT_VERSION_MAC, ALT_GIT_VERSION_WIN, ALT_NODE_VERSION, altStack } from "./harness/alt-pins.ts";
import type { StackUpdateState } from "../src/shared/updates.ts";
import { createWorld, disposeWorld, isWindows, noteUserPath, realStack, runWorld, WorldHerdr, type World } from "./harness/e2e-light.ts";

// The task 13 anchor, the half that needs real tools: a candidate stack that changes the Node, Git and gh versions is signed with a key made for this run, served from memory, and applied by
// the real engine with the real stages; `paths.sh` (and `paths.cmd`) are rewritten, and a new pane of a real Herdr resolves `node`, `git`, `gh` and `pi` from the new folders, and still does after
// the next start has deleted the old ones. A second candidate whose `pi` stage fails rolls back, and a pane then runs the old folders again. The keys are generated here and never written to disk.
//   SBD_E2E_LIGHT=1 node --test test/e2e-light-update.test.ts        (downloads the real releases of stack.json and the alternates of test/harness/alt-pins.ts into a scratch root)
const ON = process.env.SBD_E2E_LIGHT === "1";
const off = ON ? false : "SBD_E2E_LIGHT=1 is not set: this test downloads the real releases of stack.json";

const key = platformKey(process.platform, process.arch);
const RECIPE = { forges: [{ kind: "github", host: "github.com" }], tools: [] as string[] };
const version = (tool: "node" | "git" | "gh"): string => realStack.tools[tool].assets[key].version as string;
const ALT_GIT_VERSION = isWindows ? ALT_GIT_VERSION_WIN : ALT_GIT_VERSION_MAC;
const generationOf = realStack.generation as number;
const PI_VERSION = (realStack.npmGlobal as Array<{ version: string }>)[0]?.version as string;

/**
 * What a new pane prints for the four tools: their versions, and where Git's own programs are (the one line that differs between two macOS Git builds of the same release).
 * On Windows a pane's PATH is the registry's, machine entries first, and the hosted runner has its own Node, Git and gh there: the pane runs a small script that does what the shims and
 * launchers do (`gh.cmd`, then `paths.cmd` and its `SBD_PATH` in front), so what it prints is what the app's files name. `pi` is found by name through `tools\shims`, as a PM's pane does.
 */
function paneCommand(world: World, script: string, out: string): string {
	if (isWindows) return `cmd /d /c "${script} > ${out} 2>&1"`;
	return `{ gh --version; git --version; git --exec-path; node --version; pi --version; } > '${out}' 2>&1`;
}

function windowsPaneScript(world: World): string {
	return [
		"@echo off",
		`call "${join(world.layout.tools.bin, "gh.cmd")}" --version`,
		`set "SBD_APP_ROOT=${world.root}"`,
		`call "${join(world.layout.tools.bin, "paths.cmd")}"`,
		'set "PATH=%SBD_PATH%;%PATH%"',
		"node --version",
		"git --version",
		"git --exec-path",
		"pi --version",
		"",
	].join("\r\n");
}

describe("a stack update against the real tools (e2e-light, task 13)", { skip: off }, () => {
	let world: World;
	let herdr: WorldHerdr;
	let updater: StackUpdater;
	const served = new Map<string, Buffer>();
	const pair = generateKeyPairSync("ed25519");
	const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");

	const publish = (value: unknown): void => {
		const bytes = Buffer.from(`${JSON.stringify(value, null, "\t")}\n`);
		served.set("https://feed.test/stack.json", bytes);
		served.set("https://feed.test/stack.json.sig", Buffer.from(cryptoSign(null, bytes, pair.privateKey).toString("base64")));
	};
	const pathsText = (name: string): string => readFileSync(join(world.layout.tools.bin, name), "utf8");
	const pathFiles = isWindows ? ["paths.sh", "paths.cmd"] : ["paths.sh"];
	let paneScript = "";
	const pane = (label: string): Promise<string> => herdr.inPane(label, (out) => paneCommand(world, paneScript, out), world.home, 90_000);

	before(async () => {
		world = createWorld("u");
		await noteUserPath(world);
		const first = await runWorld(world, { recipe: RECIPE });
		assert.ok(first.ok, JSON.stringify(first.error ?? Object.values(first.outcomes).filter((o) => o.failure)));
		const files = stackFiles(world.layout);
		mkdirSync(world.layout.stack, { recursive: true });
		writeFileSync(files.active, `${JSON.stringify(realStack, null, "\t")}\n`);
		herdr = new WorldHerdr(world);
		await herdr.start();
		paneScript = join(world.base, "pane-tools.cmd");
		if (isWindows) writeFileSync(paneScript, windowsPaneScript(world));
		updater = new StackUpdater({
			layout: world.layout,
			shellVersion: "0.0.1",
			key,
			keys: [publicKey],
			base: "https://feed.test/",
			fetchBytes: async (url) => ({ status: served.has(url) ? 200 : 404, body: served.get(url) ?? Buffer.alloc(0) }),
			runEngine: async (stack): Promise<EngineRunResult> => {
				const run = await runWorld(world, { stack, recipe: RECIPE });
				if (run.ok) return { ok: true };
				const failed = Object.values(run.outcomes).find((o) => o.status === "failed");
				return { ok: false, failed: { stage: failed?.stage ?? "engine", category: failed?.failure?.category ?? "other" } };
			},
			// The stack stops the way the app's supervisor stops it: Herdr (whose environment the panes inherit) goes, the work runs, and a new Herdr starts with the environment built from the tools then in force.
			withStackStopped: async (work) => {
				await herdr.stop();
				try {
					return await work();
				} finally {
					herdr = new WorldHerdr(world);
					await herdr.start();
				}
			},
			recipeTools: () => [],
			reloadStack: () => undefined,
			log: () => undefined,
		});
	});

	after(async () => {
		await herdr?.stop();
		const before = world.userPathBefore;
		const real = world.realUserPath;
		const userPath = world.userPath;
		await disposeWorld(world);
		if (real) assert.deepEqual(await userPath.read(), before ?? null, "the user PATH is as it was before the run");
	});

	let firstPaths: Record<string, string> = {};

	it("starts with panes on the shipped versions", async () => {
		firstPaths = Object.fromEntries(pathFiles.map((n) => [n, pathsText(n)]));
		const text = await pane("before");
		assert.match(text, new RegExp(`gh version ${version("gh").replace(/\./g, "\\.")}`));
		assert.match(text, new RegExp(`v${version("node").replace(/\./g, "\\.")}`));
	});

	it("applies a signed candidate that changes Node, Git and gh: paths.sh (and paths.cmd) name the new folders, and a new pane resolves them", async () => {
		publish({ ...altStack(realStack, { node: true, git: true, gh: true }), generation: generationOf + 1 });
		await updater.check();
		assert.equal(updater.state.phase, "available", JSON.stringify(updater.state));
		await updater.apply();
		assert.equal(updater.state.phase, "applied", JSON.stringify(updater.state));
		for (const name of pathFiles) {
			const text = pathsText(name);
			assert.notEqual(text, firstPaths[name], `${name} was rewritten`);
			assert.match(text, new RegExp(`node[\\\\/]${ALT_NODE_VERSION.replace(/\./g, "\\.")}`));
			assert.match(text, new RegExp(`git[\\\\/]${ALT_GIT_VERSION.replace(/\./g, "\\.")}`));
			assert.match(text, new RegExp(`gh[\\\\/]${ALT_GH_VERSION.replace(/\./g, "\\.")}`));
		}
		const text = await pane("after-update");
		assert.match(text, new RegExp(`gh version ${ALT_GH_VERSION.replace(/\./g, "\\.")}`), text);
		assert.match(text, new RegExp(`v${ALT_NODE_VERSION.replace(/\./g, "\\.")}`), text);
		assert.match(text, isWindows ? new RegExp(`git version ${ALT_GIT_VERSION.replace(/\.(\d)$/, ".windows.$1").replace(/\./g, "\\.")}`) : /git version 2\.56\.0/, text);
		assert.match(text.replace(/\\/g, "/"), new RegExp(`git/${ALT_GIT_VERSION.replace(/\./g, "\\.")}/`), `git --exec-path names the new Git folder: ${text}`);
		assert.match(text, new RegExp(PI_VERSION.replace(/\./g, "\\.")), `pi --version prints the pin: ${text}`);
	});

	it("still resolves the new folders after the next start deletes the old ones", async () => {
		const store = new StateStore(world.layout);
		const processes = createPlatform().processes;
		for (const tool of ["node", "git", "gh"]) await store.pruneInactive(tool, processes);
		for (const tool of ["node", "git", "gh"]) assert.equal(existsSync(join(world.layout.tools.root, tool, version(tool as "node" | "git" | "gh"))), false, `${tool} ${version(tool as "node" | "git" | "gh")} is gone`);
		const text = await pane("after-prune");
		assert.match(text, new RegExp(`gh version ${ALT_GH_VERSION.replace(/\./g, "\\.")}`), text);
		assert.match(text, new RegExp(`v${ALT_NODE_VERSION.replace(/\./g, "\\.")}`), text);
	});

	it("rolls back a candidate whose pi stage fails: the report names pi, and a new pane runs the folders it had before the attempt", async () => {
		const bad = altStack(realStack, { node: true, git: true });
		(bad.npmGlobal as Array<{ version: string }>)[0] = { ...(bad.npmGlobal as Array<{ version: string }>)[0], version: "0.0.1" } as never;
		publish({ ...bad, generation: generationOf + 2 });
		const beforePaths = Object.fromEntries(pathFiles.map((n) => [n, pathsText(n)]));
		const activeBefore = readFileSync(stackFiles(world.layout).active, "utf8");
		await updater.check();
		assert.equal(updater.state.phase, "available", JSON.stringify(updater.state));
		await updater.apply();
		const state = updater.state as StackUpdateState;
		assert.equal(state.phase, "rolled-back", JSON.stringify(state));
		assert.equal((state as { stage: string }).stage, "pi");
		assert.equal((state as { restored: boolean }).restored, true);
		for (const name of pathFiles) assert.equal(pathsText(name), beforePaths[name], `${name} names the folders it named before the attempt`);
		assert.equal(readFileSync(stackFiles(world.layout).active, "utf8"), activeBefore, "active.json is the stack in force before");
		const text = await pane("after-rollback");
		assert.match(text, new RegExp(`gh version ${ALT_GH_VERSION.replace(/\./g, "\\.")}`), text);
		assert.match(text, new RegExp(`v${ALT_NODE_VERSION.replace(/\./g, "\\.")}`), text);
		assert.match(text.replace(/\\/g, "/"), new RegExp(`git/${ALT_GIT_VERSION.replace(/\./g, "\\.")}/`), `git --exec-path names the Git folder in force: ${text}`);
	});
});
