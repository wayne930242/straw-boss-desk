import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { after, before, describe, it } from "node:test";
import { StateStore } from "../src/main/bootstrap/state.ts";
import { privateHostSentence } from "../src/main/bootstrap/stages/preflight.ts";
import { developerToolsAsideScope } from "./harness/devtools-aside.ts";
import { ALT_BUN_VERSION, ALT_GH_VERSION, altStack } from "./harness/alt-pins.ts";
import {
	childEnvOf,
	createWorld,
	disposeWorld,
	noteUserPath,
	isWindows,
	plantShellStartupDecoy,
	rpcProbe,
	zdotdirFiles,
	realStack,
	run,
	runWorld,
	stateOf,
	viaLauncher,
	WorldHerdr,
	writeLocalProject,
	firstLine,
	builtProxyVariables,
	type RunSummary,
	type World,
} from "./harness/e2e-light.ts";
import { testPlatform } from "./harness/engine-fixture.ts";
import { createPlatform } from "../src/main/platform/index.ts";
import { execRunner } from "../src/main/platform/exec.ts";
import { checkPaneLookups } from "../src/main/pane-path.ts";
import { hostedCase, type FixtureIO } from "./harness/hosted.ts";
import { sameFolder } from "../src/main/bootstrap/stages/paths-launchers.ts";
import { nodeBinaryPath, npmCliPath } from "../src/main/bootstrap/npm.ts";
import { binShim, npmGlobalPin } from "../src/main/bootstrap/stages/pi.ts";
import { locateClaude } from "../src/main/bootstrap/stages/claude.ts";
import { runFixture, realIO } from "./harness/hosted.ts";
import { trustedTestCa, trustedCaScenario } from "./harness/system-ca.ts";
import { platformKey } from "../src/main/bootstrap/stack.ts";
import tls from "node:tls";
import type { ChildProcess } from "node:child_process";
import type { Stack } from "../src/main/bootstrap/stack.ts";
import { resolveOsProxy, systemEnv } from "../src/main/env.ts";
import { toolDir } from "../src/main/paths.ts";
import { connectProxy } from "./harness/connect-proxy.ts";
import { probeNoProxy, routeOf, VARIANTS, type ProbeContext } from "./harness/proxy-probe.ts";
import { sha256Hex } from "./harness/hash.ts";

// The task 5 anchor (spec: Tasks 5). These tests download the real releases of stack.json into a scratch root and run them, so they run only where the
// workflow asks (SBD_E2E_LIGHT=1: a CI step, or a local run on purpose). Everything lives in a scratch folder: its own home, data root, and Herdr socket.
const ON = process.env.SBD_E2E_LIGHT === "1";
const off = ON ? false : "SBD_E2E_LIGHT=1 is not set: this test downloads the real releases of stack.json";
// The credential-helper cases let gh and glab read the OS credential store, so they run on a GitHub-hosted runner only: all six signals of the guard, not one.
const hosted = (name: string) => hostedCase(name);
const GH_VERSION = realStack.tools.gh.assets["darwin-arm64"].version as string;
const BUN_VERSION = realStack.optionalTools.bun.assets["darwin-arm64"].version as string;

const platform = isWindows ? "win32" : "darwin";
const PROXY_FREE_GIT_URL = "https://github.com/octocat/Hello-World.git";
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
		return `cmd /d /c "(${where}${extra.map((e) => ` & ${e}`).join("")} & echo PATH=%PATH:)=]%) > ${out} 2>&1"`;
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

const system32 = (): string => join(process.env.SystemRoot ?? "C:\\Windows", "System32");

