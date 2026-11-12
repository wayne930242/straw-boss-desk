import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { agentPackageDir, checkLockedIntegrity, installedVersion, piInvocation, piSource } from "../src/main/bootstrap/pi-cli.ts";
import { engineRecipeOf } from "../src/main/bootstrap/recipe-config.ts";
import type { EngineDeps } from "../src/main/bootstrap/engine.ts";
import { packageDroppedSentence, packageMayLoadSentence } from "../src/main/bootstrap/errors.ts";
import { assertRegistryIntegrity } from "../src/main/bootstrap/npm.ts";
import { StackError, type NpmPin, type Stack } from "../src/main/bootstrap/stack.ts";
import type { Stage, StageContext, StageOutcome } from "../src/main/bootstrap/stage.ts";
import { allStages } from "../src/main/bootstrap/stages/index.ts";
import { profilePin, profileStages, warningsOf } from "../src/main/bootstrap/stages/profile.ts";
import { PRUNE_STAGE } from "../src/main/bootstrap/stages/prune.ts";
import { StateStore } from "../src/main/bootstrap/state.ts";
import { makeStack, scratchRoot, secretPatterns, testEngine, testLayout, testPlatform } from "./harness/engine-fixture.ts";
import { isPackageStage, readStartGate } from "../src/main/runtime/readiness.ts";
import { installFakeNode } from "./harness/fake-node.ts";
import { installFakePi } from "./harness/fake-pi.ts";
import { NpmRegistryFixture } from "./harness/npm-registry.ts";

// The profile, `pkg:<name>`, and `team-pkg:<name>` stages through the engine, with the real npm of the node running the test asking a local registry
// (`assertRegistryIntegrity`) and a stand-in pi (`harness/fake-pi.ts`) that behaves as pi does to `settings.json`, `<agent>/npm`, and the lock file.

const registry = new NpmRegistryFixture();
const scratch: string[] = [];
before(async () => {
	await registry.listen();
});
after(async () => {
	await registry.close();
	for (const d of scratch) removeTree(d);
});

const isWindows = process.platform === "win32";
const platform = isWindows ? "win32" : "darwin";
const repo = new URL("../../", import.meta.url);
const PROFILE = "straw-boss-desk-profile";

const profileDir = (): string => new URL("profile/", repo).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const published = {
	profile: registry.publish(PROFILE, "0.1.0"),
	profile2: registry.publish(PROFILE, "0.2.0"),
	one: registry.publish("pkg-one", "1.0.0"),
	two: registry.publish("@scope/pkg-two", "2.0.0"),
	team: registry.publish("team-skills", "0.1.3"),
	team2: registry.publish("@scope/team-more", "1.2.0"),
	// The swap of generation 15 in small: `show-old` is the package a stack drops, `show-new` the one that takes its place.
	old: registry.publish("show-old", "0.11.2"),
	neu: registry.publish("show-new", "0.6.1"),
};
const pin = (p: { name: string; version: string; integrity: string }): NpmPin => ({ name: p.name, version: p.version, integrity: p.integrity });

interface Fixture {
	base: string;
	root: string;
	layout: ReturnType<typeof testLayout>;
	appEnv: Record<string, string>;
	sources: string;
	log: string;
	/** What the stand-in recorded of settings.json's entry at each `pi remove` (FAKE_PI_SNAPSHOT), and of the npm variables at each call (FAKE_PI_ENV). */
	snapshot: string;
	envLog: string;
	lock: Record<string, string>;
	fail: { install: string[]; remove: string[] };
}

/** A root whose node, git, and herdr are active, with the stand-in pi installed where the `pi` stage would have put it, and package sources for the stand-in to copy. */
async function fixture(): Promise<Fixture> {
	const made = scratchRoot("sbd-prof-");
	scratch.push(made.base);
	const layout = testLayout(made.root);
	installFakeNode(layout, "24.0.0");
	installFakePi(layout);
	const store = new StateStore(layout);
	await store.setVersion("node", "24.0.0");
	await store.setVersion("git", "2.56.0");
	await store.setVersion("herdr", "0.9.5");
	const tmp = join(made.base, "tmp");
	mkdirSync(tmp, { recursive: true });
	const essentials = Object.fromEntries(
		["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "LANG"].flatMap((name) => {
			const key = Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase());
			return key !== undefined && process.env[key] !== undefined ? [[name, process.env[key] as string]] : [];
		}),
	);
	const appEnv: Record<string, string> = isWindows
		? { ...essentials, USERPROFILE: made.base, HOME: made.base, APPDATA: join(made.base, "AppData"), LOCALAPPDATA: join(made.base, "AppData", "Local"), TEMP: tmp, TMP: tmp, USERNAME: "runner" }
		: { ...essentials, HOME: made.base, USER: "runner", TMPDIR: tmp };
	// The profile package as the stand-in installs it: the repository's AGENTS.md, rules, configs, and skill, at 0.1.0 and at 0.2.0 (one more rule).
	const sources = join(made.base, "sources");
	for (const version of ["0.1.0", "0.2.0"]) {
		const dir = join(sources, `${PROFILE}@${version}`);
		for (const entry of ["AGENTS.md", "config", "rules", "skills"]) cpSync(join(profileDir(), entry), join(dir, entry), { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: PROFILE, version, pi: { skills: ["./skills"] } }));
		if (version === "0.2.0") writeFileSync(join(dir, "rules", "extra.md"), "an extra rule\n");
	}
	return { base: made.base, root: made.root, layout, appEnv, sources, log: join(made.base, "pi-calls.log"), snapshot: join(made.base, "pi-snapshots.log"), envLog: join(made.base, "pi-env.log"), lock: {}, fail: { install: [], remove: [] } };
}

const stackFor = (profile: NpmPin, pkgs: NpmPin[] = []): Stack => ({ ...makeStack({}), profile: { ...profile }, piPackages: pkgs, npmGlobal: [{ name: "@earendil-works/pi-coding-agent", version: "1.4.0", integrity: "sha512-x", bin: "pi" }] });

const envOf = (f: Fixture, extra: Record<string, string> = {}): Record<string, string> => ({
	NPM_CONFIG_REGISTRY: registry.url,
	NPM_CONFIG_FETCH_RETRIES: "0",
	FAKE_PI_SOURCES: f.sources,
	FAKE_PI_LOG: f.log,
	FAKE_PI_SNAPSHOT: f.snapshot,
	FAKE_PI_ENV: f.envLog,
	FAKE_PI_LOCK: JSON.stringify(f.lock),
	FAKE_PI_FAIL: JSON.stringify(f.fail),
	...extra,
});

/** The stage list with `needs` cut down to the stages in it (the stages before `profile` are stood in for by the fixture). */
const standalone = (stages: Stage[]): Stage[] => {
	const names = new Set(stages.map((s) => s.name));
	return stages.map((s) => ({ ...s, needs: s.needs.filter((n) => names.has(n)) }));
};

const jsonLines = (file: string): Array<Record<string, any>> => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, any>) : []);
const calls = (f: Fixture): string[] => (existsSync(f.log) ? readFileSync(f.log, "utf8").split("\n").filter((l) => l !== "") : []);

interface RunOut {
	outcomes: Record<string, StageOutcome>;
	order: string[];
	error: string | null;
}

async function go(f: Fixture, stack: Stack, recipe: unknown, extraEnv: Record<string, string> = {}, deps: Partial<EngineDeps> = {}): Promise<RunOut> {
	const options = { npm: { env: envOf(f, extraEnv) } };
	// `pi-settings` (Windows) merges `shellPath` and needs a PortableGit's bash.exe; its own tests are in pi-settings.test.ts. Here the stages after it stand on `profile`.
	const stages = (): Stage[] => {
		const all = profileStages(stack, engineRecipeOf(recipe, stack), platform, options);
		return standalone(all.filter((s) => s.name !== "pi-settings").map((s) => ({ ...s, needs: s.needs.map((n) => (n === "pi-settings" ? "profile" : n)) })));
	};
	const engine = testEngine(f.root, stages, { appEnv: f.appEnv, layout: f.layout, ...deps });
	await engine.engine.handle({ type: "run", config: { root: f.root, stack, secretPatterns, ...(recipe !== undefined ? { recipe } : {}) } });
	const done = engine.events.find((e) => e.type === "done");
	const error = engine.events.find((e) => e.type === "error");
	assert.ok(done?.type === "done", JSON.stringify(error));
	return {
		outcomes: Object.fromEntries(done.outcomes.map((o) => [o.stage, o])),
		order: engine.events.filter((e) => e.type === "stage").map((e) => (e.type === "stage" ? e.outcome.stage : "")),
		error: error?.type === "error" ? error.message : null,
	};
}

const lockOf = (...pins: NpmPin[]): Record<string, string> => Object.fromEntries(pins.map((p) => [`${p.name}@${p.version}`, p.integrity]));
const read = (f: Fixture, rel: string): string => readFileSync(join(f.layout.agent, ...rel.split("/")), "utf8");
const settings = (f: Fixture): { packages?: unknown[]; [key: string]: unknown } => JSON.parse(read(f, "settings.json"));

const RECIPE = {
	forges: [{ kind: "github", host: "github.com" }],
	tools: [] as string[],
	id: "waydo-pm",
	name: "Waydo PM",
	version: "1.0.0",
	instructions: "- one rule",
	straw: { relay: "https://relay.waydo.example/" },
	packages: [pin(published.team)],
};

