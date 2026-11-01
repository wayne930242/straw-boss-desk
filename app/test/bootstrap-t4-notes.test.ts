import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { StageError } from "../src/main/bootstrap/errors.ts";
import { ExtractRefused, extractArchive, extractSelfExtractor } from "../src/main/bootstrap/extract.ts";
import { removeTree, sha256File } from "../src/main/bootstrap/fsutil.ts";
import { sweepLeftovers } from "../src/main/bootstrap/graph.ts";
import { Redactor, StageLog, MAX_PEM_LINES, RotatingFile, loadSecretPatterns } from "../src/main/bootstrap/log.ts";
import { activateFiles, fileKey, type Stage, type StageContext } from "../src/main/bootstrap/stage.ts";
import { createPlatform, type CommandRunner } from "../src/main/platform/index.ts";
import { execRunner } from "../src/main/platform/exec.ts";
import { FixtureServer } from "./harness/fixture-server.ts";
import { leftovers, makeStack, publish, runEngine, scratchRoot, testLayout, toolStage } from "./harness/engine-fixture.ts";

// The task 4 build notes that task 5 closes: T4-F010 (activation edge cases), T4-F013 (tar's full-disk message), R4-F001 (the stage log's PEM rule),
// and the self-extractor's rules (the tar arguments note).

const server = new FixtureServer();
const scratch: string[] = [];
before(async () => {
	await server.listen();
});
after(async () => {
	await server.close();
	for (const d of scratch) removeTree(d);
});
const fresh = (): { base: string; root: string } => {
	const made = scratchRoot("sbd-t4n-");
	scratch.push(made.base);
	return made;
};
const jsonOf = (file: string): Record<string, any> => JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;

describe("T4-F010 (a): the sweep puts back a copy that was moved aside", () => {
	it("moves <v>.replaced back when <v> is missing, so current.json names a folder that exists", async () => {
		const { root } = fresh();
		const alpha = publish(server, "alpha-aside", { version: "1.0.0" });
		const stack = makeStack({ "alpha-aside": alpha });
		const first = await runEngine(root, stack, [toolStage("alpha-aside")]);
		assert.equal(first.ok, true);

		// A same-version replace killed between its two renames: the old copy is `.replaced`, the new one is still `.staging`.
		const folder = join(root, "tools", "alpha-aside", "1.0.0");
		renameSync(folder, `${folder}.replaced`);
		mkdirSync(`${folder}.staging`);
		writeFileSync(join(`${folder}.staging`, "half"), "half-written");

		const swept = sweepLeftovers(testLayout(root));
		assert.deepEqual(swept.restored, [`${folder}.replaced`]);
		assert.deepEqual(swept.removed, [`${folder}.staging`]);
		assert.equal(existsSync(folder), true, "the folder current.json names is back");
		assert.equal(existsSync(`${folder}.replaced`), false);
		assert.deepEqual(leftovers(root), []);

		// The next run finds the restored copy intact and downloads and installs nothing.
		const hits = server.hits(alpha.path);
		const again = await runEngine(root, stack, [toolStage("alpha-aside")]);
		assert.equal(again.outcomes["alpha-aside"]?.status, "skipped-verified");
		assert.equal(server.hits(alpha.path), hits);
	});

	it("deletes <v>.replaced when <v> is there, and leaves a live folder alone", async () => {
		const { root } = fresh();
		const layout = testLayout(root);
		mkdirSync(join(root, "tools", "x", "2.0.0"), { recursive: true });
		mkdirSync(join(root, "tools", "x", "2.0.0.replaced"), { recursive: true });
		mkdirSync(join(root, "tools", "x", "1.0.0"), { recursive: true });
		const swept = sweepLeftovers(layout);
		assert.deepEqual(swept.restored, []);
		assert.deepEqual(swept.removed, [join(root, "tools", "x", "2.0.0.replaced")]);
		assert.deepEqual(readdirSync(join(root, "tools", "x")).sort(), ["1.0.0", "2.0.0"]);
	});

	it("also sweeps the agent's bin folder and the gitconfig staging copy", () => {
		const { root } = fresh();
		const layout = testLayout(root);
		mkdirSync(join(layout.agent, "bin", "fd-rg.staging"), { recursive: true });
		writeFileSync(join(layout.agent, "bin", "fd.replaced"), "old fd");
		writeFileSync(join(layout.agent, "bin", "rg"), "rg");
		writeFileSync(join(layout.agent, "bin", "rg.replaced"), "old rg");
		writeFileSync(layout.gitconfig, "kept");
		writeFileSync(`${layout.gitconfig}.staging`, "half");
		const swept = sweepLeftovers(layout);
		assert.deepEqual(swept.restored, [join(layout.agent, "bin", "fd.replaced")]);
		assert.equal(readFileSync(join(layout.agent, "bin", "fd"), "utf8"), "old fd");
		assert.equal(readFileSync(join(layout.agent, "bin", "rg"), "utf8"), "rg", "the new copy wins when both exist");
		assert.equal(existsSync(join(layout.agent, "bin", "rg.replaced")), false);
		assert.equal(existsSync(join(layout.agent, "bin", "fd-rg.staging")), false);
		assert.equal(existsSync(`${layout.gitconfig}.staging`), false);
		assert.equal(readFileSync(layout.gitconfig, "utf8"), "kept");
	});
});

