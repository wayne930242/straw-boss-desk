import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { engineRecipeOf } from "../src/main/bootstrap/recipe-config.ts";
import { parseStack, StackError } from "../src/main/bootstrap/stack.ts";
import { GitconfigBlockError, configValue, hasBlock, readGitconfig, removeBlock, upsertBlock } from "../src/main/bootstrap/stages/gitconfig.ts";
import { FORGE_LAUNCHERS, LAUNCHER_UNSET, launcherFiles, shLauncher } from "../src/main/bootstrap/stages/launcher-files.ts";
import { HELPERS_BLOCK, helperCommand, helpersBody } from "../src/main/bootstrap/stages/paths-launchers.ts";

// The cases of the kit's `spike/win/test/forge-cli.test.mjs` that the port in task 5 did not carry over (spec: Tasks 7, "the kit's node tests for the forge
// module, moved"). The launcher text, the unset list, the telemetry switches, the `paths.sh` contract and the stages are covered in `tool-stages.test.ts`
// and `launchers-windows.test.ts`; what is here is the kit's run-time behavior of the POSIX launcher, its pin checks, its host checks, and its Git
// reading of the credential block.
//
// Not ported, on purpose: "one CLI serves one host". The kit refused a second forge of the same kind; the app's launchers serve every host of their CLI
// (gh and glab keep one configuration folder for all of them), the recipe validator refuses a repeated host, and the block gets one section per host.

const isWindows = process.platform === "win32";
const platform = isWindows ? "win32" : "darwin";
const realStack = JSON.parse(readFileSync(new URL("../../stack.json", import.meta.url), "utf8")) as { tools: Record<string, { assets: Record<string, { version: string; url: string; sha256: string; file: string }> }> };

/** A POSIX shell that can run the launcher: `/bin/sh`, or on Windows Git's own `sh.exe` (`SBD_SH`, else the runner's Git for Windows). */
function findSh(): string | null {
	if (!isWindows) return "/bin/sh";
	const candidates = [process.env.SBD_SH, "C:\\Program Files\\Git\\bin\\sh.exe", "C:\\Program Files\\Git\\usr\\bin\\sh.exe"];
	return candidates.find((c): c is string => c !== undefined && existsSync(c)) ?? null;
}
const sh = findSh();
const shSkip = sh === null ? "no POSIX sh on this machine (Git for Windows' sh.exe or SBD_SH)" : false;

const gitWorks = ((): boolean => {
	try {
		return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
	} catch {
		return false;
	}
})();

/** Every variable the launchers must remove, set to a dummy value; KEEP passes through. Never a real token. */
const DUMMY_ENV: Record<string, string> = { ...Object.fromEntries(LAUNCHER_UNSET.map((k) => [k, `dummy-${k.toLowerCase()}`])), KEEP: "yes" };

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "forge-kit-"));
});
// Windows keeps a copy of node.exe (the stand-in gh.exe) locked for a moment after it ran, so removal is retried.
afterEach(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

/** An app root with a space and CJK characters in it, like C:\Users\測試PM\AppData\Local\straw-boss-desk. */
function appRoot(name = "測試PM app"): { root: string; tools: string; bin: string } {
	const root = join(tmp, name);
	const bin = join(root, "tools", "bin");
	mkdirSync(bin, { recursive: true });
	return { root, tools: join(root, "tools"), bin };
}

const forwardSlashes = (p: string): string => p.split("\\").join("/");

/**
 * Writes the launchers for `specs` into `bin`, and a `paths.sh` that names a stand-in for the pinned binary (the launcher reads it the way the product's
 * `tool-paths` stage writes it). The stand-in prints what a real one would be able to see: its arguments, its environment, its standard input.
 */
function setup(bin: string, cli: "gh" | "glab", body?: string): string {
	const spec = FORGE_LAUNCHERS[cli];
	for (const [name, text] of Object.entries(launcherFiles("darwin", [spec]))) writeFileSync(join(bin, name), text, { mode: 0o755 });
	const real = join(dirname(bin), `${cli}-real${isWindows ? ".exe" : ""}`);
	if (isWindows) {
		copyFileSync(process.execPath, real);
		writeFileSync(join(dirname(bin), "dump.js"), 'console.log(Object.entries(process.env).map(([k, v]) => k + "=" + v).join("\\n")); console.log("ARGC:" + process.argv.length);\n');
	} else {
		writeFileSync(real, body ?? '#!/bin/sh\nprintf "ARGS:"; for a in "$@"; do printf "[%s]" "$a"; done; echo\nenv | sort\nif [ ! -t 0 ]; then printf "STDIN:"; cat; fi\n', { mode: 0o755 });
		chmodSync(real, 0o755);
	}
	writeFileSync(join(bin, "paths.sh"), `${spec.pathVar}="${forwardSlashes(real)}"\n`);
	return real;
}

const envOf = (out: string): Record<string, string> =>
	Object.fromEntries(
		out
			.split("\n")
			.filter((l) => /^[A-Z_]+=/.test(l))
			.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/\r$/, "")]),
	);
