import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { buildEnv, NEVER_CARRY, bunHome } from "../src/main/env.ts";
import { computeLayout, toolExecutable, type AppPlatform, type CurrentTools, type Layout } from "../src/main/paths.ts";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { NO_RECIPE, engineRecipeOf, recipeValidationOptions } from "../src/main/bootstrap/recipe-config.ts";
import { parseStack, StackError, assetFor, optionalToolNames, platformKey } from "../src/main/bootstrap/stack.ts";
import { activateDir, detectFromRecord, fileKey, installDir, type Stage, type StageContext } from "../src/main/bootstrap/stage.ts";
import { StateStore } from "../src/main/bootstrap/state.ts";
import { blockText, hasBlock, readGitconfig, removeBlock, upsertBlock, GitconfigBlockError } from "../src/main/bootstrap/stages/gitconfig.ts";
import { FORGE_LAUNCHERS, LAUNCHER_UNSET, cmdLauncher, everyLauncherName, launcherFiles, optionalLaunchers, shLauncher, windowsShims } from "../src/main/bootstrap/stages/launcher-files.ts";
import { pathFiles, pathsCmd, pathsSh, type PathVersions } from "../src/main/bootstrap/stages/path-files.ts";
import { gitHelpersStage, helperCommand, helpersBody, launchersStage, toolPathsStage } from "../src/main/bootstrap/stages/paths-launchers.ts";
import { enabledTools, toolStages } from "../src/main/bootstrap/stages/index.ts";
import { GIT_BASE_BLOCK, OPTIONAL_TOOLS, ZDOTDIR_TEXT, dugiteEnv, expectedGitVersion, herdrConfigText, optionalToolStage } from "../src/main/bootstrap/stages/tools.ts";
import { MIN_FREE_BYTES, downloadHosts, preflightStage, privateHostSentence, reachKindOf } from "../src/main/bootstrap/stages/preflight.ts";
import { leftovers, makeStack, runEngine, scratchRoot, testEngine, testLayout, testPlatform } from "./harness/engine-fixture.ts";
import { validateRecipe } from "../../recipe/validate.mjs";
import { liftSingleFolder } from "../src/main/bootstrap/archive-stage.ts";
import { withManagedFiles } from "../src/main/bootstrap/stages/support.ts";
import { FixtureServer } from "./harness/fixture-server.ts";
import { publish, toolStage } from "./harness/engine-fixture.ts";

const realStack = JSON.parse(readFileSync(new URL("../../stack.json", import.meta.url), "utf8")) as unknown;
const scratch: string[] = [];
after(() => {
	for (const d of scratch) removeTree(d);
});
const fresh = (): { base: string; root: string } => {
	const made = scratchRoot("sbd-ts-");
	scratch.push(made.base);
	return made;
};
const posixOnly = process.platform === "win32" ? "the fake tools are POSIX scripts; the Windows runner runs the real ones in the e2e-light job" : false;

function fakeLayout(platform: AppPlatform): Layout {
	const home = platform === "win32" ? "C:\\Users\\測試" : "/Users/測試";
	const root = platform === "win32" ? "C:\\Users\\測試\\AppData\\Local\\sbd 測試" : "/Users/測試/Library/Application Support/straw-boss-desk";
	return computeLayout({ root, home, platform, realpath: (p) => { if (p === home) return p; throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } });
}

const versions: PathVersions = { node: "24.22.1", git: "2.56.0-2", herdr: "0.9.5", gh: "2.103.3", glab: "1.124.0", optional: { bun: "1.2.23" } };
const winVersions: PathVersions = { ...versions, git: "2.56.0.3" };

describe("stack.json optionalTools (FE2R-F003)", () => {
	it("parseStack keeps the optional tools of the real stack, apart from the required ones", () => {
		const stack = parseStack(realStack);
		assert.deepEqual(optionalToolNames(stack), ["bun"]);
		assert.equal(stack.optionalTools.bun?.assets["darwin-arm64"]?.version, "1.2.23");
		assert.equal(stack.tools.bun, undefined);
		assert.equal(assetFor(stack, "bun", "win32-x64").file, "bun-windows-x64-baseline.zip");
		assert.equal(assetFor(stack, "gh", "darwin-arm64").version, "2.103.3");
		assert.throws(() => assetFor(stack, "nothere", "darwin-arm64"), StackError);
	});

	it("a stack without the key has no optional tools", () => {
		const { optionalTools: _dropped, ...rest } = realStack as Record<string, unknown>;
		assert.deepEqual(parseStack(rest).optionalTools, {});
	});

	it("refuses an optional tool named like a required one, a reserved folder, or a name a recipe cannot write", () => {
		const base = realStack as { tools: Record<string, unknown>; optionalTools: Record<string, unknown> };
		const bun = base.optionalTools.bun;
		for (const name of ["gh", "bin", "downloads", "bun-home", "shims", "staging", "Bun", "my-tool", "1bun"]) {
			assert.throws(() => parseStack({ ...base, optionalTools: { [name]: bun } }), StackError, name);
		}
	});

	it("checks the optional assets like the required ones", () => {
		const base = realStack as { optionalTools: { bun: { assets: Record<string, Record<string, string>> } } };
		const bad = structuredClone(base);
		(bad.optionalTools.bun.assets["darwin-arm64"] as Record<string, string>).sha256 = "nothex";
		assert.throws(() => parseStack(bad), /optionalTools\.bun\.assets\.darwin-arm64\.sha256/);
		const http = structuredClone(base);
		(http.optionalTools.bun.assets["darwin-arm64"] as Record<string, string>).url = "http://example.com/bun.zip";
		assert.throws(() => parseStack(http), /must be https/);
	});

	it("every optional tool of the real stack has a stage in this version of the app", () => {
		for (const name of optionalToolNames(parseStack(realStack))) assert.ok(name in OPTIONAL_TOOLS, `${name} has no stage`);
	});
});