describe("T4-F010 (b): files are hashed from staging, before the renames", () => {
	it("a staged file that cannot be read fails the stage while the old version is still the active one", async () => {
		const { root } = fresh();
		const v1 = publish(server, "alpha-hash", { version: "1.0.0" });
		const v2 = publish(server, "alpha-hash", { version: "2.0.0" });
		const stages = (broken: boolean): Stage[] => {
			const stage = toolStage("alpha-hash");
			if (!broken) return [stage];
			// The binary vanishes after verify (antivirus quarantine, EBUSY on a real machine): the hash step reads the staged copy and fails.
			return [
				{
					...stage,
					async verify(ctx) {
						const evidence = await stage.verify(ctx);
						for (const staged of Object.values(evidence.stagedFiles ?? {})) rmSync(staged);
						return evidence;
					},
				},
			];
		};
		const ok = await runEngine(root, makeStack({ "alpha-hash": v1 }), stages(false));
		assert.equal(ok.ok, true);

		const bad = await runEngine(root, makeStack({ "alpha-hash": v2 }), stages(true));
		assert.equal(bad.ok, false);
		assert.equal(bad.outcomes["alpha-hash"]?.status, "failed");
		const current = jsonOf(join(root, "state", "current.json"));
		assert.equal(current.versions["alpha-hash"], "1.0.0", "current.json was not touched");
		assert.equal(existsSync(join(root, "tools", "alpha-hash", "1.0.0")), true, "the old folder is intact");
		assert.equal(existsSync(join(root, "tools", "alpha-hash", "2.0.0")), false, "the new folder was never renamed into place");
		const record = jsonOf(join(root, "state", "bootstrap.json")).stages["alpha-hash"];
		assert.equal(record.status, "ok");
		assert.equal(record.version, "1.0.0");
		assert.ok(record.lastFailure);
		assert.deepEqual(leftovers(root), []);
	});

	it("records the hash of the staged file under the final key", async () => {
		const { root } = fresh();
		const pkg = publish(server, "alpha-key", { version: "1.0.0", binary: "the exact bytes" });
		const run = await runEngine(root, makeStack({ "alpha-key": pkg }), [toolStage("alpha-key")]);
		assert.equal(run.ok, true);
		const record = jsonOf(join(root, "state", "bootstrap.json")).stages["alpha-key"];
		const key = Object.keys(record.hashes)[0] ?? "";
		assert.ok(key.startsWith("tools/alpha-key/1.0.0/"), key);
		assert.equal(record.hashes[key], await sha256File(join(root, ...key.split("/"))));
	});

	it("refuses a staged path outside the data root and the agent folder", async () => {
		const { root, base } = fresh();
		const pkg = publish(server, "alpha-out", { version: "1.0.0" });
		const stage = toolStage("alpha-out");
		const outside = join(base, "outside-file");
		writeFileSync(outside, "x");
		const run = await runEngine(root, makeStack({ "alpha-out": pkg }), [
			{
				...stage,
				async verify(ctx) {
					const evidence = await stage.verify(ctx);
					return { ...evidence, stagedFiles: Object.fromEntries(Object.keys(evidence.stagedFiles ?? {}).map((key) => [key, outside])) };
				},
			},
		]);
		assert.equal(run.outcomes["alpha-out"]?.status, "failed");
		assert.match(run.outcomes["alpha-out"]?.failure?.detail ?? "", /neither the data root|under neither/);
		assert.equal(existsSync(join(root, "tools", "alpha-out", "1.0.0")), false);
	});
});

