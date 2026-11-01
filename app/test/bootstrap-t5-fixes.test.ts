import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fdRgStage } from "../src/main/bootstrap/stages/tools.ts";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { sweepLeftovers } from "../src/main/bootstrap/graph.ts";
import { activateFiles, type Stage, type StageContext } from "../src/main/bootstrap/stage.ts";
import { GitconfigBlockError, readGitconfig } from "../src/main/bootstrap/stages/gitconfig.ts";
import { withManagedFiles } from "../src/main/bootstrap/stages/support.ts";
import { gitStage } from "../src/main/bootstrap/stages/tools.ts";
import { execRunner } from "../src/main/platform/exec.ts";
import { buildEnv } from "../src/main/env.ts";
import { computeLayout, toolPathEntries, type AppPlatform } from "../src/main/paths.ts";
import { launcherPlan, sameFolder } from "../src/main/bootstrap/stages/paths-launchers.ts";
import { everyShimName } from "../src/main/bootstrap/stages/launcher-files.ts";
import type { CommandRunner } from "../src/main/platform/index.ts";
import { tarGz, zip } from "./harness/archives.ts";
import { currentKey, leftovers, makeStack, publish, runEngine, scratchRoot, testLayout, toolStage } from "./harness/engine-fixture.ts";
import { FixtureServer } from "./harness/fixture-server.ts";
import { sha256Hex } from "./harness/hash.ts";

// Task 5b: the fixes of the task 5 review (T5-F003, T5-F004, T5-F006). Each case fails when its fix is reverted.

const server = new FixtureServer();
const scratch: string[] = [];
before(async () => {
	await server.listen();
});
after(async () => {
	await server.close();
	for (const d of scratch) {
		try {
			chmodTree(d);
		} catch {
			// best effort: a folder this test made read-only is made writable again so that it can be deleted
		}
		removeTree(d);
	}
});
const fresh = (): { base: string; root: string } => {
	const made = scratchRoot("sbd-t5f-");
	scratch.push(made.base);
	return made;
};
const isWindows = process.platform === "win32";
const posixOnly = isWindows ? "POSIX file modes" : false;

/** Makes every folder under `dir` writable again, so a test that made one read-only can clean up. */
function chmodTree(dir: string): void {
	if (isWindows || !existsSync(dir)) return;
	chmodSync(dir, 0o755);
	for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) chmodTree(join(dir, entry.name));
}

const throwingFor = (pattern: RegExp) => (path: string): void => {
	if (pattern.test(path)) throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${path}'`), { code: "EPERM" });
	removeTree(path);
};