describe("the recipe's tools reach the engine (FE2R-F003)", () => {
	const stack = parseStack(realStack);
	const recipeText = readFileSync(new URL("../../recipe/examples/team.strawboss.json", import.meta.url), "utf8");

	it("validateRecipe is called with the stack's known tools, and a name outside them is refused", () => {
		const options = recipeValidationOptions(stack);
		assert.deepEqual(options.knownTools, ["bun"]);
		assert.ok(options.reservedPackages.includes("pi-straw-boss") && options.reservedPackages.includes("straw-boss-desk-profile"));
		const ok = validateRecipe(recipeText, options);
		assert.equal(ok.ok, true, JSON.stringify(ok));
		const bad = validateRecipe(recipeText.replace('"tools": ["bun"]', '"tools": ["bun", "deno"]'), options);
		assert.equal(bad.ok, false);
		assert.ok(!bad.ok && bad.errors.some((e: { rule: string }) => e.rule === "unknown-tool"));
	});

	it("engineRecipeOf takes the forges and tool names of a validated recipe", () => {
		const result = validateRecipe(recipeText, recipeValidationOptions(stack));
		assert.ok(result.ok);
		const recipe = engineRecipeOf(result.recipe, stack);
		assert.deepEqual(recipe.tools, ["bun"]);
		assert.deepEqual(recipe.forges, [{ kind: "github", host: "github.com" }, { kind: "gitlab", host: "gitlab.waydo.example" }]);
		assert.deepEqual(engineRecipeOf(undefined, stack), NO_RECIPE);
		assert.deepEqual(engineRecipeOf({ forges: [{ kind: "github", host: "GitHub.com" }] }, stack), { forges: [{ kind: "github", host: "github.com" }], tools: [] });
	});

	it("refuses a tool the stack does not list, a repeated one, and a forge that is not plain", () => {
		assert.throws(() => engineRecipeOf({ tools: ["deno"] }, stack), /not a tool this stack can turn on/);
		assert.throws(() => engineRecipeOf({ tools: ["bun", "bun"] }, stack), /listed twice/);
		assert.throws(() => engineRecipeOf({ forges: [{ kind: "bitbucket", host: "x.com" }] }, stack), StackError);
		assert.throws(() => engineRecipeOf({ forges: [{ kind: "github", host: "a b" }] }, stack), StackError);
	});

	it("the stage list follows the recipe: no recipe, no gh, glab, or opt stage; a named tool has one", () => {
		const names = (recipe: Parameters<typeof toolStages>[1]): string[] => toolStages(stack, recipe, "darwin").map((s) => s.name);
		const core = ["preflight", "node", "git", "herdr", "fd-rg", "tool-paths", "launchers", "git-helpers"];
		assert.deepEqual(names(NO_RECIPE).sort(), [...core].sort());
		const full = names({ forges: [{ kind: "github", host: "github.com" }, { kind: "gitlab", host: "g.example" }], tools: ["bun"] });
		assert.deepEqual([...full].sort(), [...core, "gh", "glab", "opt:bun"].sort());
		assert.deepEqual(names({ forges: [{ kind: "gitlab", host: "g.example" }], tools: [] }).sort(), [...core, "glab"].sort());
		const paths = toolStages(stack, { forges: [{ kind: "github", host: "github.com" }], tools: ["bun"] }, "darwin").find((s) => s.name === "tool-paths");
		assert.deepEqual([...(paths?.needs ?? [])].sort(), ["gh", "git", "herdr", "node", "opt:bun"]);
		assert.throws(() => toolStages(stack, { forges: [], tools: ["deno"] }, "darwin"), StackError);
	});

	it("every stage but preflight needs something that leads to it, and the graph orders", () => {
		const stages = toolStages(stack, { forges: [{ kind: "github", host: "github.com" }], tools: ["bun"] }, "win32");
		const byName = new Map(stages.map((s) => [s.name, s]));
		for (const stage of stages) for (const need of stage.needs) assert.ok(byName.has(need), `${stage.name} needs ${need}`);
		assert.deepEqual(byName.get("preflight")?.needs, []);
		assert.deepEqual([...(byName.get("git-helpers")?.needs ?? [])].sort(), ["git", "launchers"]);
		assert.deepEqual(enabledTools({ forges: [{ kind: "gitlab", host: "g.example" }, { kind: "github", host: "github.com" }], tools: ["bun"] }), { clis: ["gh", "glab"], optional: ["bun"] });
	});
});

describe("the private gitconfig blocks", () => {
	it("keeps the base block first and the forge block last, whatever the PM wrote between them", () => {
		const { base } = fresh();
		const file = join(base, "gitconfig");
		writeFileSync(file, '[alias]\n\tco = checkout\n[credential]\n\thelper = store\n');
		upsertBlock(file, "forge credential helpers", '[credential "https://a"]\n\thelper =', "last");
		upsertBlock(file, "base", GIT_BASE_BLOCK, "first");
		const text = readGitconfig(file);
		assert.ok(text.startsWith("# >>> straw-boss base"), text);
		assert.ok(text.trimEnd().endsWith("# <<< straw-boss forge credential helpers"), text);
		assert.ok(text.includes("[alias]\n\tco = checkout\n[credential]\n\thelper = store\n"), "the PM's lines are untouched");
		assert.ok(hasBlock(file, "base", GIT_BASE_BLOCK, "first"));
		assert.ok(hasBlock(file, "forge credential helpers", '[credential "https://a"]\n\thelper =', "last"));
	});

	it("rewrites a block in place and keeps it last when the PM appends after it", () => {
		const { base } = fresh();
		const file = join(base, "gitconfig");
		upsertBlock(file, "forge credential helpers", "[a]\n\tx = 1", "last");
		writeFileSync(file, `${readFileSync(file, "utf8")}[later]\n\tadded = by the PM\n`);
		assert.equal(hasBlock(file, "forge credential helpers", "[a]\n\tx = 1", "last"), false, "something follows it");
		upsertBlock(file, "forge credential helpers", "[a]\n\tx = 2", "last");
		const text = readGitconfig(file);
		assert.ok(text.includes("added = by the PM"));
		assert.ok(text.trimEnd().endsWith("# <<< straw-boss forge credential helpers"));
		assert.equal(text.split("# >>> straw-boss forge").length, 2, "one block, not two");
		assert.ok(hasBlock(file, "forge credential helpers", "[a]\n\tx = 2", "last"));
	});

	it("removes only its own block, reads a CRLF file with a byte order mark, and refuses a block with no end line", () => {
		const { base } = fresh();
		const file = join(base, "gitconfig");
		writeFileSync(file, `\uFEFF[user]\r\n\tname = X\r\n${blockText("forge credential helpers", "[a]")}`.replace(/\n/g, "\r\n").replace(/\r\r/g, "\r"));
		removeBlock(file, "forge credential helpers");
		assert.equal(readGitconfig(file), "[user]\n\tname = X\n");
		writeFileSync(file, "# >>> straw-boss base (written by the app; change settings outside this block)\n[user]\n");
		assert.throws(() => upsertBlock(file, "base", "x", "first"), GitconfigBlockError);
		assert.equal(hasBlock(file, "base", "x", "first"), false);
	});
});