/** The same folder by two spellings (8.3 names, case, separators, a link in the temp folder's path); the folder itself need not exist. */
const samePath = (a: string, b: string): boolean => {
	const norm = (p: string): string => {
		const rest: string[] = [];
		let at = p;
		while (!existsSync(at) && dirname(at) !== at) {
			rest.unshift(at.slice(dirname(at).length).replace(/^[\\/]/, ""));
			at = dirname(at);
		}
		const real = isWindows ? realpathSync.native(at).toLowerCase() : realpathSync(at);
		return [real, ...(isWindows ? rest.map((r) => r.toLowerCase()) : rest)].join("/").split("\\").join("/");
	};
	return norm(a) === norm(b);
};

describe("the pins of gh and glab (kit: pins)", () => {
	for (const cli of ["gh", "glab"]) {
		it(`${cli}: every platform entry has a 64-digit SHA256, a file name that matches its URL and the version, and no two share bytes`, () => {
			const assets = Object.entries((realStack.tools[cli] as { assets: Record<string, { version: string; url: string; sha256: string; file: string }> }).assets);
			assert.deepEqual(assets.map(([key]) => key).sort(), ["darwin-arm64", "darwin-x64", "win32-x64"]);
			const version = assets[0]?.[1].version as string;
			assert.match(version, /^\d+\.\d+\.\d+$/);
			for (const [key, asset] of assets) {
				assert.equal(asset.version, version, key);
				assert.match(asset.sha256, /^[0-9a-f]{64}$/, key);
				assert.ok(asset.url.endsWith(`/${asset.file}`), `${cli} ${key}: url ends with file`);
				assert.ok(asset.file.includes(`_${version}_`), `${cli} ${key}: file names the version`);
			}
			assert.equal(new Set(assets.map(([, a]) => a.sha256)).size, assets.length, "each platform has its own bytes");
		});
	}

	it("pins the versions the spec names, and parseStack refuses an entry with a missing SHA256", () => {
		assert.equal(realStack.tools.gh?.assets["win32-x64"]?.version, "2.103.3");
		assert.equal(realStack.tools.glab?.assets["win32-x64"]?.version, "1.124.0");
		const broken = structuredClone(realStack) as any;
		delete broken.tools.gh.assets["win32-x64"].sha256;
		assert.throws(() => parseStack(broken), StackError);
	});
});