describe("tool stages from an empty root (e2e-light)", { skip: off }, () => {
	let world: World;
	let first: RunSummary;
	let herdr: WorldHerdr | null = null;
	const aside = developerToolsAsideScope();

	before(async () => {
		world = createWorld("a");
		await noteUserPath(world);
		if (aside.state === "refused") throw new Error(aside.reason);
		if (aside.state === "active") await aside.enter(ioForSudo);
		first = await runWorld(world, { recipe: GITHUB_RECIPE });
	});

	after(async () => {
		await herdr?.stop();
		if (aside.state === "active") await aside.leave(ioForSudo);
		const before = world.userPathBefore;
		const real = world.realUserPath;
		const userPath = world.userPath;
		await disposeWorld(world);
		// The run took its entry off the user PATH again: the value, and its registry type, are what they were before the first stage ran.
		if (real) assert.deepEqual(await userPath.read(), before ?? null, "the user PATH is as it was before the run");
	});

	it("runs every stage from an empty root: all verified, none failed", () => {
		assert.equal(first.error, null);
		const failures = Object.values(first.outcomes).filter((o) => o.failure !== undefined).map((o) => `${o.stage}: ${o.failure?.sentence} | ${o.failure?.detail}`);
		assert.ok(first.ok, failures.length > 0 ? failures.join("\n") : JSON.stringify(first.outcomes, null, 1).slice(0, 2000));
		const expected = ["preflight", "node", "git", "herdr", "fd-rg", "gh", "glab", "opt:bun", "tool-paths", "launchers", "git-helpers", "pi", ...(isWindows ? ["pi-shim"] : [])].sort();
		assert.deepEqual(stagesOf(first), expected);
		// The preflight checks and records its result without installing anything, so it is skipped-verified even on a first run.
		for (const [name, status] of Object.entries(statusOf(first))) assert.equal(status, name === "preflight" ? "skipped-verified" : "installed", `${name} is ${status}`);
		const bootstrap = stateOf(world, "bootstrap").stages as Record<string, { status: string }>;
		for (const name of expected) assert.equal(bootstrap[name]?.status, "ok", `${name} in state/bootstrap.json`);
	});

	// T5-F005. PortableGit's self-extractor runs `post-install.bat` through git-bash from the extracted tree before it exits. Record what it left.
	it("records what PortableGit's post-install left in the Git folder, and that no process runs from it", { skip: isWindows ? false : "Windows only: PortableGit" }, async (t) => {
		const git = join(world.layout.tools.root, "git", stateOf(world, "current").versions.git as string);
		const listing = (dir: string): string => (existsSync(dir) ? readdirSync(dir).join(", ") : "(missing)");
		t.diagnostic(`post-install.bat still present: ${existsSync(join(git, "post-install.bat"))}`);
		t.diagnostic(`etc/post-install: ${listing(join(git, "etc", "post-install"))}`);
		t.diagnostic(`git folder top level: ${listing(git)}`);
		const left = await createPlatform().processes.listUnder(git);
		assert.deepEqual(left, [], "the stage's own check found nothing either");
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

	// Task 10 anchor. The GitHub step logs in with `--expiring=false`, so gh writes no refreshable token that gh itself would rewrite on routine use (the entry would then turn foreign,
	// spec: Ownership). The pinned gh must have the flag; when it does not, the task stops and reports. `auth login --help` reads no login and no store.
	it("the pinned gh lists --expiring in `auth login --help`, and the GitHub step's command carries --expiring=false", async () => {
		const help = await viaLauncher(world, "gh", ["auth", "login", "--help"]);
		assert.equal(help.code, 0, help.stderr);
		assert.match(`${help.stdout}\n${help.stderr}`, /--expiring\b/, "the pinned gh has no --expiring flag: the GitHub step cannot keep its token from being refreshed");
		// The command the step starts is the one the unit tests pin (accounts-session.test.ts): the flag is in it.
		const source = readFileSync(join(import.meta.dirname, "..", "src", "main", "accounts", "session.ts"), "utf8");
		assert.match(source, /"--web", "--expiring=false"/);
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

	/**
	 * T5-F008. The gate is the guard's: off a hosted runner the case is skipped by name, and under SBD_REQUIRE_HOSTED_FIXTURES=1 it fails there, so a skip
	 * never passes the anchor unseen. The assertions never print what the helper answered: a local run that got past the gate could hold a real token.
	 */
	it("runs each credential helper through Git's sh (hosted runners: gh and glab read the OS credential store there)", async (t) => {
		const gate = hosted("credential helper");
		if (!gate.run) {
			if (gate.fail) assert.fail(`${gate.reason} (SBD_REQUIRE_HOSTED_FIXTURES=1)`);
			t.skip(gate.reason);
			return;
		}
		const env = { ...childEnvOf(world, ["bun"]) };
		const git = env.PATH?.split(isWindows ? ";" : ":").map((dir) => join(dir, isWindows ? "git.exe" : "git")).find((p) => existsSync(p)) as string;
		mkdirSync(join(world.root, "config", "gh"), { recursive: true });
		writeFileSync(join(world.root, "config", "gh", "hosts.yml"), "github.com:\n    oauth_token: ghp_sbd_fixture_token\n    user: fixture\n    git_protocol: https\n");
		const filled = await run(git, ["credential", "fill"], { env: { ...env, GIT_TERMINAL_PROMPT: "0" }, stdin: "protocol=https\nhost=github.com\n\n" });
		assert.equal(filled.code, 0, `git credential fill for github.com exited with ${filled.code}`);
		assert.ok(filled.stdout.includes("password=ghp_sbd_fixture_token"), "the gh helper answered with the fixture token (the answer is not printed)");
		const config = read(join(world.root, "gitconfig"));
		assert.match(config, /\[credential "https:\/\/github\.com"\]\n\thelper =\n\thelper = /);
		assert.match(config, /\[credential "https:\/\/gitlab\.com"\]/);
	});

	it("runs the glab helper for a GitLab host (hosted runners only), T5-F011 d", async (t) => {
		const gate = hosted("glab credential helper");
		if (!gate.run) {
			if (gate.fail) assert.fail(`${gate.reason} (SBD_REQUIRE_HOSTED_FIXTURES=1)`);
			t.skip(gate.reason);
			return;
		}
		const env = { ...childEnvOf(world, ["bun"]) };
		const git = env.PATH?.split(isWindows ? ";" : ":").map((dir) => join(dir, isWindows ? "git.exe" : "git")).find((p) => existsSync(p)) as string;
		mkdirSync(join(world.root, "config", "glab-cli"), { recursive: true });
		writeFileSync(join(world.root, "config", "glab-cli", "config.yml"), "hosts:\n    gitlab.com:\n        token: glpat_sbd_fixture_token\n        api_protocol: https\n        api_host: gitlab.com\n        git_protocol: https\n");
		const filled = await run(git, ["credential", "fill"], { env: { ...env, GIT_TERMINAL_PROMPT: "0" }, stdin: "protocol=https\nhost=gitlab.com\n\n" });
		assert.equal(filled.code, 0, `git credential fill for gitlab.com exited with ${filled.code}`);
		assert.ok(filled.stdout.includes("password=glpat_sbd_fixture_token"), "the glab helper answered with the fixture token (the answer is not printed)");
	});

	// T5-F009. A zero-byte file is a CA bundle that trusts nothing, so a Git that reads it cannot verify github.com. No file with a certificate extension is
	// ever written. The control is the unset run, which the earlier ls-remote case also makes.
	it("the app's Git reads GIT_SSL_CAINFO: an empty bundle gives a certificate error, and unset succeeds", async (t) => {
		const env = childEnvOf(world, ["bun"]);
		const git = env.PATH?.split(isWindows ? ";" : ":").map((dir) => join(dir, isWindows ? "git.exe" : "git")).find((p) => existsSync(p)) as string;
		const empty = join(world.base, "empty-ca-bundle");
		writeFileSync(empty, "");
		const backend = (await run(git, ["config", "--show-origin", "--get", "http.sslBackend"], { env })).stdout.trim();
		t.diagnostic(`http.sslBackend: ${backend === "" ? "(unset)" : backend}`);
		const control = await run(git, ["ls-remote", PROXY_FREE_GIT_URL, "HEAD"], { env, timeoutMs: 120_000 });
		assert.equal(control.code, 0, `control: ${control.stderr}`);
		const bundle = await run(git, ["ls-remote", PROXY_FREE_GIT_URL, "HEAD"], { env: { ...env, GIT_SSL_CAINFO: empty }, timeoutMs: 120_000 });
		t.diagnostic(`GIT_SSL_CAINFO=empty-ca-bundle: exit ${bundle.code}; ${bundle.stderr.trim().split(/\r?\n/)[0] ?? ""}`);
		const certFile = await run(git, ["ls-remote", PROXY_FREE_GIT_URL, "HEAD"], { env: { ...env, SSL_CERT_FILE: empty }, timeoutMs: 120_000 });
		t.diagnostic(`SSL_CERT_FILE=empty-ca-bundle: exit ${certFile.code}; ${certFile.stderr.trim().split(/\r?\n/)[0] ?? ""}`);
		if (isWindows && /schannel/i.test(backend)) {
			// schannel asks the Windows store; the variable has no effect (a Git built for it reads `http.schannelUseSSLCAInfo` first).
			assert.equal(bundle.code, 0, `schannel ignores GIT_SSL_CAINFO: ${bundle.stderr}`);
		} else {
			assert.notEqual(bundle.code, 0, "an empty CA bundle must stop the connection");
			assert.match(bundle.stderr, /SSL certificate problem|certificate|CAfile|error setting certificate|unable to get local issuer/i);
		}
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

	it("runs the machine-PATH gh on Windows and still resolves the bare name to the launcher and its pin, from a neutral folder (T5-F011 a)", { skip: isWindows ? false : "Windows only: the runner image has gh on the machine PATH" }, async () => {
		const machine = await run("where.exe", ["gh"], { env: systemEnv("win32", world.appEnv) });
		assert.equal(machine.code, 0, "the runner has a machine-PATH gh");
		assert.equal(under(world.root, firstLine(machine)), false);
		// cmd looks in the current folder before the PATH, so this runs from a folder that holds no launcher: only the PATH order can find the pinned gh.
		const neutral = join(world.base, "neutral 測試");
		mkdirSync(neutral, { recursive: true });
		const pinned = await run(join(world.appEnv.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), ["/d", "/c", "gh", "--version"], { env: childEnvOf(world, ["bun"]), cwd: neutral });
		assert.equal(pinned.code, 0, pinned.stderr);
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

		// Herdr rebuilds a Windows pane's PATH from the registry (spec: Panes on Windows). Since task 6 the `tools\\shims` entry is first in the user PATH, and
		// its `bun.cmd` runs the launcher, so a pane finds `bun` by name. Where the user PATH is not the real one (a developer's Windows machine: the registry
		// is a guarded fixture), the case runs the launcher by its path as task 5 did.
		it("prints bun's pin through the launcher in a pane, by name; on macOS command -v bun resolves to tools/bin", async () => {
			const byName = !isWindows || world.realUserPath;
			const extra = byName ? ["bun --version"] : ["pushd %STRAW_BOSS_DESK_ROOT%\\tools\\bin", "bun.cmd --version", "popd"];
			const text = await (herdr as WorldHerdr).inPane("bun", (out) => paneScript(out, ["bun"], extra), world.home);
			assert.match(text, new RegExp(BUN_VERSION.replace(/\./g, "\\.")), text);
			if (!isWindows) {
				const path = resolved(text, "bun");
				assert.ok(path !== null && under(world.layout.tools.bin, path), `bun resolves to ${path}`);
			}
		});

		// T6-F004. The shipped pane order: Herdr builds the pane's PATH from the registry (machine entries, then the user's, `tools\shims` first among those), and the
		// pane's shell is PowerShell. The WSL check claims to say which `bash` such a pane runs; this asks a real pane and compares it with the walk of the same
		// registry values, so the check is shown to match what a pane does and not only a table in a unit test.
		it("runs, for bash typed in a pane, the file the pane-order walk of the registry names; WSL's bash.exe is the first one exactly when the walk says so (Windows)", async (t) => {
			if (!isWindows) {
				t.skip("Windows only: the pane PATH comes from the registry");
				return;
			}
			if (!world.realUserPath) {
				t.skip("the user PATH is a stand-in here, so a pane does not have the shipped order");
				return;
			}
			const type = (out: string): string => `[IO.File]::WriteAllText('${out}', ((Get-Command bash -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source }) -join '|'))`;
			const text = await (herdr as WorldHerdr).inPane("bash-order", type, world.home);
			const found = text.trim().split("|").filter((c) => c !== "");
			const walked = await checkPaneLookups({ run: execRunner(), locate: createPlatform().locate, exists: existsSync, env: process.env });
			const same = (a: string | null | undefined, b: string | null | undefined): boolean => a != null && b != null && win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();
			t.diagnostic(`a pane finds bash in this order: ${found.join(" | ")}; the walk says ${walked.firstBash ?? "nothing"} (WSL: ${walked.wslBash})`);
			assert.ok(found.length > 0, `the pane found a bash: ${JSON.stringify(text)}`);
			assert.ok(same(found[0], walked.firstBash), `the pane runs ${found[0]}, the walk says ${walked.firstBash}`);
			assert.equal(same(found[0], join(system32(), "bash.exe")), walked.wslBash, "the walk and the pane agree on whether WSL's bash.exe comes first");
			assert.ok(found.some((c) => same(c, join(world.layout.tools.shims, "bash.cmd"))), "the shim's bash.cmd is on the pane's PATH, through the user entry");
		});
	});

	// ---- task 6: pi and the Windows shims ---------------------------------------------------------------------------------
	describe("pi (task 6)", () => {
		const pinOf = (): string => npmGlobalPin(realStack as unknown as Stack, "pi").version;
		const system32 = (): string => join(world.appEnv.SystemRoot ?? "C:\\Windows", "System32");
		const shimsDir = (): string => world.layout.tools.shims;
		/** A folder with a `pi` of another install: a batch file and a POSIX script, each saying `other-pi`. */
		const otherPi = (): string => {
			const dir = join(world.base, "another pi");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "pi.cmd"), "@echo off\r\necho other-pi\r\n");
			writeFileSync(join(dir, "pi"), "#!/bin/sh\necho other-pi\n", { mode: 0o755 });
			return dir;
		};
		/** The environment of a plain program on the PM's machine (no desk variables) with `PATH` as given. */
		const plain = (pathEntries: readonly string[]): Record<string, string> => ({ ...systemEnv("win32", world.appEnv), PATH: pathEntries.join(";") });
		const desk = (pathEntries: readonly string[]): Record<string, string> => ({ ...childEnvOf(world, []), PATH: pathEntries.join(";") });
		const neutral = (): string => {
			const dir = join(world.base, "neutral 測試");
			mkdirSync(dir, { recursive: true });
			return dir;
		};
		/** `cmd /d /c <args>`: the first argument is looked up on the env's PATH, the way a pane's shell finds a command by name. */
		const cmdRun = (env: Record<string, string>, args: readonly string[], cwd = neutral()) => run(join(system32(), "cmd.exe"), ["/d", "/c", ...args], { env, cwd, timeoutMs: 120_000 });

		it("prints the pin: through the shim on Windows, through the private prefix on macOS", async () => {
			const result = isWindows
				? await cmdRun(desk([shimsDir(), system32()]), ["pi", "--version"])
				: await run(binShim(world.layout, "pi"), ["--version"], { env: childEnvOf(world, []), cwd: world.home, timeoutMs: 120_000 });
			assert.equal(result.code, 0, result.stderr);
			assert.equal(result.stdout.trim().split(/\r?\n/)[0], pinOf());
		});

		it("leaves the pinned fd and rg of the agent's bin folder unchanged after a first rpc start", async (t) => {
			const bin = join(world.layout.agent, "bin");
			const names = isWindows ? ["fd.exe", "rg.exe"] : ["fd", "rg"];
			const hashes = (): Record<string, string> => Object.fromEntries(names.map((n) => [n, sha256Hex(readFileSync(join(bin, n)))]));
			assert.ok(names.every((n) => existsSync(join(bin, n))), `fd and rg are in ${bin} before the start (the fd-rg stage put them there)`);
			const before = hashes();
			const probe = isWindows
				? await rpcProbe(join(system32(), "cmd.exe"), ["/d", "/c", "pi", "--mode", "rpc", "--no-session", "--offline"], { env: desk([shimsDir(), system32()]), cwd: world.home })
				: await rpcProbe(binShim(world.layout, "pi"), ["--mode", "rpc", "--no-session", "--offline"], { env: childEnvOf(world, []), cwd: world.home });
			t.diagnostic(`rpc start: ${probe.lines.length} line(s); first: ${(probe.lines[0] ?? "").slice(0, 160)}; stderr: ${probe.stderr.trim().slice(0, 200)}`);
			assert.ok(probe.lines.some((l) => l.includes('"state"')), `pi answered get_state: ${probe.lines.join(" | ").slice(0, 400)} ${probe.stderr.slice(0, 400)}`);
			assert.deepEqual(hashes(), before, "fd and rg are byte for byte what the fd-rg stage put there");
			assert.deepEqual(names.filter((n) => !existsSync(join(bin, n))), []);
			assert.deepEqual(readdirSync(bin).filter((n) => !names.includes(n) && !n.endsWith(".staging")).sort(), [], "pi downloaded nothing else into bin");
		});

		describe("on Windows, in a desk pane and outside one", { skip: isWindows ? false : "Windows only: the shims are batch files and a POSIX script for Git's sh" }, () => {
			it("lists pi.cmd, pi, and bash.cmd, and no byte of the root's path is in any of them", () => {
				const names = readdirSync(shimsDir()).sort();
				for (const name of ["bash.cmd", "pi", "pi.cmd"]) assert.ok(names.includes(name), `${name} is in tools\\shims: ${names.join(", ")}`);
				const roots = [world.root, dirname(world.root)];
				for (const name of names) {
					const bytes = readFileSync(join(shimsDir(), name));
					// No byte outside ASCII at all, so no character of a CJK root in the OEM or the ANSI code page, in UTF-8, or in UTF-16 (T6-F004 c): a latin1 decoding
					// could never match a root with CJK characters. The text search below is for the ASCII parts.
					assert.ok(bytes.every((b) => b < 0x80), `${name} holds a byte outside ASCII`);
					const text = bytes.toString("latin1").toLowerCase();
					for (const r of roots) {
						for (const form of [r, r.replace(/\\/g, "/")]) {
							for (const encoding of ["utf8", "utf16le"] as const) assert.ok(!bytes.includes(Buffer.from(form, encoding)), `${name} holds ${form} (${encoding})`);
							assert.ok(!text.includes(form.toLowerCase()), `${name} holds ${form}`);
						}
					}
				}
			});

			it("runs the other pi from a plain cmd and from Git's sh when the desk variables are absent, or name another root", async () => {
				const other = otherPi();
				const gitBin = join(toolDir(world.layout, "git", stateOf(world, "current").versions.git as string), "bin");
				const anotherRoot = join(world.base, "not the desk root");
				const cases: Array<[string, Record<string, string>]> = [
					["without the desk variables", plain([shimsDir(), other, system32()])],
					["with another root", { ...desk([shimsDir(), other, system32()]), STRAW_BOSS_DESK_ROOT: anotherRoot }],
				];
				for (const [what, env] of cases) {
					const viaCmd = await cmdRun(env, ["pi"]);
					assert.equal(viaCmd.stdout.trim(), "other-pi", `cmd ${what}: ${viaCmd.stderr}`);
					const viaSh = await run(join(gitBin, "sh.exe"), ["-c", "pi"], { env: { ...env, PATH: [shimsDir(), other, gitBin, system32()].join(";") }, cwd: neutral(), timeoutMs: 120_000 });
					assert.equal(viaSh.stdout.trim(), "other-pi", `Git's sh ${what}: ${viaSh.stderr}`);
				}
			});

			it("runs a script by bash.cmd into PortableGit's bash from a PowerShell, in a folder with a space and CJK characters, and its pi prints the pin", async () => {
				const folder = join(world.base, "script folder 測試");
				mkdirSync(folder, { recursive: true });
				const script = join(folder, "run 測試.sh");
				writeFileSync(script, "pi --version\necho \"bash=$(command -v bash)\"\n");
				const env = desk([shimsDir(), system32()]);
				const powershell = join(system32(), "WindowsPowerShell", "v1.0", "powershell.exe");
				const result = await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", `bash '${script.replace(/'/g, "''")}'`], { env, cwd: folder, timeoutMs: 120_000 });
				assert.equal(result.code, 0, result.stderr);
				assert.equal(result.stdout.trim().split(/\r?\n/)[0], pinOf());
				// T6-F004 (b): which bash ran the script is PortableGit's, not any bash. `bin\\bash.exe` puts /usr/bin on the PATH, so cygpath turns the shell's own $BASH
				// into the Windows file; the tail of that path is ASCII, which a console prints whole (the CJK root before it is not compared).
				const version = stateOf(world, "current").versions.git as string;
				const which = await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", "bash -c 'cygpath -w $BASH'"], { env, cwd: folder, timeoutMs: 60_000 });
				assert.equal(which.code, 0, which.stderr);
				const ran = which.stdout.trim().replace(/\\/g, "/").toLowerCase();
				assert.ok(ran.endsWith(`/tools/git/${version}/usr/bin/bash.exe`.toLowerCase()), `the script ran under ${which.stdout.trim()}, not PortableGit ${version}'s bash`);
			});

			it("keeps PI_CODING_AGENT_DIR as the child had it, and still starts the pinned pi", async () => {
				const mine = join(neutral(), ".pi", "agent");
				mkdirSync(mine, { recursive: true });
				const env = { ...desk([shimsDir(), system32()]), PI_CODING_AGENT_DIR: mine };
				const version = await cmdRun(env, ["pi", "--version"]);
				assert.equal(version.stdout.trim().split(/\r?\n/)[0], pinOf(), version.stderr);
				const viaBash = await cmdRun(env, ["bash", "-c", "echo $PI_CODING_AGENT_DIR"]);
				// Git's bash may print the Windows path or its /c/ form; either way it ends with the folder the child named.
				assert.ok(viaBash.stdout.trim().replace(/\\/g, "/").toLowerCase().endsWith("/neutral 測試/.pi/agent"), `${viaBash.stdout} ${viaBash.stderr}`);
			});

			it("has the shims folder first in the user PATH with its registry type kept (a guarded fixture)", async (t) => {
				const verdict = hostedCase("pi-shim user PATH entry");
				if (!verdict.run) {
					if (verdict.fail) assert.fail(verdict.reason);
					t.skip(verdict.reason);
					return;
				}
				const now = await world.userPath.read();
				assert.ok(now !== null, "the user Path value exists");
				assert.equal(now.value.split(";")[0]?.toLowerCase(), shimsDir().toLowerCase(), now.value);
				const before = world.userPathBefore;
				if (before !== undefined && before !== null) assert.equal(now.kind, before.kind, "the registry type is the one it had");
				assert.equal(now.value.split(";").filter((e) => e.toLowerCase() === shimsDir().toLowerCase()).length, 1, "once");
			});
		});
	});

	describe("the optional tool bun", () => {
		it("is found by a spawn without a shell on Windows through bun.exe in tools/bin-exe, and a bun.cmd alone is not (FE2R-F009)", { skip: isWindows ? false : "Windows only: macOS finds the launcher script by name" }, async () => {
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

		// T5-F001. cmd and PowerShell try every PATHEXT extension in one folder before the next folder, so with the shim beside the launcher a bare `bun`
		// ran the shim and skipped the launcher's short names. The shims are in tools\\bin-exe now, one PATH folder later.
		it("a bare bun typed in cmd and in PowerShell reaches the launcher: bun's cache is under bun-home and DO_NOT_TRACK is 1 (T5-F001)", { skip: isWindows ? false : "Windows only: PATHEXT" }, async (t) => {
			const env = childEnvOf(world, ["bun"]);
			const project = join(world.base, "bare project 測試");
			mkdirSync(project, { recursive: true });
			writeFileSync(join(project, "package.json"), '{"name":"bare","version":"1.0.0"}\n'); // bun asks for one even to print its cache folder
			const system32 = join(world.appEnv.SystemRoot ?? "C:\\Windows", "System32");
			const expected = join(world.layout.tools.root, "bun-home", "install", "cache");
			assert.equal(existsSync(join(world.layout.tools.bin, "bun.exe")), false, "no .exe beside the launcher");
			assert.equal(existsSync(join(world.layout.tools.binExe, "bun.exe")), true);
			const shells: Array<[string, string, string[]]> = [
				["cmd", join(system32, "cmd.exe"), ["/d", "/c", "bun pm cache"]],
				["PowerShell", join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", "bun pm cache"]],
			];
			for (const [name, file, args] of shells) {
				const cache = await run(file, args, { env, cwd: project });
				assert.equal(cache.code, 0, `${name}: ${cache.stderr || cache.stdout}`);
				assert.ok(sameFolder(firstLine(cache), expected), `${name}: a bare bun says its cache is ${firstLine(cache)}`);
				const dnt = await run(file, name === "cmd" ? ["/d", "/c", "bun -p process.env.DO_NOT_TRACK"] : ["-NoProfile", "-NonInteractive", "-Command", "bun -p process.env.DO_NOT_TRACK"], { env: Object.fromEntries(Object.entries(env).filter(([k]) => k !== "DO_NOT_TRACK")), cwd: project });
				assert.equal(dnt.stdout.trim(), "1", `${name}: the launcher set DO_NOT_TRACK`);
			}
			// Settles where the `??` of the task 5 run came from: the shim, started without the launcher, with the constructed environment's long names.
			const direct = await run(join(world.layout.tools.binExe, "bun.exe"), ["-p", "[process.env.BUN_INSTALL, process.env.BUN_INSTALL_CACHE_DIR].join('|')"], { env, cwd: project });
			t.diagnostic(`bun.exe by itself, long names in the environment, sees: ${direct.stdout.trim()} (exit ${direct.code})`);
			const where = await run(join(world.layout.tools.binExe, "bun.exe"), ["pm", "cache"], { env, cwd: project });
			t.diagnostic(`bun.exe by itself says its cache is: ${where.stdout.trim()}`);
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
			const where = await viaLauncher(world, "bun", ["pm", "cache"], env, join(project, "app"));
			const seen = await viaLauncher(world, "bun", ["-e", "console.log(JSON.stringify([process.env.BUN_INSTALL, process.env.BUN_INSTALL_CACHE_DIR, process.env.HOME, process.env.USERPROFILE, process.cwd()]))"], env, join(project, "app"));
			const ascii = await run(join(world.layout.tools.root, "bun", BUN_VERSION, isWindows ? "bun.exe" : "bun"), ["pm", "cache"], { env: { ...env, BUN_INSTALL_CACHE_DIR: join(world.base, "ascii-cache") }, cwd: join(project, "app") });
			const home = join(world.layout.tools.root, "bun-home");
			assert.ok(existsSync(home) && readdirSync(home).length > 0, `bun-home is filled; bun pm cache says ${where.stdout.trim()} ${where.stderr.trim()}; bun sees ${seen.stdout.trim()} ${seen.stderr.trim()}; bun.exe itself with an ASCII cache dir: ${ascii.stdout.trim()}`);
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
			if (isWindows) for (const name of ["bun.exe", "bunx.exe"]) assert.equal(existsSync(join(world.layout.tools.binExe, name)), false, `${name} is gone from tools\\bin-exe`);
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
		await disposeWorld(world);
	});

	it("completes with every stage verified, and the preflight names the unreachable host as a warning within 10 s", () => {
		assert.equal(summary.error, null);
		assert.ok(summary.ok, JSON.stringify(summary.outcomes).slice(0, 1500));
		const record = (stateOf(world, "bootstrap").stages as Record<string, { status: string; warnings?: Array<{ kind: string; host?: string; sentence: string }> }>).preflight;
		assert.equal(record?.status, "ok");
		// A runner image may have WSL's bash.exe or another pi on the machine PATH: those are warnings of their own (task 6), not what this case is about.
		assert.deepEqual(record?.warnings?.filter((w) => w.kind === "forge-host-unreachable"), [{ kind: "forge-host-unreachable", host: "gitlab.corp.invalid", sentence: privateHostSentence("gitlab.corp.invalid") }]);
		assert.ok((summary.outcomes.preflight?.ms ?? 99_999) < 10_000, `the preflight took ${summary.outcomes.preflight?.ms} ms`);
		for (const [name, status] of Object.entries(statusOf(summary))) assert.equal(status, name === "preflight" ? "skipped-verified" : "installed", name);
	});

	it("has no opt:bun stage, no tools/bun, no bun launcher, and no SBD_BUN", () => {
		const stages = stateOf(world, "bootstrap").stages as Record<string, unknown>;
		assert.equal("opt:bun" in stages, false);
		assert.equal(existsSync(join(world.layout.tools.root, "bun")), false);
		for (const name of ["bun", "bunx", "bun.cmd", "bunx.cmd", "bun.exe", "bunx.exe"]) assert.equal(existsSync(join(world.layout.tools.bin, name)), false, name);
		for (const name of ["bun.exe", "bunx.exe"]) assert.equal(existsSync(join(world.layout.tools.binExe, name)), false, `${name} in tools\\bin-exe`);
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

// ---- task 6: the pi stage through the OS proxy, the OS certificate store, and no_proxy ---------------------------------

/** Stops a process this test started: its tree on Windows, the pid elsewhere. */
async function stopTree(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.pid === undefined) return;
	if (isWindows) await run(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/T", "/F", "/PID", String(child.pid)], { env: {}, timeoutMs: 30_000 });
	else child.kill("SIGKILL");
	const end = Date.now() + 10_000;
	while (Date.now() < end && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 200));
}

/** Runs `file args` until `done()` is true, it exits, or `timeoutMs` pass, then stops it. Output is dropped: a client's words are not what these checks read. */
async function runUntil(file: string, args: readonly string[], options: { env: Record<string, string>; cwd: string; timeoutMs: number; done: () => boolean }): Promise<void> {
	const child = spawn(file, [...args], { env: options.env, cwd: options.cwd, stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
	child.on("error", () => {});
	const end = Date.now() + options.timeoutMs;
	while (Date.now() < end && child.exitCode === null && !options.done()) await new Promise((resolve) => setTimeout(resolve, 150));
	await stopTree(child);
}

describe("the pi stage through the OS proxy setting, claude and the OS certificate store, and no_proxy (e2e-light, task 6)", { skip: off }, () => {
	let world: World;
	let proxy: Awaited<ReturnType<typeof connectProxy>>;
	let install: RunSummary;
	let bridge: string;
	let claudeExe: string | null = null;

	const nodeFile = (): string => nodeBinaryPath(world.layout, stateOf(world, "current").versions.node as string);
	const gitFile = (): string => join(toolDir(world.layout, "git", stateOf(world, "current").versions.git as string), ...(isWindows ? ["cmd", "git.exe"] : ["bin", "git"]));
	const baseEnv = (): Record<string, string> => ({ ...childEnvOf(world, []) });
	const scratchDir = (name: string): string => {
		const dir = join(world.base, name);
		mkdirSync(dir, { recursive: true });
		return dir;
	};

	before(async () => {
		world = createWorld("d");
		proxy = await connectProxy();
		// What main does before an engine run: the stubbed `session.resolveProxy` answers with the test-local proxy; the app's environment names none.
		const os = await resolveOsProxy({ resolve: async () => `PROXY 127.0.0.1:${proxy.port}`, forgeHosts: [], appEnv: world.appEnv });
		install = await runWorld(world, { only: ["preflight", "node", "git", "herdr", "pi"], proxyEnv: os.env });
		// pi-claude-bridge brings the Agent SDK and, as an optional dependency, the platform package with the native claude. Installed by hand into a scratch
		// prefix here: the `pkg:` stages are task 7's.
		if (install.ok) {
			bridge = scratchDir("bridge");
			const pin = (realStack.piPackages as Array<{ name: string; version: string }>).find((p) => p.name === "pi-claude-bridge");
			const env = { ...baseEnv(), NPM_CONFIG_PREFIX: bridge };
			const npm = await run(nodeFile(), [npmCliPath(world.layout, stateOf(world, "current").versions.node as string), "install", "--prefix", bridge, "--ignore-scripts", `pi-claude-bridge@${pin?.version}`], { env, cwd: bridge, timeoutMs: 600_000 });
			assert.equal(npm.code, 0, npm.stderr.slice(0, 600));
			claudeExe = locateClaude(join(bridge, "node_modules"), platformKey(process.platform, process.arch))?.exe ?? null;
		}
	});
	after(async () => {
		await proxy?.close();
		await disposeWorld(world);
	});

	it("installs pi on a first run, before any start, through the CONNECT proxy the OS setting named, with no proxy variable in the app's environment", () => {
		assert.equal(install.error, null);
		assert.ok(install.ok, JSON.stringify(Object.values(install.outcomes).map((o) => o.failure)).slice(0, 1500));
		assert.equal(install.outcomes.pi?.status, "installed");
		assert.deepEqual(Object.keys(world.appEnv).filter((k) => /proxy/i.test(k)), []);
		assert.ok(proxy.connects.includes("registry.npmjs.org:443"), `the proxy saw ${JSON.stringify([...new Set(proxy.connects)])}`);
	});

	it("finds the native claude of the Agent SDK in the tree pi-claude-bridge installed", () => {
		assert.ok(claudeExe !== null && existsSync(claudeExe), `claude: ${claudeExe}`);
	});

	// Design record (Network): does the bundled claude trust the OS certificate store, by default and with NODE_USE_SYSTEM_CA? A test CA goes into the runner's store (a
	// guarded fixture); a stand-in HTTPS server on 127.0.0.1 answers with a certificate signed by it; claude is pointed at it with ANTHROPIC_BASE_URL. T6-F002: the
	// control comes first, in fresh processes, before the CA is in the store: claude must refuse the server then, with and without NODE_USE_SYSTEM_CA, so the later
	// "trusted" is shown to come from the store and not from a claude that verifies nothing. After the CA is added, a fresh claude must trust it with neither
	// variable and with NODE_USE_SYSTEM_CA=1 (the constructed environment sets it).
	it("shows that claude refuses a server whose CA is not in the OS store and trusts it once it is, by default and with NODE_USE_SYSTEM_CA (guarded fixture)", async (t) => {
		assert.ok(claudeExe !== null, "claude was found");
		const exe = claudeExe as string;
		type Verdict = "trusted" | "refused" | "no connection";
		let handshakes = 0;
		let refusals = 0;
		let server: tls.Server | null = null;
		let verdictOf: ((label: string, extra: Record<string, string>) => Promise<Verdict>) | null = null;
		trustedCaScenario.before = async (trusted) => {
			server = tls.createServer({ cert: trusted.ca.server.certPem, key: trusted.ca.server.keyPem }, (socket) => {
				handshakes++;
				socket.on("error", () => {});
				socket.end("HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}");
			});
			server.on("tlsClientError", () => {
				refusals++;
			});
			await new Promise<void>((resolve) => (server as tls.Server).listen(0, "127.0.0.1", resolve));
			const port = ((server as tls.Server).address() as { port: number }).port;
			const home = scratchDir("claude-home");
			verdictOf = async (label, extra) => {
				handshakes = 0;
				refusals = 0;
				const env: Record<string, string> = { ...baseEnv(), HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: scratchDir("claude-config"), ANTHROPIC_BASE_URL: `https://127.0.0.1:${port}`, ANTHROPIC_API_KEY: "sk-ant-test", ...extra };
				for (const name of ["NODE_USE_SYSTEM_CA", "NODE_EXTRA_CA_CERTS"]) if (!(name in extra)) delete env[name];
				// A fresh claude process each time; it is stopped when the server has seen its handshake succeed or fail.
				await runUntil(exe, ["-p", "hi", "--max-turns", "1"], { env, cwd: home, timeoutMs: 45_000, done: () => handshakes + refusals > 0 });
				const result: Verdict = handshakes > 0 ? "trusted" : refusals > 0 ? "refused" : "no connection";
				t.diagnostic(`claude ${label}: ${result}`);
				return result;
			};
			const before = await verdictOf("before the CA is in the store, with neither variable", {});
			const beforeSystem = await verdictOf("before the CA is in the store, with NODE_USE_SYSTEM_CA=1", { NODE_USE_SYSTEM_CA: "1" });
			assert.equal(before, "refused", "the control: claude refuses a server whose CA is not in the OS store");
			assert.equal(beforeSystem, "refused", "the control: NODE_USE_SYSTEM_CA=1 alone does not make claude trust a CA the store does not hold");
		};
		trustedCaScenario.run = async (trusted) => {
			assert.ok(verdictOf !== null, "the control ran before the CA was added");
			const none = await verdictOf("after the CA is in the store, with neither variable", {});
			const system = await verdictOf("after the CA is in the store, with NODE_USE_SYSTEM_CA=1", { NODE_USE_SYSTEM_CA: "1" });
			t.diagnostic(`DESIGN RECORD: claude refuses the CA before it is in the store, then trusts it with neither variable: ${none === "trusted"}; with NODE_USE_SYSTEM_CA=1: ${system === "trusted"} (${trusted.store})`);
			assert.equal(none, "trusted", `claude does not trust the OS store by default (${none}): the system-ca.pem file of Network is needed`);
			assert.equal(system, "trusted", `claude does not trust the OS store with NODE_USE_SYSTEM_CA=1 (${system}), which the constructed environment sets`);
		};
		try {
			const verdict = await runFixture(trustedTestCa, realIO);
			if (!verdict.run) t.skip(verdict.reason);
		} finally {
			trustedCaScenario.before = null;
			trustedCaScenario.run = null;
			(server as tls.Server | null)?.close();
		}
	});

	// T3-F007, T6-F003. A client may read `no_proxy`, `NO_PROXY`, or both, and curl (so Git) reads the lowercase name first. The constructed environment puts the
	// union of the PM's list and the resolved one in both spellings; this records what npm, Git, and claude do with each spelling and with the two spellings
	// holding different lists, and requires that every one bypasses the proxy when both are set and with the environment the desk builds for a PM whose own
	// lowercase `no_proxy` does not name the target. Each client is stopped as soon as the route is known (T6-F010).
	describe("which spelling of the bypass list each client reads (T3-F007, T6-F003)", () => {
		const routes = async (client: (c: ProbeContext) => Promise<void>) => {
			const out = await probeNoProxy(client, { built: (port) => builtProxyVariables(world, port) });
			return Object.fromEntries(VARIANTS.map((v) => [v, routeOf(out[v])])) as Record<(typeof VARIANTS)[number], "bypassed" | "proxied" | "neither">;
		};
		const record = (t: { diagnostic: (m: string) => void }, who: string, r: Record<string, string>): void =>
			t.diagnostic(`${who}: no variable ${r.none}; no_proxy only ${r.lower}; NO_PROXY only ${r.upper}; both ${r.both}; different lists (target only in NO_PROXY) ${r.differ}; as the desk builds them ${r.built}`);
		const checked = (r: Record<string, string>, who: string): void => {
			assert.equal(r.none, "proxied", "the control: without a bypass list the proxy is asked");
			assert.equal(r.both, "bypassed", `with both spellings set, ${who} goes direct`);
			assert.equal(r.built, "bypassed", `with the environment the desk builds for a PM's own lowercase no_proxy, ${who} goes direct for a host only the resolved list names`);
		};

		it("npm", async (t) => {
			const cache = scratchDir("npm-cache-probe");
			const r = await routes((c) => runUntil(nodeFile(), [npmCliPath(world.layout, stateOf(world, "current").versions.node as string), "view", "foo", "version", "--registry", c.url, "--strict-ssl=false", "--fetch-retries=0", "--fetch-timeout=5000", "--prefer-online"], { env: { ...baseEnv(), NPM_CONFIG_CACHE: cache, ...c.env }, cwd: cache, timeoutMs: 30_000, done: c.seen }));
			record(t, "npm", r);
			checked(r, "npm");
		});

		it("Git", async (t) => {
			const dir = scratchDir("git-probe");
			const r = await routes((c) => runUntil(gitFile(), ["ls-remote", `${c.url}probe.git`], { env: { ...baseEnv(), GIT_TERMINAL_PROMPT: "0", GIT_CURL_VERBOSE: "0", ...c.env }, cwd: dir, timeoutMs: 30_000, done: c.seen }));
			record(t, "Git", r);
			checked(r, "Git");
		});

		it("claude", async (t) => {
			assert.ok(claudeExe !== null, "claude was found");
			const home = scratchDir("claude-probe-home");
			// The client is stopped when the route is known; the limit is only for a slow first start.
			const r = await routes((c) => runUntil(claudeExe as string, ["-p", "hi", "--max-turns", "1"], { env: { ...baseEnv(), HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: scratchDir("claude-probe-config"), ANTHROPIC_BASE_URL: c.url, ANTHROPIC_API_KEY: "sk-ant-test", ...c.env }, cwd: home, timeoutMs: 40_000, done: c.seen }));
			record(t, "claude", r);
			checked(r, "claude");
		});
	});
});

describe("an unreachable download host (e2e-light)", { skip: off }, () => {
	let world: World;
	before(() => {
		world = createWorld("c");
	});
	after(async () => disposeWorld(world));

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
