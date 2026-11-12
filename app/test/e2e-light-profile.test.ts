import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { binShim } from "../src/main/bootstrap/stages/pi.ts";
import { packageDir } from "../src/main/bootstrap/npm.ts";
import { agentPackageDir, installedVersion } from "../src/main/bootstrap/pi-cli.ts";
import { childEnvOf, createWorld, disposeWorld, isWindows, noteUserPath, realStack, runWorld, stateOf, stopProcessesUnder, type RunSummary, type World } from "./harness/e2e-light.ts";
import { rpcCommands } from "./harness/rpc-commands.ts";

// The task 7 anchor (spec: Tasks 7): from a root the tool stages and `pi` filled, the profile, every pi package of `stack.json`, a recipe package, and the
// `claude` stage run against the real npm registry, and `pi --mode rpc --no-session --offline` lists `skill:pm-workflow` with nothing on stderr.
// Like the task 5 and 6 anchors it downloads real releases, so it runs only where the workflow asks (SBD_E2E_LIGHT=1). Everything lives in a scratch
// folder: its own home, data root, and agent folder; the real `~/.pi` is never read.
const ON = process.env.SBD_E2E_LIGHT === "1";
const off = ON ? false : "SBD_E2E_LIGHT=1 is not set: this test downloads the real releases of stack.json and installs the pi packages from the npm registry";

const PROFILE = (realStack.profile as { name: string }).name;
const PACKAGES = (realStack.piPackages as Array<{ name: string; version: string }>).map((p) => p.name);
/** The kit's test recipe package (`spike/win/test-recipe.strawboss.json`): skills only, published on npm. */
const TEAM_PACKAGE = { name: "@zeldrisho/pi-coderabbit-skills", version: "0.1.3", integrity: "sha512-5O/nfBCSoYIZs2YW98/3kFVLc1fy+7PI1+WC3AaGwXeGFU3Bf+l8woOCfGdtACQHepgtBcNq9quAq+hmOY1S3g==" };

const recipe = (version: string, instructions: string): Record<string, unknown> => ({
	forges: [{ kind: "github", host: "github.com" }],
	tools: [],
	id: "ci-profile",
	name: "CI profile",
	version,
	instructions,
	straw: { relay: "https://relay.ci.example/" },
	packages: [TEAM_PACKAGE],
});

const statusOf = (summary: RunSummary): Record<string, string> => Object.fromEntries(Object.entries(summary.outcomes).map(([name, o]) => [name, o.status]));
const failuresOf = (summary: RunSummary): string => Object.values(summary.outcomes).filter((o) => o.failure !== undefined).map((o) => `${o.stage}: ${o.failure?.sentence} | ${o.failure?.detail}`).join("\n");
const read = (world: World, rel: string): string => readFileSync(join(world.layout.agent, ...rel.split("/")), "utf8");

