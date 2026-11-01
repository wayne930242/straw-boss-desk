import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { StateStore } from "../src/main/bootstrap/state.ts";
import { privateHostSentence } from "../src/main/bootstrap/stages/preflight.ts";
import { developerToolsAsideScope } from "./harness/devtools-aside.ts";
import { ALT_BUN_VERSION, ALT_GH_VERSION, altStack } from "./harness/alt-pins.ts";
import {
	childEnvOf,
	createWorld,
	disposeWorld,
	isWindows,
	plantShellStartupDecoy,
	zdotdirFiles,
	realStack,
	run,
	runWorld,
	stateOf,
	viaLauncher,
	WorldHerdr,
	writeLocalProject,
	firstLine,
	type RunSummary,
	type World,
} from "./harness/e2e-light.ts";
import { testPlatform } from "./harness/engine-fixture.ts";
import type { FixtureIO } from "./harness/hosted.ts";
import { systemEnv } from "../src/main/env.ts";

// The task 5 anchor (spec: Tasks 5). These tests download the real releases of stack.json into a scratch root and run them, so they run only where the
// workflow asks (SBD_E2E_LIGHT=1: a CI step, or a local run on purpose). Everything lives in a scratch folder: its own home, data root, and Herdr socket.
const ON = process.env.SBD_E2E_LIGHT === "1";
const off = ON ? false : "SBD_E2E_LIGHT=1 is not set: this test downloads the real releases of stack.json";
const HOSTED = process.env.GITHUB_ACTIONS === "true";
const GH_VERSION = realStack.tools.gh.assets["darwin-arm64"].version as string;
const BUN_VERSION = realStack.optionalTools.bun.assets["darwin-arm64"].version as string;

const platform = isWindows ? "win32" : "darwin";
const ioForSudo: FixtureIO = {
	run: (command: string, args: readonly string[], options?: { timeoutMs?: number }) => run(command, args, { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, timeoutMs: options?.timeoutMs ?? 60_000 }),
	writeFile: (path: string, data: string) => writeFileSync(path, data),
	removeFile: () => {},
};

const GITHUB_RECIPE = { forges: [{ kind: "github", host: "github.com" }, { kind: "gitlab", host: "gitlab.com" }], tools: ["bun"] };
const NO_BUN_RECIPE = { forges: [{ kind: "github", host: "github.com" }, { kind: "gitlab", host: "gitlab.corp.invalid" }], tools: [] as string[] };

const stagesOf = (summary: RunSummary): string[] => Object.keys(summary.outcomes).sort();
const statusOf = (summary: RunSummary): Record<string, string> => Object.fromEntries(Object.entries(summary.outcomes).map(([name, o]) => [name, o.status]));
/** A request that is a download and not the preflight's `HEAD https://host/`. */
const isDownload = (url: string): boolean => new URL(url).pathname !== "/";
const read = (path: string): string => readFileSync(path, "utf8");
const under = (root: string, path: string): boolean => path.replace(/\\/g, "/").toLowerCase().startsWith(root.replace(/\\/g, "/").toLowerCase());

/** What a pane prints for `names`: where each resolves, plus the lines given. */
function paneScript(out: string, names: readonly string[], extra: readonly string[] = []): string {
	if (isWindows) {
		const where = names.map((n) => `echo ${n}: & where ${n} 2^>^&1`).join(" & ");
		return `cmd /d /c "(${where}${extra.map((e) => ` & ${e}`).join("")} & echo PATH=%PATH%) > ${out} 2>&1"`;
	}
	const resolves = names.map((n) => `echo "${n}=$(command -v ${n} || echo none)"`).join("; ");
	return `{ echo "zsh=$ZSH_VERSION"; echo "GH_TOKEN=\${GH_TOKEN-unset}"; ${resolves}; ${extra.join("; ")}; } > '${out}' 2>&1`;
}