describe("launchers (port of forge-cli.mjs)", () => {
	it("holds no version, no root path, and reads the paths file", () => {
		for (const spec of [FORGE_LAUNCHERS.gh, FORGE_LAUNCHERS.glab, ...optionalLaunchers("bun")]) {
			for (const text of [shLauncher(spec), cmdLauncher(spec)]) {
				assert.ok(!/\d+\.\d+\.\d+/.test(text), `${spec.name} holds a version string`);
				assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(text), "ASCII only");
				assert.ok(text.includes("paths."), "reads the paths file");
			}
			assert.ok(cmdLauncher(spec).includes("\r\n") && !cmdLauncher(spec).replace(/\r\n/g, "").includes("\n"), "cmd uses CRLF only");
			assert.ok(!shLauncher(spec).includes("\r"));
		}
	});

	it("sets gh's and glab's telemetry switches and unsets what the kit unset, plus the TLS-verify switches", () => {
		const gh = shLauncher(FORGE_LAUNCHERS.gh);
		assert.ok(gh.includes("GH_TELEMETRY=disabled") && gh.includes("DO_NOT_TRACK=1"));
		const glab = shLauncher(FORGE_LAUNCHERS.glab);
		assert.ok(glab.includes("GLAB_SEND_TELEMETRY=0") && glab.includes("DO_NOT_TRACK=1"), "glab 1.124.0's `telemetry` setting, GLAB_SEND_TELEMETRY");
		for (const name of ["CI", "GITLAB_CI", "GH_TOKEN", "GITLAB_TOKEN", "OAUTH_TOKEN", "CI_JOB_TOKEN", "GH_HOST", "GITLAB_HOST", "GLAB_USE_KEYRING", "USE_KEYRING", "GLAB_SKIP_TLS_VERIFY", "SKIP_TLS_VERIFY"]) {
			assert.ok(LAUNCHER_UNSET.includes(name), name);
			assert.ok(gh.includes(` ${name}`) || gh.includes(`unset ${name}`), name);
			assert.ok(cmdLauncher(FORGE_LAUNCHERS.gh).includes(`set "${name}="`), name);
		}
		// R3-F002: a company proxy or CA may need these, so a launcher keeps them.
		for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "GLAB_CA_CERT", "CA_CERT", "GIT_SSL_CAINFO"]) assert.ok(!LAUNCHER_UNSET.includes(name), name);
	});

	it("every name a launcher unsets is one a constructed environment never carries", () => {
		for (const name of LAUNCHER_UNSET) assert.ok(NEVER_CARRY.includes(name), `${name} is not in NEVER_CARRY`);
	});

	it("gives the config folders of gh and glab beside the root's config/, derived from the launcher's own place", () => {
		assert.ok(shLauncher(FORGE_LAUNCHERS.gh).includes('GH_CONFIG_DIR="$SBD_APP_ROOT/config/gh"'));
		assert.ok(shLauncher(FORGE_LAUNCHERS.glab).includes('GLAB_CONFIG_DIR="$SBD_APP_ROOT/config/glab-cli"'));
		assert.ok(cmdLauncher(FORGE_LAUNCHERS.glab).includes('set "GLAB_CONFIG_DIR=%SBD_APP_ROOT%\\config\\glab-cli"'));
		assert.ok(cmdLauncher(FORGE_LAUNCHERS.gh).includes('for %%I in ("%~dp0..\\..") do set "SBD_APP_ROOT=%%~fI"'));
	});

	it("bun and bunx keep bun's cache and global packages under tools/bun-home, and bunx is `bun x`", () => {
		const [bun, bunx] = optionalLaunchers("bun");
		assert.ok(bun && bunx);
		assert.ok(shLauncher(bun).includes('BUN_INSTALL="$SBD_APP_ROOT/tools/bun-home"'));
		assert.ok(shLauncher(bun).includes('exec "$SBD_BUN" "$@"'));
		assert.ok(shLauncher(bunx).includes('exec "$SBD_BUN" x "$@"'));
		assert.ok(cmdLauncher(bun).includes('set "BUN_INSTALL=%SBD_APP_ROOT%\\tools\\bun-home"'));
		assert.ok(cmdLauncher(bunx).includes('"%SBD_BUN%" x %*'));
		assert.ok(!shLauncher(bun).includes("unset"), "CI and token variables are the forge CLIs' concern, not bun's");
		assert.deepEqual(optionalLaunchers("nothere"), []);
	});

	it("writes the .cmd flavour only on Windows, and names every launcher a dropped tool would leave", () => {
		const specs = [FORGE_LAUNCHERS.gh, ...optionalLaunchers("bun")];
		assert.deepEqual(Object.keys(launcherFiles("darwin", specs)).sort(), ["bun", "bunx", "gh"]);
		assert.deepEqual(Object.keys(launcherFiles("win32", specs)).sort(), ["bun", "bun.cmd", "bunx", "bunx.cmd", "gh", "gh.cmd"]);
		assert.deepEqual(everyLauncherName("darwin", ["bun"]).sort(), ["bun", "bunx", "gh", "glab"]);
		assert.deepEqual(everyLauncherName("win32", ["bun"]).sort(), ["bun", "bun.cmd", "bun.exe", "bunx", "bunx.cmd", "bunx.exe", "gh", "gh.cmd", "glab", "glab.cmd"]);
		assert.deepEqual(windowsShims("bun"), ["bun.exe", "bunx.exe"]);
		assert.deepEqual(windowsShims("other"), []);
	});

	it("runs its tool with the telemetry switches set and the token variables gone, keeping the proxy ones (POSIX)", { skip: posixOnly }, () => {
		const { base } = fresh();
		const root = join(base, "root 測試");
		const bin = join(root, "tools", "bin");
		mkdirSync(bin, { recursive: true });
		const probe = join(base, "probe");
		writeFileSync(probe, '#!/bin/sh\nfor v in GH_TELEMETRY DO_NOT_TRACK GLAB_SEND_TELEMETRY GH_CONFIG_DIR GLAB_CONFIG_DIR CI GH_TOKEN GITLAB_TOKEN SKIP_TLS_VERIFY HTTPS_PROXY NODE_EXTRA_CA_CERTS BUN_INSTALL; do eval "printf \'%s=%s\\n\' $v \\"\\${$v-<unset>}\\""; done\nprintf \'args=%s\\n\' "$*"\n');
		chmodSync(probe, 0o755);
		writeFileSync(join(bin, "paths.sh"), `SBD_GH="${probe}"\nSBD_GLAB="${probe}"\nSBD_BUN="${probe}"\n`);
		for (const [name, text] of Object.entries(launcherFiles("darwin", [FORGE_LAUNCHERS.gh, FORGE_LAUNCHERS.glab, ...optionalLaunchers("bun")]))) writeFileSync(join(bin, name), text, { mode: 0o755 });
		const dirty = { PATH: "/usr/bin:/bin", HOME: base, CI: "true", GH_TOKEN: "leak", GITLAB_TOKEN: "leak", SKIP_TLS_VERIFY: "1", HTTPS_PROXY: "http://proxy.example:8080", NODE_EXTRA_CA_CERTS: "/ca/bundle" };
		const run = (name: string, ...args: string[]): Record<string, string> =>
			Object.fromEntries(execFileSync(join(bin, name), args, { env: dirty, encoding: "utf8" }).trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
		const gh = run("gh", "--version");
		assert.equal(gh.GH_TELEMETRY, "disabled", "GH_TELEMETRY was not set by the caller");
		assert.equal(gh.DO_NOT_TRACK, "1");
		assert.equal(gh.GH_CONFIG_DIR, join(root, "config", "gh"));
		for (const gone of ["CI", "GH_TOKEN", "GITLAB_TOKEN", "SKIP_TLS_VERIFY"]) assert.equal(gh[gone], "<unset>", gone);
		assert.equal(gh.HTTPS_PROXY, "http://proxy.example:8080");
		assert.equal(gh.NODE_EXTRA_CA_CERTS, "/ca/bundle");
		assert.equal(gh.args, "--version");
		const glab = run("glab", "api");
		assert.equal(glab.GLAB_SEND_TELEMETRY, "0");
		assert.equal(glab.GLAB_CONFIG_DIR, join(root, "config", "glab-cli"));
		assert.equal(glab.SKIP_TLS_VERIFY, "<unset>");
		const bun = run("bun", "--version");
		assert.equal(bun.BUN_INSTALL, join(root, "tools", "bun-home"));
		assert.equal(bun.CI, "true", "bun keeps the caller's CI variable");
		assert.equal(run("bunx", "cowsay", "hi").args, "x cowsay hi");
	});
});

