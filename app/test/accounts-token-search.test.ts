import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { hideSecrets, removeNestedRoots, scan, splitUnread } from "../src/main/accounts/token-search.ts";

// The token search (task 10, R3-F003), with the kit's cases: three forms of one token, a token that straddles a chunk boundary, an unreadable file, and now links and missing roots listed as unread.

const tmp = mkdtempSync(join(tmpdir(), "sbd-scan-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const canary = `canary-${"0123456789abcdef".repeat(4)}`;

describe("token search", () => {
	it("self-test: finds the planted string in UTF-8, UTF-16LE and go-keyring form, and nothing in a clean file", () => {
		const d = join(tmp, "plant");
		mkdirSync(d);
		writeFileSync(join(d, "utf8.txt"), `x ${canary} y`);
		writeFileSync(join(d, "utf16.txt"), Buffer.from(`x ${canary} y`, "utf16le"));
		writeFileSync(join(d, "keyring.txt"), `set -w go-keyring-base64:${Buffer.from(canary).toString("base64")}\n`);
		writeFileSync(join(d, "clean.txt"), "nothing here");
		const r = scan([d], canary);
		assert.deepEqual(r.hits.map((p) => p.split(/[\\/]/).pop()).sort(), ["keyring.txt", "utf16.txt", "utf8.txt"]);
		assert.equal(r.unread.length, 0);
		assert.equal(r.files, 4);
	});

	it("finds a token that straddles the 4 MB chunk boundary", () => {
		const d = join(tmp, "big");
		mkdirSync(d);
		const size = 4 * 1024 * 1024;
		const buf = Buffer.alloc(size + 100, 0x61);
		buf.write(canary, size - 20);
		writeFileSync(join(d, "big.bin"), buf);
		assert.equal(scan([d], canary).hits.length, 1);
	});

	it("lists an unreadable file with a reason", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "file modes are not enforced here" : false }, () => {
		const d = join(tmp, "locked");
		mkdirSync(d);
		writeFileSync(join(d, "secret.txt"), "x");
		chmodSync(join(d, "secret.txt"), 0o000);
		const r = scan([d], canary);
		chmodSync(join(d, "secret.txt"), 0o600);
		assert.equal(r.unread.length, 1);
		assert.match(r.unread[0]?.reason ?? "", /open or read, again: EACCES/);
	});

	it("R3-F003: a linked folder and a linked file are not followed, and are listed as unread with the reason", { skip: process.platform === "win32" ? "symlinks need Developer Mode on Windows; junctions are covered by the same lstat check" : false }, () => {
		const d = join(tmp, "linked");
		mkdirSync(d);
		symlinkSync(join(tmp, "plant"), join(d, "folder-link"), "dir");
		symlinkSync(join(tmp, "plant", "utf8.txt"), join(d, "file-link"));
		const r = scan([d], canary);
		assert.equal(r.hits.length, 0, "the link to a planted folder is not followed");
		assert.deepEqual(r.unread.map((u) => u.path.split(/[\\/]/).pop()).sort(), ["file-link", "folder-link"]);
		assert.ok(r.unread.every((u) => /^link: not followed/.test(u.reason)));
	});

	it("R3-F003: a root that is missing, a file, or a link is listed as unread, so a search over nothing cannot pass for a clean one", () => {
		const file = join(tmp, "a-file.txt");
		writeFileSync(file, "x");
		const r = scan([join(tmp, "no-such-root"), file], canary);
		assert.equal(r.hits.length, 0);
		assert.equal(r.files, 0);
		assert.deepEqual(r.unread.map((u) => u.path).sort(), [file, join(tmp, "no-such-root")].sort());
		assert.match(r.unread.find((u) => u.path.endsWith("no-such-root"))?.reason ?? "", /root missing or unreadable: ENOENT/);
		assert.match(r.unread.find((u) => u.path === file)?.reason ?? "", /root is not a folder/);
	});

	it("hideSecrets replaces known secrets and token-shaped text", () => {
		const out = hideSecrets(`a SECRETVALUE1 b ghp_${"A".repeat(30)} glpat-abcdefghij12`, ["SECRETVALUE1"]);
		assert.equal(out, "a <token> b <token> <token>");
	});
});

describe("unread files and roots", () => {
	const app = "/tmp/sbd-macacct";
	const strictRoots = [app, "/Users/x/sbd-kit"];
	const un = (path: string, reason = "open or read: EBUSY in use") => ({ path, reason });
	it("files under the spec folders and the root itself fail; a folder that only shares the prefix, and extra places, warn", () => {
		const sp = splitUnread([un(`${app}/logs/locked.log`), un(`${app}/tools/downloads/node.zip`), un(app), un("/Users/x/sbd-kit-old/a.bin"), un("/var/folders/t/nsj.tmp/System.dll"), un("/Users/x/.config/z", "list folder: EACCES")], strictRoots, false);
		assert.equal(sp.strict.length, 3);
		assert.equal(sp.extra.length, 3);
		assert.match(sp.extra[2]?.reason ?? "", /EACCES/);
	});
	it("root comparison ignores case when asked (Windows paths)", () => {
		assert.equal(splitUnread([un("/Users/X/Kit/a.bin")], ["/users/x/kit"], true).strict.length, 1);
		assert.equal(splitUnread([un("/Users/X/Kit/a.bin")], ["/users/x/kit"], false).strict.length, 0);
		assert.deepEqual(removeNestedRoots(["/A/b", "/a/B/c"], true), ["/A/b"]);
	});
	it("nothing unread is nothing to report", () => assert.deepEqual(splitUnread([], strictRoots, false), { strict: [], extra: [] }));
	it("a root inside another is dropped, a sibling that shares the prefix is kept", () => {
		assert.deepEqual(removeNestedRoots(["/a/b", "/a", "/a/b/c/", "/d/x", "/a/", "/ab"], false).sort(), ["/a", "/ab", "/d/x"]);
	});
});
