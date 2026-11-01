import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join, win32 } from "node:path";
import { after, describe, it } from "node:test";
import { execRunner } from "../src/main/platform/exec.ts";
import { createPlatform, type CommandRunner } from "../src/main/platform/index.ts";
import { ExtractRefused, extractArchive, unsafeEntryName } from "../src/main/bootstrap/extract.ts";
import { tarGz, zip, type TarEntry } from "./harness/archives.ts";
import { scratchRoot } from "./harness/engine-fixture.ts";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";

const locate = createPlatform().locate;
const scratch: string[] = [];
const fresh = (): { base: string; dest: string; archive: (name: string, bytes: Buffer) => string } => {
	const { base } = scratchRoot("sbd-ext-");
	scratch.push(base);
	return {
		base,
		dest: join(base, "out dir 測試"),
		archive(name, bytes) {
			const file = join(base, name);
			writeFileSync(file, bytes);
			return file;
		},
	};
};
after(() => {
	for (const d of scratch) removeTree(d);
});

// Entry names are ASCII, as the publishers' are: bsdtar on Windows cannot read a UTF-8 entry name under a non-UTF-8 code page ("unreadable filename").
const files = [
	{ name: "pkg-1/bin/tool", data: "binary\n" },
	{ name: "pkg-1/VERSION", data: "1\n" },
	{ name: "pkg-1/lib/dir with space/readme.txt", data: "hello\n" },
];

describe("unsafeEntryName", () => {
	it("refuses absolute names, drive letters, and `..` segments with either slash, and allows dots inside a name", () => {
		for (const bad of ["/etc/passwd", "\\windows\\x", "C:/x", "c:\\x", "../x", "a/../x", "a\\..\\x", "a/b/..", "x\0y"]) assert.notEqual(unsafeEntryName(bad), null, bad);
		for (const good of ["a/b.c", "a..b/c", "..hidden/x", "a/...", "node-v24.22.1/bin/node", "名稱/檔案"]) assert.equal(unsafeEntryName(good), null, good);
	});
});