describe("tools/bin/paths.sh and paths.cmd", () => {
	const enabled = { clis: ["gh", "glab"] as const, optional: ["bun"] as const };

	it("list the PATH folders in order and the executables, relative to the root, in ASCII, with no byte of the root", () => {
		for (const platform of ["darwin", "win32"] as const) {
			const layout = fakeLayout(platform);
			const v = platform === "win32" ? winVersions : versions;
			const files = pathFiles(platform, layout, v, enabled);
			assert.deepEqual(Object.keys(files).sort(), platform === "win32" ? ["paths.cmd", "paths.sh"] : ["paths.sh"]);
			for (const [name, text] of Object.entries(files)) {
				assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(text), `${name} is ASCII`);
				assert.ok(!text.includes(layout.root) && !text.includes("測試") && !text.includes("Users"), `${name} holds no byte of the root`);
				assert.ok(text.includes("SBD_GH") && text.includes("SBD_GLAB") && text.includes("SBD_BUN"), name);
			}
		}
		const mac = pathsSh(fakeLayout("darwin"), versions, enabled);
		assert.ok(mac.includes("SBD_REL_PATH='tools/bin tools/node/24.22.1/bin tools/npm/bin tools/git/2.56.0-2/bin tools/herdr/0.9.5'"), mac);
		assert.ok(mac.includes('SBD_GH="$SBD_APP_ROOT/tools/gh/2.103.3/bin/gh"'));
		assert.ok(mac.includes('SBD_BUN="$SBD_APP_ROOT/tools/bun/1.2.23/bun"'));
		assert.ok(!mac.includes("SBD_GIT_BASH"), "bash.exe is Windows only");
		const win = pathsCmd(fakeLayout("win32"), winVersions, enabled);
		assert.ok(win.includes("tools\\bin;%SBD_APP_ROOT%\\tools\\node\\24.22.1;%SBD_APP_ROOT%\\tools\\npm;%SBD_APP_ROOT%\\tools\\git\\2.56.0.3\\cmd;%SBD_APP_ROOT%\\tools\\git\\2.56.0.3\\bin;%SBD_APP_ROOT%\\tools\\herdr\\0.9.5"), win);
		assert.ok(win.includes('set "SBD_GIT_BASH=%SBD_APP_ROOT%\\tools\\git\\2.56.0.3\\bin\\bash.exe"'));
		assert.ok(win.includes('set "SBD_BUN=%SBD_APP_ROOT%\\tools\\bun\\1.2.23\\bun.exe"'));
		assert.ok(win.includes("\r\n") && !win.replace(/\r\n/g, "").includes("\n"));
		const winSh = pathsSh(fakeLayout("win32"), winVersions, enabled);
		assert.ok(winSh.includes('SBD_PATH="$SBD_APP_ROOT/tools/bin;$SBD_APP_ROOT/tools/node/24.22.1;'), "Windows: `;` between mixed-form paths");
		assert.ok(winSh.includes('SBD_GIT_BASH="$SBD_APP_ROOT/tools/git/2.56.0.3/bin/bash.exe"'));
	});

	it("name only the enabled tools: no SBD_BUN without bun, no SBD_GH without gh", () => {
		const layout = fakeLayout("darwin");
		const none = pathsSh(layout, versions, { clis: [], optional: [] });
		assert.ok(!none.includes("SBD_BUN") && !none.includes("SBD_GH") && !none.includes("SBD_GLAB"), none);
		const gh = pathsSh(layout, versions, { clis: ["gh"], optional: [] });
		assert.ok(gh.includes("SBD_GH") && !gh.includes("SBD_GLAB"));
		assert.throws(() => pathsSh(layout, { ...versions, optional: {} }, { clis: [], optional: ["bun"] }), /no active version/);
	});
});

describe("the herdr and git configuration", () => {
	it("Herdr's config: no onboarding, version or manifest check, or sounds; zsh panes only on macOS", () => {
		const mac = herdrConfigText("darwin");
		const win = herdrConfigText("win32");
		for (const text of [mac, win]) {
			assert.ok(text.includes("onboarding = false") && text.includes("version_check = false") && text.includes("manifest_check = false"));
			assert.ok(/\[ui\.sound\]\nenabled = false/.test(text));
		}
		assert.ok(mac.includes('shell_mode = "non_login"') && mac.includes('default_shell = "/bin/zsh"'));
		assert.ok(!win.includes("default_shell") && !win.includes("shell_mode"), "the pane shell on Windows is Herdr's default, PowerShell");
	});

	it("the ZDOTDIR files hold no version and no path, and take PATH from paths.sh with the system folders after the tool folders", () => {
		assert.ok(!/\d+\.\d+\.\d+/.test(ZDOTDIR_TEXT));
		assert.ok(!ZDOTDIR_TEXT.includes("/Users") && !ZDOTDIR_TEXT.includes("Application Support"));
		assert.ok(ZDOTDIR_TEXT.includes('"$STRAW_BOSS_DESK_ROOT/tools/bin/paths.sh"'));
		assert.ok(ZDOTDIR_TEXT.includes('PATH="$SBD_PATH:/usr/bin:/bin:/usr/sbin:/sbin"'));
		assert.ok(!ZDOTDIR_TEXT.includes("$PATH"), "the inherited PATH never survives");
	});

	it("the git version each pin reads: PortableGit's four-part pin, dugite's -N pin", () => {
		assert.equal(expectedGitVersion("2.56.0.3"), "git version 2.56.0.windows.3");
		assert.equal(expectedGitVersion("2.56.0-2"), "git version 2.56.0");
	});

	it("dugite-native's variables name its own libexec and templates (task 5 finding)", () => {
		assert.deepEqual(dugiteEnv("/g"), { GIT_EXEC_PATH: join("/g", "libexec", "git-core"), GIT_TEMPLATE_DIR: join("/g", "share", "git-core", "templates") });
		const layout = fakeLayout("darwin");
		const env = buildEnv({ layout, current: { node: "24.22.1", git: "2.56.0-2", herdr: "0.9.5" } as CurrentTools, appEnv: {} });
		assert.equal(env.GIT_EXEC_PATH, `${layout.tools.root}/git/2.56.0-2/libexec/git-core`);
		assert.equal(env.GIT_TEMPLATE_DIR, `${layout.tools.root}/git/2.56.0-2/share/git-core/templates`);
		const win = buildEnv({ layout: fakeLayout("win32"), current: { node: "24.22.1", git: "2.56.0.3", herdr: "0.9.5" }, appEnv: {} });
		assert.equal(win.GIT_EXEC_PATH, undefined, "PortableGit is relocatable");
		assert.equal(win.GIT_TEMPLATE_DIR, undefined);
	});

	it("BUN_INSTALL is in the constructed environment only for a recipe that names bun", () => {
		const layout = fakeLayout("darwin");
		const current: CurrentTools = { node: "24.22.1", git: "2.56.0-2", herdr: "0.9.5" };
		assert.equal(buildEnv({ layout, current, appEnv: {} }).BUN_INSTALL, undefined);
		assert.equal(buildEnv({ layout, current, appEnv: {}, optionalTools: ["bun"] }).BUN_INSTALL, bunHome(layout));
		assert.equal(bunHome(layout), join(layout.tools.root, "bun-home"));
	});
});