describe("T5-F004: a .replaced file that cannot be deleted does not block a run", () => {
	it("the sweep keeps it, reports it, goes on with the rest, and the next sweep deletes it", () => {
		const { root } = fresh();
		const layout = testLayout(root);
		const bin = layout.tools.bin;
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "bun.exe"), "new");
		writeFileSync(join(bin, "bun.exe.replaced"), "old, held by a running process");
		writeFileSync(join(bin, "gh.replaced"), "old gh");
		writeFileSync(join(bin, "gh"), "new gh");
		mkdirSync(join(layout.tools.root, "git", "2.0.0.staging"), { recursive: true });

		const swept = sweepLeftovers(layout, { remove: throwingFor(/bun\.exe\.replaced$/) });
		assert.deepEqual(swept.kept.map((k) => k.path), [join(bin, "bun.exe.replaced")]);
		assert.match(swept.kept[0]?.error ?? "", /EPERM/);
		assert.equal(existsSync(join(bin, "bun.exe.replaced")), true, "the held copy stays");
		assert.equal(existsSync(join(bin, "gh.replaced")), false, "the sweep went on past it");
		assert.equal(existsSync(join(layout.tools.root, "git", "2.0.0.staging")), false);

		const later = sweepLeftovers(layout);
		assert.deepEqual(later.kept, []);
		assert.equal(existsSync(join(bin, "bun.exe.replaced")), false, "a later sweep retries it");
	});

	it("an engine run goes on past a leftover it cannot delete and logs it as kept", { skip: posixOnly }, async () => {
		const { root } = fresh();
		const alpha = publish(server, "alpha-kept", { version: "1.0.0" });
		const stack = makeStack({ "alpha-kept": alpha });
		// A read-only folder holding a file cannot be deleted: the stand-in for a copy of a running executable.
		const held = join(root, "tools", "x", "1.0.0.replaced");
		mkdirSync(held, { recursive: true });
		writeFileSync(join(held, "bun.exe"), "held");
		mkdirSync(join(root, "tools", "x", "1.0.0"), { recursive: true });
		chmodSync(held, 0o555);
		const result = await runEngine(root, stack, [toolStage("alpha-kept")]);
		assert.equal(result.error, null, JSON.stringify(result.error));
		assert.equal(result.ok, true);
		const log = readFileSync(join(root, "logs", "bootstrap.jsonl"), "utf8");
		const swept = log.split("\n").filter((l) => l.includes('"swept"')).map((l) => JSON.parse(l) as { kept: Array<{ path: string }> });
		assert.deepEqual(swept[0]?.kept.map((k) => k.path), [held]);
		assert.equal(existsSync(held), true);
	});

	it("a replace goes on when the leftover of the last replace is still held: the old copy goes to the next free name", () => {
		const { base } = fresh();
		const dir = join(base, "bin");
		mkdirSync(dir);
		writeFileSync(join(dir, "bun.exe"), "v2 (running)");
		writeFileSync(join(dir, "bun.exe.replaced"), "v1 (still running)");
		writeFileSync(join(base, "new-bun.exe"), "v3");
		const ctx = { fsErrors: [] as string[] } as unknown as StageContext;
		const stuck = throwingFor(/\.replaced(-\d+)?$/);
		activateFiles(ctx, [{ from: join(base, "new-bun.exe"), to: join(dir, "bun.exe") }], [], { removeTree: stuck, renameRetry: (from, to) => void rmRename(from, to) });
		assert.equal(readFileSync(join(dir, "bun.exe"), "utf8"), "v3");
		assert.equal(readFileSync(join(dir, "bun.exe.replaced"), "utf8"), "v1 (still running)");
		assert.equal(readFileSync(join(dir, "bun.exe.replaced-2"), "utf8"), "v2 (running)");
		assert.ok(ctx.fsErrors.length >= 2 && ctx.fsErrors.every((e) => /EPERM/.test(e)), ctx.fsErrors.join("\n"));
	});

	it("the sweep puts the newest aside back when the original is missing, and deletes the older ones", () => {
		const { root } = fresh();
		const layout = testLayout(root);
		mkdirSync(layout.tools.bin, { recursive: true });
		writeFileSync(join(layout.tools.bin, "bun.exe.replaced"), "v1, held");
		writeFileSync(join(layout.tools.bin, "bun.exe.replaced-2"), "v2, the file a kill left without its replacement");
		const swept = sweepLeftovers(layout);
		assert.deepEqual(swept.restored, [join(layout.tools.bin, "bun.exe.replaced-2")]);
		assert.equal(readFileSync(join(layout.tools.bin, "bun.exe"), "utf8"), "v2, the file a kill left without its replacement");
		assert.deepEqual(readdirSync(layout.tools.bin), ["bun.exe"]);
	});
});

function rmRename(from: string, to: string): void {
	// renameRetry without its retries: the stub's files are never held.
	copyFileSync(from, to);
	rmSync(from);
}

