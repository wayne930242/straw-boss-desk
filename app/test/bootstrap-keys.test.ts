import assert from "node:assert/strict";
import { win32 } from "node:path";
import { describe, it } from "node:test";
import { layoutFromRecord } from "../src/main/paths.ts";
import { fileKey, OutsideRootError, pathOfKey, relativeToRoot } from "../src/main/bootstrap/stage.ts";

// How hashes and evidence name an installed file (T4-F004). The Windows layout is built on any OS: it is only strings and `win32` path rules.

const root = "C:\\Users\\王小明\\AppData\\Local\\straw-boss-desk";
// On Windows the agent folder falls back to `~/.straw-boss-desk/<id>/agent` when %LOCALAPPDATA% lies outside the home: outside the root.
const agent = "C:\\Users\\王小明\\.straw-boss-desk\\ab12cd34\\agent";
const layout = layoutFromRecord({
	schema: 1,
	platform: "win32",
	root,
	realRoot: root,
	home: "C:\\Users\\王小明",
	id: "ab12cd34",
	agentDir: agent,
	configHome: `${root}\\config`,
	fallbackDir: "C:\\Users\\王小明\\.straw-boss-desk\\ab12cd34",
	herdrSocket: `${root}\\config\\herdr\\herdr.sock`,
	herdrSocketBytes: 0,
	sidecarSocketBytes: null,
	reasons: [],
});

describe("fileKey", () => {
	it("names a file under the root relative to it, with `/`, and a file under the agent folder by the agent role", () => {
		assert.equal(fileKey(layout, win32.join(root, "tools", "fd", "10.1.0", "fd.exe")), "tools/fd/10.1.0/fd.exe");
		assert.equal(fileKey(layout, win32.join(agent, "bin", "fd.exe")), "agent:bin/fd.exe");
		assert.equal(pathOfKey(layout, "agent:bin/fd.exe"), win32.join(agent, "bin", "fd.exe"), "and back to the same path");
		assert.equal(pathOfKey(layout, "tools/fd/10.1.0/fd.exe"), win32.join(root, "tools", "fd", "10.1.0", "fd.exe"));
	});

	it("follows the Windows rules: the drive letter and the case of a name do not matter", () => {
		assert.equal(fileKey(layout, win32.join(root.toLowerCase(), "tools", "fd.exe")), "tools/fd.exe");
		assert.equal(fileKey(layout, win32.join(agent.toUpperCase(), "bin", "FD.EXE")), "agent:bin/FD.EXE");
	});

	it("refuses a path under neither folder, on another drive, or beside the root with the same prefix", () => {
		for (const outside of ["D:\\elsewhere\\fd.exe", "C:\\Windows\\System32\\x.exe", `${root}-evil\\fd.exe`, `${agent}2\\bin\\fd.exe`, "C:\\Users\\王小明\\x"]) {
			assert.throws(() => fileKey(layout, outside), OutsideRootError, outside);
		}
		assert.throws(() => fileKey(layout, root), OutsideRootError, "the root itself is not a file");
	});
});

describe("relativeToRoot", () => {
	it("throws for a path outside the root instead of answering with a `..` or absolute path", () => {
		assert.equal(relativeToRoot(layout, win32.join(root, "tools", "x.exe")), "tools/x.exe");
		for (const outside of [win32.join(agent, "bin", "fd.exe"), "D:\\x\\y", `${root}-evil\\x`, root]) {
			assert.throws(() => relativeToRoot(layout, outside), OutsideRootError, outside);
		}
		// The premise: what `relative()` itself gives for them.
		assert.equal(win32.relative(root, "D:\\x\\y"), "D:\\x\\y");
		assert.ok(win32.relative(root, win32.join(agent, "bin", "fd.exe")).startsWith(".."));
	});
});

describe("pathOfKey", () => {
	it("refuses a key that is absolute, climbs out, or is not a plain `/` path", () => {
		for (const bad of ["", "agent:", "../x", "tools/../x", "tools/./x", "tools//x", "/etc/passwd", "C:/x", "C:\\x", "tools\\x", "agent:../x", "agent:/x", "x\0y", "tools/x:stream"]) {
			assert.throws(() => pathOfKey(layout, bad), OutsideRootError, JSON.stringify(bad));
		}
	});
});