describe("credential helper commands", () => {
	it("single-quotes the launcher path for sh, closing and reopening around a quote in it", () => {
		assert.equal(helperCommand("darwin", "/a b/測試/tools/bin/gh"), "!'/a b/測試/tools/bin/gh' auth git-credential");
		assert.equal(helperCommand("darwin", "/it's/gh"), "!'/it'\\''s/gh' auth git-credential");
		assert.equal(helperCommand("win32", "C:\\Users\\測試\\sbd 測試\\tools\\bin\\gh"), "!'C:/Users/測試/sbd 測試/tools/bin/gh' auth git-credential");
	});

	it("writes an empty helper first, so a general helper (Git Credential Manager) is cleared for the host", () => {
		const body = helpersBody("darwin", "/r/tools/bin", [{ kind: "github", host: "github.com" }, { kind: "gitlab", host: "gitlab.example.test:8443" }]);
		assert.equal(body, ['[credential "https://github.com"]', "\thelper =", "\thelper = !'/r/tools/bin/gh' auth git-credential", '[credential "https://gitlab.example.test:8443"]', "\thelper =", "\thelper = !'/r/tools/bin/glab' auth git-credential"].join("\n"));
		assert.equal(helpersBody("darwin", "/r/tools/bin", []), "");
	});
});

describe("the preflight", () => {
	const stack = parseStack(realStack);
	const key = platformKey("darwin", "arm64");
	const plenty = (): number => 100 * 1024 ** 3;

	it("names the hosts the downloads come from: the pins of the required tools, the CLIs the forges need, the enabled tools, and the registry", () => {
		const none = downloadHosts(stack, key, NO_RECIPE);
		assert.deepEqual([...none].sort(), ["github.com", "nodejs.org", "registry.npmjs.org"]);
		const gitlab = downloadHosts(stack, key, { forges: [{ kind: "gitlab", host: "g.example" }], tools: [] });
		assert.ok(gitlab.includes("gitlab.com"), "glab is downloaded from gitlab.com");
		assert.ok(!gitlab.includes("g.example"), "the recipe's own host is checked apart, as a warning");
	});

	it("tells a name that does not resolve, a certificate this computer does not trust, and any other failure apart", () => {
		const fetchFailed = (code: string, message = "fetch failed"): Error => Object.assign(new TypeError(message), { cause: Object.assign(new Error(code), { code }) });
		assert.equal(reachKindOf(fetchFailed("ENOTFOUND")), "dns");
		assert.equal(reachKindOf(new TypeError("net::ERR_NAME_NOT_RESOLVED")), "dns");
		assert.equal(reachKindOf(fetchFailed("UNABLE_TO_VERIFY_LEAF_SIGNATURE")), "tls");
		assert.equal(reachKindOf(fetchFailed("SELF_SIGNED_CERT_IN_CHAIN")), "tls");
		assert.equal(reachKindOf(new TypeError("net::ERR_CERT_AUTHORITY_INVALID")), "tls");
		assert.equal(reachKindOf(fetchFailed("ECONNREFUSED")), "path");
		assert.equal(reachKindOf(fetchFailed("UND_ERR_CONNECT_TIMEOUT")), "path");
	});

	const answering = (down: ReadonlyMap<string, "dns" | "tls" | "path">, seen: string[] = []) =>
		async (url: string, init?: { signal?: AbortSignal; method?: string }): Promise<Response> => {
			const host = new URL(url).host;
			seen.push(`${init?.method ?? "GET"} ${host}`);
			const how = down.get(host);
			if (how === undefined) return new Response(null, { status: 200 });
			if (how === "dns") throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) });
			if (how === "tls") throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("unable to verify"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }) });
			// path: held open until the stage's limit aborts it, as a blackholed address is.
			await new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
			return new Response(null);
		};

	const patterns = JSON.parse(readFileSync(new URL("../../recipe/secret-patterns.json", import.meta.url), "utf8")) as unknown;
	const run = async (down: Map<string, "dns" | "tls" | "path">, recipe: Parameters<typeof toolStages>[1], freeBytes: (path: string) => number = plenty, extra: { release?: () => string; platform?: AppPlatform; reachTimeoutMs?: number } = {}) => {
		const { root } = fresh();
		const seen: string[] = [];
		const stage = preflightStage({ platform: extra.platform ?? "darwin", freeBytes, reachTimeoutMs: extra.reachTimeoutMs ?? 200, ...(extra.release ? { release: extra.release } : {}) });
		const engine = testEngine(root, () => [stage], { fetch: answering(down, seen) });
		const started = Date.now();
		await engine.engine.handle({ type: "run", config: { root, stack: realStack, secretPatterns: patterns, recipe } });
		const done = engine.events.find((e) => e.type === "done");
		const outcomes = Object.fromEntries((done?.type === "done" ? done.outcomes : []).map((o) => [o.stage, o]));
		return { result: { ok: done?.type === "done" && done.ok, outcomes, error: engine.events.find((e) => e.type === "error") ?? null }, seen, root, ms: Date.now() - started };
	};

	it("passes when every host answers, records itself, and asks each host with HEAD", async () => {
		const { result, seen, root } = await run(new Map(), NO_RECIPE);
		assert.equal(result.ok, true, JSON.stringify(result.error ?? result.outcomes));
		assert.equal(result.outcomes.preflight?.status, "skipped-verified");
		assert.ok(seen.every((s) => s.startsWith("HEAD ")), seen.join(","));
		const record = JSON.parse(readFileSync(join(root, "state", "bootstrap.json"), "utf8")).stages.preflight;
		assert.equal(record.status, "ok");
		assert.equal(record.warnings, undefined, "no recipe host, nothing to warn about");
		assert.match(record.evidence, /free; reached /);
	});

	it("is a warning, not a failure, when a recipe's forge host does not resolve: everything else still runs", async () => {
		const stackWithHost = stack;
		const { root } = fresh();
		const stage = preflightStage({ platform: "darwin", freeBytes: plenty, reachTimeoutMs: 200 });
		const recipe = { forges: [{ kind: "gitlab" as const, host: "gitlab.nowhere.invalid" }], tools: [] };
		const engine = testEngine(root, () => [stage, { ...stage, name: "after", needs: ["preflight"], recordDetect: false, detect: async () => null, install: async () => {}, verify: async () => ({ text: "after ran", version: "1" }), activate: async () => {} }], { fetch: answering(new Map([["gitlab.nowhere.invalid", "dns"]])) });
		const events = engine.events;
		await engine.engine.handle({ type: "run", config: { root, stack: stackWithHost, secretPatterns: JSON.parse(readFileSync(new URL("../../recipe/secret-patterns.json", import.meta.url), "utf8")), recipe } });
		const done = events.find((e) => e.type === "done");
		assert.ok(done?.type === "done" && done.ok, JSON.stringify(events.at(-1)));
		const outcomes = Object.fromEntries((done?.type === "done" ? done.outcomes : []).map((o) => [o.stage, o]));
		assert.equal(outcomes.preflight?.status, "skipped-verified");
		assert.equal(outcomes.after?.status, "installed", "the stages that need preflight run");
		const warning = outcomes.preflight?.warnings?.[0];
		assert.equal(warning?.kind, "forge-host-unreachable");
		assert.equal(warning?.host, "gitlab.nowhere.invalid");
		assert.equal(warning?.sentence, privateHostSentence("gitlab.nowhere.invalid"));
		assert.equal(privateHostSentence("h"), "Could not reach h; it may be reachable only on the company network, so connect to that network and try again.");
		const record = JSON.parse(readFileSync(join(root, "state", "bootstrap.json"), "utf8")).stages.preflight;
		assert.equal(record.status, "ok");
		assert.deepEqual(record.warnings, [warning], "recorded in state/bootstrap.json");
	});

	it("fails with the network-path wording, naming the host, when a download host is blackholed; one attempt, and quickly", async () => {
		const { result, ms } = await run(new Map([["nodejs.org", "path"]]), NO_RECIPE, plenty, { reachTimeoutMs: 300 });
		const outcome = result.outcomes.preflight;
		assert.equal(outcome?.status, "failed");
		assert.equal(outcome?.failure?.category, "network");
		assert.equal(outcome?.failure?.params.host, "nodejs.org");
		assert.match(outcome?.failure?.sentence ?? "", /^Could not reach nodejs\.org: something on the network path \(a VPN, a proxy, or a firewall\) may be blocking it\./);
		assert.equal(outcome?.attempts, 1, "no retry after the check waited");
		assert.ok(ms < 5000, `${ms} ms`);
	});

	it("names a proxy or certificate inspection when the issuer is unknown", async () => {
		const { result } = await run(new Map([["github.com", "tls"]]), NO_RECIPE);
		const outcome = result.outcomes.preflight;
		assert.equal(outcome?.failure?.params.cause, "tls");
		assert.match(outcome?.failure?.sentence ?? "", /a proxy or certificate inspection on this network presents a certificate this computer does not trust/);
	});

	it("a host that is both a download host and a recipe forge host is a failure (github.com), not a warning", async () => {
		const { result } = await run(new Map([["github.com", "dns"]]), { forges: [{ kind: "github", host: "github.com" }], tools: [] });
		assert.equal(result.outcomes.preflight?.status, "failed");
	});

	it("fails with the disk category below 3 GB, and with other on a Windows older than 1803", async () => {
		const low = await run(new Map(), NO_RECIPE, () => MIN_FREE_BYTES - 1);
		assert.equal(low.result.outcomes.preflight?.failure?.category, "disk");
		const old = await run(new Map(), NO_RECIPE, plenty, { platform: "win32", release: () => "10.0.17133" });
		assert.equal(old.result.outcomes.preflight?.failure?.category, "other");
		assert.match(old.result.outcomes.preflight?.failure?.detail ?? "", /1803/);
	});

	it("the requirement is 3 GB, and the check runs again on a second run (it is not cached)", async () => {
		assert.equal(MIN_FREE_BYTES, 3 * 1024 ** 3);
		const { root } = fresh();
		const seen: string[] = [];
		const stage = (): Stage => preflightStage({ platform: "darwin", freeBytes: plenty, reachTimeoutMs: 200 });
		const engine = testEngine(root, () => [stage()], { fetch: answering(new Map(), seen) });
		const a = await engine.run(stack);
		const first = seen.length;
		const b = await engine.run(stack);
		assert.equal(a.outcomes.preflight?.status, "skipped-verified");
		assert.equal(b.outcomes.preflight?.status, "skipped-verified");
		assert.ok(seen.length === first * 2 && first > 0, `${first} then ${seen.length} requests`);
	});
});

