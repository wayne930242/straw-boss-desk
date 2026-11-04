import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { StageError } from "../src/main/bootstrap/errors.ts";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { parseStack, platformKey } from "../src/main/bootstrap/stack.ts";
import { activateDir, detectFromRecord, fileKey, installDir, type Stage, type StageContext } from "../src/main/bootstrap/stage.ts";
import { StateStore } from "../src/main/bootstrap/state.ts";
import { toolPathsStage } from "../src/main/bootstrap/stages/paths-launchers.ts";
import { toolExecutable } from "../src/main/paths.ts";
import { StackUpdater, stackFiles, type EngineRunResult } from "../src/main/update/stack.ts";
import { scratchRoot, testEngine, testLayout, testPlatform } from "./harness/engine-fixture.ts";

// The stack update against the real engine and the real `tool-paths` stage, with stand-in tools (task 13): an applied candidate that changes the Node, Git and gh versions rewrites
// `paths.sh` (and `paths.cmd` on Windows), and a candidate whose `pi` stage fails leaves them naming the old folders again. The panes that read these files are the e2e's.

const key = platformKey(process.platform, process.arch);
const platform = process.platform === "win32" ? "win32" : "darwin";
const scratch: string[] = [];
after(() => {
	for (const d of scratch) removeTree(d);
});

const asset = (version: string) => ({ version, url: "http://127.0.0.1:9/never-fetched", sha256: "0".repeat(64), file: "x.zip" });
const stackOf = (generation: number, versions: { node: string; git: string; gh: string; pi: string }): Record<string, unknown> => ({
	schema: 1,
	generation,
	minShell: "0.0.1",
	tools: Object.fromEntries(["node", "git", "herdr", "gh"].map((tool) => [tool, { assets: { [key]: asset(tool === "herdr" ? "0.9.5" : versions[tool as "node" | "git" | "gh"]) } }])),
	optionalTools: {},
	npmGlobal: [],
	profile: { name: "p", version: "0.0.1", integrity: "sha512-x" },
	piPackages: [{ name: "pi-x", version: versions.pi, integrity: "sha512-x" }],
});

/** A stage that "installs" a tool: a file where the real archive's executable would be, in the folder of the pinned version. */
function fakeTool(tool: string): Stage {
	const exe = toolExecutable(platform, tool);
	const version = (ctx: StageContext): string => {
		const v = ctx.stack.tools[tool]?.assets[ctx.key]?.version;
		if (v === undefined) throw new Error(`no ${tool}`);
		return v;
	};
	const staging = (ctx: StageContext): string => `${installDir(ctx.layout, tool, version(ctx))}.staging`;
	return {
		name: tool,
		needs: [],
		plannedVersion: version,
		detect: (ctx) => detectFromRecord(ctx, { version: version(ctx), tool }),
		async install(ctx) {
			const file = join(ctx.freshStaging(staging(ctx)), ...exe.split("/"));
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, `${tool} ${version(ctx)}\n`);
		},
		async verify(ctx) {
			const final = fileKey(ctx.layout, join(installDir(ctx.layout, tool, version(ctx)), ...exe.split("/")));
			return { text: `${tool} ${version(ctx)}`, version: version(ctx), files: [final], stagedFiles: { [final]: join(staging(ctx), ...exe.split("/")) } };
		},
		async activate(ctx, evidence) {
			await activateDir(ctx, { tool, version: evidence.version, staging: staging(ctx) });
		},
	};
}

/** The `pi` stage: it fails (the registry's integrity check) for the version `9.9.9`. */
const fakePi = (): Stage => {
	const wanted = (ctx: StageContext): string => ctx.stack.piPackages[0]?.version ?? "0";
	return {
		name: "pi",
		needs: ["node"],
		plannedVersion: wanted,
		detect: (ctx) => detectFromRecord(ctx, { version: wanted(ctx) }),
		async install(ctx) {
			if (wanted(ctx) === BROKEN) throw new StageError("registry", { what: `pi-x@${BROKEN}`, stage: "pi" }, `the registry's integrity for pi-x@${BROKEN} is not the pin`);
		},
		verify: async (ctx) => ({ text: `pi ${wanted(ctx)}`, version: wanted(ctx) }),
		async activate() {},
	};
};

const BROKEN = "9.9.9";
const V1 = { node: "1.0.0", git: "1.0.0", gh: "1.0.0", pi: "1.0.0" };
const V2 = { node: "2.0.0", git: "2.0.0", gh: "2.0.0", pi: "2.0.0" };

