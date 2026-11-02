import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { agentPackageDir, checkLockedIntegrity, installedVersion, piInvocation, piSource } from "../src/main/bootstrap/pi-cli.ts";
import { engineRecipeOf } from "../src/main/bootstrap/recipe-config.ts";
import { StackError, type NpmPin, type Stack } from "../src/main/bootstrap/stack.ts";
import type { Stage, StageContext, StageOutcome } from "../src/main/bootstrap/stage.ts";
import { allStages } from "../src/main/bootstrap/stages/index.ts";
import { profilePin, profileStages, warningsOf } from "../src/main/bootstrap/stages/profile.ts";
import { StateStore } from "../src/main/bootstrap/state.ts";
import { makeStack, scratchRoot, secretPatterns, testEngine, testLayout } from "./harness/engine-fixture.ts";
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
};
const pin = (p: { name: string; version: string; integrity: string }): NpmPin => ({ name: p.name, version: p.version, integrity: p.integrity });

interface Fixture {
	base: string;
	root: string;
	layout: ReturnType<typeof testLayout>;
	appEnv: Record<string, string>;
	sources: string;
	log: string;
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
	return { base: made.base, root: made.root, layout, appEnv, sources, log: join(made.base, "pi-calls.log"), lock: {}, fail: { install: [], remove: [] } };
}

const stackFor = (profile: NpmPin, pkgs: NpmPin[] = []): Stack => ({ ...makeStack({}), profile: { ...profile }, piPackages: pkgs, npmGlobal: [{ name: "@earendil-works/pi-coding-agent", version: "1.4.0", integrity: "sha512-x", bin: "pi" }] });

const envOf = (f: Fixture, extra: Record<string, string> = {}): Record<string, string> => ({
	NPM_CONFIG_REGISTRY: registry.url,
	NPM_CONFIG_FETCH_RETRIES: "0",
	FAKE_PI_SOURCES: f.sources,
	FAKE_PI_LOG: f.log,
	FAKE_PI_LOCK: JSON.stringify(f.lock),
	FAKE_PI_FAIL: JSON.stringify(f.fail),
	...extra,
});

/** The stage list with `needs` cut down to the stages in it (the stages before `profile` are stood in for by the fixture). */
const standalone = (stages: Stage[]): Stage[] => {
	const names = new Set(stages.map((s) => s.name));
	return stages.map((s) => ({ ...s, needs: s.needs.filter((n) => names.has(n)) }));
};

const calls = (f: Fixture): string[] => (existsSync(f.log) ? readFileSync(f.log, "utf8").split("\n").filter((l) => l !== "") : []);

interface RunOut {
	outcomes: Record<string, StageOutcome>;
	order: string[];
	error: string | null;
}

async function go(f: Fixture, stack: Stack, recipe: unknown, extraEnv: Record<string, string> = {}): Promise<RunOut> {
	const options = { npm: { env: envOf(f, extraEnv) } };
	// `pi-settings` (Windows) merges `shellPath` and needs a PortableGit's bash.exe; its own tests are in pi-settings.test.ts. Here the stages after it stand on `profile`.
	const stages = (): Stage[] => standalone(profileStages(stack, engineRecipeOf(recipe, stack), platform, options).filter((s) => s.name !== "pi-settings"));
	const engine = testEngine(f.root, stages, { appEnv: f.appEnv, layout: f.layout });
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

	it("RC-F001: when pi remove fails as well, the failure says the package may still be enabled, and the log says rollback-failed, not rolled-back", async () => {
		const f = await fixture();
		f.lock = lock();
		f.fail = { install: [], remove: ["team-skills"] };
		const out = await go(f, stack(), RECIPE, { FAKE_PI_UNLISTED: JSON.stringify(["team-skills"]) });
		const outcome = out.outcomes["team-pkg:team-skills"];
		assert.equal(outcome?.status, "failed", JSON.stringify(outcome));
		assert.match(outcome?.failure?.detail ?? "", /removing it failed \(pi remove exit 1\), so it may still be enabled with its extensions; remove it from settings\.json before starting pi/);
		const log = readFileSync(join(f.layout.logs, "bootstrap.jsonl"), "utf8");
		assert.match(log, /rollback-failed/);
		assert.doesNotMatch(log, /"rolled-back"/);
		assert.equal(installedVersion(f.layout, "team-skills"), "0.1.3", "the package is still there, and the message says so");
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

describe("the stage list", () => {
	const pins = (names: string[]): NpmPin[] => names.map((name) => ({ name, version: "1.0.0", integrity: published.one.integrity }));
	const s = (names: string[]): Stack => stackFor(pin(published.profile), pins(names));

	it("orders profile, pi-settings (Windows), pkg:*, team-pkg:*, and claude as the spec's table does", () => {
		const stack = s(["pi-claude-bridge", "pkg-one"]);
		const recipe = engineRecipeOf(RECIPE, stack);
		const win = profileStages(stack, recipe, "win32");
		const mac = profileStages(stack, recipe, "darwin");
		assert.deepEqual(win.map((x) => x.name), ["profile", "pi-settings", "pkg:pi-claude-bridge", "pkg:pkg-one", "team-pkg:team-skills", "claude"]);
		assert.deepEqual(mac.map((x) => x.name), ["profile", "pkg:pi-claude-bridge", "pkg:pkg-one", "team-pkg:team-skills", "claude"]);
		const needs = (stages: Stage[]): Record<string, readonly string[]> => Object.fromEntries(stages.map((x) => [x.name, x.needs]));
		assert.deepEqual(needs(win), {
			profile: ["pi"],
			"pi-settings": ["profile", "git"],
			"pkg:pi-claude-bridge": ["pi-settings"],
			"pkg:pkg-one": ["pi-settings"],
			"team-pkg:team-skills": ["pi-settings", "pkg:pi-claude-bridge", "pkg:pkg-one"],
			claude: ["pkg:pi-claude-bridge"],
		});
		assert.deepEqual(needs(mac)["pkg:pkg-one"], ["profile"]);
		assert.deepEqual(needs(mac)["team-pkg:team-skills"], ["profile", "pkg:pi-claude-bridge", "pkg:pkg-one"]);
		assert.deepEqual(needs(profileStages(s([]), recipe, "darwin"))["team-pkg:team-skills"], ["profile"], "a stack with no package still keeps the team package behind the profile");
	});

	it("has no claude stage when the stack does not list pi-claude-bridge, and no team-pkg stage for a recipe without packages", () => {
		const stack = s(["pkg-one"]);
		assert.deepEqual(profileStages(stack, engineRecipeOf({ ...RECIPE, packages: [] }, stack), "darwin").map((x) => x.name), ["profile", "pkg:pkg-one"]);
		assert.deepEqual(profileStages(stack, engineRecipeOf(undefined, stack), "darwin").map((x) => x.name), ["profile", "pkg:pkg-one"]);
	});

	it("allStages joins the tool stages and the profile stages, and every stage that needs one leads to a stage in the list", () => {
		const stack = s(["pi-claude-bridge", "pkg-one"]);
		const stages = allStages(stack, engineRecipeOf(RECIPE, stack), platform);
		const names = new Set(stages.map((x) => x.name));
		assert.equal(names.size, stages.length, "no stage name twice");
		for (const stage of stages) for (const need of stage.needs) assert.ok(names.has(need), `${stage.name} needs ${need}, which is not a stage`);
		for (const name of ["pi", "profile", "pkg:pkg-one", "team-pkg:team-skills", "claude"]) assert.ok(names.has(name), name);
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
		const layout = testLayout(scratchRoot("sbd-prof-n-").root);
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