// ---- the stages that write the path files and launchers, with stand-in tools -----------------------------------------

/** A stage that "installs" a tool: scripts that print their version, in the folder layout the real archive has. */
function fakeTool(name: string, tool: string, version: string, installs: string[]): Stage {
	const exe = toolExecutable("darwin", tool);
	const script = tool === "gh" ? `echo "gh version ${version} (fake)"` : tool === "glab" ? `echo "glab ${version} (fake)"` : tool === "bun" ? `echo "${version}"` : `echo "${tool} ${version}"`;
	const stagingOf = (ctx: StageContext): string => `${installDir(ctx.layout, tool, version)}.staging`;
	return {
		name,
		needs: [],
		plannedVersion: () => version,
		detect: (ctx) => detectFromRecord(ctx, { version, tool }),
		async install(ctx) {
			installs.push(`${name} ${version}`);
			const dir = ctx.freshStaging(stagingOf(ctx));
			const file = join(dir, ...exe.split("/"));
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
		},
		async verify(ctx) {
			const final = fileKey(ctx.layout, join(installDir(ctx.layout, tool, version), ...exe.split("/")));
			return { text: `${tool} ${version}`, version, files: [final], stagedFiles: { [final]: join(stagingOf(ctx), ...exe.split("/")) } };
		},
		async activate(ctx, evidence) {
			await activateDir(ctx, { tool, version: evidence.version, staging: stagingOf(ctx) });
		},
	};
}

interface Setup {
	gh: string;
	bun: string | null;
	clis: Array<"gh" | "glab">;
}