describe("T5-F006: gitconfig.replaced is restored, and managed files are written before the folder is activated", () => {
	it("the sweep moves gitconfig.replaced back when gitconfig is missing, so the PM's settings are not stranded", () => {
		const { root } = fresh();
		const layout = testLayout(root);
		writeFileSync(`${layout.gitconfig}.replaced`, "[user]\n\tname = The PM\n");
		writeFileSync(`${layout.gitconfig}.staging`, "half");
		const swept = sweepLeftovers(layout);
		assert.deepEqual(swept.restored, [`${layout.gitconfig}.replaced`]);
		assert.equal(readFileSync(layout.gitconfig, "utf8"), "[user]\n\tname = The PM\n");
		assert.equal(existsSync(`${layout.gitconfig}.staging`), false);
		assert.deepEqual(leftovers(root), []);
	});

	it("the sweep deletes gitconfig.replaced when gitconfig is there, and touches no other gitconfig.* file", () => {
		const { root } = fresh();
		const layout = testLayout(root);
		writeFileSync(layout.gitconfig, "new");
		writeFileSync(`${layout.gitconfig}.replaced`, "old");
		writeFileSync(`${layout.gitconfig}.local.replaced`, "somebody else's");
		const swept = sweepLeftovers(layout);
		assert.deepEqual(swept.restored, []);
		assert.equal(readFileSync(layout.gitconfig, "utf8"), "new");
		assert.equal(existsSync(`${layout.gitconfig}.replaced`), false);
		assert.equal(existsSync(`${layout.gitconfig}.local.replaced`), true);
	});

	it("a managed file that cannot be written fails the stage with the old version still active", async () => {
		const { root } = fresh();
		const v1 = publish(server, "alpha-managed", { version: "1.0.0" });
		const v2 = publish(server, "alpha-managed", { version: "2.0.0" });
		// The managed file's folder is a regular file, so writing it fails.
		const blocker = join(root, "blocker");
		writeFileSync(blocker, "a file where a folder should be");
		const managed = (): Stage => withManagedFiles(toolStage("alpha-managed"), () => [{ path: join(blocker, "config.toml"), text: "x" }]);
		const failed = await runEngine(root, makeStack({ "alpha-managed": v1 }), [managed()]);
		assert.equal(failed.outcomes["alpha-managed"]?.status, "failed");
		assert.equal(existsSync(join(root, "state", "current.json")), false, "nothing became active");
		assert.equal(existsSync(join(root, "tools", "alpha-managed", "1.0.0")), false);

		rmSync(blocker);
		const first = await runEngine(root, makeStack({ "alpha-managed": v1 }), [managed()]);
		assert.equal(first.outcomes["alpha-managed"]?.status, "installed");
		rmSync(blocker, { recursive: true });
		writeFileSync(blocker, "a file again");
		const second = await runEngine(root, makeStack({ "alpha-managed": v2 }), [withManagedFiles(toolStage("alpha-managed"), () => [{ path: join(blocker, "config.toml"), text: "y" }])]);
		assert.equal(second.outcomes["alpha-managed"]?.status, "failed");
		const current = JSON.parse(readFileSync(join(root, "state", "current.json"), "utf8")) as { versions: Record<string, string> };
		assert.equal(current.versions["alpha-managed"], "1.0.0", "current.json still names the old version");
		assert.equal(existsSync(join(root, "tools", "alpha-managed", "2.0.0")), false);
		assert.deepEqual(leftovers(root).filter((p) => !p.endsWith(".tmp")), []);
	});

	it("the git stage refuses a hand-edited gitconfig block before it activates anything", async () => {
		const { root } = fresh();
		const layout = testLayout(root);
		writeFileSync(layout.gitconfig, "# >>> straw-boss base (written by the app; change settings outside this block)\n[core]\n\tx = 1\n");
		const stage = gitStage(isWindows ? "win32" : "darwin");
		// No stack, no staging folder: a stage that renamed or read the pin first would throw something else.
		await assert.rejects(() => stage.activate({ layout } as unknown as StageContext, { text: "", version: "1.0.0" }), GitconfigBlockError);
		assert.equal(readGitconfig(layout.gitconfig).includes("x = 1"), true);
	});
});

describe("T5-F005: tar and the self-extractor get a scrubbed environment, and their commands are in the stage log", () => {
	it("an engine run's tar calls carry only the system essentials, replace the environment, and are logged", { skip: posixOnly }, async () => {
		const { root } = fresh();
		const version = "1.0.0";
		const alpha = publish(server, "alpha-scrub", { version });
		const calls: Array<{ file: string; env: Readonly<Record<string, string>> | undefined; replaceEnv: boolean | undefined }> = [];
		const real = execRunner();
		const run: CommandRunner = (file, args, options) => {
			calls.push({ file, env: options?.env, replaceEnv: options?.replaceEnv });
			return real(file, args, options);
		};
		const appEnv = { HOME: root, GH_TOKEN: "ghp_must_not_reach_tar", PI_SUBAGENT_ID: "x", SOME_SECRET: "s3cret" };
		const result = await runEngine(root, makeStack({ "alpha-scrub": alpha }), [toolStage("alpha-scrub")], { run, appEnv });
		assert.equal(result.ok, true, JSON.stringify(result.outcomes));
		const tarCalls = calls.filter((c) => /tar$/.test(c.file));
		assert.ok(tarCalls.length >= 2);
		for (const c of tarCalls) {
			assert.equal(c.replaceEnv, true);
			assert.deepEqual(Object.keys(c.env ?? {}).sort(), ["HOME"], "only the system essentials of the app's environment");
		}
		const log = readFileSync(join(root, "logs", "stage-alpha-scrub.log"), "utf8");
		assert.match(log, /\$ \/usr\/bin\/tar -xf /, "the extraction command is in the stage log");
		assert.ok(!log.includes("ghp_must_not_reach_tar"));
		const events = readFileSync(join(root, "logs", "bootstrap.jsonl"), "utf8");
		assert.match(events, /"event":"exec".*\/usr\/bin\/tar/);
	});
});

