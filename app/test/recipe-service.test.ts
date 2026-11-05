import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { validateRecipe } from "../../recipe/validate.mjs";
import type { Recipe } from "../../recipe/validate.d.mts";
import { parseStack } from "../src/main/bootstrap/stack.ts";
import { FetchRefused } from "../src/main/net/safe-fetch.ts";
import { recipeChanges, needsInstall, repoSpecs } from "../src/main/recipe/diff.ts";
import { RecipeService, type RecipeServiceDeps } from "../src/main/recipe/service.ts";
import { RecipeMemoStore } from "../src/main/recipe/store.ts";
import type { RepoSpec } from "../src/main/projects/runner.ts";
import { intakeRecipe, type Intake } from "../src/main/wizard/recipe-intake.ts";
import type { ProjectsView } from "../src/shared/projects.ts";
import type { LaterItem } from "../src/shared/wizard.ts";

// The Team recipe card's logic (task 12): a check of `updateUrl` offers a newer version of the same recipe as a change list and applies nothing; Apply writes the file, runs the install step when the
// changes need it, undoes everything when that fails, and starts the projects step for what the repository list changed; Keep keeps the old one out of reach of the next check; Replace takes a file.

const scratch: string[] = [];
after(() => {
	for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const stack = parseStack(JSON.parse(readFileSync(new URL("../../stack.json", import.meta.url), "utf8")));
const BASE = {
	recipe: 1,
	id: "team",
	name: "Team",
	version: "1.0.0",
	updateUrl: "https://recipes.example.com/team.json",
	forges: [{ kind: "github", host: "github.com" }],
	repos: [{ url: "https://github.com/acme/web.git", folder: "web", label: "Web", defaultBranch: "main" }],
	linear: { enabled: false },
	tools: [],
};
const text = (over: Record<string, unknown> = {}): string => JSON.stringify({ ...BASE, ...over }, null, 2);
const intake = (name: string, body: string): Intake => intakeRecipe(validateRecipe, stack, name, body);
const recipeOf = (body: string): Recipe => {
	const r = intake("r.json", body);
	assert.equal(r.ok, true, JSON.stringify(r));
	return (r as Extract<Intake, { ok: true }>).recipe;
};

interface Rig {
	service: RecipeService;
	fetched: string[];
	accepted: Array<{ id: string; version: string; source: unknown }>;
	undone: number;
	installs: number;
	updates: Array<{ before: RepoSpec[]; after: RepoSpec[] }>;
	later: LaterItem[][];
	logs: Array<Record<string, unknown>>;
	store: RecipeMemoStore;
	state: { active: Recipe | null; enabled: boolean; served: string | (() => Promise<never>); picked: { name: string; text: string } | null | Error; install: Array<{ ok: true } | { ok: false; stage: string; category: string } | Error> };
	retried: RepoSpec[];
	/** The callbacks `start()` registered: the first check, then the daily one. */
	timers: Array<() => void>;
}

function rig(over: Partial<Rig["state"]> = {}): Rig {
	const dir = mkdtempSync(join(tmpdir(), "sbd-recipe-"));
	scratch.push(dir);
	mkdirSync(join(dir, "state"), { recursive: true });
	const store = new RecipeMemoStore({ state: join(dir, "state") });
	const state: Rig["state"] = { active: recipeOf(text()), enabled: true, served: text({ version: "1.1.0" }), picked: null, install: [], ...over };
	const r = { fetched: [], accepted: [], undone: 0, installs: 0, updates: [], later: [], logs: [], retried: [], timers: [], store, state } as unknown as Rig;
	const deps: RecipeServiceDeps = {
		active: () => state.active,
		stack: () => stack,
		intake,
		fetchText: async (url) => {
			r.fetched.push(url);
			if (typeof state.served === "function") return state.served();
			return { text: state.served };
		},
		pickFile: async () => {
			if (state.picked instanceof Error) throw state.picked;
			return state.picked;
		},
		accept: (next, source) => {
			const before = state.active;
			r.accepted.push({ id: next.recipe.id, version: next.recipe.version, source });
			state.active = next.recipe;
			return () => {
				r.undone++;
				state.active = before;
			};
		},
		install: async () => {
			r.installs++;
			const next = state.install.shift() ?? { ok: true as const };
			if (next instanceof Error) throw next;
			return next;
		},
		projects: {
			update: async (before, after) => void r.updates.push({ before: [...before], after: [...after] }),
			view: (): ProjectsView => ({ rows: [], running: false, held: false }),
			onChange: () => () => undefined,
			retry: async (spec) => void r.retried.push(spec),
		},
		addLater: (items) => void r.later.push(items),
		store,
		log: (f) => void r.logs.push(f as Record<string, unknown>),
		enabled: () => state.enabled,
		now: () => new Date("2026-11-05T10:00:00.000Z"),
		setTimeout: (fn) => (r.timers.push(fn), {}),
		setInterval: (fn) => (r.timers.push(fn), {}),
		clear: () => undefined,
	};
	r.service = new RecipeService(deps);
	return r;
}

const offered = (r: Rig) => {
	const s = r.service.view().state;
	assert.equal(s.phase, "offered", JSON.stringify(s));
	return s as Extract<ReturnType<RecipeService["view"]>["state"], { phase: "offered" }>;
};

describe("the check of updateUrl", () => {
	it("offers a newer version of the same recipe with its change list, and applies nothing", async () => {
		const r = rig({ served: text({ version: "1.1.0", repos: [...BASE.repos, { url: "https://github.com/acme/api.git", folder: "api" }] }) });
		await r.service.check();
		const s = offered(r);
		assert.deepEqual([s.origin, s.version, s.replaces], ["url", "1.1.0", false]);
		assert.deepEqual(s.changes.map((c) => c.kind), ["version", "repo-added"]);
		assert.deepEqual(r.fetched, [BASE.updateUrl]);
		assert.deepEqual([r.accepted.length, r.installs, r.updates.length], [0, 0, 0], "nothing is applied by a check");
		assert.equal(r.store.read().checkedAt, "2026-11-05T10:00:00.000Z");
	});

	it("is idle for the same or an older version, and keeps the time of the check", async () => {
		for (const served of [text(), text({ version: "0.9.0" })]) {
			const r = rig({ served });
			await r.service.check();
			assert.deepEqual(r.service.view().state, { phase: "idle", checkedAt: "2026-11-05T10:00:00.000Z" });
		}
	});

	it("refuses a file with another id when it comes from the address: only the PM's own file replaces a recipe", async () => {
		const r = rig({ served: text({ id: "other", version: "9.0.0" }) });
		await r.service.check();
		assert.deepEqual(r.service.view().state, { phase: "refused", reason: "other-id", version: "9.0.0" });
		assert.equal(r.accepted.length, 0);
	});

	it("refuses an invalid file by field and rule, never its contents", async () => {
		const r = rig({ served: text({ version: "1.1.0", repos: [{ url: "https://github.com/acme/web.git", folder: "Straw Boss" }] }) });
		await r.service.check();
		const s = r.service.view().state;
		assert.equal(s.phase, "refused");
		assert.ok(s.phase === "refused" && s.reason === "invalid" && (s.fields ?? []).some((f) => f.rule === "reserved-folder"), JSON.stringify(s));
		assert.equal(JSON.stringify(s).includes("acme"), false, "the state carries no value from the file");
	});

	it("turns each fetch refusal into its reason and writes it to the log without the address's query", async () => {
		for (const reason of ["scheme", "credentials", "host", "redirects", "too-large", "network"] as const) {
			const r = rig({
				served: async () => {
					throw new FetchRefused(reason, "https://recipes.example.com/team.json");
				},
			});
			await r.service.check();
			assert.deepEqual(r.service.view().state, { phase: "refused", reason: "fetch", fetch: reason });
			assert.equal(r.logs.some((l) => l.event === "recipe-fetch-refused" && l.reason === reason), true);
		}
		const r = rig({
			served: async () => {
				throw new FetchRefused("status", "https://recipes.example.com/team.json", 404);
			},
		});
		await r.service.check();
		assert.deepEqual(r.service.view().state, { phase: "refused", reason: "fetch", fetch: "status", status: 404 });
	});

	it("does nothing before the wizard is over, with a check already running, or for a recipe without an address", async () => {
		const early = rig();
		early.state.enabled = false;
		await early.service.check();
		assert.deepEqual(early.fetched, []);
		const none = rig({ active: recipeOf(text({ updateUrl: undefined })) });
		await none.service.check();
		assert.deepEqual(none.fetched, []);
		assert.equal(none.service.view().state.phase, "idle");
		const slow = rig();
		let release: () => void = () => undefined;
		slow.state.served = () => new Promise<never>((_, reject) => { release = () => reject(new Error("later")); });
		const first = slow.service.check();
		await slow.service.check();
		assert.equal(slow.fetched.length, 1, "a second check waits for the first");
		release();
		await first;
		assert.equal(slow.service.view().state.phase, "error");
	});

	it("reports any other failure as an error with its first line only", async () => {
		const r = rig({
			served: async () => {
				throw new Error("boom\nsecond line");
			},
		});
		await r.service.check();
		assert.deepEqual(r.service.view().state, { phase: "error", kind: "other", detail: "boom" });
	});
});

describe("Apply", () => {
	it("writes the file, runs the install step for changes that need one, starts the projects for the changed list, and puts off a sign-in it adds", async () => {
		const r = rig({ served: text({ version: "1.1.0", forges: [...BASE.forges, { kind: "gitlab", host: "gitlab.acme.example" }], repos: [...BASE.repos, { url: "https://github.com/acme/api.git", folder: "api" }] }) });
		await r.service.check();
		await r.service.apply();
		assert.deepEqual(r.accepted, [{ id: "team", version: "1.1.0", source: { kind: "url", host: "recipes.example.com" } }]);
		assert.equal(r.installs, 1);
		assert.deepEqual(r.updates.map((u) => [u.before.map((s) => s.folder), u.after.map((s) => s.folder)]), [[["web"], ["web", "api"]]]);
		assert.deepEqual(r.later, [[{ item: "gitlab", host: "gitlab.acme.example" }]]);
		assert.deepEqual(r.service.view().state, { phase: "applied", version: "1.1.0", at: "2026-11-05T10:00:00.000Z" });
		assert.deepEqual(r.store.read().source, { kind: "url", host: "recipes.example.com" });
		assert.equal(r.service.view().active?.version, "1.1.0");
	});

	it("applies only what is offered: not twice, not from idle, not before the wizard is over", async () => {
		const r = rig();
		await r.service.apply();
		assert.equal(r.accepted.length, 0);
		await r.service.check();
		r.state.enabled = false;
		await r.service.apply();
		assert.equal(r.accepted.length, 0);
		r.state.enabled = true;
		await r.service.apply();
		await r.service.apply();
		assert.equal(r.accepted.length, 1);
	});

	it("puts the old recipe back when the install fails, runs the install again for it, and starts no project", async () => {
		const r = rig({ install: [{ ok: false, stage: "opt:glab", category: "download" }, { ok: true }] });
		await r.service.check();
		await r.service.apply();
		assert.equal(r.undone, 1);
		assert.equal(r.installs, 2, "the install runs once more for the old recipe");
		assert.deepEqual(r.service.view().state, { phase: "failed", stage: "opt:glab", category: "download", restored: true, at: "2026-11-05T10:00:00.000Z" });
		assert.equal(r.state.active?.version, "1.0.0");
		assert.deepEqual([r.updates.length, r.later.length], [0, 0]);
		assert.equal(r.store.read().source, null, "the source is not remembered for a recipe that was not applied");
	});

	it("says the old setup is not back when that install fails too", async () => {
		const r = rig({ install: [{ ok: false, stage: "pkg:x", category: "download" }, { ok: false, stage: "pkg:x", category: "download" }] });
		await r.service.check();
		await r.service.apply();
		const s = r.service.view().state;
		assert.ok(s.phase === "failed" && s.restored === false, JSON.stringify(s));
	});

	it("undoes and reports busy when the stack cannot be stopped", async () => {
		const r = rig({ install: [new Error("the tools did not stop in time")] });
		await r.service.check();
		await r.service.apply();
		assert.equal(r.undone, 1);
		assert.deepEqual(r.service.view().state, { phase: "error", kind: "busy", detail: "the tools did not stop in time" });
	});

	it("runs no install for a change the stages do not read (a repository only is not a stage), and still starts the projects", async () => {
		const base = recipeOf(text());
		const next = recipeOf(text({ version: "1.0.0", repos: [...BASE.repos, { url: "https://github.com/acme/api.git", folder: "api" }] }));
		assert.equal(needsInstall(base, next), false);
		assert.equal(needsInstall(base, recipeOf(text({ tools: ["bun"] }))), true);
		assert.equal(needsInstall(base, recipeOf(text({ version: "2.0.0" }))), true, "the version is recorded by the installer");
	});
});

describe("the timer checks (PIN0590-F002)", () => {
	const settle = () => new Promise((resolve) => setImmediate(resolve));

	it("skips the launch's first check once a check or an apply has run, so it cannot replace 'applied' with 'idle'", async () => {
		const r = rig();
		r.service.start();
		await r.service.check();
		await r.service.apply();
		assert.equal(r.service.view().state.phase, "applied");
		r.fetched.length = 0;
		r.timers[0]?.();
		await settle();
		assert.equal(r.service.view().state.phase, "applied");
		assert.equal(r.fetched.length, 0, "no second fetch");
	});

	it("skips the first check after a manual check alone", async () => {
		const r = rig();
		r.service.start();
		await r.service.check();
		r.fetched.length = 0;
		r.timers[0]?.();
		await settle();
		assert.equal(r.fetched.length, 0);
		assert.equal(r.service.view().state.phase, "offered");
	});

	it("skips the first check once the PM has chosen a file with Replace, so it cannot clear the offer of that file (CIN-F010)", async () => {
		const r = rig({ picked: { name: "other.json", text: text({ id: "other", name: "Other", version: "2.0.0", updateUrl: undefined }) } });
		r.service.start();
		await r.service.replace();
		const chosen = offered(r);
		assert.equal(chosen.origin, "file");
		r.fetched.length = 0;
		r.timers[0]?.();
		await settle();
		assert.deepEqual(r.service.view().state, chosen, "the card still shows the file the PM chose");
		assert.equal(r.fetched.length, 0, "no fetch");
		await r.service.apply();
		assert.deepEqual(r.accepted.map((a) => a.id), ["other"], "and Apply applies that file");
	});

	it("still runs the first check when nothing else has", async () => {
		const r = rig();
		r.service.start();
		r.timers[0]?.();
		await settle();
		assert.equal(r.fetched.length, 1);
		assert.equal(r.service.view().state.phase, "offered");
	});

	it("never lets the daily check replace a failed update's card, with the stage and the rollback sentence", async () => {
		const r = rig({ install: [{ ok: false, stage: "opt:glab", category: "download" }, { ok: true }] });
		r.service.start();
		await r.service.check();
		await r.service.apply();
		const failed = r.service.view().state;
		assert.equal(failed.phase, "failed");
		r.fetched.length = 0;
		r.timers[1]?.();
		await settle();
		assert.deepEqual(r.service.view().state, failed);
		assert.equal(r.fetched.length, 0);
	});

	it("never lets the daily check replace 'applied'", async () => {
		const r = rig();
		r.service.start();
		await r.service.check();
		await r.service.apply();
		r.timers[1]?.();
		await settle();
		assert.equal(r.service.view().state.phase, "applied");
	});

	it("a PM's own Check now still replaces the card", async () => {
		const r = rig();
		await r.service.check();
		await r.service.apply();
		await r.service.check();
		assert.equal(r.service.view().state.phase, "idle");
	});
});

describe("Keep and Replace", () => {
	it("keeps the old recipe, remembers the version kept out, and offers a higher one but not that one again", async () => {
		const r = rig();
		await r.service.check();
		r.service.keep();
		assert.deepEqual(r.service.view().state, { phase: "kept", version: "1.1.0" });
		assert.deepEqual(r.store.read().kept, { id: "team", version: "1.1.0" });
		await r.service.check();
		assert.deepEqual(r.service.view().state, { phase: "kept", version: "1.1.0" });
		r.state.served = text({ version: "1.2.0" });
		await r.service.check();
		assert.equal(offered(r).version, "1.2.0");
	});

	it("takes a file the PM chose as another recipe, shown the same way and applied with a file as its source", async () => {
		const r = rig({ picked: { name: "other.json", text: text({ id: "other", name: "Other", version: "2.0.0", updateUrl: undefined }) } });
		await r.service.replace();
		const s = offered(r);
		assert.deepEqual([s.origin, s.replaces, s.name], ["file", true, "Other"]);
		await r.service.apply();
		assert.deepEqual(r.accepted, [{ id: "other", version: "2.0.0", source: { kind: "file", fileName: "other.json" } }]);
		assert.deepEqual(r.fetched, [], "a chosen file is never fetched");
	});

	it("refuses a file that is not newer than the same recipe, an invalid one, and one that cannot be read; a cancelled dialog changes nothing", async () => {
		const older = rig({ picked: { name: "o.json", text: text({ version: "0.5.0" }) } });
		await older.service.replace();
		assert.deepEqual(older.service.view().state, { phase: "refused", reason: "not-newer", version: "0.5.0" });
		const bad = rig({ picked: { name: "b.json", text: "{not json" } });
		await bad.service.replace();
		const s = bad.service.view().state;
		assert.ok(s.phase === "refused" && s.reason === "invalid");
		const unreadable = rig({ picked: new Error("EACCES") });
		await unreadable.service.replace();
		assert.deepEqual(unreadable.service.view().state, { phase: "refused", reason: "unreadable" });
		const cancelled = rig({ picked: null });
		await cancelled.service.replace();
		assert.equal(cancelled.service.view().state.phase, "idle");
	});

	it("drops a chosen file that is kept out without remembering it", async () => {
		const r = rig({ picked: { name: "n.json", text: text({ version: "1.5.0" }) } });
		await r.service.replace();
		r.service.keep();
		assert.equal(r.store.read().kept, null);
		assert.equal(r.service.view().state.phase, "idle");
	});
});

describe("the change list", () => {
	it("names each kind of change once and carries the new instructions in full", () => {
		const before = recipeOf(text());
		const after = recipeOf(text({ name: "Team 2", version: "2.0.0", instructions: "- Run the tests.", straw: { relay: "https://relay.example.com" }, linear: { enabled: true }, forges: [{ kind: "gitlab", host: "gitlab.acme.example" }], repos: [{ url: "https://gitlab.acme.example/acme/web.git", folder: "web", label: "Web app" }, { url: "https://gitlab.acme.example/acme/api.git", folder: "api" }] }));
		const changes = recipeChanges(before, after, () => null);
		const kinds = changes.map((c) => c.kind);
		for (const k of ["name", "version", "forge-added", "forge-removed", "repo-added", "repo-url", "repo-branch", "repo-label", "relay", "linear", "instructions"]) assert.ok(kinds.includes(k as never), k);
		assert.deepEqual(changes.find((c) => c.kind === "instructions"), { kind: "instructions", text: "- Run the tests." });
		assert.deepEqual(repoSpecs(after).map((s) => s.folder), ["web", "api"]);
		assert.deepEqual(recipeChanges(before, before, () => null), []);
	});
});