describe("tool-paths and launchers with stand-in tools (POSIX)", { skip: posixOnly }, () => {
	const platform: AppPlatform = "darwin";
	const stages = (setup: Setup, installs: string[]): Stage[] => {
		const enabled = { clis: setup.clis, optional: setup.bun === null ? [] : ["bun"] };
		return [
			fakeTool("node", "node", "24.22.1", installs),
			fakeTool("git", "git", "2.56.0-2", installs),
			fakeTool("herdr", "herdr", "0.9.5", installs),
			...setup.clis.map((cli) => fakeTool(cli, cli, cli === "gh" ? setup.gh : "1.124.0", installs)),
			...(setup.bun === null ? [] : [fakeTool("opt:bun", "bun", setup.bun, installs)]),
			toolPathsStage(platform, enabled),
			launchersStage(platform, enabled, ["bun"]),
		];
	};
	const status = (run: Awaited<ReturnType<typeof runEngine>>, ...names: string[]): string[] => names.map((n) => `${n}:${run.outcomes[n]?.status}`);
	const bin = (root: string, name: string): string => join(root, "tools", "bin", name);
	const say = (root: string, name: string, ...args: string[]): string => execFileSync(bin(root, name), args, { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" }).trim();
	const currentOf = (root: string): Record<string, any> => JSON.parse(readFileSync(join(root, "state", "current.json"), "utf8"));

	it("a recipe that names no tool: no opt:bun stage or record, no tools/bun, no bun launcher, no SBD_BUN", async () => {
		const { root } = fresh();
		const installs: string[] = [];
		const run = await runEngine(root, makeStack({}), stages({ gh: "2.103.3", bun: null, clis: ["gh"] }, installs));
		assert.equal(run.ok, true, JSON.stringify(run.error ?? run.outcomes));
		assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(root, "state", "bootstrap.json"), "utf8")).stages).filter((s) => s.startsWith("opt:")), []);
		assert.equal(existsSync(join(root, "tools", "bun")), false);
		assert.deepEqual(readdirSync(join(root, "tools", "bin")).sort(), ["gh", "paths.sh"]);
		assert.ok(!readFileSync(bin(root, "paths.sh"), "utf8").includes("SBD_BUN"));
		assert.equal(say(root, "gh", "--version"), "gh version 2.103.3 (fake)");
		assert.deepEqual(leftovers(root), []);
	});

	it("no forge and no tool: the launchers stage has nothing to write and still passes", async () => {
		const { root } = fresh();
		const run = await runEngine(root, makeStack({}), stages({ gh: "2.103.3", bun: null, clis: [] }, []));
		assert.equal(run.ok, true, JSON.stringify(run.error ?? run.outcomes));
		assert.equal(run.outcomes.launchers?.evidence, "no launchers (the recipe names no code host and no optional tool)");
		assert.deepEqual(readdirSync(join(root, "tools", "bin")), ["paths.sh"]);
	});

	it("a second run is all skipped-verified", async () => {
		const { root } = fresh();
		const installs: string[] = [];
		const setup: Setup = { gh: "2.103.3", bun: "1.2.23", clis: ["gh", "glab"] };
		const first = await runEngine(root, makeStack({}), stages(setup, installs));
		assert.equal(first.ok, true, JSON.stringify(first.error ?? first.outcomes));
		const again = await runEngine(root, makeStack({}), stages(setup, installs));
		for (const outcome of Object.values(again.outcomes)) assert.equal(outcome.status, "skipped-verified", outcome.stage);
	});

	it("a gh pin change installs the new gh beside the old one, rewrites tool-paths, leaves the launchers verified, and the launcher runs the new gh", async () => {
		const { root } = fresh();
		const installs: string[] = [];
		await runEngine(root, makeStack({}), stages({ gh: "2.103.3", bun: null, clis: ["gh"] }, installs));
		assert.match(say(root, "gh", "--version"), /2\.103\.3/);
		const launcherBefore = readFileSync(bin(root, "gh"), "utf8");

		const run = await runEngine(root, makeStack({}), stages({ gh: "2.103.4", bun: null, clis: ["gh"] }, installs));
		assert.deepEqual(status(run, "gh", "tool-paths", "launchers", "node"), ["gh:installed", "tool-paths:installed", "launchers:skipped-verified", "node:skipped-verified"]);
		assert.deepEqual(readdirSync(join(root, "tools", "gh")).sort(), ["2.103.3", "2.103.4"]);
		assert.equal(readFileSync(bin(root, "gh"), "utf8"), launcherBefore, "the launcher file did not change");
		assert.match(say(root, "gh", "--version"), /2\.103\.4/);
		assert.equal(currentOf(root).versions.gh, "2.103.4");
		assert.equal(currentOf(root).previous.gh, "2.103.3");
		// The same file twice: the prune of inactive versions (after a successful start) removes the old gh.
		const pruned = await new StateStore(testLayout(root)).pruneInactive("gh", testPlatform().processes);
		assert.deepEqual(pruned, []);
		assert.deepEqual(readdirSync(join(root, "tools", "gh")), ["2.103.4"]);
	});

	it("dropping bun from the recipe leaves tools/bun in place, rewrites tool-paths and launchers, and the launcher is gone", async () => {
		const { root } = fresh();
		const installs: string[] = [];
		const withBun: Setup = { gh: "2.103.3", bun: "1.2.23", clis: ["gh"] };
		const first = await runEngine(root, makeStack({}), stages(withBun, installs));
		assert.equal(first.ok, true, JSON.stringify(first.error ?? first.outcomes));
		assert.deepEqual(readdirSync(join(root, "tools", "bin")).sort(), ["bun", "bunx", "gh", "paths.sh"]);
		assert.match(readFileSync(bin(root, "paths.sh"), "utf8"), /SBD_BUN=/);
		assert.equal(say(root, "bun", "--version"), "1.2.23");
		assert.equal(say(root, "bunx", "--version"), "1.2.23");

		const dropped = await runEngine(root, makeStack({}), stages({ ...withBun, bun: null }, installs));
		assert.deepEqual(status(dropped, "tool-paths", "launchers", "gh"), ["tool-paths:installed", "launchers:installed", "gh:skipped-verified"]);
		assert.equal(existsSync(join(root, "tools", "bun", "1.2.23", "bun")), true, "the folder stays on disk");
		assert.deepEqual(readdirSync(join(root, "tools", "bin")).sort(), ["gh", "paths.sh"], "the bun launchers are deleted");
		assert.ok(!readFileSync(bin(root, "paths.sh"), "utf8").includes("SBD_BUN"));
		assert.equal(currentOf(root).versions.bun, "1.2.23", "current.json keeps a dropped tool's version (FE2R-F001)");
		assert.deepEqual(leftovers(root), []);

		// A full successful start prunes inactive versions: the folder current.json names stays, dropped or not.
		const pruned = await new StateStore(testLayout(root)).pruneInactive("bun", testPlatform().processes);
		assert.deepEqual(pruned, []);
		assert.equal(existsSync(join(root, "tools", "bun", "1.2.23", "bun")), true);

		// Naming it again needs no download: opt:bun finds the verified folder, and the two stages are written again.
		const before = installs.filter((i) => i.startsWith("opt:bun")).length;
		const back = await runEngine(root, makeStack({}), stages(withBun, installs));
		assert.deepEqual(status(back, "opt:bun", "tool-paths", "launchers"), ["opt:bun:skipped-verified", "tool-paths:installed", "launchers:installed"]);
		assert.equal(installs.filter((i) => i.startsWith("opt:bun")).length, before, "bun was not installed again");
		assert.equal(say(root, "bun", "--version"), "1.2.23");
		assert.match(readFileSync(bin(root, "paths.sh"), "utf8"), /SBD_BUN=/);
	});

	it("a new bun pin installs beside the old one and the launcher runs the new one; the old one goes with the prune", async () => {
		const { root } = fresh();
		const installs: string[] = [];
		await runEngine(root, makeStack({}), stages({ gh: "2.103.3", bun: "1.2.23", clis: [] }, installs));
		const run = await runEngine(root, makeStack({}), stages({ gh: "2.103.3", bun: "1.2.24", clis: [] }, installs));
		assert.deepEqual(status(run, "opt:bun", "tool-paths", "launchers"), ["opt:bun:installed", "tool-paths:installed", "launchers:skipped-verified"]);
		assert.deepEqual(readdirSync(join(root, "tools", "bun")).sort(), ["1.2.23", "1.2.24"]);
		assert.equal(say(root, "bun", "--version"), "1.2.24");
		const pruned = await new StateStore(testLayout(root)).pruneInactive("bun", testPlatform().processes);
		assert.deepEqual(pruned, []);
		assert.deepEqual(readdirSync(join(root, "tools", "bun")), ["1.2.24"]);
	});

	it("rewrites a launcher or a paths file that someone changed", async () => {
		const { root } = fresh();
		const setup: Setup = { gh: "2.103.3", bun: null, clis: ["gh"] };
		await runEngine(root, makeStack({}), stages(setup, []));
		writeFileSync(bin(root, "gh"), "#!/bin/sh\necho tampered\n", { mode: 0o755 });
		const run = await runEngine(root, makeStack({}), stages(setup, []));
		assert.equal(run.outcomes.launchers?.status, "installed");
		assert.match(say(root, "gh", "--version"), /gh version 2\.103\.3/);
		writeFileSync(bin(root, "paths.sh"), "SBD_GH=/elsewhere\n");
		const again = await runEngine(root, makeStack({}), stages(setup, []));
		assert.equal(again.outcomes["tool-paths"]?.status, "installed");
		assert.match(readFileSync(bin(root, "paths.sh"), "utf8"), /SBD_GH="\$SBD_APP_ROOT\/tools\/gh\/2\.103\.3\/bin\/gh"/);
	});

	it("deletes a launcher that came back for a tool the recipe does not name", async () => {
		const { root } = fresh();
		const setup: Setup = { gh: "2.103.3", bun: null, clis: ["gh"] };
		await runEngine(root, makeStack({}), stages(setup, []));
		writeFileSync(bin(root, "bun"), "#!/bin/sh\necho stray\n", { mode: 0o755 });
		const run = await runEngine(root, makeStack({}), stages(setup, []));
		assert.equal(run.outcomes.launchers?.status, "installed");
		assert.equal(existsSync(bin(root, "bun")), false);
	});

	it("a launcher whose tool prints another version fails the stage and writes nothing into tools/bin", async () => {
		const { root } = fresh();
		const liar = fakeTool("gh", "gh", "2.103.3", []);
		const lying: Stage = {
			...liar,
			async install(ctx) {
				await liar.install(ctx);
				writeFileSync(join(`${installDir(ctx.layout, "gh", "2.103.3")}.staging`, "bin", "gh"), '#!/bin/sh\necho "gh version 0.0.1"\n', { mode: 0o755 });
			},
		};
		const all = stages({ gh: "2.103.3", bun: null, clis: ["gh"] }, []).map((s) => (s.name === "gh" ? lying : s));
		const run = await runEngine(root, makeStack({}), all);
		assert.equal(run.outcomes.launchers?.status, "failed");
		assert.match(run.outcomes.launchers?.failure?.detail ?? "", /reports "gh version 0\.0\.1", the pin is 2\.103\.3/);
		assert.deepEqual(readdirSync(join(root, "tools", "bin")), ["paths.sh"], "no launcher was put in place");
		assert.deepEqual(leftovers(root), []);
	});
});