async function rig() {
	const { base, root } = scratchRoot("sbd-upe-");
	scratch.push(base);
	const layout = testLayout(root);
	mkdirSync(layout.stack, { recursive: true });
	const files = stackFiles(layout);
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const keys = [publicKey.export({ type: "spki", format: "der" }).toString("base64")];
	const stages = (): Stage[] => [fakeTool("node"), fakeTool("git"), fakeTool("herdr"), fakeTool("gh"), fakePi(), toolPathsStage(layout.platform, { clis: ["gh"], optional: [] })];
	const engine = testEngine(root, stages);
	const runEngine = async (raw: unknown): Promise<EngineRunResult> => {
		const run = await engine.run(parseStack(raw));
		if (run.ok) return { ok: true };
		const failed = Object.values(run.outcomes).find((o) => o.status === "failed");
		return { ok: false, failed: { stage: failed?.stage ?? "engine", category: failed?.failure?.category ?? "other" } };
	};
	// The first install: generation 1.
	const first = stackOf(1, V1);
	writeFileSync(files.active, `${JSON.stringify(first, null, "\t")}\n`);
	assert.equal((await runEngine(first)).ok, true);
	const served = new Map<string, Buffer>();
	const updater = new StackUpdater({
		layout,
		shellVersion: "0.0.1",
		key,
		keys,
		base: "https://feed.test/",
		fetchBytes: async (url) => ({ status: served.has(url) ? 200 : 404, body: served.get(url) ?? Buffer.alloc(0) }),
		runEngine,
		withStackStopped: (work) => work(),
		recipeTools: () => [],
		reloadStack: () => undefined,
		log: () => undefined,
	});
	const publish = (value: unknown): void => {
		const bytes = Buffer.from(`${JSON.stringify(value, null, "\t")}\n`);
		served.set("https://feed.test/stack.json", bytes);
		served.set("https://feed.test/stack.json.sig", Buffer.from(cryptoSign(null, bytes, privateKey).toString("base64")));
	};
	const pathsText = (name: string): string => readFileSync(join(layout.tools.bin, name), "utf8");
	const current = (): { versions: Record<string, string> } => JSON.parse(readFileSync(join(layout.state, "current.json"), "utf8")) as { versions: Record<string, string> };
	return { layout, files, updater, publish, pathsText, current };
}

const pathFileNames = platform === "win32" ? ["paths.sh", "paths.cmd"] : ["paths.sh"];

describe("a stack update against the real engine and the real tool-paths stage", () => {
	it("an applied candidate that changes Node, Git and gh rewrites paths.sh (and paths.cmd), and prune leaves them naming the new folders", async () => {
		const t = await rig();
		const before = Object.fromEntries(pathFileNames.map((n) => [n, t.pathsText(n)]));
		for (const n of pathFileNames) assert.match(before[n] as string, /1\.0\.0/);
		t.publish(stackOf(2, V2));
		await t.updater.check();
		assert.equal(t.updater.state.phase, "available");
		await t.updater.apply();
		assert.equal(t.updater.state.phase, "applied", JSON.stringify(t.updater.state));
		assert.deepEqual({ node: t.current().versions.node, git: t.current().versions.git, gh: t.current().versions.gh }, { node: "2.0.0", git: "2.0.0", gh: "2.0.0" });
		for (const n of pathFileNames) {
			const text = t.pathsText(n);
			assert.notEqual(text, before[n], `${n} was rewritten`);
			assert.match(text, /node[\\/]2\.0\.0/);
			assert.match(text, /git[\\/]2\.0\.0/);
			assert.match(text, /gh[\\/]2\.0\.0/);
			assert.doesNotMatch(text, /(?:node|git|gh)[\\/]1\.0\.0/);
		}
		// The next successful start deletes the previous versions; the files still name the new ones.
		const store = new StateStore(t.layout);
		for (const tool of ["node", "git", "gh"]) await store.pruneInactive(tool, testPlatform().processes);
		for (const tool of ["node", "git", "gh"]) assert.equal(existsSync(join(t.layout.tools.root, tool, "1.0.0")), false, `${tool} 1.0.0 is gone`);
		for (const n of pathFileNames) assert.match(t.pathsText(n), /node[\\/]2\.0\.0/);
	});

	it("a candidate whose pi stage fails is rolled back: the report names pi, current.json and the path files name the old folders again, and active.json stays", async () => {
		const t = await rig();
		const before = Object.fromEntries(pathFileNames.map((n) => [n, t.pathsText(n)]));
		const activeBefore = readFileSync(t.files.active, "utf8");
		t.publish(stackOf(2, { ...V2, pi: BROKEN }));
		await t.updater.check();
		await t.updater.apply();
		const state = t.updater.state;
		assert.equal(state.phase, "rolled-back", JSON.stringify(state));
		assert.equal((state as { stage: string }).stage, "pi");
		assert.equal((state as { category: string }).category, "registry");
		assert.equal((state as { restored: boolean }).restored, true);
		assert.deepEqual({ node: t.current().versions.node, git: t.current().versions.git, gh: t.current().versions.gh }, { node: "1.0.0", git: "1.0.0", gh: "1.0.0" });
		for (const n of pathFileNames) assert.equal(t.pathsText(n), before[n], `${n} names the old folders again`);
		assert.equal(readFileSync(t.files.active, "utf8"), activeBefore);
		// The old versions never left: a pane that opens now resolves them.
		for (const tool of ["node", "git", "gh"]) assert.ok(existsSync(join(t.layout.tools.root, tool, "1.0.0")), `${tool} 1.0.0 is still there`);
	});
});