describe("activateFiles", () => {
	const ctxOf = (): StageContext => ({ fsErrors: [] }) as unknown as StageContext;

	it("replaces a set of files whole: a failure in the middle puts the earlier ones back", () => {
		const { base } = fresh();
		const dir = join(base, "bin");
		mkdirSync(dir);
		writeFileSync(join(dir, "a"), "old a");
		writeFileSync(join(dir, "b"), "old b");
		writeFileSync(join(base, "new-a"), "new a");
		// `new-b` is missing, so the second rename fails.
		assert.throws(() => activateFiles(ctxOf(), [{ from: join(base, "new-a"), to: join(dir, "a") }, { from: join(base, "new-b"), to: join(dir, "b") }]));
		assert.equal(readFileSync(join(dir, "a"), "utf8"), "old a");
		assert.equal(readFileSync(join(dir, "b"), "utf8"), "old b");
		assert.deepEqual(readdirSync(dir).sort(), ["a", "b"], "no .replaced file left behind");
	});

	it("moves new files in, deletes the files to remove, and leaves nothing aside", () => {
		const { base } = fresh();
		const dir = join(base, "bin");
		mkdirSync(dir);
		writeFileSync(join(dir, "gone"), "old");
		writeFileSync(join(dir, "a"), "old a");
		writeFileSync(join(base, "new-a"), "new a");
		writeFileSync(join(base, "new-c"), "new c");
		activateFiles(ctxOf(), [{ from: join(base, "new-a"), to: join(dir, "a") }, { from: join(base, "new-c"), to: join(dir, "c") }], [join(dir, "gone"), join(dir, "never-there")]);
		assert.deepEqual(readdirSync(dir).sort(), ["a", "c"]);
		assert.equal(readFileSync(join(dir, "a"), "utf8"), "new a");
	});

	it("puts back a removed file when a later rename fails", () => {
		const { base } = fresh();
		const dir = join(base, "bin");
		mkdirSync(dir);
		writeFileSync(join(dir, "gone"), "old");
		assert.throws(() => activateFiles(ctxOf(), [{ from: join(base, "missing"), to: join(dir, "x") }], [join(dir, "gone")]));
		assert.equal(readFileSync(join(dir, "gone"), "utf8"), "old");
	});
});

describe("agent-folder keys (T4-F004)", () => {
	it("a file in an agent folder outside the root is keyed with the agent role; one inside it, relative to the root", () => {
		const { base, root } = fresh();
		const inside = testLayout(root);
		assert.equal(fileKey(inside, join(inside.agent, "bin", "fd")), "agent/bin/fd");
		const outside = testLayout(root, { agentDir: join(base, "elsewhere", "agent") });
		assert.equal(fileKey(outside, join(outside.agent, "bin", "fd")), "agent:bin/fd");
	});
});