describe("T5-F003: fd-rg extracts under the root, whatever the agent folder is", () => {
	it("an agent folder outside the root and behind a non-ASCII path installs; tar sees only ASCII names and works under tools/", async () => {
		const { base, root } = fresh();
		const agentDir = join(base, "別的磁碟", "agent");
		const key = currentKey();
		const fakeTool = (name: string, version: string): { asset: { version: string; url: string; sha256: string; file: string }; file: string } => {
			const file = `${name}-${version}.${isWindows ? "zip" : "tar.gz"}`;
			const exe = `${name}${isWindows ? ".exe" : ""}`;
			let bytes: Buffer;
			if (isWindows) {
				// A real program that prints the version in its --version line: node itself.
				bytes = zip([{ name: `${name}-${version}/${exe}`, data: readFileSync(process.execPath) }]);
			} else {
				bytes = tarGz([{ name: `${name}-${version}/`, type: "dir" }, { name: `${name}-${version}/${exe}`, data: `#!/bin/sh\necho "${name} ${version}"\n`, mode: 0o755 }]);
			}
			return { asset: { version, url: server.serve(`/${file}`, bytes), sha256: sha256Hex(bytes), file }, file };
		};
		const nodeVersion = process.versions.node;
		const fd = fakeTool("fd", isWindows ? nodeVersion : "10.3.0");
		const rg = fakeTool("rg", isWindows ? nodeVersion : "15.1.0");
		const stack = makeStack({ fd: fd.asset, rg: rg.asset });
		assert.ok(key);
		const calls: Array<{ file: string; args: readonly string[]; cwd: string | undefined }> = [];
		const real = execRunner();
		const run: CommandRunner = (file, args, options) => {
			calls.push({ file, args: [...args], cwd: options?.cwd });
			return real(file, args, options);
		};
		const stage: Stage = { ...fdRgStage(isWindows ? "win32" : "darwin"), needs: [] };
		const result = await runEngine(root, stack, [stage], { layout: testLayout(root, { agentDir }), run });
		assert.equal(result.outcomes["fd-rg"]?.status, "installed", JSON.stringify(result.outcomes["fd-rg"]?.failure));
		for (const name of isWindows ? ["fd.exe", "rg.exe"] : ["fd", "rg"]) assert.equal(existsSync(join(agentDir, "bin", name)), true, `${name} is in the agent folder`);
		const tarCalls = calls.filter((c) => /tar(\.exe)?$/.test(c.file));
		assert.ok(tarCalls.length >= 4, "listed and extracted both archives");
		for (const c of tarCalls) {
			assert.match(c.args.join(" "), /^[\x20-\x7e]*$/, "tar gets only ASCII arguments");
			assert.ok(c.cwd !== undefined && c.cwd.startsWith(root), `tar works under the root, not in ${c.cwd}`);
		}
		assert.deepEqual(leftovers(root), []);
		assert.deepEqual(leftovers(agentDir), []);
	});
});

// ---- T5-F001 and T5-F002 -----------------------------------------------------------------------------------------------

function layoutOf(platform: AppPlatform) {
	const home = platform === "win32" ? "C:\\Users\\測試" : "/Users/測試";
	const root = platform === "win32" ? `${home}\\AppData\\Local\\sbd 測試` : `${home}/Library/Application Support/straw-boss-desk`;
	return computeLayout({ root, home, platform, realpath: (p) => { if (p === home) return p; throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } });
}

