import assert from "node:assert/strict";
import { test } from "node:test";
import { SCHEMA_PATH, STACK_PATH, assetsOf, checkBytes, checkStack, packagesOf, readJson } from "../lib/stack.mjs";
import { validate } from "../lib/schema.mjs";
import { readFileSync } from "node:fs";

const schema = readJson(SCHEMA_PATH);
const fresh = () => structuredClone(readJson(STACK_PATH));

/** The problems checkStack reports after `mutate` changes a copy of the real stack. */
function problems(mutate) {
  const stack = fresh();
  mutate(stack);
  return checkStack(stack, schema);
}

function assertRefused(mutate, pattern) {
  const errors = problems(mutate);
  assert.ok(errors.length > 0, "the stack was accepted");
  assert.ok(errors.some((e) => pattern.test(e)), `no error matches ${pattern}: ${errors.join(" | ")}`);
}

test("the real stack.json is valid", () => {
  assert.deepEqual(checkStack(fresh(), schema), []);
  assert.deepEqual(checkBytes(readFileSync(STACK_PATH)), []);
});

test("the real stack.json holds what task 2 lists", () => {
  const stack = fresh();
  assert.equal(stack.schema, 1);
  assert.ok(Number.isInteger(stack.generation) && stack.generation >= 1);
  assert.deepEqual(Object.keys(stack.tools).sort(), ["fd", "gh", "git", "glab", "herdr", "node", "rg"]);
  for (const [tool, entry] of Object.entries(stack.tools)) {
    assert.deepEqual(Object.keys(entry.assets).sort(), ["darwin-arm64", "darwin-x64", "win32-x64"], tool);
  }
  assert.match(stack.tools.git.assets["darwin-arm64"].url, /desktop\/dugite-native\//);
  assert.match(stack.tools.git.assets["win32-x64"].url, /PortableGit/);
  assert.deepEqual(stack.profile, {
    name: "straw-boss-desk-profile",
    version: "0.1.0",
    integrity: "sha512-wDsiOrkxIB1HNU8XmQ3jvjGQ1cKaqH6GarwEgsIq3eYVoN4SpEJ4i4UIPGUK2sdnb3pb26ULiJnAqBFTiClpBA==",
  });
  const names = packagesOf(stack).map((p) => p.name);
  assert.ok(!names.includes("playwriter"), "playwriter is dropped");
  const ttt = stack.npmGlobal.find((p) => p.bin === "ttt");
  assert.equal(ttt?.optional, true);
  assert.equal(stack.npmGlobal.find((p) => p.bin === "pi")?.optional, undefined);
  assert.equal(assetsOf(stack).length, 7 * 3);
});

test("a missing SHA256 is refused", () => {
  assertRefused((s) => delete s.tools.node.assets["darwin-arm64"].sha256, /missing sha256/);
});

test("a malformed SHA256 is refused", () => {
  assertRefused((s) => (s.tools.gh.assets["win32-x64"].sha256 = s.tools.gh.assets["win32-x64"].sha256.toUpperCase()), /sha256/);
  assertRefused((s) => (s.tools.gh.assets["win32-x64"].sha256 = "abc123"), /sha256/);
  assertRefused((s) => (s.tools.gh.assets["win32-x64"].sha256 = `sha256:${s.tools.gh.assets["win32-x64"].sha256}`), /sha256/);
});

test("a missing URL, a plain http URL, and a missing file are refused", () => {
  assertRefused((s) => delete s.tools.rg.assets["darwin-x64"].url, /missing url/);
  assertRefused((s) => (s.tools.rg.assets["darwin-x64"].url = s.tools.rg.assets["darwin-x64"].url.replace("https:", "http:")), /url/);
  assertRefused((s) => delete s.tools.rg.assets["darwin-x64"].file, /missing file/);
});

test("an unknown platform key is refused", () => {
  for (const key of ["win32-arm64", "linux-x64", "darwin", "win32", "windows-x64", "Darwin-arm64"]) {
    assertRefused((s) => (s.tools.node.assets[key] = structuredClone(s.tools.node.assets["win32-x64"])), new RegExp(`unknown key ${key}`));
  }
});

test("a missing platform key is refused", () => {
  assertRefused((s) => delete s.tools.herdr.assets["darwin-x64"], /missing darwin-x64/);
});

test("a non-exact version is refused, for a tool and for a package", () => {
  for (const version of ["^1.0.0", "~1.0.0", ">=1.0.0", "1.0", "1", "1.x", "*", "latest", "v1.0.0", "1.0.0 - 2.0.0", "1.0.0||2.0.0", ""]) {
    assertRefused((s) => (s.tools.node.assets["win32-x64"].version = version), /version/);
    assertRefused((s) => (s.piPackages[0].version = version), /version/);
    assertRefused((s) => (s.profile.version = version), /version/);
    assertRefused((s) => (s.npmGlobal[0].version = version), /version/);
  }
});

test("a non-string version is refused", () => {
  assertRefused((s) => (s.piPackages[0].version = 1), /expected string/);
});

test("exact versions with four parts or a suffix are accepted for tools", () => {
  for (const version of ["2.56.0.3", "2.56.0-2", "1.0.0-rc.1"]) {
    assert.deepEqual(problems((s) => (s.tools.git.assets["win32-x64"].version = version)), [], version);
  }
});

test("a missing or malformed registry integrity is refused", () => {
  assertRefused((s) => delete s.piPackages[0].integrity, /missing integrity/);
  assertRefused((s) => (s.piPackages[0].integrity = "sha1-aaaaaaaaaaaaaaaaaaaaaaaaaaaa"), /integrity/);
  assertRefused((s) => (s.profile.integrity = s.profile.integrity.slice(0, -4)), /integrity/);
  assertRefused((s) => delete s.profile, /missing profile/);
});

test("the top level is closed", () => {
  assertRefused((s) => (s.extra = 1), /unknown key extra/);
  assertRefused((s) => delete s.generation, /missing generation/);
  assertRefused((s) => delete s.minShell, /missing minShell/);
  assertRefused((s) => (s.schema = 2), /must be 1/);
  assertRefused((s) => (s.generation = 0), /below 1/);
  assertRefused((s) => (s.generation = 1.5), /expected integer/);
  assertRefused((s) => (s.minShell = "1"), /minShell/);
  assertRefused((s) => (s.tools.curl = structuredClone(s.tools.node)), /unknown key curl/);
  assertRefused((s) => delete s.tools.fd, /missing fd/);
});

test("rules a schema cannot say", () => {
  assertRefused((s) => (s.tools.node.assets["win32-x64"].file = "other.zip"), /not the last segment/);
  assertRefused((s) => s.piPackages.push(structuredClone(s.piPackages[0])), /listed twice/);
  assertRefused((s) => (s.npmGlobal[0].optional = true), /pi must be listed and not optional/);
  assertRefused((s) => s.npmGlobal.push({ ...structuredClone(s.npmGlobal[1]), name: "other-ttt" }), /bin ttt is listed twice/);
});

test("the signed bytes must be LF with a final newline and no BOM", () => {
  assert.deepEqual(checkBytes(Buffer.from('{"a":1}\n')), []);
  assert.match(checkBytes(Buffer.from('{"a":1}\r\n'))[0], /carriage return/);
  assert.match(checkBytes(Buffer.from('{"a":1}'))[0], /final newline|newline/);
  assert.match(checkBytes(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d, 0x0a])).join(), /byte order mark/);
});

test("the schema checker throws on a keyword it does not check", () => {
  assert.throws(() => validate({ type: "object", oneOf: [] }, {}), /does not check/);
  assert.throws(() => validate({ $ref: "#/$defs/missing" }, 1), /unresolved/);
});