/** The path a pane's lookup gave for `name`, or null. */
function resolved(text: string, name: string): string | null {
	if (isWindows) {
		const lines = text.split(/\r?\n/);
		const at = lines.findIndex((l) => l.trim() === `${name}:`);
		const next = at < 0 ? undefined : lines[at + 1]?.trim();
		return next === undefined || next === "" || /^INFO:/i.test(next) || /^[a-z0-9]+:$/i.test(next) ? null : next;
	}
	const m = new RegExp(`^${name}=(.*)$`, "m").exec(text);
	return m === null || m[1] === "none" ? null : (m[1] as string);
}

describe("tool stages from an empty root (e2e-light)", { skip: off }, () => {
	let world: World;
	let first: RunSummary;
	let herdr: WorldHerdr | null = null;
	const aside = developerToolsAsideScope();

	before(async () => {
		world = createWorld("a");
		if (aside.state === "refused") throw new Error(aside.reason);
		if (aside.state === "active") await aside.enter(ioForSudo);
		first = await runWorld(world, { recipe: GITHUB_RECIPE });
	});

	after(async () => {
		await herdr?.stop();
		if (aside.state === "active") await aside.leave(ioForSudo);
		disposeWorld(world);
	});

	it("runs every stage from an empty root: all verified, none failed", () => {
		assert.equal(first.error, null);
		assert.ok(first.ok, JSON.stringify(first.outcomes, null, 1).slice(0, 2000));
		const expected = ["preflight", "node", "git", "herdr", "fd-rg", "gh", "glab", "opt:bun", "tool-paths", "launchers", "git-helpers"].sort();
		assert.deepEqual(stagesOf(first), expected);
		// The preflight checks and records its result without installing anything, so it is skipped-verified even on a first run.
		for (const [name, status] of Object.entries(statusOf(first))) assert.equal(status, name === "preflight" ? "skipped-verified" : "installed", `${name} is ${status}`);
		const bootstrap = stateOf(world, "bootstrap").stages as Record<string, { status: string }>;
		for (const name of expected) assert.equal(bootstrap[name]?.status, "ok", `${name} in state/bootstrap.json`);
	});

	it("the developer tools moved aside case: skipped locally by name, run on a hosted macOS runner", (t) => {
		if (aside.state === "skipped") t.skip(aside.reason);
		else assert.equal(aside.state, "active", "the case ran with the tools moved aside");
	});

	it("prints the pin through each launcher, and bunx runs bun", async () => {
		const gh = await viaLauncher(world, "gh", ["--version"]);
		assert.match(firstLine(gh), new RegExp(`gh version ${GH_VERSION.replace(/\./g, "\\.")}`));
		const glab = await viaLauncher(world, "glab", ["--version"]);
		assert.match(glab.stdout, /glab(?: version)? 1\.124\.0/);
		assert.equal(firstLine(await viaLauncher(world, "bun", ["--version"])), BUN_VERSION);
		assert.equal(firstLine(await viaLauncher(world, "bunx", ["--version"])), BUN_VERSION);
	});

	it("shows GH_TELEMETRY=disabled, DO_NOT_TRACK=1 and glab's switch to the child, with the caller's values replaced", async () => {
		const env = { ...systemEnv(platform, world.appEnv), ...(isWindows ? {} : { PATH: "/usr/bin:/bin" }), GH_TELEMETRY: "enabled", DO_NOT_TRACK: "0", GLAB_SEND_TELEMETRY: "1", GITHUB_TOKEN: "leak", CI: "true" };
		const sh = isWindows ? 'echo "$GH_TELEMETRY $DO_NOT_TRACK $GITHUB_TOKEN$CI"' : 'echo "$GH_TELEMETRY $DO_NOT_TRACK $GITHUB_TOKEN$CI"';
		const set = await viaLauncher(world, "gh", ["alias", "set", "--shell", "seeenv", sh], env);
		assert.equal(set.code, 0, set.stderr);
		const seen = await viaLauncher(world, "gh", ["seeenv"], env);
		assert.equal(seen.stdout.trim(), "disabled 1", seen.stderr);
		const glabSet = await viaLauncher(world, "glab", ["alias", "set", "seeenv", `!echo "$GLAB_SEND_TELEMETRY $DO_NOT_TRACK $GITLAB_TOKEN$CI"`], env);
		assert.equal(glabSet.code, 0, glabSet.stderr);
		const glabSeen = await viaLauncher(world, "glab", ["seeenv"], env);
		assert.equal(glabSeen.stdout.trim(), "0 1");
		const bunSeen = await viaLauncher(world, "bun", ["-e", "console.log(process.env.DO_NOT_TRACK)"], env);
		assert.equal(bunSeen.stdout.trim(), "1");
	});

	it("runs the app's Git against a public repository and a ! helper, which a wrong exec path would fail", async () => {
		const env = childEnvOf(world, ["bun"]);
		const git = env.PATH?.split(isWindows ? ";" : ":").map((dir) => join(dir, isWindows ? "git.exe" : "git")).find((p) => existsSync(p));
		assert.ok(git !== undefined && under(world.root, git), `git on the constructed PATH is ${git}`);
		const remote = await run(git as string, ["ls-remote", "https://github.com/octocat/Hello-World.git", "HEAD"], { env, timeoutMs: 120_000 });
		assert.equal(remote.code, 0, remote.stderr);
		assert.match(remote.stdout, /^[0-9a-f]{40}\tHEAD/m);
		const helper = await run(git as string, ["-c", "alias.sbdsay=!echo helper-ran", "sbdsay"], { env });
		assert.equal(helper.code, 0, helper.stderr);
		assert.equal(helper.stdout.trim(), "helper-ran");
		assert.equal((await run(git as string, ["config", "--global", "--get", "init.defaultBranch"], { env })).stdout.trim(), "main");
	});

	it("runs each credential helper through Git's sh (hosted runners: gh reads the OS credential store there)", { skip: HOSTED ? false : "hosted runner only: a local run would let gh read the author's OS credential store" }, async () => {
		const env = { ...childEnvOf(world, ["bun"]) };
		const git = env.PATH?.split(isWindows ? ";" : ":").map((dir) => join(dir, isWindows ? "git.exe" : "git")).find((p) => existsSync(p)) as string;
		mkdirSync(join(world.root, "config", "gh"), { recursive: true });
		writeFileSync(join(world.root, "config", "gh", "hosts.yml"), "github.com:\n    oauth_token: ghp_sbd_fixture_token\n    user: fixture\n    git_protocol: https\n");
		const filled = await run(git, ["credential", "fill"], { env: { ...env, GIT_TERMINAL_PROMPT: "0" }, stdin: "protocol=https\nhost=github.com\n\n" });
		assert.equal(filled.code, 0, filled.stderr);
		assert.match(filled.stdout, /password=ghp_sbd_fixture_token/);
		const config = read(join(world.root, "gitconfig"));
		assert.match(config, /\[credential "https:\/\/github\.com"\]\n\thelper =\n\thelper = /);
		assert.match(config, /\[credential "https:\/\/gitlab\.com"\]/);
	});

	it("keeps versions out of the launchers and the ZDOTDIR files, and the root's bytes out of the paths files", () => {
		const versions = Object.values(stateOf(world, "current").versions as Record<string, string>);
		// The paths files name the tool folders, so they hold the versions by design; the launchers and the ZDOTDIR files read them.
		const files = readdirSync(world.layout.tools.bin).filter((n) => !/^paths\./.test(n)).map((n) => join(world.layout.tools.bin, n));
		if (!isWindows) files.push(...zdotdirFiles(world));
		for (const file of files) {
			const bytes = readFileSync(file);
			if (bytes.length > 4_000_000) continue; // a copied executable (the Windows bun.exe shims)
			if (/\.exe$/i.test(file)) continue;
			const text = bytes.toString("latin1");
			for (const version of versions) assert.ok(!text.includes(version), `${file} holds ${version}`);
		}
		const paths = [join(world.layout.tools.bin, "paths.sh"), ...(isWindows ? [join(world.layout.tools.bin, "paths.cmd")] : [])];
		for (const file of paths) {
			const bytes = readFileSync(file);
			for (const needle of [world.root, world.root.replace(/\\/g, "/"), dirname(world.root), world.home]) {
				for (const encoding of ["utf8", "utf16le", "latin1"] as const) {
					assert.equal(bytes.includes(Buffer.from(needle, encoding)), false, `${file} holds ${needle} (${encoding})`);
				}
			}
			assert.match(bytes.toString("utf8"), /SBD_BUN=/);
		}
	});

	it("runs the machine-PATH gh on Windows and still resolves the launcher to the pin", { skip: isWindows ? false : "Windows only: the runner image has gh on the machine PATH" }, async () => {
		const machine = await run("where.exe", ["gh"], { env: systemEnv("win32", world.appEnv) });
		assert.equal(machine.code, 0, "the runner has a machine-PATH gh");
		assert.equal(under(world.root, firstLine(machine)), false);
		const pinned = await viaLauncher(world, "gh", ["--version"], systemEnv("win32", world.appEnv));
		assert.match(firstLine(pinned), new RegExp(`gh version ${GH_VERSION.replace(/\./g, "\\.")}`));
	});

	describe("a second run and a pin change", () => {
		it("is all skipped-verified in under 30 s", async () => {
			const second = await runWorld(world, { recipe: GITHUB_RECIPE });
			assert.ok(second.ok, JSON.stringify(second.error));
			for (const [name, status] of Object.entries(statusOf(second))) assert.equal(status, "skipped-verified", name);
			assert.ok(second.ms < 30_000, `took ${second.ms} ms`);
			assert.deepEqual(second.requests.filter(isDownload), []);
		});

		it("installs a gh pin change beside the old one: tool-paths is written again, the launchers stay, and the launcher runs the new gh", async () => {
			const stack = altStack(realStack, { gh: true });
			const changed = await runWorld(world, { recipe: GITHUB_RECIPE, stack });
			assert.ok(changed.ok, JSON.stringify(changed.error ?? changed.outcomes));
			const status = statusOf(changed);
			assert.equal(status.gh, "installed");
			assert.equal(status["tool-paths"], "installed");
			assert.equal(status.launchers, "skipped-verified");
			assert.equal(status["git-helpers"], "skipped-verified");
			assert.ok(existsSync(join(world.layout.tools.root, "gh", GH_VERSION)) && existsSync(join(world.layout.tools.root, "gh", ALT_GH_VERSION)), "both gh folders exist");
			const gh = await viaLauncher(world, "gh", ["--version"]);
			assert.match(firstLine(gh), new RegExp(`gh version ${ALT_GH_VERSION.replace(/\./g, "\\.")}`));
			assert.equal(stateOf(world, "current").previous.gh, GH_VERSION);
		});
	});

	describe("a Herdr pane", () => {
		before(async () => {
			if (!isWindows) plantShellStartupDecoy(world);
			herdr = new WorldHerdr(world, ["bun"]);
			await herdr.start();
		});

		it("runs zsh from an app whose SHELL is /bin/bash and reads only the ZDOTDIR files (macOS)", { skip: isWindows ? "macOS only: ZDOTDIR is the macOS pane's isolation" : false }, async () => {
			assert.equal(world.appEnv.SHELL, "/bin/bash");
			const text = await (herdr as WorldHerdr).inPane("zsh", (out) => paneScript(out, ["gh", "git", "node", "bun"]), world.home);
			assert.match(text, /^zsh=5\./m, text);
			assert.match(text, /^GH_TOKEN=unset$/m, "the PM's startup file was not read");
			for (const name of ["gh", "git", "node", "bun"]) {
				const path = resolved(text, name);
				assert.ok(path !== null && under(world.layout.tools.root, path), `${name} resolves to ${path}`);
			}
		});

		it("prints bun's pin in a pane, and command -v bun resolves to the launcher under tools/bin", async () => {
			const text = await (herdr as WorldHerdr).inPane("bun", (out) => paneScript(out, ["bun"], ["bun --version"]), world.home);
			assert.match(text, new RegExp(BUN_VERSION.replace(/\./g, "\\.")), text);
			const path = resolved(text, "bun");
			assert.ok(path !== null && under(world.layout.tools.bin, path), `bun resolves to ${path}`);
		});
	});

	describe("the optional tool bun", () => {
		it("is found by a spawn without a shell on Windows through bun.exe in tools/bin, and a bun.cmd alone is not (FE2R-F009)", { skip: isWindows ? false : "Windows only: macOS finds the launcher script by name" }, async () => {
			const env = childEnvOf(world, ["bun"]);
			const found = await run("bun", ["--version"], { env });
			assert.equal(found.code, 0, found.stderr);
			assert.equal(found.stdout.trim(), BUN_VERSION);
			const lonely = join(world.base, "cmd-only");
			mkdirSync(lonely, { recursive: true });
			writeFileSync(join(lonely, "bun.cmd"), "@echo off\r\necho cmd-only\r\n");
			const missing = await run("bun", ["--version"], { env: { ...systemEnv("win32", world.appEnv), PATH: lonely } });
			assert.notEqual(missing.code, 0, "a spawn without a shell does not try .cmd");
			assert.match(missing.stderr, /ENOENT/);
		});

		it("fills tools/bun-home and leaves a scratch home empty", async () => {
			const probeHome = join(world.base, "probe-home");
			const project = join(world.base, "project");
			mkdirSync(probeHome, { recursive: true });
			writeLocalProject(project);
			const env = { ...systemEnv(platform, world.appEnv), HOME: probeHome, USERPROFILE: probeHome, TMPDIR: join(world.base, "tmp"), TEMP: join(world.base, "tmp"), TMP: join(world.base, "tmp") };
			const installed = await viaLauncher(world, "bun", ["install"], env, join(project, "app"));
			assert.equal(installed.code, 0, installed.stderr || installed.stdout);
			assert.deepEqual(readdirSync(probeHome), [], "nothing in the scratch home");
			assert.ok(readdirSync(join(world.layout.tools.root, "bun-home")).length > 0, "bun-home is filled");
		});

		it("drop, a full start, re-add: the folder stays, no download, the launcher works; then a new pin installs beside it", async () => {
			const bunDir = join(world.layout.tools.root, "bun", BUN_VERSION);
			assert.ok(existsSync(bunDir));
			const dropped = await runWorld(world, { recipe: { ...GITHUB_RECIPE, tools: [] } });
			assert.ok(dropped.ok, JSON.stringify(dropped.error ?? dropped.outcomes));
			assert.equal(dropped.outcomes["opt:bun"], undefined, "no opt:bun stage runs");
			assert.equal(statusOf(dropped)["tool-paths"], "installed");
			assert.equal(statusOf(dropped).launchers, "installed");
			assert.ok(existsSync(bunDir), "tools/bun/<version> stays");
			assert.equal(stateOf(world, "current").versions.bun, BUN_VERSION, "a dropped tool keeps its version in current.json");
			for (const name of isWindows ? ["bun", "bun.cmd", "bunx", "bunx.cmd", "bun.exe", "bunx.exe"] : ["bun", "bunx"]) assert.equal(existsSync(join(world.layout.tools.bin, name)), false, `${name} is gone`);
			assert.ok(!read(join(world.layout.tools.bin, "paths.sh")).includes("SBD_BUN"));
			const pane = await (herdr as WorldHerdr).inPane("nobun", (out) => paneScript(out, ["bun"]), world.home);
			const found = resolved(pane, "bun");
			assert.ok(found === null || !under(world.layout.tools.root, found), `the pane found ${found}`);

			// A full successful start prunes every tool's inactive versions.
			const store = new StateStore(world.layout);
			for (const tool of Object.keys(stateOf(world, "current").versions)) await store.pruneInactive(tool, testPlatform().processes);
			assert.ok(existsSync(bunDir), "prune keeps the folder current.json names");

			const readded = await runWorld(world, { recipe: GITHUB_RECIPE });
			assert.ok(readded.ok, JSON.stringify(readded.error ?? readded.outcomes));
			assert.deepEqual(readded.requests.filter(isDownload), [], "naming it again downloads nothing");
			assert.equal(statusOf(readded)["opt:bun"], "skipped-verified");
			assert.equal(firstLine(await viaLauncher(world, "bun", ["--version"])), BUN_VERSION);

			const changed = await runWorld(world, { recipe: GITHUB_RECIPE, stack: altStack(realStack, { bun: true }) });
			assert.ok(changed.ok, JSON.stringify(changed.error ?? changed.outcomes));
			assert.equal(statusOf(changed)["opt:bun"], "installed");
			assert.ok(existsSync(bunDir) && existsSync(join(world.layout.tools.root, "bun", ALT_BUN_VERSION)));
			assert.equal(firstLine(await viaLauncher(world, "bun", ["--version"])), ALT_BUN_VERSION);
		});
	});
});

