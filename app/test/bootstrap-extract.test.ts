import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join, posix, win32 } from "node:path";
import { after, describe, it } from "node:test";
import { execRunner } from "../src/main/platform/exec.ts";
import { createPlatform, type CommandRunner } from "../src/main/platform/index.ts";
import { ExtractRefused, archiveArgument, extractArchive, nameCollision, unsafeEntryName } from "../src/main/bootstrap/extract.ts";
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

describe("nameCollision", () => {
	it("finds names, or folders on the way to them, that differ only in case or Unicode normalization, and lets an exact repeat through", () => {
		assert.equal(nameCollision(["pkg/", "pkg/bin/", "pkg/bin/tool", "pkg/VERSION"]), null);
		assert.equal(nameCollision(["pkg/bin/tool", "pkg/bin/tool"]), null, "the same name twice is not a case collision");
		assert.match(nameCollision(["pkg/bin/tool", "pkg/bin/Tool"]) ?? "", /differ only in case/);
		assert.match(nameCollision(["pkg/bin/tool", "pkg/BIN/other"]) ?? "", /differ only in case/, "two folders that are one folder on a case-insensitive disk");
		assert.match(nameCollision(["a\\b\\c", "A/b/d"]) ?? "", /differ only in case/, "either slash");
		assert.match(nameCollision(["caf\u00e9", "cafe\u0301"]) ?? "", /differ/, "one name in two normalization forms");
	});
});

describe("archiveArgument", () => {
	it("is the path from the destination to the archive, made of names the app chose", () => {
		assert.equal(archiveArgument("C:\\r\\tools\\downloads\\a.zip", "C:\\r\\tools\\node\\1.0.0.staging", win32), "..\\..\\downloads\\a.zip");
		assert.equal(archiveArgument("/r/tools/downloads/a.zip", "/r/tools/node/1.0.0.staging", posix), "../../downloads/a.zip");
	});

	it("refuses an archive on another drive, where `relative()` would answer with an absolute path (T4-F004)", () => {
		assert.equal(win32.relative("C:\\r\\tools\\x", "D:\\dl\\a.zip"), "D:\\dl\\a.zip", "the premise: relative() gives an absolute path");
		assert.throws(() => archiveArgument("D:\\dl\\a.zip", "C:\\r\\tools\\x", win32), (e: unknown) => e instanceof ExtractRefused && /no relative path/.test((e as Error).message));
		assert.throws(() => archiveArgument("/r/a.zip", "/r/a.zip", posix), ExtractRefused);
	});

	it("refuses, for tar.exe, a relative path that carries a character outside ASCII (T4-F004)", () => {
		const root = "C:\\Users\\\u738b\\AppData\\Local\\straw-boss-desk";
		assert.throws(() => archiveArgument(`${root}\\tools\\\u4e0b\\a.zip`, `${root}\\tools\\git\\2.0.0.staging`, win32), ExtractRefused, "a name below the common folder");
		// The root's own name is above the common folder, so it never appears in the argument.
		assert.equal(archiveArgument(`${root}\\tools\\downloads\\a.zip`, `${root}\\tools\\git`, win32), "..\\downloads\\a.zip");
		assert.equal(archiveArgument("/r/\u738b/a.zip", "/r/\u738b/x", posix), "../a.zip", "macOS tar reads UTF-8");
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
			await assert.rejects(extractArchive({ archive, dest: t.dest, locate, run: execRunner() }), (error: unknown) => {
				// bsdtar on Windows may refuse to create the link itself (no privilege): a failed extraction is also a refusal there. Elsewhere the link is
				// created and it is this program's own check that refuses it.
				assert.ok(error instanceof Error);
				if (process.platform !== "win32") assert.ok(error instanceof ExtractRefused && /link/.test(error.message), String(error));
				return true;
			});
			assert.deepEqual(readdirSync(t.dest), [], "nothing stays in the destination");
		}
	});

	it("refuses a FIFO or other special file in the archive, and removes what was extracted (T4-F007)", async () => {
		const t = fresh();
		const archive = t.archive("fifo.tar.gz", tarGz([{ name: "pkg/ok.txt", data: "ok" }, { name: "pkg/bin/tool", type: "fifo" }]));
		await assert.rejects(extractArchive({ archive, dest: t.dest, locate, run: execRunner() }), (error: unknown) => {
			// bsdtar on Windows cannot make a FIFO and fails on its own; elsewhere it makes one, and the walk of the tree refuses it.
			assert.ok(error instanceof Error);
			if (process.platform !== "win32") assert.ok(error instanceof ExtractRefused && /special file/.test(error.message), String(error));
			return true;
		});
		assert.deepEqual(readdirSync(t.dest), [], "no FIFO stays in the destination");
	});

	it("refuses two entries whose names differ only in case before writing anything (T4-F007)", async () => {
		const t = fresh();
		const archive = t.archive("case.tar.gz", tarGz([{ name: "pkg/bin/tool", data: "one" }, { name: "pkg/BIN/tool", data: "two" }]));
		await assert.rejects(extractArchive({ archive, dest: t.dest, locate, run: execRunner() }), (e: unknown) => e instanceof ExtractRefused && /differ only in case/.test((e as Error).message));
		assert.deepEqual(readdirSync(t.dest), [], "nothing was extracted");
	});

	it("refuses an archive whose file name starts with `-`, which tar would take for an option or stdin (T4-F008)", async () => {
		const t = fresh();
		const archive = t.archive("-evil.tar.gz", tarGz([{ name: "pkg/ok.txt", data: "ok" }]));
		await assert.rejects(extractArchive({ archive, dest: t.dest, locate, run: execRunner() }), (e: unknown) => e instanceof ExtractRefused && /starts with `-`/.test((e as Error).message));
		assert.deepEqual(readdirSync(t.dest), []);
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
