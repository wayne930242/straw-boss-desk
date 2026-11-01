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