describe("T4-F013: tar's full-disk message is a disk failure", () => {
	const archiveOf = (base: string): string => {
		const file = join(base, "x.tar");
		writeFileSync(file, "not read: the runner is a fake");
		return file;
	};
	const platform = createPlatform();

	it("maps 'No space left on device' from the extract step to the category disk, with the sentence for it", async () => {
		const { base } = fresh();
		const run: CommandRunner = async (_file, args) => (args[0] === "-tf" ? { code: 0, stdout: "pkg/\npkg/bin/tool\n", stderr: "" } : { code: 1, stdout: "", stderr: "tar: pkg/bin/tool: Cannot write: No space left on device\n" });
		await assert.rejects(
			extractArchive({ archive: archiveOf(base), dest: join(base, "out"), locate: platform.locate, run }),
			(error: unknown) => error instanceof StageError && error.category === "disk" && error.sentence === "There is not enough free space on the disk.",
		);
		assert.deepEqual(readdirSync(join(base, "out")), [], "what was extracted is removed");
	});

	it("maps the Windows message too, and keeps every other tar failure as 'other'", async () => {
		const { base } = fresh();
		const fail = (stderr: string): CommandRunner => async (_file, args) => (args[0] === "-tf" ? { code: 0, stdout: "pkg/\n", stderr: "" } : { code: 1, stdout: "", stderr });
		await assert.rejects(extractArchive({ archive: archiveOf(base), dest: join(base, "o1"), locate: platform.locate, run: fail("tar.exe: There is not enough space on the disk.") }), (e: unknown) => e instanceof StageError && e.category === "disk");
		await assert.rejects(extractArchive({ archive: archiveOf(base), dest: join(base, "o2"), locate: platform.locate, run: fail("tar: Truncated input file") }), (e: unknown) => e instanceof StageError && e.category === "other");
	});

	it("is not retried by the engine: one attempt", async () => {
		const { root } = fresh();
		const pkg = publish(server, "alpha-disk", { version: "1.0.0" });
		const stage = toolStage("alpha-disk");
		const run = await runEngine(root, makeStack({ "alpha-disk": pkg }), [
			{
				...stage,
				async install() {
					throw new StageError("disk", {}, "tar: No space left on device");
				},
			},
		]);
		assert.equal(run.outcomes["alpha-disk"]?.failure?.category, "disk");
		assert.equal(run.outcomes["alpha-disk"]?.attempts, 1);
	});
});