describe("a forge host in the recipe (kit: parseForge)", () => {
	const stack = parseStack(JSON.parse(readFileSync(new URL("../../stack.json", import.meta.url), "utf8")));

	it("accepts the two kinds with a plain host, lower-cased, with a port", () => {
		const forges = (...hosts: Array<[string, string]>): unknown => ({ forges: hosts.map(([kind, host]) => ({ kind, host })) });
		assert.deepEqual(engineRecipeOf(forges(["github", "GitHub.com"]), stack).forges, [{ kind: "github", host: "github.com" }]);
		assert.deepEqual(engineRecipeOf(forges(["gitlab", "gitlab.moldplan.app"]), stack).forges, [{ kind: "gitlab", host: "gitlab.moldplan.app" }]);
		assert.deepEqual(engineRecipeOf(forges(["gitlab", "git.example.org:8443"]), stack).forges, [{ kind: "gitlab", host: "git.example.org:8443" }]);
	});

	it("refuses anything that could put text into the Git configuration, and a kind that is neither github nor gitlab", () => {
		for (const host of ["", "a b.com", "a.com\n[core]", 'a".com', "a.com/path", "https://a.com", "-a.com", "a..com", "a.com'", "a.com;rm"]) {
			assert.throws(() => engineRecipeOf({ forges: [{ kind: "github", host }] }, stack), StackError, JSON.stringify(host));
		}
		assert.throws(() => engineRecipeOf({ forges: [{ kind: "gitea", host: "x.com" }] }, stack), StackError);
	});

	it("a host with a port gets its own section, and two hosts of one kind get two (the app's launcher serves every host of its CLI)", () => {
		const body = helpersBody("darwin", "/r/tools/bin", [{ kind: "gitlab", host: "gitlab.a.test" }, { kind: "gitlab", host: "gitlab.b.test:8443" }]);
		assert.equal(body.split("[credential ").length - 1, 2);
		assert.ok(body.includes('[credential "https://gitlab.b.test:8443"]'));
	});
});