describe("git-helpers detect", () => {
	it("a stage for no forge has the tag `none`, and one for a host names it", () => {
		const a = gitHelpersStage("darwin", []);
		const b = gitHelpersStage("darwin", [{ kind: "github", host: "github.com" }]);
		assert.equal(a.plannedVersion?.({} as StageContext), "format 1; hosts none");
		assert.equal(b.plannedVersion?.({} as StageContext), "format 1; hosts github.com");
		assert.deepEqual([...a.needs], ["git", "launchers"]);
	});
});

describe("the optional tool stage", () => {
	it("is built for a tool this version knows and refuses one it does not", () => {
		const stage = optionalToolStage("darwin", "bun");
		assert.equal(stage.name, "opt:bun");
		assert.deepEqual([...stage.needs], ["preflight"]);
		assert.throws(() => optionalToolStage("darwin", "deno"), /no stage for/);
		assert.deepEqual(OPTIONAL_TOOLS.bun?.executables("win32"), ["bun.exe"]);
		assert.deepEqual(OPTIONAL_TOOLS.bun?.executables("darwin"), ["bun"]);
	});
});

describe("the engine's recipe configuration", () => {
	const patterns = JSON.parse(readFileSync(new URL("../../recipe/secret-patterns.json", import.meta.url), "utf8")) as unknown;
	const stack = parseStack(realStack);

	it("hands the stage factory the recipe's forges and tools, the stack, and the layout's platform", async () => {
		const { root } = fresh();
		const seen: unknown[] = [];
		const engine = testEngine(root, () => [], {
			stages: (s, recipe, platform) => {
				seen.push({ generation: s.generation, recipe, platform });
				return [];
			},
		});
		await engine.engine.handle({ type: "run", config: { root, stack: realStack, secretPatterns: patterns, recipe: { forges: [{ kind: "gitlab", host: "G.Example" }], tools: ["bun"] } } });
		assert.deepEqual(seen, [{ generation: stack.generation, recipe: { forges: [{ kind: "gitlab", host: "g.example" }], tools: ["bun"] }, platform: process.platform === "win32" ? "win32" : "darwin" }]);
		await engine.engine.handle({ type: "run", config: { root, stack: realStack, secretPatterns: patterns } });
		assert.deepEqual((seen[1] as { recipe: unknown }).recipe, NO_RECIPE, "no recipe is no forge and no tool");
	});

	it("refuses a recipe tool the stack does not list before any stage runs", async () => {
		const { root } = fresh();
		const engine = testEngine(root, () => []);
		await engine.engine.handle({ type: "run", config: { root, stack: realStack, secretPatterns: patterns, recipe: { tools: ["deno"] } } });
		const error = engine.events.find((e) => e.type === "error");
		assert.ok(error?.type === "error");
		assert.equal(error.name, "StackError");
		assert.ok(!engine.events.some((e) => e.type === "stage-start"));
	});
});

const withManagedFilesFor = (stage: Stage, file: string): Stage => withManagedFiles(stage, () => [{ path: file, text: "managed text\n" }]);

describe("a stage's managed files", () => {
	it("are rewritten when someone changes them, and the stage reports installed again", async () => {
		const { root } = fresh();
		const file = join(root, "config", "managed.txt");
		const stage = (): Stage => withManagedFilesFor(toolStage("alpha-managed"), file);
		const server = new FixtureServer();
		await server.listen();
		try {
			const pkg = publish(server, "alpha-managed", { version: "1.0.0" });
			const stack2 = makeStack({ "alpha-managed": pkg });
			const first = await runEngine(root, stack2, [stage()]);
			assert.equal(first.outcomes["alpha-managed"]?.status, "installed");
			assert.equal(readFileSync(file, "utf8"), "managed text\n");
			assert.equal((await runEngine(root, stack2, [stage()])).outcomes["alpha-managed"]?.status, "skipped-verified");
			writeFileSync(file, "changed by someone\n");
			const again = await runEngine(root, stack2, [stage()]);
			assert.equal(again.outcomes["alpha-managed"]?.status, "installed");
			assert.equal(readFileSync(file, "utf8"), "managed text\n");
			assert.equal(server.hits(pkg.path), 1, "the archive came from the cache");
		} finally {
			await server.close();
		}
	});
});

describe("liftSingleFolder", () => {
	it("moves the contents of a lone top folder up, and leaves other layouts alone", () => {
		const { base } = fresh();
		const a = join(base, "a");
		mkdirSync(join(a, "bun-darwin-aarch64"), { recursive: true });
		writeFileSync(join(a, "bun-darwin-aarch64", "bun"), "x");
		liftSingleFolder(a, "bun");
		assert.deepEqual(readdirSync(a), ["bun"]);

		const b = join(base, "b");
		mkdirSync(join(b, "bin"), { recursive: true });
		writeFileSync(join(b, "bin", "gh"), "x");
		writeFileSync(join(b, "LICENSE"), "x");
		liftSingleFolder(b, "bin/gh");
		assert.deepEqual(readdirSync(b).sort(), ["LICENSE", "bin"], "two entries: not a lone folder");

		const c = join(base, "c");
		mkdirSync(join(c, "top", "bin"), { recursive: true });
		writeFileSync(join(c, "top", "bin", "gh"), "x");
		liftSingleFolder(c, "bin/gh");
		assert.deepEqual(readdirSync(join(c, "bin")), ["gh"]);

		const d = join(base, "d");
		mkdirSync(join(d, "top"), { recursive: true });
		writeFileSync(join(d, "top", "other"), "x");
		liftSingleFolder(d, "bin/gh");
		assert.deepEqual(readdirSync(d), ["top"], "the probe is not inside: nothing moves");
	});
});