describe("R4-F001: the stage log's PEM rule", () => {
	const patterns = loadSecretPatterns(JSON.parse(readFileSync(new URL("../../recipe/secret-patterns.json", import.meta.url), "utf8")));
	const BEGIN = `-----${"BEGIN"} PRIVATE KEY-----`;
	const END = `-----${"END"} PRIVATE KEY-----`;
	const logOf = (): { log: StageLog; read: () => string } => {
		const { base } = fresh();
		const file = join(base, "stage.log");
		return { log: new StageLog(new Redactor(patterns), new RotatingFile(file), () => {}), read: () => (existsSync(file) ? readFileSync(file, "utf8") : "") };
	};
	const body = (n: number): string[] => Array.from({ length: n }, (_, i) => `body line ${i}`);

	it("drops a whole block and keeps the lines before and after it", () => {
		const { log, read } = logOf();
		log.raw([`before`, BEGIN, ...body(3), END, `after`, ``].join("\n"));
		log.flush();
		const text = read();
		assert.match(text, /^before\n/);
		assert.ok(text.includes("after\n"));
		assert.ok(!text.includes("body line"), text);
		assert.ok(!text.includes("-----END"), text);
	});

	it("stops dropping at the END marker and keeps any text after it on the same line", () => {
		const { log, read } = logOf();
		log.raw([BEGIN, ...body(2), `${END} then this text stays`, `next line`, ``].join("\n"));
		log.flush();
		const text = read();
		assert.ok(text.includes("then this text stays\n"), text);
		assert.ok(text.includes("next line\n"), text);
		assert.ok(!text.includes("body line"), text);
	});

	it("stops dropping after MAX_PEM_LINES lines when no END comes, and writes what follows", () => {
		const { log, read } = logOf();
		log.raw([BEGIN, ...body(MAX_PEM_LINES + 30), `last`, ``].join("\n"));
		log.flush();
		const text = read();
		assert.ok(!text.includes("body line 0\n"), "the first lines of the block are dropped");
		assert.ok(!text.includes(`body line ${MAX_PEM_LINES - 2}\n`), "up to the limit");
		assert.ok(text.includes(`body line ${MAX_PEM_LINES + 29}\n`), "the lines past the limit are written again");
		assert.ok(text.includes("last\n"));
	});

	it("keeps a later stage's ordinary output when a stray BEGIN line has no END at all", () => {
		const { log, read } = logOf();
		log.raw(`${BEGIN}\n`);
		for (let i = 0; i < 200; i++) log.raw(`ordinary output ${i}\n`);
		log.flush();
		const text = read();
		assert.ok(text.includes("ordinary output 199\n"), "output far past the stray BEGIN is written");
		assert.ok(text.includes("ordinary output 150\n"));
	});

	it("masks a block that opens and closes on one line, and a block split across chunks", () => {
		const { log, read } = logOf();
		log.raw(`x ${BEGIN} abc ${END} y\n`);
		log.raw(BEGIN.slice(0, 10));
		log.raw(`${BEGIN.slice(10)}\nsecret body\n${END.slice(0, 8)}`);
		log.raw(`${END.slice(8)}\nsafe\n`);
		log.flush();
		const text = read();
		assert.ok(!text.includes("abc"), text);
		assert.ok(!text.includes("secret body"), text);
		assert.ok(text.includes("safe\n"));
	});
});

