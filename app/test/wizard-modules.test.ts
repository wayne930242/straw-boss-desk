import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { validateRecipe } from "../../recipe/validate.mjs";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { parseStack, platformKey } from "../src/main/bootstrap/stack.ts";
import { UtilityEngineHost, type UtilityChild } from "../src/main/wizard/engine-host.ts";
import { workFolderProblem } from "../src/main/wizard/folder.ts";
import { InstallProgress } from "../src/main/wizard/install-progress.ts";
import { intakeRecipe, plainFileName } from "../src/main/wizard/recipe-intake.ts";
import { loadActiveStack } from "../src/main/wizard/stack-source.ts";
import { FRESH, parseWizardFile, readWizardFile, writeWizardFile } from "../src/main/wizard/state-file.ts";
import { olderVersion, trustModelOf } from "../src/main/wizard/trust.ts";
import type { EngineEvent, EngineRequest } from "../src/main/bootstrap/engine.ts";
import { scratchRoot, testLayout } from "./harness/engine-fixture.ts";

// The wizard's pure modules (task 9): the state file, the stack source, the recipe intake and the trust model, the folder rule, the install list, and the engine host.

const scratch: string[] = [];
after(() => {
	for (const d of scratch) removeTree(d);
});
const world = () => {
	const made = scratchRoot("sbd-wiz-");
	scratch.push(made.base);
	return { ...made, layout: testLayout(made.root) };
};
const realStackFile = new URL("../../stack.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const stack = parseStack(JSON.parse(readFileSync(realStackFile, "utf8")));
const key = platformKey(process.platform, process.arch);
const example = (name: string): string => readFileSync(new URL(`../../recipe/examples/${name}`, import.meta.url), "utf8");

describe("state/wizard.json", () => {
	it("round-trips, and drops a field of the wrong shape instead of trusting it", () => {
		const w = world();
		assert.equal(readWizardFile(w.layout), null);
		writeWizardFile(w.layout, { ...FRESH, step: "install", locale: "zh-TW", workFolder: "/x/y", later: [{ item: "claude" }, { item: "gitlab", host: "g.example" }], noRecipeForges: [{ kind: "github", host: "github.com" }] });
		const back = readWizardFile(w.layout);
		assert.equal(back?.step, "install");
		assert.equal(back?.locale, "zh-TW");
		assert.deepEqual(back?.later, [{ item: "claude" }, { item: "gitlab", host: "g.example" }]);
		const messy = parseWizardFile(JSON.stringify({ schema: 1, step: "nonsense", locale: "fr", later: [{ item: "github" }, { item: "linear" }, 4], hostsIndex: -3, workFolder: 5 }));
		assert.deepEqual(messy, { schema: 1, step: "welcome", done: false, later: [{ item: "linear" }], hostsIndex: 0 });
		// The trust step holds a recipe that only memory has, so a record at `trust` opens on the recipe step (T9-F001).
		assert.equal(parseWizardFile(JSON.stringify({ schema: 1, step: "trust", later: [] }))?.step, "recipe");
		assert.equal(parseWizardFile(JSON.stringify({ schema: 1, step: "folder", later: [] }))?.step, "folder");
		assert.equal(parseWizardFile("not json"), null);
		assert.equal(parseWizardFile(JSON.stringify({ schema: 2 })), null);
	});

	it("is the file runtime/config.ts reads the work folder from", async () => {
		const w = world();
		writeWizardFile(w.layout, { ...FRESH, workFolder: join(w.base, "work") });
		const { loadStartConfig } = await import("../src/main/runtime/config.ts");
		assert.equal(loadStartConfig(w.layout, w.base).workFolder, join(w.base, "work"));
	});
});

describe("the stack source", () => {
	it("seeds stack/active.json from the bundled file, and never lowers a higher generation", () => {
		const w = world();
		const first = loadActiveStack(w.layout, realStackFile);
		assert.equal(first.seeded, true);
		assert.ok(existsSync(join(w.layout.stack, "active.json")));
		const again = loadActiveStack(w.layout, realStackFile);
		assert.equal(again.seeded, false);
		const higher = { ...(first.raw as Record<string, unknown>), generation: first.stack.generation + 5 };
		writeFileSync(join(w.layout.stack, "active.json"), JSON.stringify(higher));
		assert.equal(loadActiveStack(w.layout, realStackFile).stack.generation, first.stack.generation + 5);
		writeFileSync(join(w.layout.stack, "active.json"), "damaged");
		assert.equal(loadActiveStack(w.layout, realStackFile).seeded, true);
	});

	it("throws when the bundled file is missing", () => {
		const w = world();
		assert.throws(() => loadActiveStack(w.layout, join(w.base, "nope.json")), /bundled stack\.json is missing/);
	});
});

describe("the recipe intake", () => {
	it("accepts the example, keeps its text and the SHA256 of its bytes", () => {
		const text = example("team.strawboss.json");
		const r = intakeRecipe(validateRecipe, stack, "C:\\Users\\x\\waydo-pm.strawboss.json", text);
		assert.ok(r.ok);
		assert.equal(r.text, text);
		assert.equal(r.fileName, "waydo-pm.strawboss.json");
		assert.match(r.sha256, /^[0-9a-f]{64}$/);
	});

	it("refuses each invalid example with its field and rule, and never shows a value", () => {
		const secret = intakeRecipe(validateRecipe, stack, "x.json", example("invalid/secret-pattern.strawboss.json"));
		const scheme = intakeRecipe(validateRecipe, stack, "x.json", example("invalid/url-scheme.strawboss.json"));
		for (const r of [secret, scheme]) {
			assert.equal(r.ok, false);
			assert.ok(!r.ok && r.refused.length > 0);
			assert.ok(!r.ok && r.refused.every((e) => Object.keys(e).sort().join() === "field,rule"));
			assert.ok(!JSON.stringify(r).includes("LEAKCHECK123"), "the planted value is nowhere in the refusal");
		}
		assert.ok(!secret.ok && secret.refused.some((e) => e.rule === "secret-pattern"));
		assert.ok(!scheme.ok && scheme.refused.some((e) => e.field.startsWith("repos[0]") && e.rule === "url-scheme"));
	});

	it("refuses a name the stack reserves and a tool it does not list", () => {
		const base = JSON.parse(example("team.strawboss.json")) as Record<string, unknown>;
		const unknownTool = intakeRecipe(validateRecipe, stack, "x.json", JSON.stringify({ ...base, tools: ["deno"] }));
		assert.ok(!unknownTool.ok && unknownTool.refused.some((e) => e.rule === "unknown-tool"));
	});

	it("cuts a file name to a plain short one", () => {
		assert.equal(plainFileName("/a/b/c.json"), "c.json");
		assert.equal(plainFileName("a\u0007b\\c\u0000.json"), "c.json");
		assert.equal(plainFileName("x".repeat(500)).length, 120);
		assert.equal(plainFileName(""), "recipe.strawboss.json");
	});
});

describe("the trust model", () => {
	it("lists everything the recipe sets up", () => {
		const r = intakeRecipe(validateRecipe, stack, "waydo.json", example("team.strawboss.json"));
		assert.ok(r.ok);
		const t = trustModelOf({ recipe: r.recipe, stack, key, fileName: r.fileName, sha256: r.sha256 });
		assert.equal(t.name, r.recipe.name);
		assert.deepEqual(t.forges.map((f) => `${f.kind}:${f.host}:${f.cli}`), ["github:github.com:gh", "gitlab:gitlab.waydo.example:glab"]);
		assert.deepEqual(t.repos.map((x) => [x.host, x.folder, x.defaultBranch]), [["gitlab.waydo.example", "web", "develop"], ["github.com", "handbook", null]]);
		assert.equal(t.relay, "https://relay.waydo.example/", "the validator returns the normalized href, the form the trust screen shows");
		assert.deepEqual(t.tools, [{ name: "bun", version: stack.optionalTools.bun?.assets[key]?.version ?? null }]);
		assert.ok(t.tools[0]?.version, "the pinned version is shown");
		assert.match(t.instructions ?? "", /Waydo/);
		assert.equal(t.linear, true);
		assert.equal(t.sha256, r.sha256);
	});

	it("flags a profile pin older than the app's own", () => {
		assert.equal(olderVersion("0.0.9", "0.1.0"), true);
		assert.equal(olderVersion("0.1.0", "0.1.0"), false);
		assert.equal(olderVersion("1.0.0", "0.9.9"), false);
	});
});

describe("the work folder rule", () => {
	const base = { home: "/Users/pm", root: "/Users/pm/Library/Application Support/straw-boss-desk", platform: "darwin" as const, realpath: (p: string) => p, isFile: () => false };
	it("takes a folder inside the home and refuses the rest", () => {
		assert.equal(workFolderProblem({ ...base, path: "/Users/pm/StrawBoss" }), null);
		assert.equal(workFolderProblem({ ...base, path: "/Users/pm/Documents/work" }), null);
		assert.equal(workFolderProblem({ ...base, path: "/Users/pm" }), "is-home");
		assert.equal(workFolderProblem({ ...base, path: "/Users/other/x" }), "outside-home");
		assert.equal(workFolderProblem({ ...base, path: "/tmp/x" }), "outside-home");
		assert.equal(workFolderProblem({ ...base, path: "relative/dir" }), "not-absolute");
		assert.equal(workFolderProblem({ ...base, path: "/Users/pm/Library/Application Support/straw-boss-desk/work" }), "inside-app-data");
		assert.equal(workFolderProblem({ ...base, path: "/Users/pm/file.txt", isFile: () => true }), "not-a-folder");
	});

	it("compares Windows paths without regard to case", () => {
		const win = { home: "C:\\Users\\PM", root: "C:\\Users\\PM\\AppData\\Local\\straw-boss-desk", platform: "win32" as const, realpath: (p: string) => p, isFile: () => false };
		assert.equal(workFolderProblem({ ...win, path: "c:\\users\\pm\\StrawBoss" }), null);
		assert.equal(workFolderProblem({ ...win, path: "D:\\work" }), "outside-home");
		assert.equal(workFolderProblem({ ...win, path: "C:\\Users\\PM" }), "is-home");
	});
});

describe("the install list", () => {
	it("follows the engine's events from waiting to done, and records a failure", () => {
		const p = new InstallProgress();
		p.begin(["preflight", "node", "git"]);
		assert.deepEqual(p.view().stages.map((s) => s.badge), ["waiting", "waiting", "waiting"]);
		p.apply({ type: "stage-start", stage: "preflight" });
		assert.equal(p.view().current, "preflight");
		p.apply({ type: "stage", outcome: { stage: "preflight", status: "installed", ms: 1, attempts: 1, fsErrors: [] } });
		p.apply({ type: "stage", outcome: { stage: "node", status: "skipped-verified", ms: 1, attempts: 1, fsErrors: [] } });
		p.apply({ type: "stage", outcome: { stage: "git", status: "failed", ms: 1, attempts: 2, fsErrors: [], failure: { category: "network", sentence: "x", params: { host: "h.example" }, detail: "boom" } } });
		const v = p.view();
		assert.deepEqual(v.stages.map((s) => s.badge), ["done", "skipped", "failed"]);
		assert.deepEqual(v.failures, [{ stage: "git", category: "network", params: { host: "h.example" }, detail: "boom" }]);
		p.finish(false, ["t1"]);
		assert.equal(p.view().status, "failed");
		assert.deepEqual(p.view().tail, ["t1"]);
	});

	it("adds a stage the plan did not know, and fails a stage a second crash ended", () => {
		const p = new InstallProgress();
		p.begin(["node"]);
		p.apply({ type: "stage-start", stage: "extra" });
		assert.equal(p.working, "extra");
		p.crashFailed("extra");
		assert.equal(p.view().crashed, "extra");
		assert.equal(p.view().stages.find((s) => s.name === "extra")?.badge, "failed");
	});
});

class FakeChild implements UtilityChild {
	pid: number | undefined = 4321;
	killed = 0;
	posted: EngineRequest[] = [];
	#message: Array<(m: EngineEvent) => void> = [];
	#exit: Array<(c: number) => void> = [];
	postMessage(m: EngineRequest): void {
		this.posted.push(m);
	}
	on(event: "message" | "exit", listener: ((m: EngineEvent) => void) & ((c: number) => void)): void {
		if (event === "message") this.#message.push(listener);
		else this.#exit.push(listener);
	}
	kill(): boolean {
		this.killed++;
		queueMicrotask(() => this.end(0));
		return true;
	}
	say(m: EngineEvent): void {
		for (const l of this.#message) l(m);
	}
	end(code: number): void {
		for (const l of this.#exit) l(code);
	}
}

describe("the engine host", () => {
	const config = { root: "/r", stack: {}, secretPatterns: {} };
	it("posts the run when the engine is ready, passes events on, and ends the child when the run is done", async () => {
		const child = new FakeChild();
		const host = new UtilityEngineHost({ fork: () => child });
		const heard: string[] = [];
		const run = host.run(config, (e) => heard.push(e.type));
		assert.equal(host.pid, 4321);
		assert.deepEqual(child.posted, []);
		child.say({ type: "ready" });
		assert.deepEqual(child.posted, [{ type: "run", config }]);
		child.say({ type: "stage-start", stage: "node" });
		child.say({ type: "done", ok: true, outcomes: [] });
		assert.deepEqual(await run, { kind: "done", ok: true, outcomes: [] });
		assert.deepEqual(heard, ["stage-start", "done"]);
		assert.equal(child.killed, 1);
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(host.pid, null);
	});

	it("starts the next run as soon as a run is done, before its process has exited (the update's rollback run follows the failed one at once)", async () => {
		const first = new FakeChild();
		// Killed, but exiting later than the next run starts.
		first.kill = () => {
			first.killed++;
			return true;
		};
		const second = new FakeChild();
		const children = [first, second];
		const host = new UtilityEngineHost({ fork: () => children.shift() as FakeChild });
		const runA = host.run(config, () => undefined);
		first.say({ type: "ready" });
		first.say({ type: "done", ok: false, outcomes: [] });
		assert.equal((await runA).kind, "done");
		// `first` has not emitted its exit: a slow platform is still tearing the process down.
		const runB = host.run(config, () => undefined);
		second.say({ type: "ready" });
		assert.deepEqual(second.posted, [{ type: "run", config }]);
		second.say({ type: "done", ok: true, outcomes: [] });
		assert.deepEqual(await runB, { kind: "done", ok: true, outcomes: [] });
		first.end(0);
		assert.equal(host.pid, null, "the first process's late exit does not touch the second run");
	});

	it("reports an error event, and a process that ends before it is done", async () => {
		const a = new FakeChild();
		const hostA = new UtilityEngineHost({ fork: () => a });
		const runA = hostA.run(config, () => undefined);
		a.say({ type: "ready" });
		a.say({ type: "error", name: "EngineLockedError", message: "locked", details: ["d"] });
		assert.deepEqual(await runA, { kind: "error", name: "EngineLockedError", message: "locked", details: ["d"] });
		const b = new FakeChild();
		const hostB = new UtilityEngineHost({ fork: () => b });
		const runB = hostB.run(config, () => undefined);
		b.say({ type: "ready" });
		b.end(7);
		assert.deepEqual(await runB, { kind: "crashed", code: 7 });
	});

	it("refuses a second run while one is active, asks the engine to cancel, and disposes the child", async () => {
		const child = new FakeChild();
		const host = new UtilityEngineHost({ fork: () => child, cancelWaitMs: 20, exitWaitMs: 50 });
		const run = host.run(config, () => undefined);
		await assert.rejects(host.run(config, () => undefined), /already active/);
		host.cancel();
		assert.deepEqual(child.posted.at(-1), { type: "cancel" });
		await host.dispose();
		assert.ok(child.killed >= 1);
		assert.equal((await run).kind, "disposed");
	});

	it("dispose asks the run to cancel first, waits for it to end by itself, and does not kill a process that left (T9-F002)", async () => {
		const child = new FakeChild();
		child.kill = () => {
			child.killed++;
			return true;
		};
		const host = new UtilityEngineHost({ fork: () => child, cancelWaitMs: 500, exitWaitMs: 50 });
		const run = host.run(config, () => undefined);
		child.say({ type: "ready" });
		const disposing = host.dispose();
		assert.deepEqual(child.posted.at(-1), { type: "cancel" });
		assert.equal(child.killed, 0, "nothing is killed while the cancelled run can still end");
		// The engine answers the cancel and leaves.
		child.say({ type: "done", ok: false, outcomes: [] });
		child.end(0);
		await disposing;
		assert.equal((await run).kind, "done");
		assert.equal(child.killed, 1, "only the host's own end-of-run kill, which is a no-op for a process that left");
	});

	it("dispose kills a run that ignores the cancel, and that end is `disposed`, not `crashed` (T9-F002)", async () => {
		const child = new FakeChild();
		const host = new UtilityEngineHost({ fork: () => child, cancelWaitMs: 20, exitWaitMs: 50 });
		const run = host.run(config, () => undefined);
		child.say({ type: "ready" });
		await host.dispose();
		assert.ok(child.killed >= 1);
		assert.deepEqual(await run, { kind: "disposed" });
	});

	it("refuses a run after dispose, and does not post the run of an engine that became ready after it (T9-F002)", async () => {
		const early = new FakeChild();
		const a = new UtilityEngineHost({ fork: () => early, cancelWaitMs: 10, exitWaitMs: 20 });
		const runA = a.run(config, () => undefined);
		await a.dispose();
		early.say({ type: "ready" });
		assert.equal(early.posted.some((m) => m.type === "run"), false, "the run the quit cancelled is never started");
		assert.deepEqual(await runA, { kind: "disposed" });
		await assert.rejects(a.run(config, () => undefined), /disposed/);
	});
});
