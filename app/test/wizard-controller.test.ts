import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { validateRecipe } from "../../recipe/validate.mjs";
import type { EngineConfig, EngineEvent } from "../src/main/bootstrap/engine.ts";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { StartFailureError } from "../src/main/runtime/failure.ts";
import { WizardController, type WizardDeps } from "../src/main/wizard/controller.ts";
import type { EngineEnd, EngineHost } from "../src/main/wizard/engine-host.ts";
import { readWizardFile } from "../src/main/wizard/state-file.ts";
import { scratchRoot, testLayout } from "./harness/engine-fixture.ts";
import { FakeAccounts, FakeClaude, FakeLinear } from "./harness/fake-accounts.ts";

// The wizard's step machine (task 9): the steps in order, what is written and when, the refusals, the resume of an install, an engine that crashes, and the sign-in placeholders.

const scratch: string[] = [];
after(() => {
	for (const d of scratch) removeTree(d);
});

const stackFile = new URL("../../stack.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const example = (name: string): string => readFileSync(new URL(`../../recipe/examples/${name}`, import.meta.url), "utf8");
const platform = process.platform === "win32" ? "win32" : "darwin";

type Script = (config: EngineConfig, emit: (e: EngineEvent) => void) => EngineEnd | Promise<EngineEnd>;

class FakeEngine implements EngineHost {
	pid: number | null = null;
	configs: EngineConfig[] = [];
	scripts: Script[] = [];
	run(config: EngineConfig, onEvent: (e: EngineEvent) => void): Promise<EngineEnd> {
		this.configs.push(config);
		const script = this.scripts.shift() ?? (() => ({ kind: "done" as const, ok: true, outcomes: [] }));
		return Promise.resolve(script(config, onEvent));
	}
	cancel(): void {}
	async dispose(): Promise<void> {}
}

const okOutcome = (stage: string) => ({ stage, status: "installed" as const, ms: 1, attempts: 1, fsErrors: [] });

interface MakeOptions {
	start?: () => Promise<unknown>;
	pick?: Partial<WizardDeps>;
}

const stackStopOptions: Array<{ waitForTools?: boolean } | undefined> = [];
const engineJobs: string[] = [];

function make(options: MakeOptions = {}) {
	const made = scratchRoot("sbd-ctl-");
	scratch.push(made.base);
	const layout = testLayout(made.root);
	const engine = new FakeEngine();
	const accounts = new FakeAccounts();
	const claude = new FakeClaude();
	const linear = new FakeLinear();
	const log: Array<Record<string, unknown>> = [];
	let starts = 0;
	const deps: WizardDeps = {
		layout,
		home: made.base,
		platform,
		dev: true,
		bundledStack: stackFile,
		secretPatterns: JSON.parse(readFileSync(new URL("../../recipe/secret-patterns.json", import.meta.url), "utf8")),
		validate: validateRecipe,
		engine,
		supervisor: {
			state: "idle",
			start: async () => {
				starts++;
				await options.start?.();
				return { url: "http://127.0.0.1:1/x/", slotDir: "", server: "started", herdrReused: false, notices: [] };
			},
			engineProxyEnv: async () => ({}),
			withStackStopped: (work, options) => {
				stackStopOptions.push(options);
				return work();
			},
			withEngineJob: (work) => {
				engineJobs.push("job");
				return work();
			},
			repairLock: () => undefined,
		},
		accounts,
		claude,
		linear,
		tttInstalled: () => false,
		osLocale: () => "en",
		pickRecipeFile: async () => null,
		pickFolder: async () => null,
		logTail: () => ["a log line"],
		log: (f) => log.push(f as Record<string, unknown>),
		realpath: (p) => p,
		isFile: () => false,
		...options.pick,
	};
	const controller = new WizardController(deps);
	return { controller, layout, engine, accounts, claude, linear, deps, base: made.base, log, starts: () => starts };
}

const recipeFiles = (layout: { recipe: string }): string[] => (existsSync(layout.recipe) ? readdirSync(layout.recipe) : []);

describe("the steps", () => {
	it("welcome, recipe, trust, folder: nothing is written to the recipe folder before Apply", async () => {
		const w = make();
		const c = w.controller;
		assert.equal(c.view().step, "welcome");
		await c.act({ type: "welcome-next" });
		assert.equal(c.view().step, "recipe");
		await c.act({ type: "recipe-text", name: "waydo.strawboss.json", text: example("team.strawboss.json") });
		assert.equal(c.view().step, "trust");
		const trust = c.view().trust;
		assert.equal(trust?.name, "Waydo PM 工作環境");
		assert.equal(trust?.source, "waydo.strawboss.json");
		assert.deepEqual(recipeFiles(w.layout), [], "the recipe is held in memory until Apply");
		await c.act({ type: "trust-cancel" });
		assert.equal(c.view().step, "recipe");
		assert.equal(c.view().recipe.choice.kind, "none");
		assert.deepEqual(recipeFiles(w.layout), []);
		await c.act({ type: "recipe-text", name: "waydo.strawboss.json", text: example("team.strawboss.json") });
		await c.act({ type: "trust-apply" });
		assert.equal(c.view().step, "folder");
		assert.deepEqual(recipeFiles(w.layout), ["waydo-pm.json"]);
		assert.equal(readFileSync(join(w.layout.recipe, "waydo-pm.json"), "utf8"), example("team.strawboss.json"), "the accepted file is saved as it came");
		assert.equal(readWizardFile(w.layout)?.step, "folder");
	});

	it("a relaunch at the trust step opens on the recipe step, and the trust page always has a way out (T9-F001)", async () => {
		const w = make();
		await w.controller.act({ type: "welcome-next" });
		await w.controller.act({ type: "recipe-text", name: "waydo.strawboss.json", text: example("team.strawboss.json") });
		assert.equal(w.controller.view().step, "trust");
		assert.equal(readWizardFile(w.layout)?.step, "recipe", "the record never holds a step that memory alone can resume");
		const again = new WizardController(w.deps);
		assert.equal(again.view().step, "recipe");
		assert.equal(again.view().trust, null);
		await again.act({ type: "recipe-text", name: "waydo.strawboss.json", text: example("team.strawboss.json") });
		assert.equal(again.view().step, "trust");
		assert.ok(again.view().trust !== null);
	});

	it("the step total is the same at every step and in every kind of run (SA-01)", async () => {
		const full = ["welcome", "recipe", "trust", "folder", "install", "start", "claude", "hosts", "linear", "done"];
		const recipe = make();
		const seen: string[][] = [recipe.controller.view().steps];
		await recipe.controller.act({ type: "welcome-next" });
		seen.push(recipe.controller.view().steps);
		await recipe.controller.act({ type: "recipe-text", name: "waydo.strawboss.json", text: example("team.strawboss.json") });
		seen.push(recipe.controller.view().steps);
		await recipe.controller.act({ type: "trust-apply" });
		seen.push(recipe.controller.view().steps);
		const none = await atFolder();
		seen.push(none.controller.view().steps);
		for (const steps of seen) assert.deepEqual(steps, full);
	});

	it("refuses an invalid recipe with its field and rule, keeps the step, and writes nothing", async () => {
		const w = make();
		await w.controller.act({ type: "welcome-next" });
		await w.controller.act({ type: "recipe-text", name: "bad.json", text: example("invalid/secret-pattern.strawboss.json") });
		const v = w.controller.view();
		assert.equal(v.step, "recipe");
		assert.ok(v.recipe.refused.some((r) => r.rule === "secret-pattern"));
		assert.ok(!JSON.stringify(v).includes("LEAKCHECK123"));
		assert.ok(!JSON.stringify(w.log).includes("LEAKCHECK123"), "the log holds rules and fields, not the file's text");
		assert.deepEqual(recipeFiles(w.layout), []);
		await w.controller.act({ type: "recipe-text", name: "bad.json", text: example("invalid/url-scheme.strawboss.json") });
		assert.ok(w.controller.view().recipe.refused.some((r) => r.rule === "url-scheme"));
		// a recipe-text out of turn is ignored
		const ok = make();
		await ok.controller.act({ type: "recipe-text", name: "x.json", text: example("team.strawboss.json") });
		assert.equal(ok.controller.view().step, "welcome");
	});

	it("the file dialog feeds the same intake, and an unreadable file is a refusal", async () => {
		const w = make({ pick: { pickRecipeFile: async () => ({ name: "acme.json", text: example("github-only.strawboss.json") }) } });
		await w.controller.act({ type: "welcome-next" });
		await w.controller.act({ type: "choose-recipe-file" });
		assert.equal(w.controller.view().step, "trust");
		const bad = make({
			pick: {
				pickRecipeFile: async () => {
					throw new Error("EACCES: /secret/path");
				},
			},
		});
		await bad.controller.act({ type: "welcome-next" });
		await bad.controller.act({ type: "choose-recipe-file" });
		assert.deepEqual(bad.controller.view().recipe.refused, [{ field: "(file)", rule: "unreadable" }]);
	});

	it("'I have no recipe' asks for the hosts and skips the trust step", async () => {
		const w = make();
		await w.controller.act({ type: "welcome-next" });
		await w.controller.act({ type: "no-recipe", github: false, gitlabHost: "" });
		assert.deepEqual(w.controller.view().recipe.refused, [{ field: "forges", rule: "none-chosen" }]);
		await w.controller.act({ type: "no-recipe", github: false, gitlabHost: "not a host!" });
		assert.deepEqual(w.controller.view().recipe.refused, [{ field: "gitlabHost", rule: "bad-host" }]);
		await w.controller.act({ type: "no-recipe", github: true, gitlabHost: "GitLab.Example.COM" });
		const v = w.controller.view();
		assert.equal(v.step, "folder");
		assert.deepEqual(v.hosts.forges, [{ kind: "github", host: "github.com" }, { kind: "gitlab", host: "gitlab.example.com" }]);
		assert.equal(v.linearOffered, true);
	});
});

async function atFolder(extra: MakeOptions = {}) {
	const w = make(extra);
	await w.controller.act({ type: "welcome-next" });
	await w.controller.act({ type: "no-recipe", github: true, gitlabHost: "" });
	return w;
}

describe("the work folder", () => {
	it("defaults to ~/StrawBoss, takes a folder inside the home, and names the problem of one that is not", async () => {
		const picks: string[] = [];
		const w = await atFolder({ pick: { pickFolder: async () => picks.shift() ?? null } });
		assert.equal(w.controller.view().folder.path, join(w.base, "StrawBoss"));
		picks.push("/somewhere/else");
		await w.controller.act({ type: "folder-change" });
		assert.equal(w.controller.view().folder.problem, "outside-home");
		assert.equal(w.controller.view().folder.path, join(w.base, "StrawBoss"), "a refused folder is not taken");
		picks.push(join(w.base, "Documents", "work"));
		await w.controller.act({ type: "folder-change" });
		assert.equal(w.controller.view().folder.problem, null);
		assert.equal(w.controller.view().folder.path, join(w.base, "Documents", "work"));
		await w.controller.act({ type: "folder-default" });
		assert.equal(w.controller.view().folder.path, join(w.base, "StrawBoss"));
		assert.equal(readWizardFile(w.layout)?.workFolder, undefined);
	});

	it("records the folder and starts the install when Install is pressed", async () => {
		const w = await atFolder();
		w.engine.scripts.push((_c, emit) => {
			emit({ type: "stage-start", stage: "preflight" });
			emit({ type: "stage", outcome: okOutcome("preflight") });
			return { kind: "done", ok: true, outcomes: [okOutcome("preflight")] };
		});
		await w.controller.act({ type: "folder-next" });
		assert.equal(readWizardFile(w.layout)?.workFolder, join(w.base, "StrawBoss"));
		assert.equal(w.engine.configs.length, 1);
		assert.equal((w.engine.configs[0] as EngineConfig).root, w.layout.root);
		assert.deepEqual((w.engine.configs[0] as EngineConfig).recipe, { forges: [{ kind: "github", host: "github.com" }], tools: [] });
		assert.equal(w.controller.step, "claude", "install ok, then the stack started, then the first sign-in step");
		assert.equal(w.starts(), 1);
	});
});

describe("the install", () => {
	async function atInstall(scripts: Script[], start?: () => Promise<unknown>) {
		const w = await atFolder(start ? { start } : {});
		w.engine.scripts.push(...scripts);
		await w.controller.act({ type: "folder-next" });
		return w;
	}
	const fail: Script = (_c, emit) => {
		emit({ type: "stage", outcome: { stage: "node", status: "failed", ms: 1, attempts: 2, fsErrors: [], failure: { category: "network", sentence: "x", params: { host: "nodejs.org", cause: "path" }, detail: "ETIMEDOUT" } } });
		return { kind: "done", ok: false, outcomes: [] };
	};

	it("stays on the install step when a stage fails, shows the failure, and Try again resumes", async () => {
		const w = await atInstall([fail]);
		assert.equal(w.controller.step, "install");
		const i = w.controller.view().install;
		assert.equal(i.status, "failed");
		assert.deepEqual(i.failures.map((f) => [f.stage, f.category, f.params.host]), [["node", "network", "nodejs.org"]]);
		assert.deepEqual(i.tail, ["a log line"]);
		assert.equal(w.starts(), 0);
		await w.controller.act({ type: "install-retry" });
		assert.equal(w.controller.step, "claude");
		assert.equal(w.engine.configs.length, 2);
	});

	it("an engine that ends is run again; a second end in the same stage fails that stage", async () => {
		const crash: Script = (_c, emit) => {
			emit({ type: "stage-start", stage: "node" });
			return { kind: "crashed", code: 1 };
		};
		const once = await atInstall([crash]);
		assert.equal(once.engine.configs.length, 2, "resumed after one crash");
		assert.equal(once.controller.step, "claude");
		const twice = await atInstall([crash, crash]);
		assert.equal(twice.controller.step, "install");
		assert.equal(twice.controller.view().install.crashed, "node");
		assert.equal(twice.engine.configs.length, 2);
	});

	it("a run that ends `disposed` (the app is quitting) is not resumed and not counted as a crash (T9-F002)", async () => {
		const w = await atFolder();
		w.engine.scripts.push((_c, emit) => {
			emit({ type: "stage-start", stage: "preflight" });
			return { kind: "disposed" };
		});
		await w.controller.act({ type: "folder-next" });
		assert.equal(w.engine.configs.length, 1, "no second engine");
		assert.equal(w.log.some((l) => l.event === "engine-crashed"), false);
		assert.equal(w.controller.view().install.crashed, null);
		assert.equal(readWizardFile(w.layout)?.step, "install", "the next launch resumes the install");
	});

	it("an engine that refuses (a held lock) is a failure with the message, not a crash", async () => {
		const w = await atInstall([() => ({ kind: "error", name: "EngineLockedError", message: "another engine holds the lock", details: ["d1"] })]);
		assert.equal(w.controller.step, "install");
		assert.equal(w.controller.view().install.failures[0]?.detail, "another engine holds the lock");
	});

	it("a quit during the install and a relaunch open on the install step and finish it", async () => {
		const first = await atFolder();
		// the run never answers: the app quits in the middle of it
		first.engine.scripts.push(() => new Promise<EngineEnd>(() => undefined));
		void first.controller.act({ type: "folder-next" });
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(readWizardFile(first.layout)?.step, "install");
		// the next launch: same root, a new controller
		const second = new WizardController({ ...first.deps, engine: new FakeEngine() });
		assert.equal(second.launchMode(), "wizard");
		assert.equal(second.view().step, "install");
		await second.resume();
		assert.equal(second.step, "claude");
		assert.equal(second.view().install.status, "done");
	});
});

describe("the start step", () => {
	it("shows a failure with its kind and Try again, and Repair when it offers one", async () => {
		let attempts = 0;
		const w = await atFolder({
			start: async () => {
				if (attempts++ === 0) throw new StartFailureError({ kind: "engine-locked", reason: "another engine", offerRepair: true });
			},
		});
		await w.controller.act({ type: "folder-next" });
		assert.equal(w.controller.step, "start");
		const v = w.controller.view().start;
		assert.equal(v.status, "failed");
		assert.deepEqual([v.failure?.kind, v.failure?.offerRepair], ["engine-locked", true]);
		await w.controller.act({ type: "start-retry" });
		assert.equal(w.controller.step, "claude");
	});

	it("Repair runs the engine with the stack stopped and then starts again; a failed engine is a repair-failed screen", async () => {
		let attempts = 0;
		const w = await atFolder({
			start: async () => {
				if (attempts++ === 0) throw new StartFailureError({ kind: "install-interrupted", reason: "x", offerRepair: true });
			},
		});
		await w.controller.act({ type: "folder-next" });
		const before = w.engine.configs.length;
		await w.controller.act({ type: "repair" });
		assert.equal(w.engine.configs.length, before + 1);
		assert.equal(w.controller.step, "claude");
		w.engine.scripts.push((_c, emit) => {
			emit({ type: "stage", outcome: { stage: "pi", status: "failed", ms: 1, attempts: 1, fsErrors: [], failure: { category: "other", sentence: "x", params: { stage: "pi" }, detail: "npm broke" } } });
			return { kind: "done", ok: false, outcomes: [] };
		});
		assert.deepEqual(await w.controller.repair(), { ok: false, failure: { kind: "repair-failed", reason: "npm broke", offerRepair: true } });
	});
});

describe("Repair of a start failure that names one package (R9B-F001, R9B-F006)", () => {
	for (const [kind, stage] of [["loader", "pkg:pi-straw-boss"], ["intercom", "pkg:pi-intercom"]] as const) {
		it(`${kind} forces that package's stage, and the stop waits for leftovers`, async () => {
			let attempts = 0;
			const w = await atFolder({
				start: async () => {
					if (attempts++ === 0) throw new StartFailureError({ kind, reason: "x", offerRepair: true });
				},
			});
			await w.controller.act({ type: "folder-next" });
			stackStopOptions.length = 0;
			await w.controller.act({ type: "repair" });
			assert.deepEqual(w.engine.configs.at(-1)?.forceStages, [stage]);
			assert.equal(w.engine.configs.at(-1)?.force, undefined);
			assert.deepEqual(stackStopOptions, [{ waitForTools: true }]);
		});
	}

	it("a Repair that follows no such failure forces nothing", async () => {
		const w = make();
		await w.controller.repair();
		assert.equal(w.engine.configs.at(-1)?.forceStages, undefined);
		assert.equal((await w.controller.repair("loader")).ok, true);
		assert.deepEqual(w.engine.configs.at(-1)?.forceStages, ["pkg:pi-straw-boss"], "the kind the runtime page showed decides after the wizard");
	});
});

describe("the sign-in steps and the end", () => {
	async function atClaude(host = "gitlab.example.com") {
		const w = make();
		await w.controller.act({ type: "welcome-next" });
		await w.controller.act({ type: "no-recipe", github: true, gitlabHost: host });
		await w.controller.act({ type: "folder-next" });
		return w;
	}

	it("every sign-in step ends in Later, one hosts step per forge, and Linear is offered without a recipe", async () => {
		const w = await atClaude();
		const c = w.controller;
		assert.equal(c.step, "claude");
		await c.act({ type: "later" });
		assert.equal(c.step, "hosts");
		assert.equal(c.view().hosts.index, 0);
		await c.act({ type: "later" });
		assert.equal(c.step, "hosts");
		assert.equal(c.view().hosts.index, 1);
		await c.act({ type: "later" });
		assert.equal(c.step, "linear");
		await c.act({ type: "later" });
		assert.equal(c.step, "done");
		assert.deepEqual(c.later, [{ item: "claude" }, { item: "github", host: "github.com" }, { item: "gitlab", host: "gitlab.example.com" }, { item: "linear" }]);
		let done = 0;
		c.onDone(() => done++);
		await c.act({ type: "finish" });
		assert.equal(c.done, true);
		assert.equal(done, 1);
		assert.equal(readWizardFile(w.layout)?.done, true);
		assert.equal(c.view().step, "launching");
	});

	it("the hosts step runs the checks of the forge on screen when it opens, and again for the next forge", async () => {
		const w = await atClaude();
		const c = w.controller;
		await c.act({ type: "later" });
		assert.deepEqual(w.accounts.begun, ["github.com"], "the first forge's checks start with the step");
		assert.equal(c.view().hosts.current?.flow.phase, "ready");
		await c.act({ type: "later" });
		assert.deepEqual(w.accounts.begun, ["github.com", "gitlab.example.com"]);
		assert.deepEqual(w.accounts.cancelled, ["github.com"], "Later ends a sign-in that waits");
		assert.equal(c.view().hosts.current?.host, "gitlab.example.com");
	});

	it("Next is for a sign-in that passed its verdict, and puts nothing off; Later puts the host off", async () => {
		const w = await atClaude();
		const c = w.controller;
		await c.act({ type: "later" });
		await c.act({ type: "hosts-next" });
		assert.equal(c.view().hosts.index, 0, "no Next before the sign-in is done");
		w.accounts.setFlow("github.com", { phase: "done" });
		await c.act({ type: "hosts-next" });
		assert.equal(c.view().hosts.index, 1);
		assert.deepEqual(c.later, [{ item: "claude" }], "the signed-in forge was not put off");
		await c.act({ type: "later" });
		assert.deepEqual(c.later, [{ item: "claude" }, { item: "gitlab", host: "gitlab.example.com" }]);
	});

	it("a sign-in that passes takes its forge off the list of sign-ins put off, in the wizard and after it", async () => {
		const w = await atClaude();
		const c = w.controller;
		await c.act({ type: "later" });
		await c.act({ type: "later" });
		await c.act({ type: "later" });
		assert.deepEqual(c.later.map((l) => l.item), ["claude", "github", "gitlab"]);
		let changes = 0;
		c.onChange(() => changes++);
		w.accounts.signedIn("github", "github.com");
		assert.deepEqual(c.later, [{ item: "claude" }, { item: "gitlab", host: "gitlab.example.com" }]);
		assert.deepEqual(readWizardFile(w.layout)?.later, c.later, "written to wizard.json");
		assert.ok(changes >= 1);
		w.accounts.signedIn("gitlab", "gitlab.example.com");
		assert.deepEqual(c.later, [{ item: "claude" }]);
	});

	it("forge requests are honored only for a host the recipe listed, with its own kind, and in the shape the page may send", async () => {
		const w = await atClaude();
		const c = w.controller;
		await c.act({ type: "forge-begin", kind: "github", host: "github.com" });
		await c.act({ type: "forge-sign-out", kind: "gitlab", host: "gitlab.example.com" });
		assert.deepEqual(w.accounts.actions.map((a) => a.type), ["forge-begin", "forge-sign-out"]);
		w.accounts.actions.length = 0;
		await c.act({ type: "forge-begin", kind: "github", host: "evil.example.org" });
		await c.act({ type: "forge-begin", kind: "gitlab", host: "github.com" });
		await c.forgeAction({ type: "forge-token", host: "gitlab.example.com", token: "" });
		await c.forgeAction({ type: "forge-token", host: "gitlab.example.com", token: "x".repeat(513) });
		await c.forgeAction({ type: "forge-start", kind: "gitlab", host: "gitlab.example.com" } as never);
		await c.forgeAction({ type: "forge-nope", host: "github.com" } as never);
		await c.forgeAction({ type: "forge-token", host: 7, token: "a" } as never);
		assert.deepEqual(w.accounts.actions, []);
		await c.forgeAction({ type: "forge-token", host: "gitlab.example.com", token: "glpat-x" });
		assert.equal(w.accounts.actions.length, 1);
	});

	it("Later does nothing while a login is being finished, and ends one that waits (T10R-F001)", async () => {
		const w = await atClaude();
		const c = w.controller;
		await c.act({ type: "later" });
		w.accounts.setFlow("github.com", { phase: "working" });
		await c.act({ type: "later" });
		assert.equal(c.view().hosts.index, 0, "still on the host whose login is being recorded");
		assert.deepEqual(w.accounts.cancelled, []);
		assert.deepEqual(c.later, [{ item: "claude" }], "nothing was put off");
		w.accounts.setFlow("github.com", { phase: "code", code: "ABCD-1234", deviceUrl: "https://github.com/login/device" });
		await c.act({ type: "later" });
		assert.equal(c.view().hosts.index, 1);
		assert.deepEqual(w.accounts.cancelled, ["github.com"]);
	});

	it("a token is honored only for a GitLab host: a GitHub host's sign-in is not replaced by one (T10R-F009)", async () => {
		const w = await atClaude();
		await w.controller.forgeAction({ type: "forge-token", host: "github.com", token: "glpat-x" });
		assert.equal(w.accounts.actions.length, 0);
		await w.controller.forgeAction({ type: "forge-token", host: "gitlab.example.com", token: "glpat-x" });
		assert.deepEqual(w.accounts.actions.map((a) => a.type), ["forge-token"]);
	});

	it("a relaunch on the hosts step starts the checks of the forge it stopped at", async () => {
		const w = await atClaude();
		await w.controller.act({ type: "later" });
		const again = make();
		mkdirSync(again.layout.state, { recursive: true });
		writeFileSync(join(again.layout.state, "wizard.json"), JSON.stringify({ schema: 1, step: "hosts", done: false, later: [], hostsIndex: 0, noRecipeForges: [{ kind: "gitlab", host: "gitlab.example.com" }] }));
		const fresh = new WizardController({ ...again.deps });
		await fresh.resume();
		assert.deepEqual(again.accounts.begun, ["gitlab.example.com"]);
	});

	it("an action out of turn does nothing", async () => {
		const w = await atClaude();
		await w.controller.act({ type: "finish" });
		await w.controller.act({ type: "welcome-next" });
		await w.controller.act({ type: "trust-apply" });
		assert.equal(w.controller.step, "claude");
		assert.equal(w.controller.done, false);
	});

	it("a language choice is kept and a relaunch shows it", async () => {
		const w = make();
		await w.controller.act({ type: "set-locale", locale: "zh-TW" });
		assert.equal(w.controller.locale, "zh-TW");
		assert.equal(new WizardController(w.deps).locale, "zh-TW");
		await w.controller.act({ type: "set-locale", locale: "fr" as never });
		assert.equal(w.controller.locale, "zh-TW");
	});
});

describe("the launch", () => {
	it("a root with no wizard record and no install shows the wizard; a finished wizard starts the stack", () => {
		const w = make();
		assert.equal(w.controller.launchMode(), "wizard");
		mkdirSync(w.layout.state, { recursive: true });
		writeFileSync(join(w.layout.state, "wizard.json"), JSON.stringify({ schema: 1, step: "done", done: true, later: [], hostsIndex: 0 }));
		assert.equal(new WizardController(w.deps).launchMode(), "stack");
	});

	it("the Windows welcome screen reports a WSL bash, and Check again looks once more", async () => {
		let wsl = false;
		const w = make({ pick: { checkPane: async () => ({ firstBash: wsl ? "C:\\Windows\\System32\\bash.exe" : "C:\\Git\\bash.exe", wslBash: wsl, machinePi: null, machineBun: null, machineBunx: null }) } });
		await w.controller.scanPane();
		assert.equal(w.controller.view().welcome.wslBash, null);
		wsl = true;
		await w.controller.act({ type: "rescan" });
		assert.equal(w.controller.view().welcome.wslBash, "C:\\Windows\\System32\\bash.exe");
	});
});

describe("the interface language", () => {
	it("asks the OS for its language when it is first needed, not when the controller is built (Electron answers en-US before ready)", () => {
		let asked = 0;
		const w = make({
			pick: {
				osLocale: () => {
					asked++;
					return "zh-TW";
				},
			},
		});
		assert.equal(asked, 0);
		assert.equal(w.controller.locale, "zh-TW");
		assert.equal(w.controller.view().locale, "zh-TW");
		assert.ok(asked >= 1);
	});
});

describe("steps 7 and 9: Claude and Linear (task 11)", () => {
	// One code host (github.com) sits between Claude and Linear.
	async function atClaude() {
		const w = make();
		await w.controller.act({ type: "welcome-next" });
		await w.controller.act({ type: "no-recipe", github: true, gitlabHost: "" });
		await w.controller.act({ type: "folder-next" });
		assert.equal(w.controller.step, "claude");
		return w;
	}

	it("opening the Claude step reads the CLI's status once; a later redraw does not read it again", async () => {
		const w = await atClaude();
		await new Promise((r) => setImmediate(r));
		assert.equal(w.claude.refreshes, 1);
		await w.controller.act({ type: "rescan" });
		assert.equal(w.claude.refreshes, 1, "the state is known now");
	});

	it("Next moves on only when the CLI's status says signed in, and does not put Claude off; Later puts it off and ends a login that waits", async () => {
		const w = await atClaude();
		const c = w.controller;
		await c.act({ type: "step-next" });
		assert.equal(c.step, "claude", "not signed in: Next does nothing");
		w.claude.set({ phase: "browser", url: null, codeAsked: false, codeSent: false }, "not-signed-in");
		w.claude.signedIn();
		await c.act({ type: "step-next" });
		assert.equal(c.step, "claude", "a login still under way is not skipped past");
		w.claude.set({ phase: "done" }, "signed-in");
		await c.act({ type: "step-next" });
		assert.equal(c.step, "hosts", "on to the code hosts");
		assert.deepEqual(c.later, [], "nothing was put off");

		const later = await atClaude();
		later.claude.set({ phase: "browser", url: "https://claude.ai/x", codeAsked: true, codeSent: false }, "not-signed-in");
		await later.controller.act({ type: "later" });
		assert.equal(later.claude.cancels, 1, "the login that waited ended with the choice");
		assert.deepEqual(later.controller.later, [{ item: "claude" }]);
	});

	it("Later waits while the CLI's status is read after a login ended", async () => {
		const w = await atClaude();
		w.claude.set({ phase: "working" }, "not-signed-in");
		await w.controller.act({ type: "later" });
		assert.equal(w.controller.step, "claude");
		assert.equal(w.claude.cancels, 0);
	});

	it("a Claude sign-in that is done takes Claude off the list of those put off", async () => {
		const w = await atClaude();
		await w.controller.act({ type: "later" });
		assert.deepEqual(w.controller.later, [{ item: "claude" }]);
		w.claude.signedIn();
		assert.deepEqual(w.controller.later, []);
	});

	it("the Linear step: Next needs a saved key and no setup running; Later puts Linear off and resets the screen; a saved key takes it off the list", async () => {
		const w = await atClaude();
		const c = w.controller;
		await c.act({ type: "later" });
		await c.act({ type: "later" });
		assert.equal(c.step, "linear");
		await c.act({ type: "step-next" });
		assert.equal(c.step, "linear", "no key saved");
		w.linear.set({ phase: "initializing" }, "saved");
		await c.act({ type: "step-next" });
		await c.act({ type: "later" });
		assert.equal(c.step, "linear", "a setup under way is neither skipped nor cut off");
		w.linear.set({ phase: "done", initialized: "ran" }, "saved");
		await c.act({ type: "step-next" });
		assert.equal(c.step, "done");
		assert.equal(w.linear.resets, 1);
		assert.deepEqual(c.later, [{ item: "claude" }, { item: "github", host: "github.com" }]);

		const off = await atClaude();
		for (let i = 0; i < 3; i++) await off.controller.act({ type: "later" });
		assert.deepEqual(off.controller.later.map((l) => l.item), ["claude", "github", "linear"]);
		off.linear.saved();
		assert.deepEqual(off.controller.later.map((l) => l.item), ["claude", "github"]);
	});

	it("the OS is asked whether it can encrypt when the Linear step opens, not before", async () => {
		const w = await atClaude();
		await new Promise((r) => setImmediate(r));
		assert.equal(w.linear.probes, 0, "the Claude step does not ask");
		await w.controller.act({ type: "later" });
		await w.controller.act({ type: "later" });
		assert.equal(w.controller.step, "linear");
		await new Promise((r) => setImmediate(r));
		assert.equal(w.linear.probes, 1);
	});

	it("a relaunch on a sign-in step starts what the step shows at once, without waiting for the stack to start", async () => {
		const w = await atClaude();
		await w.controller.act({ type: "later" });
		await w.controller.act({ type: "later" });
		assert.equal(w.controller.step, "linear");
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => (release = resolve));
		const again = make({ pick: { layout: w.layout, home: w.base } as Partial<WizardDeps>, start: () => held });
		// The same wizard.json: a controller made on the same layout opens on the same step.
		assert.equal(again.controller.step, "linear");
		const resuming = again.controller.resume();
		await new Promise((r) => setImmediate(r));
		assert.equal(again.linear.probes, 1, "asked while the stack is still starting");
		release();
		await resuming;
	});

	it("R11-F001: a start that fails while the PM is on the Linear step is shown there, and Try again and Repair work from it", async () => {
		const w = await atClaude();
		await w.controller.act({ type: "later" });
		await w.controller.act({ type: "later" });
		assert.equal(w.controller.step, "linear");
		let attempts = 0;
		const again = make({
			pick: { layout: w.layout, home: w.base } as Partial<WizardDeps>,
			start: async () => {
				if (attempts++ === 0) throw new StartFailureError({ kind: "engine-locked", reason: "another engine", offerRepair: true });
			},
		});
		await again.controller.resume();
		assert.equal(again.controller.step, "linear", "the failed start does not move the PM off the step");
		const failed = again.controller.view().start;
		assert.deepEqual([failed.status, failed.failure?.kind, failed.failure?.offerRepair], ["failed", "engine-locked", true]);
		const before = again.engine.configs.length;
		await again.controller.act({ type: "repair" });
		assert.equal(again.engine.configs.length, before + 1, "Repair ran from the Linear step");
		assert.equal(again.controller.view().start.status, "idle");
		assert.equal(again.controller.step, "linear");
		// Without a failed start, neither action does anything on this step.
		const calls = again.starts();
		await again.controller.act({ type: "start-retry" });
		assert.equal(again.starts(), calls);
	});

	it("R11-F001: the install of ttt is a job of the supervisor's queue", async () => {
		const w = await atClaude();
		engineJobs.length = 0;
		w.engine.scripts.push(() => ({ kind: "done" as const, ok: true, outcomes: [okOutcome("ttt")] }));
		await w.controller.installTtt();
		assert.deepEqual(engineJobs, ["job"]);
	});

	it("account actions are checked: a malformed one is dropped, a Linear one is dropped where Linear is not offered, a Claude one reaches the sign-in", async () => {
		const w = await atClaude();
		await w.controller.accountAction({ type: "claude-code", code: 5 } as never);
		await w.controller.accountAction({ type: "nonsense" } as never);
		assert.deepEqual(w.claude.actions, []);
		await w.controller.accountAction({ type: "claude-start" });
		assert.deepEqual(w.claude.actions, [{ type: "claude-start" }]);
		await w.controller.accountAction({ type: "linear-save", key: "lin_api_DUMMYDUMMY1234" });
		assert.equal(w.linear.actions.length, 1, "Linear is offered without a recipe");
	});

	it("installTtt runs the engine with only the ttt stage, and says why when it fails", async () => {
		const w = await atClaude();
		w.engine.scripts.push(() => ({ kind: "done" as const, ok: true, outcomes: [okOutcome("ttt")] }));
		assert.deepEqual(await w.controller.installTtt(), { ok: true, detail: "" });
		const config = w.engine.configs.at(-1) as EngineConfig;
		assert.deepEqual(config.only, ["ttt"]);
		assert.equal(config.ttt, true);
		w.engine.scripts.push(() => ({ kind: "done" as const, ok: false, outcomes: [{ ...okOutcome("ttt"), status: "failed" as const, failure: { stage: "ttt", category: "network" as const, sentence: "npm could not reach the registry", detail: "ENOTFOUND", params: {} } }] }));
		const failed = await w.controller.installTtt();
		assert.equal(failed.ok, false);
		assert.match(failed.detail, /registry|ENOTFOUND/);
		w.engine.scripts.push(() => ({ kind: "error" as const, name: "Error", message: "engine exploded\nstack", details: [] }));
		assert.deepEqual(await w.controller.installTtt(), { ok: false, detail: "engine exploded" });
	});
});