describe("the self-extractor (PortableGit's .7z.exe)", () => {
	const installerOf = (base: string, content = "pretend installer bytes"): { path: string; sha: string } => {
		const path = join(base, "downloads", "PortableGit.7z.exe");
		mkdirSync(join(base, "downloads"), { recursive: true });
		writeFileSync(path, content);
		return { path, sha: "" };
	};
	const hashOf = async (path: string): Promise<string> => sha256File(path);

	/** A fake installer: records its arguments and working directory, writes files into the folder `-o` names, relative to the working directory. */
	const fakeRun = (log: Array<{ file: string; args: string[]; cwd: string | undefined }>, write: (out: string) => void): CommandRunner =>
		async (file, args, options) => {
			log.push({ file, args: [...args], cwd: options?.cwd });
			const out = join(options?.cwd ?? ".", String(args[0]).slice(2));
			write(out);
			return { code: 0, stdout: "", stderr: "" };
		};

	it("runs only on bytes whose SHA-256 equals the pin at that moment", async () => {
		const { base } = fresh();
		const { path } = installerOf(base);
		const pin = await hashOf(path);
		const calls: Array<{ file: string; args: string[]; cwd: string | undefined }> = [];
		await extractSelfExtractor({ installer: path, sha256: pin, dest: join(base, "git", "2.56.0.3.staging"), run: fakeRun(calls, (out) => writeFileSync(join(out, "ok.txt"), "x")) });
		assert.equal(calls.length, 1);

		// The download is swapped between the hash that admitted it and the run: the second hash catches it, and nothing runs.
		writeFileSync(path, "swapped bytes");
		const before = calls.length;
		await assert.rejects(
			extractSelfExtractor({ installer: path, sha256: pin, dest: join(base, "git", "other.staging"), run: fakeRun(calls, () => {}) }),
			(error: unknown) => error instanceof StageError && error.category === "integrity",
		);
		assert.equal(calls.length, before, "the installer did not run");
	});

	it("gets only ASCII arguments and the folder it works in as its working directory", async () => {
		const { base } = fresh();
		const { path } = installerOf(base);
		const calls: Array<{ file: string; args: string[]; cwd: string | undefined }> = [];
		const dest = join(base, "tools 測試", "git", "2.56.0.3.staging");
		await extractSelfExtractor({ installer: path, sha256: await hashOf(path), dest, run: fakeRun(calls, (out) => writeFileSync(join(out, "f"), "x")) });
		const call = calls[0];
		assert.ok(call);
		assert.deepEqual(call.args, ["-o2.56.0.3.staging", "-y"]);
		assert.ok(call.args.every((a) => /^[\x20-\x7e]+$/.test(a)), "ASCII only");
		assert.equal(call.cwd, join(base, "tools 測試", "git"));
		assert.equal(call.file, path, "the installer is called by its absolute path");
	});

	it("refuses a destination name outside ASCII before anything runs", async () => {
		const { base } = fresh();
		const { path } = installerOf(base);
		const calls: unknown[] = [];
		await assert.rejects(
			extractSelfExtractor({ installer: path, sha256: await hashOf(path), dest: join(base, "git", "版本.staging"), run: async (...a) => (calls.push(a), { code: 0, stdout: "", stderr: "" }) }),
			ExtractRefused,
		);
		assert.deepEqual(calls, []);
	});

	it("walks what was extracted: a link that leaves the folder, or a special file, is refused and everything is removed", async () => {
		if (process.platform === "win32") return;
		const { base } = fresh();
		const { path } = installerOf(base);
		const dest = join(base, "git", "v.staging");
		const { symlinkSync } = await import("node:fs");
		await assert.rejects(
			extractSelfExtractor({ installer: path, sha256: await hashOf(path), dest, run: fakeRun([], (out) => (writeFileSync(join(out, "real"), "x"), symlinkSync("/etc/passwd", join(out, "link")))) }),
			/absolute path/,
		);
		assert.deepEqual(readdirSync(dest), []);
		await assert.rejects(
			extractSelfExtractor({ installer: path, sha256: await hashOf(path), dest, run: fakeRun([], (out) => symlinkSync("../../../outside", join(out, "up"))) }),
			/outside/,
		);
		assert.deepEqual(readdirSync(dest), []);
	});

	it("maps a full disk and a failed run to their categories", async () => {
		const { base } = fresh();
		const { path } = installerOf(base);
		const sha = await hashOf(path);
		await assert.rejects(
			extractSelfExtractor({ installer: path, sha256: sha, dest: join(base, "git", "a.staging"), run: async () => ({ code: 2, stdout: "", stderr: "ERROR: There is not enough space on the disk." }) }),
			(e: unknown) => e instanceof StageError && e.category === "disk",
		);
		await assert.rejects(
			extractSelfExtractor({ installer: path, sha256: sha, dest: join(base, "git", "b.staging"), run: async () => ({ code: 2, stdout: "", stderr: "Data error" }) }),
			(e: unknown) => e instanceof StageError && e.category === "other",
		);
	});

	it("really runs a program and reads what it wrote (a script as the installer)", { skip: process.platform === "win32" ? "the fake installer is a POSIX script" : false }, async () => {
		const { base } = fresh();
		const path = join(base, "downloads", "fake.7z.exe");
		mkdirSync(join(base, "downloads"), { recursive: true });
		writeFileSync(path, '#!/bin/sh\nout=${1#-o}\nmkdir -p "$out/bin"\necho hi > "$out/bin/tool"\n');
		chmodSync(path, 0o755);
		const extracted = await extractSelfExtractor({ installer: path, sha256: await hashOf(path), dest: join(base, "git", "1.0.0.staging"), run: execRunner() });
		assert.equal(extracted.entries, 1);
		assert.equal(readFileSync(join(base, "git", "1.0.0.staging", "bin", "tool"), "utf8"), "hi\n");
	});
});
