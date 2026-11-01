// node --test spike/win/test/token-scan.test.mjs
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { hideSecrets, scan } from "../lib/token-scan.mjs";

const tmp = mkdtempSync(join(tmpdir(), "sbd-scan-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const canary = "canary-" + "0123456789abcdef".repeat(4);

describe("token scan", () => {
  it("self-test: finds the planted string in UTF-8, UTF-16LE and go-keyring form, and nothing in a clean file", () => {
    const d = join(tmp, "plant");
    mkdirSync(d);
    writeFileSync(join(d, "utf8.txt"), `x ${canary} y`);
    writeFileSync(join(d, "utf16.txt"), Buffer.from(`x ${canary} y`, "utf16le"));
    writeFileSync(join(d, "keyring.txt"), `set -w go-keyring-base64:${Buffer.from(canary).toString("base64")}\n`);
    writeFileSync(join(d, "clean.txt"), "nothing here");
    const r = scan([d], canary);
    assert.deepEqual(r.hits.map((p) => p.split("/").pop()).sort(), ["keyring.txt", "utf16.txt", "utf8.txt"]);
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
  it("lists an unreadable file with a reason and does not follow links", () => {
    const d = join(tmp, "locked");
    mkdirSync(d);
    writeFileSync(join(d, "secret.txt"), "x");
    chmodSync(join(d, "secret.txt"), 0o000);
    symlinkSync(join(tmp, "plant"), join(d, "link"));
    const r = scan([d], canary);
    chmodSync(join(d, "secret.txt"), 0o600);
    if (process.getuid?.() !== 0) {
      assert.equal(r.unread.length, 1);
      assert.match(r.unread[0].reason, /open or read, again: EACCES/);
    }
    assert.equal(r.hits.length, 0, "the link to a planted folder is not followed");
  });
  it("hideSecrets replaces known secrets and token-shaped text", () => {
    const out = hideSecrets("a SECRETVALUE1 b ghp_" + "A".repeat(30) + " glpat-abcdefghij12", ["SECRETVALUE1"]);
    assert.equal(out, "a <token> b <token> <token>");
  });
});