describe("extractArchive", () => {
	it("extracts a zip and a tar.gz with the system tar, strips the top folder, into a destination with a space and CJK characters", async () => {
		for (const [name, bytes] of [["a.zip", zip(files)], ["a.tar.gz", tarGz(files.map((f) => ({ ...f, mode: 0o755 })))]] as const) {
			const t = fresh();
			const archive = t.archive(name, bytes);
			const result = await extractArchive({ archive, dest: t.dest, locate, run: execRunner(), stripComponents: 1 });
			assert.equal(readFileSync(join(t.dest, "VERSION"), "utf8"), "1\n");
			assert.equal(readFileSync(join(t.dest, "lib", "dir with space", "readme.txt"), "utf8"), "hello\n");
			assert.ok(result.entries >= 3);
			assert.ok(isAbsolute(result.tar));
			if (process.platform !== "win32" && name.endsWith(".gz")) assert.ok((statSync(join(t.dest, "bin", "tool")).mode & 0o100) !== 0, "the executable bit survives");
		}
	});

	it("calls tar by the absolute system path, never by name", async () => {
		const t = fresh();
		const calls: string[] = [];
		const run: CommandRunner = (file, args, options) => {
			calls.push(file);
			return execRunner()(file, args, options);
		};
		await extractArchive({ archive: t.archive("a.zip", zip(files)), dest: t.dest, locate, run, stripComponents: 1 });
		assert.ok(calls.length >= 2, "listing and extraction");
		const expected = process.platform === "win32" ? win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "/usr/bin/tar";
		for (const file of calls) assert.equal(file.toLowerCase(), expected.toLowerCase());
	});

	it("does not use a tar that comes first on the PATH (a GNU tar of Git for Windows cannot read zip)", async () => {
		const t = fresh();
		const decoyDir = join(t.base, "decoy bin");
		mkdirSync(decoyDir);
		const marker = join(t.base, "decoy-ran.txt");
		if (process.platform === "win32") {
			// A program named tar.exe that is not bsdtar: node itself, which fails on tar's arguments. It must not be the one that runs.
			copyFileSync(process.execPath, join(decoyDir, "tar.exe"));
			writeFileSync(join(decoyDir, "tar.cmd"), `@echo ran> "${marker}"\r\nexit /b 3\r\n`);
		} else {
			const decoy = join(decoyDir, "tar");
			writeFileSync(decoy, `#!/bin/sh\necho ran > "${marker}"\nexit 3\n`);
			chmodSync(decoy, 0o755);
		}
		const inherited = Object.entries(process.env).find(([k]) => k.toLowerCase() === "path")?.[1] ?? "";
		const path = `${decoyDir}${delimiter}${inherited}`;
		// Whatever resolves a bare `tar` from this PATH is the decoy; the extraction must still succeed and the decoy must not have run.
		assert.equal(locate.onPath("tar", path)?.startsWith(decoyDir), true, "the decoy is what a PATH lookup would find");
		const base = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== "path")), [process.platform === "win32" ? "Path" : "PATH"]: path };
		const result = await extractArchive({ archive: t.archive("a.zip", zip(files)), dest: t.dest, locate, run: execRunner(base), stripComponents: 1 });
		assert.ok(result.entries >= 3);
		assert.equal(readFileSync(join(t.dest, "VERSION"), "utf8"), "1\n");
		assert.equal(existsSync(marker), false, "the decoy tar never ran");
		assert.notEqual(result.tar.startsWith(decoyDir), true);
	});

	it("refuses an entry with `..` or an absolute name before writing anything", async () => {
		for (const bad of ["../escaped.txt", "pkg/../../escaped.txt", "/tmp/sbd-escaped.txt"]) {
			const t = fresh();
			const archive = t.archive("bad.tar.gz", tarGz([{ name: "pkg/ok.txt", data: "ok" }, { name: bad, data: "x" }]));
			await assert.rejects(extractArchive({ archive, dest: t.dest, locate, run: execRunner() }), (e: unknown) => e instanceof ExtractRefused && /`\.\.`|absolute/.test((e as Error).message), bad);
			assert.deepEqual(readdirSync(t.dest), [], "nothing was extracted");
			assert.equal(existsSync(join(t.base, "escaped.txt")), false);
		}
	});

	it("refuses a link that leaves the folder, absolute or relative, and removes what was extracted", async () => {
		const cases: TarEntry[][] = [
			[{ name: "pkg/ok.txt", data: "ok" }, { name: "pkg/up", type: "symlink", link: "../../outside" }],
			[{ name: "pkg/ok.txt", data: "ok" }, { name: "pkg/abs", type: "symlink", link: process.platform === "win32" ? "C:\\Windows" : "/etc" }],
			[{ name: "pkg/ok.txt", data: "ok" }, { name: "pkg/deep", type: "symlink", link: "a/b/../../../../outside" }],
		];
		for (const entries of cases) {
			const t = fresh();
			const archive = t.archive("link.tar.gz", tarGz(entries));
			try {
				await extractArchive({ archive, dest: t.dest, locate, run: execRunner() });
				assert.fail("the extraction should be refused");
			} catch (error) {
				// bsdtar on Windows may refuse to create the link itself (no privilege): a failed extraction is also a refusal. Either way nothing stays.
				assert.ok(error instanceof Error);
				if (error instanceof ExtractRefused) assert.match(error.message, /link/);
			}
			assert.deepEqual(readdirSync(t.dest), [], "nothing stays in the destination");
		}
	});

	it("allows a link that stays inside, as the Node tarball's `bin/npm` does", async () => {
		if (process.platform === "win32") return; // a symbolic link needs a privilege there; the refusal cases above cover the check
		const t = fresh();
		const archive = t.archive("ok.tar.gz", tarGz([
			{ name: "pkg/lib/cli.js", data: "x" },
			{ name: "pkg/bin/", type: "dir" },
			{ name: "pkg/bin/npm", type: "symlink", link: "../lib/cli.js" },
		]));
		await extractArchive({ archive, dest: t.dest, locate, run: execRunner() });
		assert.equal(readFileSync(join(t.dest, "pkg", "bin", "npm"), "utf8"), "x");
	});

	it("does not link a file outside through a hard link entry", async () => {
		const t = fresh();
		const outside = join(t.base, "outside.txt");
		writeFileSync(outside, "keep");
		const before = statSync(outside).nlink;
		const archive = t.archive("hard.tar.gz", tarGz([{ name: "pkg/h", type: "hardlink", link: outside }, { name: "pkg/ok.txt", data: "ok" }]));
		await extractArchive({ archive, dest: t.dest, locate, run: execRunner() }).catch(() => {});
		assert.equal(statSync(outside).nlink, before, "bsdtar's secure extraction did not link the outside file");
		assert.equal(readFileSync(outside, "utf8"), "keep");
	});

	it("refuses a destination that is not empty, and an archive tar cannot read", async () => {
		const t = fresh();
		mkdirSync(t.dest);
		writeFileSync(join(t.dest, "x"), "x");
		await assert.rejects(extractArchive({ archive: t.archive("a.zip", zip(files)), dest: t.dest, locate, run: execRunner() }), /not empty/);
		const u = fresh();
		await assert.rejects(extractArchive({ archive: u.archive("junk.tar.gz", Buffer.from("not an archive at all")), dest: u.dest, locate, run: execRunner() }), /failed/);
	});
});