describe("a recipe with no optional tool and a private forge host (e2e-light)", { skip: off }, () => {
	let world: World;
	let summary: RunSummary;
	let herdr: WorldHerdr | null = null;

	before(async () => {
		world = createWorld("b");
		summary = await runWorld(world, { recipe: NO_BUN_RECIPE });
	});

	after(async () => {
		await herdr?.stop();
		disposeWorld(world);
	});

	it("completes with every stage verified, and the preflight names the unreachable host as a warning within 10 s", () => {
		assert.equal(summary.error, null);
		assert.ok(summary.ok, JSON.stringify(summary.outcomes).slice(0, 1500));
		const record = (stateOf(world, "bootstrap").stages as Record<string, { status: string; warnings?: Array<{ kind: string; host?: string; sentence: string }> }>).preflight;
		assert.equal(record?.status, "ok");
		assert.deepEqual(record?.warnings, [{ kind: "forge-host-unreachable", host: "gitlab.corp.invalid", sentence: privateHostSentence("gitlab.corp.invalid") }]);
		assert.ok((summary.outcomes.preflight?.ms ?? 99_999) < 10_000, `the preflight took ${summary.outcomes.preflight?.ms} ms`);
		for (const [name, status] of Object.entries(statusOf(summary))) assert.equal(status, name === "preflight" ? "skipped-verified" : "installed", name);
	});

	it("has no opt:bun stage, no tools/bun, no bun launcher, and no SBD_BUN", () => {
		const stages = stateOf(world, "bootstrap").stages as Record<string, unknown>;
		assert.equal("opt:bun" in stages, false);
		assert.equal(existsSync(join(world.layout.tools.root, "bun")), false);
		for (const name of ["bun", "bunx", "bun.cmd", "bunx.cmd", "bun.exe", "bunx.exe"]) assert.equal(existsSync(join(world.layout.tools.bin, name)), false, name);
		assert.ok(!read(join(world.layout.tools.bin, "paths.sh")).includes("SBD_BUN"));
		if (isWindows) assert.ok(!read(join(world.layout.tools.bin, "paths.cmd")).includes("SBD_BUN"));
	});

	it("does not find bun from a pane", async () => {
		herdr = new WorldHerdr(world);
		await herdr.start();
		const pane = await herdr.inPane("nobun", (out) => paneScript(out, ["bun"]), world.home);
		const found = resolved(pane, "bun");
		assert.ok(found === null || !under(world.layout.tools.root, found), `the pane found ${found}`);
	});
});

describe("an unreachable download host (e2e-light)", { skip: off }, () => {
	let world: World;
	before(() => {
		world = createWorld("c");
	});
	after(() => disposeWorld(world));

	it("is named within 10 s and installs nothing", async () => {
		// 192.0.2.1 is TEST-NET-1 (RFC 5737): never routed, so a connection is blackholed or refused, and either way is a path failure.
		const stack = structuredClone(realStack);
		for (const key of Object.keys(stack.tools.rg.assets)) stack.tools.rg.assets[key].url = stack.tools.rg.assets[key].url.replace("https://github.com/", "https://192.0.2.1/");
		const failed = await runWorld(world, { stack });
		assert.equal(failed.ok, false);
		assert.ok(failed.ms < 10_000, `took ${failed.ms} ms`);
		const outcome = failed.outcomes.preflight;
		assert.equal(outcome?.status, "failed");
		assert.equal(outcome?.failure?.category, "network");
		assert.match(outcome?.failure?.sentence ?? "", /192\.0\.2\.1/);
		assert.deepEqual(failed.requests.filter(isDownload), []);
		assert.equal(existsSync(join(world.layout.tools.root, "node")), false);
	});
});