describe("T5-F001: a bare bun in cmd or PowerShell reaches the launcher, a spawn without a shell still finds the shim", () => {
	const win = layoutOf("win32");
	const bun = { clis: [] as ("gh" | "glab")[], optional: ["bun"] };

	it("the .exe shims go to tools\\bin-exe, the PATH lists it after tools\\bin, and no .exe stays in tools\\bin", () => {
		const plan = launcherPlan(win, bun, ["bun"]);
		assert.deepEqual(plan.textNames.sort(), ["bun", "bun.cmd", "bunx", "bunx.cmd"]);
		assert.deepEqual(plan.shimNames, ["bun.exe", "bunx.exe"]);
		// Task 5 wrote the shims into tools\bin; a left-over there beside bun.cmd would win the PATHEXT lookup, so every set deletes them.
		assert.deepEqual(plan.drop.filter((p) => /bunx?\.exe$/.test(p)).sort(), [`${win.tools.bin}\\bun.exe`, `${win.tools.bin}\\bunx.exe`]);
		const entries = toolPathEntries(win, { node: "24.22.1", git: "2.56.0.3", herdr: "0.9.5" });
		assert.deepEqual(entries.slice(0, 2), [win.tools.bin, win.tools.binExe]);
		assert.equal(win.tools.binExe, `${win.root}\\tools\\bin-exe`);
	});

	it("a recipe that drops bun deletes the launchers, any .exe in tools\\bin, and the shims in tools\\bin-exe", () => {
		const plan = launcherPlan(win, { clis: [], optional: [] }, ["bun"]);
		assert.deepEqual(plan.shimNames, []);
		assert.deepEqual(plan.drop.filter((p) => /bunx?(\.cmd|\.exe)?$/.test(p)).sort(), [
			`${win.tools.bin}\\bun`, `${win.tools.bin}\\bun.cmd`, `${win.tools.bin}\\bun.exe`, `${win.tools.bin}\\bunx`, `${win.tools.bin}\\bunx.cmd`, `${win.tools.bin}\\bunx.exe`,
			`${win.tools.binExe}\\bun.exe`, `${win.tools.binExe}\\bunx.exe`,
		].sort());
	});

	it("macOS has no shims and no tools/bin-exe entry", () => {
		const mac = layoutOf("darwin");
		assert.deepEqual(launcherPlan(mac, bun, ["bun"]).shimNames, []);
		assert.deepEqual(everyShimName("darwin", ["bun"]), []);
		assert.equal(toolPathEntries(mac, { node: "24.22.1", git: "2.56.0-2", herdr: "0.9.5" }).some((e) => e.includes("bin-exe")), false);
	});

	it("the constructed environment gives a bun reached without its launcher the telemetry opt-out and the app's folders", () => {
		const env = buildEnv({ layout: win, current: { node: "24.22.1", git: "2.56.0.3", herdr: "0.9.5" }, appEnv: {}, optionalTools: ["bun"] });
		assert.equal(env.DO_NOT_TRACK, "1");
		assert.equal(env.BUN_INSTALL, `${win.root}\\tools\\bun-home`);
		assert.equal(env.BUN_INSTALL_CACHE_DIR, `${win.root}\\tools\\bun-home\\install\\cache`);
		const none = buildEnv({ layout: win, current: { node: "24.22.1", git: "2.56.0.3", herdr: "0.9.5" }, appEnv: {} });
		assert.equal(none.DO_NOT_TRACK, undefined, "a recipe without bun sets none of it");
	});
});

describe("T5-F002: the cache folder check", () => {
	const real = (map: Record<string, string>) => (p: string): string => {
		const found = map[p];
		if (found === undefined) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
		return found;
	};

	it("takes a short name and the long name of one folder as the same, and a project's node_modules/.cache as another", () => {
		const longName = "/r/測試/tools/bun-home/install/cache";
		const table = real({ "/r": "/r", "/r/測試": "/r/測試", "/r/測試/tools": "/r/測試/tools", "/r/測試/tools/bun-home": "/r/測試/tools/bun-home", [longName]: longName, "/r/SBD~1/tools/bun-home/install/cache": longName, "/r/SBD~1/tools/bun-home/install": "/r/測試/tools/bun-home/install" });
		assert.equal(sameFolder("/r/SBD~1/tools/bun-home/install/cache\n", longName, table), true);
		assert.equal(sameFolder("/work/app/node_modules/.cache", longName, table), false);
		assert.equal(sameFolder("", longName, table), false);
	});

	it("compares a folder the launcher has not made yet by its existing parent", () => {
		const table = real({ "/var": "/private/var", "/var/x": "/private/var/x", "/private/var": "/private/var", "/private/var/x": "/private/var/x" });
		assert.equal(sameFolder("/private/var/x/tools/cache", "/var/x/tools/cache", table), true);
	});
});