describe("the POSIX launcher at run time (kit: the POSIX launcher at run time)", { skip: shSkip }, () => {
	// Git starts a helper command through sh with a forward-slash path (posixPath in helperCommand), so the test does too.
	const run = (launcher: string, args: string[], env: Record<string, string>, input?: string, cwd?: string) =>
		spawnSync(sh as string, [forwardSlashes(launcher), ...args], { encoding: "utf8", ...(input !== undefined ? { input } : {}), ...(cwd ? { cwd } : {}), env: { PATH: process.env.PATH ?? "", HOME: tmp, ...env } });

	for (const cli of ["gh", "glab"] as const) {
		it(`${cli}: sets the config folder under the app root and the no-prompt variables, removes CI, GITLAB_CI and the token and host variables, keeps the arguments and standard input`, () => {
			const { root, bin } = appRoot();
			setup(bin, cli);
			const args = isWindows ? [forwardSlashes(join(dirname(bin), "dump.js")), "x y"] : ["auth", "login", "--hostname", "x y", "--stdin"];
			const r = run(join(bin, cli), args, DUMMY_ENV, "secret-on-stdin\n");
			assert.equal(r.status, 0, r.stderr);
			const env = envOf(r.stdout);
			const spec = FORGE_LAUNCHERS[cli];
			assert.ok(samePath(env[spec.config?.variable as string] as string, join(root, "config", spec.config?.folder as string)), `${spec.config?.variable}=${env[spec.config?.variable as string]}`);
			for (const [k, v] of spec.env) assert.equal(env[k], v, k);
			for (const k of LAUNCHER_UNSET) assert.equal(env[k], undefined, `${k} is removed`);
			assert.equal(env.KEEP, "yes", "other variables pass through");
			if (!isWindows) {
				assert.ok(r.stdout.includes("ARGS:[auth][login][--hostname][x y][--stdin]"));
				assert.ok(r.stdout.includes("STDIN:secret-on-stdin"));
			} else {
				assert.match(r.stdout, /ARGC:3\r?$/m, "the binary got its argument, `x y` as one");
			}
		});
	}

	it("works when started through PATH from another folder, and not only by its full path", { skip: isWindows }, () => {
		const { bin } = appRoot();
		setup(bin, "gh");
		const r = spawnSync("gh", ["--version"], { encoding: "utf8", cwd: tmp, env: { PATH: `${bin}:${process.env.PATH ?? ""}`, CI: "1" } });
		assert.equal(r.status, 0, r.stderr);
		// A gh of the machine would also exit 0 with no CI line: the stand-in's own ARGS line says it was the one that ran (T7-F012 c).
		assert.ok(r.stdout.includes("ARGS:[--version]"), `the app's stand-in ran, not a gh from the machine: ${r.stdout.slice(0, 120)}`);
		assert.equal(envOf(r.stdout).CI, undefined);
	});

	it("a relative start with CDPATH set still finds its own folder (R-F010)", { skip: isWindows }, () => {
		const { root, bin } = appRoot();
		setup(bin, "gh");
		// CDPATH names a folder that has its own "bin": without CDPATH= the launcher's `cd bin` would go there and print its path into $d.
		const decoy = join(tmp, "decoy");
		mkdirSync(join(decoy, "bin"), { recursive: true });
		const r = spawnSync("/bin/sh", ["bin/gh", "--version"], { encoding: "utf8", cwd: join(root, "tools"), env: { PATH: process.env.PATH ?? "", CDPATH: decoy } });
		assert.equal(r.status, 0, r.stderr);
		assert.equal(envOf(r.stdout).GH_CONFIG_DIR, `${realpathSync(root)}/config/gh`);
	});

	it("passes the exit status of the binary on", { skip: isWindows }, () => {
		const { bin } = appRoot();
		setup(bin, "gh", "#!/bin/sh\nexit 7\n");
		assert.equal(run(join(bin, "gh"), [], {}).status, 7);
	});

	it("the launcher text keeps cd from following CDPATH and uses no bare cd", () => {
		const text = shLauncher(FORGE_LAUNCHERS.gh);
		assert.ok(text.includes('CDPATH= cd -- "$d"') && text.includes('CDPATH= cd -- "$d/../.."'), "cd ignores CDPATH");
		assert.ok(!/\bcd "/.test(text), "no bare cd");
		assert.ok(text.startsWith("#!/bin/sh\n") && !text.includes("\r"));
	});
});

describe("credential helpers in the private Git configuration (kit: credential helpers)", () => {
	const both = [{ kind: "github" as const, host: "github.com" }, { kind: "gitlab" as const, host: "gitlab.moldplan.app" }];
	// Absolute on the machine that runs the test, so Windows resolves "/Users/..." to a drive path and expects it.
	const tools = isWindows ? "C:\\Users\\x\\AppData\\Local\\straw-boss-desk\\tools" : "/Users/x/Library/Application Support/straw-boss-desk/tools";
	const posixTools = isWindows ? "C:/Users/x/AppData/Local/straw-boss-desk/tools" : tools;

	it("writes the empty helper first, then the launcher, for each host (exact text)", () => {
		assert.equal(
			helpersBody(platform, join(tools, "bin"), both),
			[
				'[credential "https://github.com"]',
				"\thelper =",
				`\thelper = !'${posixTools}/bin/gh' auth git-credential`,
				'[credential "https://gitlab.moldplan.app"]',
				"\thelper =",
				`\thelper = !'${posixTools}/bin/glab' auth git-credential`,
			].join("\n"),
		);
	});

	it("quotes only what needs it", () => {
		assert.equal(configValue("!'/a b/gh' auth git-credential"), "!'/a b/gh' auth git-credential");
		assert.equal(configValue("a;b"), '"a;b"');
		assert.equal(configValue("a#b"), '"a#b"');
		assert.equal(configValue('a"b'), '"a\\"b"');
		assert.equal(configValue("a\\b"), '"a\\\\b"');
		assert.equal(configValue(" edge"), '" edge"');
	});

	it("turns a Windows path into forward slashes and single-quotes it for sh", () => {
		assert.equal(helperCommand("win32", "C:\\Users\\測試PM\\AppData\\Local\\straw-boss-desk\\tools\\bin\\gh"), "!'C:/Users/測試PM/AppData/Local/straw-boss-desk/tools/bin/gh' auth git-credential");
	});

	// The strongest check available on any machine: let Git itself read the file, then let sh run what Git would run.
	for (const dirName of ["測試PM app", "plain", "it's #1; \"quoted\" 測試", "back\\slash"]) {
		if (isWindows && /[\\"]/.test(dirName)) continue; // not valid in a Windows file name
		it(`Git reads the block back as an empty helper and the launcher command; sh runs it (folder '${dirName}')`, { skip: gitWorks ? false : "no git on the PATH" }, () => {
			const { bin } = appRoot(dirName);
			const file = join(tmp, "gitconfig");
			upsertBlock(file, HELPERS_BLOCK, helpersBody(platform, bin, both), "last");
			const git = (args: string[]) => spawnSync("git", ["config", "--file", file, ...args], { encoding: "utf8" });
			for (const [host, cli] of [["github.com", "gh"], ["gitlab.moldplan.app", "glab"]] as const) {
				const r = git(["--get-all", `credential.https://${host}.helper`]);
				assert.equal(r.status, 0, r.stderr);
				const values = r.stdout.replace(/\r\n/g, "\n").split("\n").slice(0, -1);
				assert.equal(values.length, 2, r.stdout);
				assert.equal(values[0], "", "the empty entry comes first");
				assert.ok((values[1] as string).startsWith("!'"));
				assert.ok((values[1] as string).endsWith(`/bin/${cli}' auth git-credential`) || (values[1] as string).includes("'\\''"), String(values[1]));
				assert.equal(values[1], helperCommand(platform, join(bin, cli)), "Git reads back exactly the command the app wrote");
				if (!isWindows) {
					// Run it as Git does: sh -c "<command without the !> get", with a launcher that echoes its arguments.
					writeFileSync(join(bin, cli), '#!/bin/sh\necho "got:$*"\n');
					chmodSync(join(bin, cli), 0o755);
					const ran = spawnSync("/bin/sh", ["-c", `${(values[1] as string).slice(1)} get`], { encoding: "utf8" });
					assert.equal(ran.stdout.trim(), "got:auth git-credential get", ran.stderr);
				}
			}
		});
	}

	it("is idempotent, keeps the user's lines, and moves the block behind a general helper written later", () => {
		const file = join(tmp, "gitconfig");
		const body = helpersBody(platform, join(tools, "bin"), both);
		writeFileSync(file, "[user]\n\tname = Spike PM\n[credential]\n\thelper = manager\n");
		upsertBlock(file, HELPERS_BLOCK, body, "last");
		upsertBlock(file, HELPERS_BLOCK, body, "last");
		let text = readGitconfig(file);
		assert.equal(text.split(">>> straw-boss").length - 1, 1);
		assert.ok(text.startsWith("[user]\n\tname = Spike PM\n[credential]\n\thelper = manager\n# >>>"));
		assert.equal(hasBlock(file, HELPERS_BLOCK, body, "last"), true);
		// the git stage runs later and appends a general section after the block
		writeFileSync(file, `${text}[credential]\n\thelper = manager\n`);
		assert.equal(hasBlock(file, HELPERS_BLOCK, body, "last"), false);
		upsertBlock(file, HELPERS_BLOCK, body, "last");
		text = readGitconfig(file);
		assert.ok(text.trimEnd().endsWith("# <<< straw-boss forge credential helpers"));
		assert.equal(text.split("helper = manager").length - 1, 2);
		assert.equal(hasBlock(file, HELPERS_BLOCK, body, "last"), true);
	});

	it("reads CRLF and a BOM, writes UTF-8 with LF and no BOM, and replaces a block for other hosts", () => {
		const file = join(tmp, "gitconfig");
		writeFileSync(file, "﻿[user]\r\n\tname = 測試\r\n");
		upsertBlock(file, HELPERS_BLOCK, helpersBody(platform, join(tools, "bin"), [both[0] as (typeof both)[number]]), "last");
		upsertBlock(file, HELPERS_BLOCK, helpersBody(platform, join(tools, "bin"), both), "last");
		const bytes = readFileSync(file);
		assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
		const text = bytes.toString("utf8");
		assert.ok(!text.includes("\r") && text.includes("name = 測試"));
		assert.ok(text.includes("gitlab.moldplan.app") && text.split("github.com").length === 2);
	});

	it("refuses a block that lost its end line instead of cutting the file, and leaves the file as it was", () => {
		const file = join(tmp, "gitconfig");
		const body = helpersBody(platform, join(tools, "bin"), both);
		upsertBlock(file, HELPERS_BLOCK, body, "last");
		const broken = readFileSync(file, "utf8").replace(/# <<<.*\n/, "");
		writeFileSync(file, broken);
		assert.throws(() => upsertBlock(file, HELPERS_BLOCK, body, "last"), GitconfigBlockError);
		assert.throws(() => removeBlock(file, HELPERS_BLOCK), /no end line/);
		assert.equal(readFileSync(file, "utf8"), broken);
	});
});