describe("the profile stage", () => {
	it("installs the profile package through pi, runs the installer, merges the owned keys, and leaves the skill to the package", async () => {
		const f = await fixture();
		f.lock = lockOf(pin(published.profile));
		const out = await go(f, stackFor(pin(published.profile)), { ...RECIPE, packages: [] });
		const outcome = out.outcomes.profile;
		assert.equal(outcome?.status, "installed", JSON.stringify(outcome));
		assert.deepEqual(calls(f), [`install npm:${PROFILE}@0.1.0`]);
		assert.match(read(f, "AGENTS.md"), /<!-- straw-boss:team-block:begin -->\n## Team: Waydo PM\n\n- one rule/);
		assert.ok(existsSync(join(f.layout.agent, "rules", "bash-not-powershell.md")));
		assert.ok(!existsSync(join(f.layout.agent, "skills")), "the skill is the package's, loaded in place by pi");
		const s = settings(f);
		assert.equal(s.defaultProvider, "claude-bridge");
		assert.deepEqual(s.packages, [`npm:${PROFILE}@0.1.0`]);
		assert.equal((JSON.parse(read(f, "straw-boss/config.json")) as { link: { relay: string } }).link.relay, "https://relay.waydo.example/");
		const record = new StateStore(f.layout).record("profile");
		assert.equal(record?.status, "ok");
		assert.equal(record?.version, "0.1.0");
		assert.deepEqual(Object.keys(record?.hashes ?? {}).map((k) => k.replace(/^agent[:/]/, "")), [`npm/node_modules/${PROFILE}/package.json`]);
		assert.match(outcome?.evidence ?? "", /straw-boss-desk-profile@0\.1\.0 \+ recipe waydo-pm 1\.0\.0; 0 kept/);
	});

	it("is skipped-verified the second time, and installed again when the recipe, a hashed file, or the settings entry changes", async () => {
		const f = await fixture();
		f.lock = lockOf(pin(published.profile));
		const stack = stackFor(pin(published.profile));
		assert.equal((await go(f, stack, RECIPE)).outcomes.profile?.status, "installed");
		assert.equal((await go(f, stack, RECIPE)).outcomes.profile?.status, "skipped-verified");
		// a recipe update: the installer has a change to make
		assert.equal((await go(f, stack, { ...RECIPE, version: "1.1.0", instructions: "- two rules" })).outcomes.profile?.status, "installed");
		assert.match(read(f, "AGENTS.md"), /- two rules/);
		// a changed package.json fails the hash
		const manifest = join(agentPackageDir(f.layout, PROFILE), "package.json");
		writeFileSync(manifest, `${readFileSync(manifest, "utf8")} `);
		assert.equal((await go(f, stack, { ...RECIPE, version: "1.1.0", instructions: "- two rules" })).outcomes.profile?.status, "installed");
		// a settings entry that pi lost
		const s = settings(f);
		writeFileSync(join(f.layout.agent, "settings.json"), JSON.stringify({ ...s, packages: [] }));
		assert.equal((await go(f, stack, { ...RECIPE, version: "1.1.0", instructions: "- two rules" })).outcomes.profile?.status, "installed");
		assert.deepEqual(settings(f).packages, [`npm:${PROFILE}@0.1.0`]);
		// a rule the PM deleted comes back, since nothing of theirs is in its place
		rmSync(join(f.layout.agent, "rules", "bash-not-powershell.md"));
		assert.equal((await go(f, stack, { ...RECIPE, version: "1.1.0", instructions: "- two rules" })).outcomes.profile?.status, "installed");
		assert.ok(existsSync(join(f.layout.agent, "rules", "bash-not-powershell.md")));
	});

	it("keeps a file the PM changed, says so in the outcome's warnings on every run, and is skipped-verified while it is kept", async () => {
		const f = await fixture();
		f.lock = lockOf(pin(published.profile));
		const stack = stackFor(pin(published.profile));
		await go(f, stack, RECIPE);
		const mine = `${read(f, "AGENTS.md")}\nmy own line\n`;
		writeFileSync(join(f.layout.agent, "AGENTS.md"), mine);
		const update = { ...RECIPE, version: "1.1.0", instructions: "- two" };
		const again = await go(f, stack, update);
		assert.equal(again.outcomes.profile?.status, "installed");
		assert.equal(read(f, "AGENTS.md"), mine);
		assert.deepEqual(again.outcomes.profile?.warnings?.map((w) => `${w.kind}:${w.path}`), ["profile-file-kept:AGENTS.md"]);
		assert.match(again.outcomes.profile?.warnings?.[0]?.sentence ?? "", /Your copy of AGENTS\.md was kept because you changed it\. The team's new version is in \.straw-boss-profile\/pending\/0\.1\.0\/AGENTS\.md\./);
		const third = await go(f, stack, update);
		assert.equal(third.outcomes.profile?.status, "skipped-verified");
		assert.deepEqual(third.outcomes.profile?.warnings?.map((w) => w.kind), ["profile-file-kept"], "reported on every run");
		assert.deepEqual(new StateStore(f.layout).record("profile")?.warnings?.map((w) => w.kind), ["profile-file-kept"]);
		assert.deepEqual(new StateStore(f.layout).record("profile")?.warnings?.map((w) => w.path), ["AGENTS.md"], "the file survives a read of state/bootstrap.json, which the settings screen needs");
	});

	it("takes the recipe's profile pin over the stack's and installs that version; pi replaces the settings entry", async () => {
		const f = await fixture();
		f.lock = lockOf(pin(published.profile), pin(published.profile2));
		const stack = stackFor(pin(published.profile));
		await go(f, stack, { ...RECIPE, packages: [] });
		assert.equal(profilePin(stack, engineRecipeOf({ ...RECIPE, profile: { version: "0.2.0", integrity: published.profile2.integrity } }, stack)).version, "0.2.0");
		const out = await go(f, stack, { ...RECIPE, packages: [], profile: { version: "0.2.0", integrity: published.profile2.integrity } });
		assert.equal(out.outcomes.profile?.status, "installed", JSON.stringify(out.outcomes.profile));
		assert.equal(installedVersion(f.layout, PROFILE), "0.2.0");
		assert.deepEqual(settings(f).packages, [`npm:${PROFILE}@0.2.0`]);
		assert.ok(existsSync(join(f.layout.agent, "rules", "extra.md")));
	});

	it("without a recipe it installs the profile alone: no team block, no relay", async () => {
		const f = await fixture();
		f.lock = lockOf(pin(published.profile));
		const out = await go(f, stackFor(pin(published.profile)), undefined);
		assert.equal(out.outcomes.profile?.status, "installed", JSON.stringify(out.outcomes.profile));
		assert.ok(!read(f, "AGENTS.md").includes("straw-boss:team-block"));
		assert.ok(!existsSync(join(f.layout.agent, "straw-boss", "config.json")));
	});

	it("refuses a pin the registry does not confirm: integrity, never retried, pi never asked", async () => {
		const f = await fixture();
		const wrong = { ...pin(published.profile), integrity: `sha512-${Buffer.alloc(64, 7).toString("base64")}` };
		const out = await go(f, stackFor(wrong), RECIPE);
		assert.equal(out.outcomes.profile?.failure?.category, "integrity");
		assert.equal(out.outcomes.profile?.attempts, 1);
		assert.deepEqual(calls(f), []);
		assert.ok(!existsSync(join(f.layout.agent, "AGENTS.md")));
	});

	it("takes the package out again and copies nothing when npm recorded another tarball than the pin", async () => {
		const f = await fixture();
		f.lock = { [`${PROFILE}@0.1.0`]: `sha512-${Buffer.alloc(64, 9).toString("base64")}` };
		const out = await go(f, stackFor(pin(published.profile)), RECIPE);
		assert.equal(out.outcomes.profile?.failure?.category, "integrity", JSON.stringify(out.outcomes.profile));
		assert.match(out.outcomes.profile?.failure?.detail ?? "", /another integrity than the pin/);
		assert.deepEqual(calls(f), [`install npm:${PROFILE}@0.1.0`, `remove npm:${PROFILE}@0.1.0`]);
		assert.ok(!existsSync(join(f.layout.agent, "AGENTS.md")), "the installer never ran");
		assert.equal(installedVersion(f.layout, PROFILE), null);
	});

	it("says no integrity was recorded when the lock has no entry, and removes the package", async () => {
		const f = await fixture();
		const out = await go(f, stackFor(pin(published.profile)), RECIPE);
		assert.equal(out.outcomes.profile?.failure?.category, "other");
		assert.match(out.outcomes.profile?.failure?.detail ?? "", /npm recorded no integrity for straw-boss-desk-profile@0\.1\.0/);
		assert.deepEqual(calls(f).slice(-1), [`remove npm:${PROFILE}@0.1.0`]);
	});

	it("reports a pi install that cannot reach the registry as a registry failure with the kit's sentence, tried twice", async () => {
		const f = await fixture();
		f.fail = { install: [PROFILE], remove: [] };
		const out = await go(f, stackFor(pin(published.profile)), RECIPE);
		assert.equal(out.outcomes.profile?.failure?.category, "registry");
		assert.equal(out.outcomes.profile?.attempts, 2);
		assert.match(out.outcomes.profile?.failure?.sentence ?? "", /^The npm registry could not be reached or is out of date, so straw-boss-desk-profile@0\.1\.0 was not installed\./);
	});

	it("a profile whose files a link guards fails the stage and leaves the manifest as it was (the installer refuses before its first write)", async () => {
		const f = await fixture();
		f.lock = lockOf(pin(published.profile));
		const outside = join(f.base, "outside");
		mkdirSync(outside, { recursive: true });
		mkdirSync(f.layout.agent, { recursive: true });
		symlinkSync(outside, join(f.layout.agent, "rules"), "junction");
		const out = await go(f, stackFor(pin(published.profile)), RECIPE);
		assert.equal(out.outcomes.profile?.status, "failed");
		assert.match(out.outcomes.profile?.failure?.detail ?? "", /symbolic link or junction/);
		assert.ok(!existsSync(join(f.layout.agent, ".straw-boss-profile", "manifest.json")));
		assert.deepEqual(existsSync(outside) ? (await import("node:fs")).readdirSync(outside) : [], []);
	});
});

describe("the pkg:<name> stages", () => {
	const pkgs = (): NpmPin[] => [pin(published.one), pin(published.two)];

	it("installs each package of the stack through pi, one at a time, after the profile, and a second run skips them all", async () => {
		const f = await fixture();
		f.lock = lockOf(pin(published.profile), ...pkgs(), pin(published.team));
		const stack = stackFor(pin(published.profile), pkgs());
		const first = await go(f, stack, RECIPE);
		assert.deepEqual(Object.fromEntries(Object.entries(first.outcomes).map(([k, v]) => [k, v.status])), {
			profile: "installed",
			"pkg:pkg-one": "installed",
			"pkg:@scope/pkg-two": "installed",
			// Nothing of an earlier stack is there to remove: the stage records that and installs nothing.
			"pkg-prune": "skipped-verified",
			"team-pkg:team-skills": "installed",
		}, JSON.stringify(Object.values(first.outcomes).map((o) => o.failure)));
		assert.deepEqual(calls(f).slice(0, 3), [`install npm:${PROFILE}@0.1.0`, "install npm:pkg-one@1.0.0", "install npm:@scope/pkg-two@2.0.0"]);
		const listed = settings(f).packages as unknown[];
		assert.ok(listed.includes("npm:pkg-one@1.0.0") && listed.includes("npm:@scope/pkg-two@2.0.0"));
		assert.equal(first.order.indexOf("profile"), 0);
		const second = await go(f, stack, RECIPE);
		for (const [name, o] of Object.entries(second.outcomes)) assert.equal(o.status, "skipped-verified", name);
	});

	it("installs a package again when its folder is damaged or its settings entry is gone, and notes the package.json hash", async () => {
		const f = await fixture();
		f.lock = lockOf(pin(published.profile), ...pkgs());
		const stack = stackFor(pin(published.profile), pkgs());
		await go(f, stack, { ...RECIPE, packages: [] });
		const record = new StateStore(f.layout).record("pkg:pkg-one");
		assert.deepEqual(Object.keys(record?.hashes ?? {}).map((k) => k.replace(/^agent[:/]/, "")), ["npm/node_modules/pkg-one/package.json"]);
		writeFileSync(join(agentPackageDir(f.layout, "pkg-one"), "package.json"), JSON.stringify({ name: "pkg-one", version: "1.0.0", tampered: true }));
		const again = await go(f, stack, { ...RECIPE, packages: [] });
		assert.equal(again.outcomes["pkg:pkg-one"]?.status, "installed");
		assert.equal(again.outcomes["pkg:@scope/pkg-two"]?.status, "skipped-verified");
		writeFileSync(join(f.layout.agent, "settings.json"), JSON.stringify({ ...settings(f), packages: [`npm:${PROFILE}@0.1.0`] }));
		const third = await go(f, stack, { ...RECIPE, packages: [] });
		assert.equal(third.outcomes["pkg:pkg-one"]?.status, "installed");
		assert.equal(third.outcomes["pkg:@scope/pkg-two"]?.status, "installed");
	});

	it("fails with the registry sentence for a version the registry does not have, and does not call pi", async () => {
		const f = await fixture();
		f.lock = lockOf(pin(published.profile));
		const missing: NpmPin = { name: "pkg-one", version: "9.9.9", integrity: published.one.integrity };
		const out = await go(f, stackFor(pin(published.profile), [missing]), { ...RECIPE, packages: [] });
		assert.equal(out.outcomes["pkg:pkg-one"]?.failure?.category, "registry");
		assert.match(out.outcomes["pkg:pkg-one"]?.failure?.sentence ?? "", /pkg-one@9\.9\.9 was not installed/);
		assert.ok(!calls(f).some((c) => c.includes("pkg-one")));
	});

	it("removes a package whose recorded tarball is not the pin, and reports integrity", async () => {
		const f = await fixture();
		f.lock = { ...lockOf(pin(published.profile)), "pkg-one@1.0.0": `sha512-${Buffer.alloc(64, 3).toString("base64")}` };
		const out = await go(f, stackFor(pin(published.profile), [pin(published.one)]), { ...RECIPE, packages: [] });
		assert.equal(out.outcomes["pkg:pkg-one"]?.failure?.category, "integrity");
		assert.deepEqual(calls(f).slice(-2), ["install npm:pkg-one@1.0.0", "remove npm:pkg-one@1.0.0"]);
		assert.equal(installedVersion(f.layout, "pkg-one"), null);
		assert.ok(!(settings(f).packages as unknown[]).includes("npm:pkg-one@1.0.0"));
	});
});

describe("the team-pkg:<name> stages", () => {
	const stack = (): Stack => stackFor(pin(published.profile), [pin(published.one)]);
	const lock = (): Record<string, string> => lockOf(pin(published.profile), pin(published.one), pin(published.team), pin(published.team2));

	it("installs a recipe package through pi and lists it skills-only; the stack's package stays a plain entry", async () => {
		const f = await fixture();
		f.lock = lock();
		const out = await go(f, stack(), RECIPE);
		assert.equal(out.outcomes["team-pkg:team-skills"]?.status, "installed", JSON.stringify(out.outcomes["team-pkg:team-skills"]));
		const listed = settings(f).packages as unknown[];
		assert.deepEqual(listed.find((e) => typeof e === "object"), { source: "npm:team-skills@0.1.3", extensions: [] });
		assert.ok(listed.includes("npm:pkg-one@1.0.0"));
		assert.match(out.outcomes["team-pkg:team-skills"]?.evidence ?? "", /\(skills only: extensions \[\]\)/);
		assert.equal(out.order.indexOf("team-pkg:team-skills"), out.order.length - 1, "after every pkg:");
		assert.equal((await go(f, stack(), RECIPE)).outcomes["team-pkg:team-skills"]?.status, "skipped-verified");
	});

	it("is installed again when the listing lost its empty extensions list", async () => {
		const f = await fixture();
		f.lock = lock();
		await go(f, stack(), RECIPE);
		const s = settings(f);
		writeFileSync(join(f.layout.agent, "settings.json"), JSON.stringify({ ...s, packages: (s.packages as unknown[]).map((e) => (typeof e === "object" ? "npm:team-skills@0.1.3" : e)) }));
		const again = await go(f, stack(), RECIPE);
		assert.equal(again.outcomes["team-pkg:team-skills"]?.status, "installed");
		assert.deepEqual((settings(f).packages as unknown[]).find((e) => typeof e === "object"), { source: "npm:team-skills@0.1.3", extensions: [] });
	});

	it("scoped recipe packages work too", async () => {
		const f = await fixture();
		f.lock = lock();
		const out = await go(f, stack(), { ...RECIPE, packages: [pin(published.team2)] });
		assert.equal(out.outcomes["team-pkg:@scope/team-more"]?.status, "installed", JSON.stringify(out.outcomes["team-pkg:@scope/team-more"]));
		assert.ok((settings(f).packages as unknown[]).some((e) => typeof e === "object" && (e as { source: string }).source === "npm:@scope/team-more@1.2.0"));
	});

	it("RC-F001: a package that cannot be listed skills-only is removed again, the stage fails, and the log says rolled-back", async () => {
		const f = await fixture();
		f.lock = lock();
		const out = await go(f, stack(), RECIPE, { FAKE_PI_UNLISTED: JSON.stringify(["team-skills"]) });
		const outcome = out.outcomes["team-pkg:team-skills"];
		assert.equal(outcome?.status, "failed", JSON.stringify(outcome));
		assert.match(outcome?.failure?.detail ?? "", /could not be accepted, so it was removed again: npm:team-skills@0\.1\.3 is not listed in settings\.json/);
		assert.deepEqual(calls(f).slice(-2), ["install npm:team-skills@0.1.3", "remove npm:team-skills@0.1.3"]);
		assert.equal(installedVersion(f.layout, "team-skills"), null);
		const log = readFileSync(join(f.layout.logs, "bootstrap.jsonl"), "utf8");
		assert.match(log, /"rolled-back"/);
		assert.doesNotMatch(log, /rollback-failed/);
	});

	it("RC-F001: when pi remove fails as well, the log says rollback-failed, not rolled-back, and an entry pi never wrote is not left for pi to load", async () => {
		const f = await fixture();
		f.lock = lock();
		f.fail = { install: [], remove: ["team-skills"] };
		const out = await go(f, stack(), RECIPE, { FAKE_PI_UNLISTED: JSON.stringify(["team-skills"]) });
		const outcome = out.outcomes["team-pkg:team-skills"];
		assert.equal(outcome?.status, "failed", JSON.stringify(outcome));
		assert.match(outcome?.failure?.detail ?? "", /could not be removed with pi remove \(exit 1\); it was taken off pi's package list instead, so pi loads none of it/);
		const log = readFileSync(join(f.layout.logs, "bootstrap.jsonl"), "utf8");
		assert.match(log, /rollback-failed/);
		assert.doesNotMatch(log, /"rolled-back"/);
		assert.equal(installedVersion(f.layout, "team-skills"), "0.1.3", "the package's files are still there, and the message says so");
		assert.deepEqual(new StateStore(f.layout).startBlocks(), [], "nothing is listed, so nothing can load and the start is not blocked");
	});

	describe("T7-F002: a recipe package whose rollback fails never stays loadable", () => {
		const entryOf = (f: Fixture): unknown => (settings(f).packages as unknown[]).find((e) => (typeof e === "string" ? e : (e as { source: string }).source) === "npm:team-skills@0.1.3");

		it("is listed skills-only before the lock is checked, so the entry pi remove finds already has no extensions", async () => {
			const f = await fixture();
			f.lock = { ...lock(), "team-skills@0.1.3": `sha512-${Buffer.alloc(64, 5).toString("base64")}` };
			await go(f, stack(), RECIPE);
			const removals = jsonLines(f.snapshot).filter((e) => e.name === "team-skills");
			assert.deepEqual(removals, [{ name: "team-skills", entry: { source: "npm:team-skills@0.1.3", extensions: [] } }], "at pi remove the entry was { source, extensions: [] }, not pi's plain string");
		});

		it("takes the listing out of settings.json when pi remove fails after the lock check failed: nothing of the package loads, the category stays integrity, the start is not blocked", async () => {
			const f = await fixture();
			f.lock = { ...lock(), "team-skills@0.1.3": `sha512-${Buffer.alloc(64, 5).toString("base64")}` };
			f.fail = { install: [], remove: ["team-skills"] };
			const out = await go(f, stack(), RECIPE);
			const outcome = out.outcomes["team-pkg:team-skills"];
			assert.equal(outcome?.status, "failed", JSON.stringify(outcome));
			assert.equal(outcome?.failure?.category, "integrity");
			assert.match(outcome?.failure?.detail ?? "", /taken off pi's package list instead/);
			assert.doesNotMatch(outcome?.failure?.detail ?? "", /edit|remove it from settings\.json/i, "the message does not ask a PM to edit a file");
			assert.equal(entryOf(f), undefined, "the entry is gone: pi loads none of it");
			assert.ok(existsSync(join(agentPackageDir(f.layout, "team-skills"), "package.json")), "its files stay");
			const log = readFileSync(join(f.layout.logs, "bootstrap.jsonl"), "utf8");
			assert.match(log, /rollback-failed/);
			assert.match(log, /"event":"unlisted"[^\n]*"listing":"absent"/);
			const store = new StateStore(f.layout);
			assert.equal(store.record("team-pkg:team-skills")?.status, "failed");
			assert.deepEqual(store.startBlocks(), []);
		});

		it("records a start block when settings.json cannot be fixed either, with a sentence of its own, keeps it through a failure that touches nothing, and a successful run clears it", async () => {
			const f = await fixture();
			f.lock = lock();
			f.fail = { install: [], remove: ["team-skills"] };
			const unfixable = { FAKE_PI_CORRUPT: JSON.stringify(["team-skills"]) };
			const out = await go(f, stack(), RECIPE, unfixable);
			const outcome = out.outcomes["team-pkg:team-skills"];
			assert.equal(outcome?.status, "failed", JSON.stringify(outcome));
			assert.equal(outcome?.failure?.sentence, packageMayLoadSentence("team-skills"));
			assert.match(outcome?.failure?.sentence ?? "", /will not start your agents until it has been/);
			assert.doesNotMatch(`${outcome?.failure?.sentence}\n${outcome?.failure?.detail}`, /edit|remove it from settings\.json/i, "neither sentence nor detail asks a PM to edit a file");
			assert.match(outcome?.failure?.detail ?? "", /the app does not start pi until a later run of team-pkg:team-skills has removed it/);
			const expected = { stage: "team-pkg:team-skills", kind: "package-may-load", package: "team-skills", sentence: packageMayLoadSentence("team-skills") };
			assert.deepEqual(new StateStore(f.layout).startBlocks(), [expected], "read from state/bootstrap.json by a fresh store, the way the supervisor reads it");
			assert.deepEqual((JSON.parse(readFileSync(join(f.layout.state, "bootstrap.json"), "utf8")) as { stages: Record<string, { startBlock?: unknown }> }).stages["team-pkg:team-skills"]?.startBlock, { kind: "package-may-load", package: "team-skills", sentence: packageMayLoadSentence("team-skills") });
			const bad = { ...pin(published.team), integrity: `sha512-${Buffer.alloc(64, 7).toString("base64")}` };
			// A later run that fails before it touches anything (the registry does not confirm the pin) leaves the block where it was.
			const again = await go(f, stackFor(pin(published.profile), [pin(published.one)]), { ...RECIPE, packages: [bad] });
			assert.equal(again.outcomes["team-pkg:team-skills"]?.failure?.category, "integrity");
			assert.deepEqual(new StateStore(f.layout).startBlocks(), [expected], "the block outlives a failure that did not remove the package");
			// A run that removes the package properly clears it.
			f.fail = { install: [], remove: [] };
			const ok = await go(f, stack(), RECIPE);
			assert.equal(ok.outcomes["team-pkg:team-skills"]?.status, "installed", JSON.stringify(ok.outcomes["team-pkg:team-skills"]));
			assert.deepEqual(new StateStore(f.layout).startBlocks(), []);
			assert.deepEqual(entryOf(f), { source: "npm:team-skills@0.1.3", extensions: [] });
		});

		it("keeps a block through the running record, so a kill in the middle of the next attempt does not lift it", async () => {
			const f = await fixture();
			const block = { kind: "package-may-load" as const, package: "team-skills", sentence: packageMayLoadSentence("team-skills") };
			await new StateStore(f.layout).setRecord("team-pkg:team-skills", { status: "failed", version: "0.1.3", evidence: "", at: "2026-11-02T00:00:00.000Z", hashes: {}, dependsOn: {}, startBlock: block });
			let seen: unknown = "never ran";
			const probe: Stage = {
				name: "team-pkg:team-skills",
				needs: [],
				async detect() {
					return null;
				},
				async install(ctx) {
					seen = new StateStore(ctx.layout).record("team-pkg:team-skills")?.startBlock;
				},
				async verify() {
					return { text: "x", version: "0.1.3" };
				},
				async activate() {},
			};
			const run = testEngine(f.root, () => [probe], { appEnv: f.appEnv, layout: f.layout });
			await run.run(stackFor(pin(published.profile)));
			assert.deepEqual(seen, block);
			assert.deepEqual(new StateStore(f.layout).startBlocks(), [], "and the run that succeeded cleared it");
		});

		it("pkg:<name> and profile get the same fallback: the plain entry of a stack package is taken out when pi remove fails after a lock mismatch", async () => {
			const f = await fixture();
			f.lock = { ...lockOf(pin(published.profile)), "pkg-one@1.0.0": `sha512-${Buffer.alloc(64, 3).toString("base64")}` };
			f.fail = { install: [], remove: ["pkg-one"] };
			const out = await go(f, stackFor(pin(published.profile), [pin(published.one)]), { ...RECIPE, packages: [] });
			assert.equal(out.outcomes["pkg:pkg-one"]?.failure?.category, "integrity");
			assert.ok(!(settings(f).packages as unknown[]).includes("npm:pkg-one@1.0.0"), "not listed any more");
			assert.deepEqual(new StateStore(f.layout).startBlocks(), []);
		});
	});

	it("takes a recipe package out when npm recorded another tarball than its pin", async () => {
		const f = await fixture();
		f.lock = { ...lock(), "team-skills@0.1.3": `sha512-${Buffer.alloc(64, 5).toString("base64")}` };
		const out = await go(f, stack(), RECIPE);
		assert.equal(out.outcomes["team-pkg:team-skills"]?.failure?.category, "integrity");
		assert.deepEqual(calls(f).slice(-2), ["install npm:team-skills@0.1.3", "remove npm:team-skills@0.1.3"]);
	});

	it("refuses a recipe package that the stack installs itself, before any stage runs", () => {
		const s = stackFor(pin(published.profile), [pin(published.one)]);
		for (const name of ["pkg-one", PROFILE, "@earendil-works/pi-coding-agent"]) {
			assert.throws(() => profileStages(s, engineRecipeOf({ ...RECIPE, packages: [{ name, version: "1.0.0", integrity: published.one.integrity }] }, s), platform), StackError, name);
		}
	});
});

describe("T7-F003: a stage whose tarball is not the pin is never skipped-verified, and its failed reinstall does not keep an old ok", () => {
	const RECIPE_ONE = { ...RECIPE, packages: [pin(published.team)] };
	const stack = (): Stack => stackFor(pin(published.profile), [pin(published.one)]);
	const goodLock = (): Record<string, string> => lockOf(pin(published.profile), pin(published.one), pin(published.team));
	const lockFile = (f: Fixture): string => join(f.layout.agent, "npm", "package-lock.json");
	/** npm records another tarball for `name` in the lock file, the way a later run of npm or a changed registry answer would leave it. */
	function tamperLock(f: Fixture, name: string): void {
		const lock = JSON.parse(readFileSync(lockFile(f), "utf8")) as { packages: Record<string, { integrity: string }> };
		(lock.packages[`node_modules/${name}`] as { integrity: string }).integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
		writeFileSync(lockFile(f), JSON.stringify(lock));
	}
	const statuses = (out: RunOut): Record<string, string> => Object.fromEntries(Object.entries(out.outcomes).map(([k, v]) => [k, v.status]));

	it("detect re-reads the lock: a lock entry that no longer equals the pin fails profile, pkg:*, and team-pkg:*, and the next run installs them again", async () => {
		const f = await fixture();
		f.lock = goodLock();
		await go(f, stack(), RECIPE_ONE);
		const names: Array<[string, string]> = [["profile", PROFILE], ["pkg:pkg-one", "pkg-one"], ["team-pkg:team-skills", "team-skills"]];
		for (const [stageName, pkgName] of names) {
			const second = await go(f, stack(), RECIPE_ONE);
			assert.equal(second.outcomes[stageName]?.status, "skipped-verified", `${stageName} before the change`);
			tamperLock(f, pkgName);
			const third = await go(f, stack(), RECIPE_ONE);
			assert.equal(third.outcomes[stageName]?.status, "installed", `${stageName} after the lock changed: ${JSON.stringify(statuses(third))}`);
			const reasons = jsonLines(join(f.layout.logs, "bootstrap.jsonl")).filter((e) => e.stage === stageName && e.event === "detect-failed").map((e) => String(e.reason));
			assert.ok(reasons.some((r) => /npm's lock records another integrity for/.test(r)), `${stageName}: ${reasons.join(" | ")}`);
		}
	});

	it("detect fails when the lock has no entry for the package at all", async () => {
		const f = await fixture();
		f.lock = goodLock();
		await go(f, stack(), RECIPE_ONE);
		rmSync(lockFile(f));
		const again = await go(f, stack(), RECIPE_ONE);
		for (const name of ["profile", "pkg:pkg-one", "team-pkg:team-skills"]) assert.equal(again.outcomes[name]?.status, "installed", name);
	});

	it("a reinstall that fails after pi install records failed, and the old ok is not kept: with the lock and the listing repaired by hand it is installed again, not skipped-verified", async () => {
		const f = await fixture();
		f.lock = goodLock();
		await go(f, stack(), RECIPE_ONE);
		const okRecord = new StateStore(f.layout).record("pkg:pkg-one");
		assert.equal(okRecord?.status, "ok");
		// the settings entry is lost, so detect fails; the reinstall then records another tarball, and pi remove fails too
		writeFileSync(join(f.layout.agent, "settings.json"), JSON.stringify({ ...settings(f), packages: (settings(f).packages as unknown[]).filter((e) => e !== "npm:pkg-one@1.0.0") }));
		f.lock = { ...goodLock(), "pkg-one@1.0.0": `sha512-${Buffer.alloc(64, 4).toString("base64")}` };
		f.fail = { install: [], remove: ["pkg-one"] };
		const failed = await go(f, stack(), RECIPE_ONE);
		assert.equal(failed.outcomes["pkg:pkg-one"]?.status, "failed", JSON.stringify(failed.outcomes["pkg:pkg-one"]));
		const record = new StateStore(f.layout).record("pkg:pkg-one");
		assert.equal(record?.status, "failed", "not the old ok");
		assert.equal(record?.lastFailure?.category, "integrity");
		assert.deepEqual(record?.hashes, {}, "and none of the old install's hashes");
		// Repair what the review's trace needs for the old record to pass: the lock says the pin again, the entry is back, package.json is the same bytes.
		const lock = JSON.parse(readFileSync(lockFile(f), "utf8")) as { packages: Record<string, unknown> };
		lock.packages["node_modules/pkg-one"] = { version: "1.0.0", integrity: published.one.integrity };
		writeFileSync(lockFile(f), JSON.stringify(lock));
		writeFileSync(join(f.layout.agent, "settings.json"), JSON.stringify({ ...settings(f), packages: [...(settings(f).packages as unknown[]), "npm:pkg-one@1.0.0"] }));
		f.fail = { install: [], remove: [] };
		f.lock = goodLock();
		const next = await go(f, stack(), RECIPE_ONE);
		assert.equal(next.outcomes["pkg:pkg-one"]?.status, "installed", "a failed record is never a verified one");
	});

	it("a failure before pi install touched anything keeps the old ok and its version (the old install is still the active one)", async () => {
		const f = await fixture();
		f.lock = lockOf(pin(published.profile), pin(published.profile2));
		await go(f, stackFor(pin(published.profile)), { ...RECIPE, packages: [] });
		assert.equal(new StateStore(f.layout).record("profile")?.version, "0.1.0");
		// the stack moves to 0.2.0, but the registry does not confirm the pin: nothing was installed
		const wrong = { ...pin(published.profile2), integrity: `sha512-${Buffer.alloc(64, 8).toString("base64")}` };
		const out = await go(f, stackFor(wrong), { ...RECIPE, packages: [] });
		assert.equal(out.outcomes.profile?.failure?.category, "integrity");
		const record = new StateStore(f.layout).record("profile");
		assert.equal(record?.status, "ok");
		assert.equal(record?.version, "0.1.0");
		assert.equal(record?.lastFailure?.category, "integrity");
		assert.equal(installedVersion(f.layout, PROFILE), "0.1.0");
	});
});

describe("T7-F010: npm's configuration files cannot turn the lock off", () => {
	it("every pi install and pi remove gets NPM_CONFIG_PACKAGE_LOCK=true and NPM_CONFIG_SAVE=true, which outrank a user's package-lock=false and save=false", async () => {
		const f = await fixture();
		const stack = stackFor(pin(published.profile), [pin(published.one)]);
		f.lock = { ...lockOf(pin(published.profile)), "pkg-one@1.0.0": `sha512-${Buffer.alloc(64, 3).toString("base64")}` };
		await go(f, stack, { ...RECIPE, packages: [] });
		const seen = jsonLines(f.envLog);
		assert.deepEqual(seen.map((e) => `${e.command} ${e.name}`), [`install ${PROFILE}`, "install pkg-one", "remove pkg-one"]);
		for (const e of seen) assert.deepEqual([e.lock, e.save], ["true", "true"], `${e.command} ${e.name}`);
	});
});

describe("pkg-prune: a package an earlier stack installed and this one no longer lists is removed", () => {
	const gen14 = (): Stack => stackFor(pin(published.profile), [pin(published.one), pin(published.old)]);
	const gen15 = (): Stack => stackFor(pin(published.profile), [pin(published.one), pin(published.neu)]);
	const NO_TEAM = { ...RECIPE, packages: [] };
	const lock = (): Record<string, string> => lockOf(pin(published.profile), pin(published.one), pin(published.old), pin(published.neu), pin(published.team));
	const sources = (f: Fixture): unknown[] => (settings(f).packages as unknown[]).map((e) => (typeof e === "string" ? e : (e as { source: string }).source));
	const statuses = (out: RunOut): Record<string, string> => Object.fromEntries(Object.entries(out.outcomes).map(([k, v]) => [k, v.status]));
	const OLD = "npm:show-old@0.11.2";
	const NEW = "npm:show-new@0.6.1";

	/** A root on the old stack, as a machine that installed generation 14 is. */
	async function onOldStack(recipe: unknown = NO_TEAM): Promise<Fixture> {
		const f = await fixture();
		f.lock = lock();
		const first = await go(f, gen14(), recipe);
		assert.equal(first.outcomes["pkg:show-old"]?.status, "installed", JSON.stringify(first.outcomes["pkg:show-old"]));
		assert.ok(sources(f).includes(OLD));
		return f;
	}

	it("an update installs the new package first, then removes the dropped one through pi and forgets its record; the next run finds nothing to remove", async () => {
		const f = await onOldStack();
		const out = await go(f, gen15(), NO_TEAM);
		assert.deepEqual(statuses(out), { profile: "skipped-verified", "pkg:pkg-one": "skipped-verified", "pkg:show-new": "installed", "pkg-prune": "installed" }, JSON.stringify(Object.values(out.outcomes).map((o) => o.failure)));
		assert.deepEqual(calls(f).slice(-2), [`install ${NEW}`, `remove ${OLD}`], "the replacement is installed and checked before the old package goes");
		assert.equal(out.outcomes[PRUNE_STAGE]?.evidence, "removed show-old@0.11.2");
		assert.ok(sources(f).includes(NEW) && !sources(f).includes(OLD), JSON.stringify(sources(f)));
		assert.equal(installedVersion(f.layout, "show-old"), null);
		const store = new StateStore(f.layout);
		assert.equal(store.record("pkg:show-old"), null, "the record of the dropped package is gone");
		assert.equal(store.record(PRUNE_STAGE)?.status, "ok");
		assert.match(readFileSync(join(f.layout.logs, "bootstrap.jsonl"), "utf8"), /"event":"pruned"[^\n]*"package":"show-old"[^\n]*"how":"removed"/);
		const again = await go(f, gen15(), NO_TEAM);
		assert.equal(again.outcomes[PRUNE_STAGE]?.status, "skipped-verified");
		assert.equal(again.outcomes[PRUNE_STAGE]?.evidence, "nothing to remove");
		assert.equal(calls(f).filter((c) => c.startsWith("remove")).length, 1, "nothing is removed twice");
	});

	it("a rollback is the same run the other way: the new package is removed and the old one installed again", async () => {
		const f = await onOldStack();
		await go(f, gen15(), NO_TEAM);
		const back = await go(f, gen14(), NO_TEAM);
		assert.deepEqual(statuses(back), { profile: "skipped-verified", "pkg:pkg-one": "skipped-verified", "pkg:show-old": "installed", "pkg-prune": "installed" }, JSON.stringify(Object.values(back.outcomes).map((o) => o.failure)));
		assert.deepEqual(calls(f).slice(-2), [`install ${OLD}`, `remove ${NEW}`]);
		assert.ok(sources(f).includes(OLD) && !sources(f).includes(NEW), JSON.stringify(sources(f)));
		assert.equal(installedVersion(f.layout, "show-new"), null);
		assert.equal(installedVersion(f.layout, "show-old"), "0.11.2");
		assert.equal(new StateStore(f.layout).record("pkg:show-new"), null);
	});

	it("a Repair (force) of the new stack removes the dropped package too", async () => {
		const f = await onOldStack();
		const options = { npm: { env: envOf(f) } };
		const stages = (): Stage[] => standalone(profileStages(gen15(), engineRecipeOf(NO_TEAM, gen15()), platform, options).filter((s) => s.name !== "pi-settings").map((s) => ({ ...s, needs: s.needs.map((n) => (n === "pi-settings" ? "profile" : n)) })));
		const engine = testEngine(f.root, stages, { appEnv: f.appEnv, layout: f.layout });
		await engine.engine.handle({ type: "run", config: { root: f.root, stack: gen15(), secretPatterns, recipe: NO_TEAM, force: true } });
		const done = engine.events.find((e) => e.type === "done");
		assert.ok(done?.type === "done" && done.ok, JSON.stringify(engine.events.filter((e) => e.type === "error" || (e.type === "stage" && e.outcome.status === "failed"))));
		assert.ok(!sources(f).includes(OLD) && sources(f).includes(NEW));
	});

	it("touches nothing the desk did not install: a recipe package, a package the PM listed, and the PM's own version of the dropped package all stay", async () => {
		const f = await onOldStack(RECIPE);
		// The PM (or another tool) listed a package of their own, and one more that is on disk too.
		const before = settings(f);
		writeFileSync(join(f.layout.agent, "settings.json"), JSON.stringify({ ...before, packages: [...(before.packages ?? []), "npm:pm-own@1.0.0", { source: "npm:pm-skills@2.0.0", extensions: [] }] }, null, 2));
		const out = await go(f, gen15(), RECIPE);
		assert.equal(out.outcomes[PRUNE_STAGE]?.status, "installed", JSON.stringify(out.outcomes[PRUNE_STAGE]));
		assert.deepEqual(calls(f).filter((c) => c.startsWith("remove")), [`remove ${OLD}`], "one removal, of the one package the desk installed for the old stack");
		const now = settings(f).packages as unknown[];
		assert.ok(now.includes("npm:pm-own@1.0.0"), "the PM's package is still listed");
		assert.ok(now.some((e) => typeof e === "object" && (e as { source: string }).source === "npm:pm-skills@2.0.0"));
		assert.ok(now.some((e) => typeof e === "object" && (e as { source: string }).source === "npm:team-skills@0.1.3"), "the recipe's package is still listed");
		assert.equal(installedVersion(f.layout, "team-skills"), "0.1.3");
		assert.equal(new StateStore(f.layout).record("team-pkg:team-skills")?.status, "ok");

		// The PM moved the dropped package to a version of their own: pi replaced the desk's listing, so the desk's is absent and theirs is not touched.
		const g = await onOldStack();
		const listed = settings(g);
		writeFileSync(join(g.layout.agent, "settings.json"), JSON.stringify({ ...listed, packages: (listed.packages ?? []).map((e) => (e === OLD ? "npm:show-old@0.12.0" : e)) }, null, 2));
		const kept = await go(g, gen15(), NO_TEAM);
		assert.equal(kept.outcomes[PRUNE_STAGE]?.status, "installed", JSON.stringify(kept.outcomes[PRUNE_STAGE]));
		assert.equal(kept.outcomes[PRUNE_STAGE]?.evidence, "nothing to remove");
		assert.deepEqual(calls(g).filter((c) => c.startsWith("remove")), [], "pi remove matches by name, so it is not run for a listing that is not the desk's");
		assert.ok(sources(g).includes("npm:show-old@0.12.0"));
		assert.equal(new StateStore(g.layout).record("pkg:show-old"), null, "the desk no longer answers for it");
	});

	it("leaves a dropped package alone when the recipe lists it now: the team stage owns it", async () => {
		const f = await onOldStack();
		const recipe = { ...RECIPE, packages: [pin(published.old)] };
		const out = await go(f, gen15(), recipe);
		assert.equal(out.outcomes["team-pkg:show-old"]?.status, "installed", JSON.stringify(out.outcomes["team-pkg:show-old"]));
		assert.equal(out.outcomes[PRUNE_STAGE]?.status, "skipped-verified", JSON.stringify(out.outcomes[PRUNE_STAGE]));
		assert.deepEqual(calls(f).filter((c) => c.startsWith("remove")), []);
		assert.deepEqual((settings(f).packages as unknown[]).find((e) => typeof e === "object" && (e as { source: string }).source === OLD), { source: OLD, extensions: [] });
	});

	it("when pi remove fails, the listing is taken out of settings.json instead: pi loads none of it, its files stay, and the start is not blocked", async () => {
		const f = await onOldStack();
		f.fail = { install: [], remove: ["show-old"] };
		const out = await go(f, gen15(), NO_TEAM);
		const outcome = out.outcomes[PRUNE_STAGE];
		assert.equal(outcome?.status, "installed", JSON.stringify(outcome));
		assert.match(outcome?.evidence ?? "", /^removed show-old@0\.11\.2 \(off pi's package list; its files stay under /);
		assert.ok(!sources(f).includes(OLD) && sources(f).includes(NEW), JSON.stringify(sources(f)));
		assert.equal(installedVersion(f.layout, "show-old"), "0.11.2", "the files are still there, and the evidence says so");
		const log = readFileSync(join(f.layout.logs, "bootstrap.jsonl"), "utf8");
		assert.match(log, /"event":"prune-remove-failed"[^\n]*pi remove exit 1/);
		assert.match(log, /"event":"unlisted"[^\n]*"listing":"absent"/);
		const store = new StateStore(f.layout);
		assert.deepEqual(store.startBlocks(), []);
		assert.equal(store.record("pkg:show-old"), null);
	});

	it("when the listing cannot be taken out either, the stage fails with a sentence of its own and a start block, and a later run that removes the package clears it", async () => {
		const f = await onOldStack();
		f.fail = { install: [], remove: ["show-old"] };
		const out = await go(f, gen15(), NO_TEAM, { FAKE_PI_BREAK: JSON.stringify(["show-old"]) });
		const outcome = out.outcomes[PRUNE_STAGE];
		assert.equal(outcome?.status, "failed", JSON.stringify(outcome));
		assert.equal(outcome?.attempts, 1, "not retried: the bytes of settings.json will not change by waiting");
		assert.equal(outcome?.failure?.sentence, packageDroppedSentence("show-old"));
		assert.deepEqual(outcome?.failure?.params, { stage: PRUNE_STAGE, reason: "package-dropped", name: "show-old" });
		assert.match(outcome?.failure?.detail ?? "", /show-old@0\.11\.2: pi remove failed \(exit 1\), and its listing in settings\.json is not readable, so what pi loads is unknown/);
		assert.match(outcome?.failure?.detail ?? "", /the app does not start pi until a later run of pkg-prune has removed it/);
		assert.doesNotMatch(`${outcome?.failure?.sentence}\n${outcome?.failure?.detail}`, /edit|remove it from settings\.json/i, "neither asks a PM to edit a file");
		const expected = { stage: PRUNE_STAGE, kind: "package-may-load", package: "show-old", sentence: packageDroppedSentence("show-old") };
		assert.deepEqual(new StateStore(f.layout).startBlocks(), [expected]);
		assert.deepEqual(readStartGate(f.layout).blocks, [{ stage: PRUNE_STAGE, package: "show-old", sentence: packageDroppedSentence("show-old") }], "the supervisor's own read refuses the start");
		assert.equal(new StateStore(f.layout).record("pkg:show-old")?.version, "0.11.2", "the record stays, so the next run tries again");
		// The next run: the profile and the packages write settings.json again (it was unreadable), and the dropped package is no longer listed.
		f.fail = { install: [], remove: [] };
		const ok = await go(f, gen15(), NO_TEAM);
		assert.equal(ok.outcomes[PRUNE_STAGE]?.status, "installed", JSON.stringify(ok.outcomes[PRUNE_STAGE]));
		assert.deepEqual(new StateStore(f.layout).startBlocks(), []);
		assert.deepEqual(readStartGate(f.layout).blocks, []);
		assert.ok(!sources(f).includes(OLD));
		assert.equal(new StateStore(f.layout).record("pkg:show-old"), null);
	});

	/** A root where the replacement is already installed beside the old package (an earlier run was cut before the prune), and a tools folder that never goes quiet, so `pi remove` is never run (pbsswap-F001). */
	async function withBothInstalled(): Promise<{ f: Fixture; deps: Partial<EngineDeps> }> {
		const f = await onOldStack();
		const both = stackFor(pin(published.profile), [pin(published.one), pin(published.old), pin(published.neu)]);
		const first = await go(f, both, NO_TEAM);
		assert.equal(first.outcomes["pkg:show-new"]?.status, "installed", JSON.stringify(first.outcomes["pkg:show-new"]));
		assert.ok(sources(f).includes(OLD) && sources(f).includes(NEW));
		const base = testPlatform();
		const executable = join(f.layout.tools.root, "node", "24.0.0", isWindows ? "node.exe" : "node");
		return { f, deps: { platform: { ...base, processes: { ...base.processes, listUnder: async () => [{ pid: 4242, startTime: "t", executable }] } }, toolsWaitMs: 100, toolsPollMs: 10 } };
	}

	it("when pi remove cannot even run (a program of an earlier run never ends), the listing is still taken out of settings.json (pbsswap-F001)", async () => {
		const { f, deps } = await withBothInstalled();
		const before = calls(f).length;
		const out = await go(f, gen15(), NO_TEAM, {}, deps);
		const outcome = out.outcomes[PRUNE_STAGE];
		assert.equal(outcome?.status, "installed", JSON.stringify(outcome));
		assert.match(outcome?.evidence ?? "", /^removed show-old@0\.11\.2 \(off pi's package list; its files stay under /);
		assert.equal(calls(f).length, before, "pi was not run");
		assert.ok(!sources(f).includes(OLD) && sources(f).includes(NEW), JSON.stringify(sources(f)));
		assert.match(readFileSync(join(f.layout.logs, "bootstrap.jsonl"), "utf8"), /"event":"prune-remove-failed"[^\n]*pi remove did not run/);
		const store = new StateStore(f.layout);
		assert.deepEqual(store.startBlocks(), []);
		assert.equal(store.record("pkg:show-old"), null);
	});

	it("when pi remove cannot run and the listing cannot be taken out either, the start is blocked (pbsswap-F001)", { skip: isWindows ? "a read-only folder is a POSIX way to make the unlisting fail" : false }, async () => {
		const { f, deps } = await withBothInstalled();
		chmodSync(f.layout.agent, 0o555);
		let out: RunOut;
		try {
			out = await go(f, gen15(), NO_TEAM, {}, deps);
		} finally {
			chmodSync(f.layout.agent, 0o755);
		}
		const outcome = out.outcomes[PRUNE_STAGE];
		assert.equal(outcome?.status, "failed", JSON.stringify(outcome));
		assert.deepEqual(outcome?.failure?.params, { stage: PRUNE_STAGE, reason: "package-dropped", name: "show-old" });
		assert.match(outcome?.failure?.detail ?? "", /show-old@0\.11\.2: pi remove did not run, and its listing in settings\.json is still listed, so pi loads it with its extensions/);
		assert.ok(sources(f).includes(OLD), "still listed");
		assert.deepEqual(readStartGate(f.layout).blocks, [{ stage: PRUNE_STAGE, package: "show-old", sentence: packageDroppedSentence("show-old") }]);
		assert.equal(new StateStore(f.layout).record("pkg:show-old")?.version, "0.11.2", "the record stays, so the next run tries again");
	});

	it("a start block ends when a stack lists the package again (a rollback), without the prune removing anything", async () => {
		const f = await onOldStack();
		const block = { kind: "package-may-load" as const, package: "show-old", sentence: packageDroppedSentence("show-old") };
		await new StateStore(f.layout).setRecord(PRUNE_STAGE, { status: "failed", version: "format 1", evidence: "", at: "2026-11-12T00:00:00.000Z", hashes: {}, dependsOn: {}, startBlock: block });
		const back = await go(f, gen14(), NO_TEAM);
		assert.equal(back.outcomes[PRUNE_STAGE]?.status, "skipped-verified", JSON.stringify(back.outcomes[PRUNE_STAGE]));
		assert.deepEqual(new StateStore(f.layout).startBlocks(), [], "the stage's record is written again without the block");
		assert.deepEqual(calls(f).filter((c) => c.startsWith("remove")), []);
		assert.ok(sources(f).includes(OLD));
	});

	it("forgets the record a cut install left for a package the stack then dropped, so the start gate no longer reads an interrupted install", async () => {
		const f = await onOldStack();
		// An update to the new stack was cut while `pkg:show-new` ran pi: its record says `running`, and nothing of it is listed.
		await new StateStore(f.layout).setRecord("pkg:show-new", { status: "running", version: "0.6.1", evidence: "", at: "2026-11-12T00:00:00.000Z", hashes: {}, dependsOn: {} });
		assert.deepEqual(readStartGate(f.layout).interrupted, ["pkg:show-new"]);
		const back = await go(f, gen14(), NO_TEAM);
		assert.equal(back.outcomes[PRUNE_STAGE]?.status, "installed", JSON.stringify(back.outcomes[PRUNE_STAGE]));
		assert.deepEqual(calls(f).filter((c) => c.startsWith("remove")), [], "nothing of it was listed, so pi was not asked");
		assert.deepEqual(readStartGate(f.layout).interrupted, []);
		assert.equal(new StateStore(f.layout).record("pkg:show-new"), null);
	});

	it("a prune cut after pi remove began is an interrupted install to the start gate, like any package stage", () => {
		assert.equal(isPackageStage(PRUNE_STAGE), true);
	});
});

describe("the stage list", () => {
	const pins = (names: string[]): NpmPin[] => names.map((name) => ({ name, version: "1.0.0", integrity: published.one.integrity }));
	const s = (names: string[]): Stack => stackFor(pin(published.profile), pins(names));

	it("orders profile, pi-settings (Windows), pkg:*, pkg-prune, team-pkg:*, and claude as the spec's table does", () => {
		const stack = s(["pi-claude-bridge", "pkg-one"]);
		const recipe = engineRecipeOf(RECIPE, stack);
		const win = profileStages(stack, recipe, "win32");
		const mac = profileStages(stack, recipe, "darwin");
		assert.deepEqual(win.map((x) => x.name), ["profile", "pi-settings", "pkg:pi-claude-bridge", "pkg:pkg-one", "pkg-prune", "team-pkg:team-skills", "claude"]);
		assert.deepEqual(mac.map((x) => x.name), ["profile", "pkg:pi-claude-bridge", "pkg:pkg-one", "pkg-prune", "team-pkg:team-skills", "claude"]);
		const needs = (stages: Stage[]): Record<string, readonly string[]> => Object.fromEntries(stages.map((x) => [x.name, x.needs]));
		assert.deepEqual(needs(win), {
			profile: ["pi"],
			"pi-settings": ["profile", "git"],
			"pkg:pi-claude-bridge": ["pi-settings"],
			"pkg:pkg-one": ["pi-settings"],
			// After every package of the stack: the new one is installed and checked before the one it replaces goes.
			"pkg-prune": ["pi-settings", "pkg:pi-claude-bridge", "pkg:pkg-one"],
			"team-pkg:team-skills": ["pi-settings", "pkg:pi-claude-bridge", "pkg:pkg-one"],
			claude: ["pkg:pi-claude-bridge"],
		});
		assert.deepEqual(needs(mac)["pkg:pkg-one"], ["profile"]);
		assert.deepEqual(needs(mac)["team-pkg:team-skills"], ["profile", "pkg:pi-claude-bridge", "pkg:pkg-one"]);
		assert.deepEqual(needs(mac)["pkg-prune"], ["profile", "pkg:pi-claude-bridge", "pkg:pkg-one"]);
		assert.deepEqual(needs(profileStages(s([]), recipe, "darwin"))["team-pkg:team-skills"], ["profile"], "a stack with no package still keeps the team package behind the profile");
		assert.deepEqual(needs(profileStages(s([]), recipe, "darwin"))["pkg-prune"], ["profile"], "and the prune behind the stage that wrote settings.json");
	});

	it("makes pi-claude-bridge wait for the pinned Agent SDK, which is listed first, and the claude stage checks that pin", () => {
		const stack = s(["@anthropic-ai/claude-agent-sdk", "pi-claude-bridge"]);
		const stages = profileStages(stack, engineRecipeOf(undefined, stack), "darwin");
		assert.deepEqual(stages.map((x) => x.name), ["profile", "pkg:@anthropic-ai/claude-agent-sdk", "pkg:pi-claude-bridge", "pkg-prune", "claude"]);
		assert.deepEqual(stages.find((x) => x.name === "pkg:pi-claude-bridge")?.needs, ["profile", "pkg:@anthropic-ai/claude-agent-sdk"]);
		assert.deepEqual(stages.find((x) => x.name === "pkg:@anthropic-ai/claude-agent-sdk")?.needs, ["profile"]);
	});

	it("has no claude stage when the stack does not list pi-claude-bridge, and no team-pkg stage for a recipe without packages", () => {
		const stack = s(["pkg-one"]);
		assert.deepEqual(profileStages(stack, engineRecipeOf({ ...RECIPE, packages: [] }, stack), "darwin").map((x) => x.name), ["profile", "pkg:pkg-one", "pkg-prune"]);
		assert.deepEqual(profileStages(stack, engineRecipeOf(undefined, stack), "darwin").map((x) => x.name), ["profile", "pkg:pkg-one", "pkg-prune"]);
	});

	it("allStages joins the tool stages and the profile stages, and every stage that needs one leads to a stage in the list", () => {
		const stack = s(["pi-claude-bridge", "pkg-one"]);
		const stages = allStages(stack, engineRecipeOf(RECIPE, stack), platform);
		const names = new Set(stages.map((x) => x.name));
		assert.equal(names.size, stages.length, "no stage name twice");
		for (const stage of stages) for (const need of stage.needs) assert.ok(names.has(need), `${stage.name} needs ${need}, which is not a stage`);
		for (const name of ["pi", "profile", "pkg:pkg-one", "pkg-prune", "team-pkg:team-skills", "claude"]) assert.ok(names.has(name), name);
	});

	it("every package stage runs on the npm lane, one at a time", () => {
		const stack = s(["pkg-one"]);
		for (const stage of profileStages(stack, engineRecipeOf(RECIPE, stack), platform)) if (stage.name !== "pi-settings" && stage.name !== "claude") assert.equal(stage.lane, "npm", stage.name);
	});
});

describe("what the installer kept, as warnings", () => {
	it("says in a sentence which file or setting was kept and why", () => {
		const warnings = warningsOf([
			{ kind: "file-kept", file: "rules/a.md", reason: "edited", pending: ".straw-boss-profile/pending/1.0.0/rules/a.md" },
			{ kind: "file-kept", file: "AGENTS.md", reason: "no-record", pending: ".straw-boss-profile/pending/1.0.0/AGENTS.md" },
			{ kind: "key-kept", file: "settings.json", key: "defaultModel" },
			{ kind: "dropped-file-kept", file: "rules/old.md" },
		]);
		assert.deepEqual(warnings.map((w) => `${w.kind}|${w.path}`), ["profile-file-kept|rules/a.md", "profile-file-kept|AGENTS.md", "profile-key-kept|settings.json", "profile-dropped-file-kept|rules/old.md"]);
		assert.match(warnings[0]?.sentence ?? "", /because you changed it/);
		assert.match(warnings[1]?.sentence ?? "", /there before the app wrote its own/);
		assert.match(warnings[2]?.sentence ?? "", /Your setting defaultModel in settings\.json was kept/);
		assert.match(warnings[3]?.sentence ?? "", /no longer part of the team profile/);
	});
});

describe("the recipe's team part", () => {
	const stack = stackFor(pin(published.profile));

	it("takes id, name, version, instructions, relay, packages, and a profile pin from a validated recipe; none from one without an id", () => {
		const team = engineRecipeOf({ ...RECIPE, profile: { version: "0.2.0", integrity: published.profile2.integrity } }, stack).team;
		assert.equal(team?.id, "waydo-pm");
		assert.equal(team?.instructions, "- one rule");
		assert.equal(team?.straw?.relay, "https://relay.waydo.example/");
		assert.deepEqual(team?.packages, [pin(published.team)]);
		assert.deepEqual(team?.profile, { version: "0.2.0", integrity: published.profile2.integrity });
		assert.equal(engineRecipeOf({ forges: [], tools: [] }, stack).team, undefined);
	});

	it("T7-F009: refuses a package name that is not an npm name, so it never reaches npm's or pi's arguments", () => {
		const named = (name: string): unknown => ({ ...RECIPE, packages: [{ name, version: "1.0.0", integrity: published.one.integrity }] });
		for (const name of ["--registry=https://x/", "-x", "--ignore-scripts", "@scope/--x", "UPPER", "a b", "@scope", "a/b", "../x", ".hidden", "_x", "x".repeat(215)]) {
			assert.throws(() => engineRecipeOf(named(name), stack), /npm package name/, JSON.stringify(name));
		}
		assert.equal(engineRecipeOf(named("@scope/ok-name.1"), stack).team?.packages[0]?.name, "@scope/ok-name.1");
	});

	it("T7-F009: the stage's own steps refuse such a name too, before any program is started", async () => {
		const started: string[] = [];
		const ctx = { stage: "team-pkg:x", exec: async (file: string) => (started.push(file), { code: 0, stdout: "", stderr: "" }), versionsOf: () => ({ node: "24.0.0" }) } as unknown as StageContext;
		const bad: NpmPin = { name: "--registry=https://x/", version: "1.0.0", integrity: published.one.integrity };
		await assert.rejects(() => assertRegistryIntegrity(ctx, bad), StackError);
		assert.throws(() => piSource(bad), StackError);
		assert.deepEqual(started, []);
	});

	it("refuses a package or a profile pin of the wrong shape, and a package listed twice", () => {
		const bad = (extra: Record<string, unknown>): unknown => ({ ...RECIPE, ...extra });
		assert.throws(() => engineRecipeOf(bad({ packages: [{ name: "x", version: "1", integrity: "sha512-x" }] }), stack), StackError);
		assert.throws(() => engineRecipeOf(bad({ packages: [pin(published.team), pin(published.team)] }), stack), /listed twice/);
		assert.throws(() => engineRecipeOf(bad({ profile: { version: "0.2.0", integrity: "nope" } }), stack), StackError);
		assert.throws(() => engineRecipeOf(bad({ name: "" }), stack), StackError);
		assert.throws(() => engineRecipeOf(bad({ straw: { relay: 5 } }), stack), StackError);
	});
});

describe("running pi and reading what it left", () => {
	it("names a package folder under node_modules, and refuses a name that is not an npm name", () => {
		const made = scratchRoot("sbd-prof-n-");
		scratch.push(made.base);
		const layout = testLayout(made.root);
		assert.equal(agentPackageDir(layout, "@scope/name"), join(layout.agent, "npm", "node_modules", "@scope", "name"));
		for (const name of ["../x", "a/b/c", "A", "x y", "@scope", "..", "a\\b", "", "x".repeat(215)]) assert.throws(() => agentPackageDir(layout, name), StackError, JSON.stringify(name));
		assert.equal(piSource({ name: "@s/n", version: "1.0.0" }), "npm:@s/n@1.0.0");
	});

	it("reads npm's lock entry whatever path prefix its key carries, and tells a match, a mismatch, and an absence apart", () => {
		const made = scratchRoot("sbd-prof-l-");
		scratch.push(made.base);
		const layout = testLayout(made.root);
		mkdirSync(join(layout.agent, "npm"), { recursive: true });
		const lockFile = join(layout.agent, "npm", "package-lock.json");
		const p: NpmPin = { name: "@scope/name", version: "1.0.0", integrity: "sha512-AAA" };
		const write = (packages: Record<string, unknown>): void => writeFileSync(lockFile, JSON.stringify({ packages }));
		assert.deepEqual(checkLockedIntegrity(layout, p), { kind: "absent" }, "no lock file");
		write({ "node_modules/@scope/name": { version: "1.0.0", integrity: "sha512-AAA" } });
		assert.deepEqual(checkLockedIntegrity(layout, p), { kind: "match" });
		write({ "../../../../private/tmp/x/agent/npm/node_modules/@scope/name": { version: "1.0.0", integrity: "sha512-AAA" } });
		assert.deepEqual(checkLockedIntegrity(layout, p), { kind: "match" }, "a key with a path prefix");
		write({ "node_modules/@scope/name": { version: "1.0.0", integrity: "sha512-BBB" } });
		assert.deepEqual(checkLockedIntegrity(layout, p), { kind: "mismatch", recorded: "sha512-BBB" });
		write({ "node_modules/@scope/name": { version: "0.9.0", integrity: "sha512-AAA" } });
		assert.deepEqual(checkLockedIntegrity(layout, p), { kind: "absent" }, "another version of the package");
		write({ "node_modules/@scope/name": { version: "1.0.0" } });
		assert.deepEqual(checkLockedIntegrity(layout, p), { kind: "absent" }, "an entry with no integrity");
		write({ "node_modules/other": { version: "1.0.0", integrity: "sha512-AAA" }, "node_modules/x/node_modules/@scope/name-ish": { version: "1.0.0", integrity: "sha512-AAA" } });
		assert.deepEqual(checkLockedIntegrity(layout, p), { kind: "absent" }, "another package whose name only starts the same");
		writeFileSync(lockFile, "not json");
		assert.deepEqual(checkLockedIntegrity(layout, p), { kind: "absent" });
	});

	it("T7-F008: only the top-level entry answers; a copy nested under a dependency does not, even one that sorts first", () => {
		const made = scratchRoot("sbd-prof-t-");
		scratch.push(made.base);
		const layout = testLayout(made.root);
		mkdirSync(join(layout.agent, "npm"), { recursive: true });
		const lockFile = join(layout.agent, "npm", "package-lock.json");
		const p: NpmPin = { name: "@scope/name", version: "1.0.0", integrity: "sha512-AAA" };
		const write = (packages: Record<string, unknown>): void => writeFileSync(lockFile, JSON.stringify({ packages }));
		const genuine = { version: "1.0.0", integrity: "sha512-AAA" };
		const tampered = { version: "1.0.0", integrity: "sha512-BBB" };
		// npm sorts its keys, so a nested key can come before the top-level one: the genuine nested copy must not answer for the tampered top-level one.
		write({ "node_modules/dep/node_modules/@scope/name": genuine, "node_modules/@scope/name": tampered });
		assert.deepEqual(checkLockedIntegrity(layout, p), { kind: "mismatch", recorded: "sha512-BBB" });
		write({ "node_modules/dep/node_modules/@scope/name": genuine });
		assert.deepEqual(checkLockedIntegrity(layout, p), { kind: "absent" }, "a nested copy alone is not the installed package");
		write({ "../../x/agent/npm/node_modules/dep/node_modules/@scope/name": genuine, "../../x/agent/npm/node_modules/@scope/name": tampered });
		assert.deepEqual(checkLockedIntegrity(layout, p), { kind: "mismatch", recorded: "sha512-BBB" }, "the same behind a path prefix");
		write({ "../../x/agent/npm/node_modules/dep/node_modules/@scope/name": genuine });
		assert.deepEqual(checkLockedIntegrity(layout, p), { kind: "absent" });
	});

	it("piInvocation fails by name when the pinned pi is not installed", async () => {
		const made = scratchRoot("sbd-prof-i-");
		scratch.push(made.base);
		const layout = testLayout(made.root);
		installFakeNode(layout, "24.0.0");
		const store = new StateStore(layout);
		await store.setVersion("node", "24.0.0");
		await store.setVersion("git", "2.56.0");
		await store.setVersion("herdr", "0.9.5");
		const ctx = { stage: "profile", stack: stackFor(pin(published.profile)), layout, versionsOf: (tools: string[]) => Object.fromEntries(tools.map((t) => [t, store.version(t) as string])) } as unknown as StageContext;
		assert.throws(() => piInvocation(ctx), /@earendil-works\/pi-coding-agent is not installed/);
		installFakePi(layout);
		assert.match(piInvocation(ctx).script, /dist[\\/]cli\.js$/);
	});
});

describe("R9-F001: a package stage waits for a program of an earlier run that still runs under <root>/tools, and fails as locked when it never ends", () => {
	/** A process table whose listing under the tools folder names an `npm`-sized leftover `busy(call)` says so, and that notes whether pi had run when it answered. */
	const withLeftover = (f: Fixture, busy: (call: number) => boolean): { deps: Partial<EngineDeps>; answers: Array<{ busy: boolean; piCalls: number }> } => {
		const answers: Array<{ busy: boolean; piCalls: number }> = [];
		const base = testPlatform();
		let call = 0;
		return {
			answers,
			deps: {
				platform: {
					...base,
					processes: {
						...base.processes,
						listUnder: async () => {
							const hit = busy(++call);
							answers.push({ busy: hit, piCalls: calls(f).length });
							return hit ? [{ pid: 4242, startTime: "t", executable: join(f.layout.tools.root, "node", "24.0.0", isWindows ? "node.exe" : "node") }] : [];
						},
					},
				},
				toolsWaitMs: 5_000,
				toolsPollMs: 10,
			},
		};
	};

	it("does not run pi until the listing is empty, and then installs", async () => {
		const f = await fixture();
		f.lock = lockOf(pin(published.profile));
		const table = withLeftover(f, (call) => call <= 3);
		const out = await go(f, stackFor(pin(published.profile)), { ...RECIPE, packages: [] }, {}, table.deps);
		assert.equal(out.outcomes.profile?.status, "installed", JSON.stringify(out.outcomes.profile));
		assert.deepEqual(table.answers.map((a) => a.busy), [true, true, true, false], "three listings named the leftover, the fourth was empty");
		assert.ok(table.answers.every((a) => a.piCalls === 0), "pi had not been run when any of them answered");
		assert.deepEqual(calls(f), [`install npm:${PROFILE}@0.1.0`]);
	});

	it("lists once for the whole run: a second package stage does not wait again", async () => {
		const f = await fixture();
		f.lock = lockOf(pin(published.profile), pin(published.one));
		const table = withLeftover(f, () => false);
		const out = await go(f, stackFor(pin(published.profile), [pin(published.one)]), { ...RECIPE, packages: [] }, {}, table.deps);
		assert.equal(out.outcomes["pkg:pkg-one"]?.status, "installed");
		assert.equal(table.answers.length, 1, "the profile stage listed, the package stage reused the answer");
	});

	it("fails the stage as locked (reason tools-running, one attempt, pi never run) when the leftover is still there after the wait, and keeps an old ok record", async () => {
		const f = await fixture();
		f.lock = lockOf(pin(published.profile));
		const stack = stackFor(pin(published.profile));
		assert.equal((await go(f, stack, { ...RECIPE, packages: [] })).outcomes.profile?.status, "installed");
		const before = calls(f).length;
		// A recipe update gives the installer work, so the stage installs again: now with a leftover that never goes.
		const table = withLeftover(f, () => true);
		table.deps.toolsWaitMs = 150;
		const out = await go(f, stack, { ...RECIPE, packages: [], version: "1.1.0", instructions: "- two rules" }, {}, table.deps);
		const outcome = out.outcomes.profile;
		assert.equal(outcome?.status, "failed");
		assert.equal(outcome?.failure?.category, "locked");
		assert.equal(outcome?.failure?.params.reason, "tools-running");
		assert.equal(outcome?.attempts, 1, "the wait was the retry");
		assert.equal(calls(f).length, before, "pi was not run");
		const record = new StateStore(f.layout).record("profile");
		assert.equal(record?.status, "ok", "nothing in place was touched, so the old version stays the active one");
		assert.equal(record?.lastFailure?.category, "locked");
		assert.deepEqual(readStartGate(f.layout).interrupted, []);
	});
});