describe("the profile and the pi packages from an empty root (e2e-light, task 7)", { skip: off }, () => {
	let world: World;
	let first: RunSummary;

	before(async () => {
		world = createWorld("p");
		await noteUserPath(world);
		// T7-F010: a user's npm configuration that turns the lock file and the save off, which would leave no integrity to check. It is a file in the scratch
		// folder (npm reads any path named by NPM_CONFIG_USERCONFIG), never a file of the machine's user; the app forces both settings back on for pi's npm.
		const hostile = join(world.base, "user-npm-config.ini");
		writeFileSync(hostile, "package-lock=false\nsave=false\n");
		first = await runWorld(world, { recipe: recipe("1.0.0", "- the CI rule"), profile: true, npmEnv: { NPM_CONFIG_USERCONFIG: hostile } });
	});

	after(async () => {
		const before = world.userPathBefore;
		const real = world.realUserPath;
		const userPath = world.userPath;
		await disposeWorld(world);
		// The run took its entry off the user PATH again (Windows): the value, and its registry type, are what they were before the first stage ran.
		if (real) assert.deepEqual(await userPath.read(), before ?? null, "the user PATH is as it was before the run");
	});

	/** Starts the pinned pi in RPC mode the way a pane would (Windows: `pi` by name through the shims folder; macOS: the private prefix) and asks for its commands. */
	const commands = async () => {
		const system32 = join(world.appEnv.SystemRoot ?? "C:\\Windows", "System32");
		const result = await (isWindows
			? rpcCommands(join(system32, "cmd.exe"), ["/d", "/c", "pi", "--mode", "rpc", "--no-session", "--offline"], { env: { ...childEnvOf(world, []), PATH: [world.layout.tools.shims, system32].join(";") }, cwd: world.home })
			: rpcCommands(binShim(world.layout, "pi"), ["--mode", "rpc", "--no-session", "--offline"], { env: childEnvOf(world, []), cwd: world.home }));
		// A pi session leaves detached helpers of its own behind (pi-intercom's broker, a node that exits only after a registered session has left, and tsx's `esbuild --service` child), which `rpcCommands` does not own. The desk's package stages wait for any program under
		// <root>/tools to end before they install (R9-F001), and the product stops the stack and lists such programs before an engine run ever follows a session, so the test ends them here, more broadly than the product's stop (it ends every program under the scratch folder, not only the broker `broker.pid` names).
		await stopProcessesUnder(world.base);
		return result;
	};

	it("runs every stage: the tool stages, the profile, each package of the stack, the recipe's package, and claude, all verified", (t) => {
		t.diagnostic(`first run: ${Math.round(first.ms / 1000)} s; stages over 5 s: ${Object.values(first.outcomes).filter((o) => o.ms > 5000).map((o) => `${o.stage} ${Math.round(o.ms / 1000)} s`).join(", ")}`);
		assert.equal(first.error, null);
		assert.ok(first.ok, failuresOf(first) || JSON.stringify(first.outcomes, null, 1).slice(0, 2000));
		const expected = [
			"preflight", "node", "git", "herdr", "fd-rg", "gh", "tool-paths", "launchers", "git-helpers", "pi",
			...(isWindows ? ["pi-shim", "pi-settings"] : []),
			"profile",
			...PACKAGES.map((n) => `pkg:${n}`),
			"pkg-prune",
			`team-pkg:${TEAM_PACKAGE.name}`,
			"claude",
		].sort();
		assert.deepEqual(Object.keys(first.outcomes).sort(), expected);
		// The preflight only checks, and `pkg-prune` finds no package of an earlier stack on an empty root: both record their result without installing anything.
		for (const [name, status] of Object.entries(statusOf(first))) assert.equal(status, name === "preflight" || name === "pkg-prune" ? "skipped-verified" : "installed", `${name} is ${status}`);
		const bootstrap = stateOf(world, "bootstrap").stages as Record<string, { status: string }>;
		for (const name of expected) assert.equal(bootstrap[name]?.status, "ok", `${name} in state/bootstrap.json`);
	});

	it("pi --mode rpc --no-session --offline lists skill:pm-workflow, from the installed profile package, and writes nothing to stderr", async (t) => {
		const started = Date.now();
		const result = await commands();
		t.diagnostic(`pi answered after ${Date.now() - started} ms; commands: ${(result.commands ?? []).join(" ")}; stderr: ${JSON.stringify(result.stderr.slice(0, 400))}`);
		assert.ok(result.commands !== null, `pi answered get_commands: ${result.lines.join(" | ").slice(0, 400)} ${result.stderr.slice(0, 400)}`);
		assert.ok(result.commands.includes("skill:pm-workflow"), `commands: ${result.commands.join(" ")}`);
		const skill = result.sources.find((c) => c.name === "skill:pm-workflow");
		assert.equal(skill?.source, "skill");
		assert.ok(skill?.path?.replace(/\\/g, "/").includes(`/npm/node_modules/${PROFILE}/skills/pm-workflow/`), `the skill is loaded in place from the package: ${skill?.path}`);
		assert.equal(result.stderr, "", "stderr is empty");
		assert.ok(!existsSync(join(world.layout.agent, "skills", "pm-workflow")), "the installer did not copy the skill beside the package's own");
	});

	it("lists every package of the stack in settings.json at its pin, and the recipe's package skills-only", () => {
		const settings = JSON.parse(read(world, "settings.json")) as { packages: unknown[]; shellPath?: string };
		const sources = settings.packages.map((e) => (typeof e === "string" ? e : (e as { source: string }).source));
		for (const pin of [...(realStack.piPackages as Array<{ name: string; version: string }>), { name: PROFILE, version: (realStack.profile as { version: string }).version }]) {
			assert.ok(sources.includes(`npm:${pin.name}@${pin.version}`), `${pin.name}@${pin.version} is listed`);
			assert.equal(installedVersion(world.layout, pin.name), pin.version);
		}
		const team = settings.packages.find((e) => typeof e === "object" && (e as { source: string }).source === `npm:${TEAM_PACKAGE.name}@${TEAM_PACKAGE.version}`);
		assert.deepEqual(team, { source: `npm:${TEAM_PACKAGE.name}@${TEAM_PACKAGE.version}`, extensions: [] });
		if (isWindows) assert.equal(settings.shellPath?.endsWith("bash.exe"), true, "pi-settings merged shellPath");
		assert.ok(existsSync(join(agentPackageDir(world.layout, TEAM_PACKAGE.name), "package.json")));
	});

	it("wrote the profile's files, the team block, the relay, and the manifest", () => {
		assert.match(read(world, "AGENTS.md"), /<!-- straw-boss:team-block:begin -->\n## Team: CI profile\n\n- the CI rule\n<!-- straw-boss:team-block:end -->/);
		for (const rel of ["rules/bash-not-powershell.md", "rules/forge-login-hands-off.md", "herdr-agents/config.json", ".straw-boss-profile/manifest.json"]) assert.ok(existsSync(join(world.layout.agent, ...rel.split("/"))), rel);
		assert.equal((JSON.parse(read(world, "straw-boss/config.json")) as { link: { relay: string } }).link.relay, "https://relay.ci.example/");
		assert.equal((JSON.parse(read(world, "settings.json")) as { defaultProvider: string }).defaultProvider, "claude-bridge");
		const manifest = JSON.parse(read(world, ".straw-boss-profile/manifest.json")) as { profile: { name: string; version: string }; recipe: { id: string } };
		assert.deepEqual(manifest.profile, { name: PROFILE, version: (realStack.profile as { version: string }).version });
		assert.equal(manifest.recipe.id, "ci-profile");
	});

	it("records the integrity npm wrote for each package in the lock file, equal to the pin", () => {
		const lock = JSON.parse(read(world, "npm/package-lock.json")) as { packages: Record<string, { version?: string; integrity?: string }> };
		const pins = [...(realStack.piPackages as Array<{ name: string; version: string; integrity: string }>), realStack.profile as unknown as { name: string; version: string; integrity: string }, TEAM_PACKAGE];
		for (const pin of pins) {
			const entry = Object.entries(lock.packages).find(([key, e]) => (key === `node_modules/${pin.name}` || key.endsWith(`/node_modules/${pin.name}`)) && e.version === pin.version);
			assert.equal(entry?.[1].integrity, pin.integrity, pin.name);
		}
	});

	it("a second run is all skipped-verified", async () => {
		const again = await runWorld(world, { recipe: recipe("1.0.0", "- the CI rule"), profile: true });
		assert.ok(again.ok, failuresOf(again));
		for (const [name, status] of Object.entries(statusOf(again))) assert.equal(status, "skipped-verified", name);
		assert.ok(!again.requests.some((url) => new URL(url).pathname !== "/"), "nothing was downloaded");
	});

	it("keeps a rule the PM edited, reports it on every run, and still installs a recipe update", async () => {
		const rule = join(world.layout.agent, "rules", "bash-not-powershell.md");
		const mine = `${readFileSync(rule, "utf8")}\nmy own line\n`;
		writeFileSync(rule, mine);
		const updated = recipe("1.1.0", "- the CI rule, updated");
		const run = await runWorld(world, { recipe: updated, profile: true });
		assert.ok(run.ok, failuresOf(run));
		assert.equal(run.outcomes.profile?.status, "installed");
		assert.equal(readFileSync(rule, "utf8"), mine, "the PM's rule is as they left it");
		assert.match(read(world, "AGENTS.md"), /- the CI rule, updated/);
		const kinds = (run.outcomes.profile?.warnings ?? []).map((w) => `${w.kind}:${w.path}`);
		assert.deepEqual(kinds, ["profile-file-kept:rules/bash-not-powershell.md"]);
		const third = await runWorld(world, { recipe: updated, profile: true });
		assert.equal(third.outcomes.profile?.status, "skipped-verified");
		assert.deepEqual((third.outcomes.profile?.warnings ?? []).map((w) => w.kind), ["profile-file-kept"]);
		assert.ok(existsSync(join(world.layout.agent, ".straw-boss-profile", "pending", (realStack.profile as { version: string }).version, "rules", "bash-not-powershell.md")));
	});

	// R12-F006 (task 12 anchor: "a Trust saved for the home base does not cover a clone"). The question belongs to pi: the pinned pi-straw-boss relays it to the GUI only when pi's own `ProjectTrustStore` has no
	// saved decision for the folder or a parent (`src/trust/ask.ts`, read here as data), and the store is keyed by folder, walking up to parents and never sideways. The store and the resource test below are
	// the pinned pi's own code, installed by this run; nothing of the app's decides it. A clone sits beside the home base (`<work>/Straw Boss`, `<work>/<folder>`), so a Trust of the base is not a Trust of it.
	it("a Trust saved for the home base does not cover a clone that brings .pi/extensions: pi's own store has no decision for it, and it needs the question", async () => {
		const piDir = packageDir(world.layout, "@earendil-works/pi-coding-agent");
		const trust = (await import(pathToFileURL(join(piDir, "dist", "core", "trust-manager.js")).href)) as {
			ProjectTrustStore: new (agentDir: string) => { get(cwd: string): boolean | null; set(cwd: string, decision: boolean | null): void };
			hasTrustRequiringProjectResources(cwd: string): boolean;
		};
		const work = join(world.home, "StrawBoss");
		const homeBase = join(work, "Straw Boss");
		const clone = join(work, "fixture-repo");
		mkdirSync(join(homeBase, ".pi"), { recursive: true });
		mkdirSync(join(clone, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(clone, ".pi", "extensions", "x.ts"), "export default function () {}\n");
		const store = new trust.ProjectTrustStore(join(world.base, "trust-agent"));
		store.set(homeBase, true);
		assert.equal(store.get(homeBase), true, "the home base is trusted");
		assert.equal(store.get(join(homeBase, "sub")), true, "and a folder inside it");
		assert.equal(store.get(clone), null, "the clone beside it has no decision: pi decides nothing and the question is asked");
		assert.equal(trust.hasTrustRequiringProjectResources(clone), true, "its .pi/extensions is a resource that needs the question");
		// The rule that makes the work folder the one thing the app never trusts for the PM: a decision on the parent would cover the clone.
		store.set(work, true);
		assert.equal(store.get(clone), true);
		// The pinned pi-straw-boss asks the GUI exactly when the store has no decision (read as data, never run).
		const ask = readFileSync(join(agentPackageDir(world.layout, "pi-straw-boss"), "src", "trust", "ask.ts"), "utf8");
		assert.ok(ask.includes("new api.ProjectTrustStore(api.getAgentDir()).get(cwd)"), "its saved decision is pi's store");
		assert.match(ask, /if \(d\.saved\(cwd\) !== null\) return false;/, "a saved decision means no question; none means the question");
	});

	// pbsswap-F004 (generation 15's `pkg-prune`): the stand-in pi of `profile-stages.test.ts` proves the stage's decisions; this is the real pi 1.4.0's `pi remove` (its `npm uninstall` of one package out of the prefix every
	// package of the stack shares), run through the stage, on both hosted runners. Stack A lists one more small package (the kit's skills-only package, already pinned above); stack B is the stack.json and drops it.
	it("a stack that drops a package it listed has it removed by the real pi: settings.json no longer lists it, its files go, the record is forgotten, and every other stage stays verified", async () => {
		const DROPPED = TEAM_PACKAGE;
		const droppedStage = `pkg:${DROPPED.name}`;
		const noTeam = { ...recipe("1.1.0", "- the CI rule, updated"), packages: [] };
		const stackA = { ...realStack, piPackages: [...(realStack.piPackages as unknown[]), DROPPED] };
		const sources = (): unknown[] => (JSON.parse(read(world, "settings.json")) as { packages: unknown[] }).packages.map((e) => (typeof e === "string" ? e : (e as { source: string }).source));
		const listed = `npm:${DROPPED.name}@${DROPPED.version}`;

		const a = await runWorld(world, { recipe: noTeam, profile: true, stack: stackA });
		assert.ok(a.ok, failuresOf(a));
		assert.equal(a.outcomes[droppedStage]?.status, "installed", failuresOf(a));
		assert.ok(sources().includes(listed), "stack A lists the package");
		assert.equal(installedVersion(world.layout, DROPPED.name), DROPPED.version);
		assert.equal((stateOf(world, "bootstrap").stages as Record<string, { status: string }>)[droppedStage]?.status, "ok");

		const b = await runWorld(world, { recipe: noTeam, profile: true });
		assert.ok(b.ok, failuresOf(b));
		assert.equal(b.outcomes["pkg-prune"]?.status, "installed", failuresOf(b));
		assert.equal(b.outcomes["pkg-prune"]?.evidence, `removed ${DROPPED.name}@${DROPPED.version}`, "pi remove did it; the settings.json fallback was not needed");
		assert.ok(!sources().includes(listed), `settings.json no longer lists it: ${JSON.stringify(sources())}`);
		assert.equal(installedVersion(world.layout, DROPPED.name), null, "its files went with the removal");
		const bootstrap = stateOf(world, "bootstrap").stages as Record<string, { status: string; startBlock?: unknown }>;
		assert.equal(bootstrap[droppedStage], undefined, "the record of the dropped package is forgotten");
		assert.equal(bootstrap["pkg-prune"]?.status, "ok");
		assert.equal(bootstrap["pkg-prune"]?.startBlock, undefined);
		for (const [name, status] of Object.entries(statusOf(b))) if (name !== "pkg-prune") assert.equal(status, "skipped-verified", `${name} is untouched by the removal`);
		for (const name of PACKAGES) assert.ok(sources().includes(`npm:${name}@${(realStack.piPackages as Array<{ name: string; version: string }>).find((p) => p.name === name)?.version}`), `${name} is still listed`);
		const again = await runWorld(world, { recipe: noTeam, profile: true });
		assert.equal(again.outcomes["pkg-prune"]?.status, "skipped-verified", "nothing is left to remove");
	});
});
