import assert from "node:assert/strict";
import { test } from "node:test";
import { SCHEMA_PATH, STACK_PATH, assetsOf, checkBytes, checkStack, optionalToolNames, packagesOf, readJson } from "../lib/stack.mjs";
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
  assert.equal(stack.generation, 11, "generation 11: pi-straw-boss 0.64.0 and the profile 0.1.2");
  assert.equal(stack.piPackages.find((p) => p.name === "pi-straw-boss")?.version, "0.64.0");
  assert.deepEqual(Object.keys(stack.tools).sort(), ["fd", "gh", "git", "glab", "herdr", "node", "rg"]);
  for (const [tool, entry] of Object.entries(stack.tools)) {
    assert.deepEqual(Object.keys(entry.assets).sort(), ["darwin-arm64", "darwin-x64", "win32-x64"], tool);
  }
  assert.match(stack.tools.git.assets["darwin-arm64"].url, /desktop\/dugite-native\//);
  assert.match(stack.tools.git.assets["win32-x64"].url, /PortableGit/);
  assert.deepEqual(stack.profile, {
    name: "straw-boss-desk-profile",
    version: "0.1.2",
    integrity: "sha512-Jni/GVFxrspv9FJBRoTYOBfEYst8HvK+PV0NyUta9dKXvMHqT4b/jGZknYtiZrbw2+IH+EkD4ShfBh5Tuvm/xA==",
  });
  const names = packagesOf(stack).map((p) => p.name);
  assert.ok(!names.includes("playwriter"), "playwriter is dropped");
  const ttt = stack.npmGlobal.find((p) => p.bin === "ttt");
  assert.equal(ttt?.optional, true);
  assert.equal(stack.npmGlobal.find((p) => p.bin === "pi")?.optional, undefined);
  assert.equal(assetsOf(stack).length, (7 + 1) * 3);
});

test("the real stack.json holds bun as an optional tool, pinned to the release's published checksums", () => {
  const stack = fresh();
  assert.deepEqual(optionalToolNames(stack), ["bun"]);
  assert.ok(!("bun" in stack.tools), "bun is not a required tool");
  const bun = stack.optionalTools.bun;
  assert.deepEqual(Object.keys(bun.assets).sort(), ["darwin-arm64", "darwin-x64", "win32-x64"]);
  for (const asset of Object.values(bun.assets)) {
    assert.equal(asset.version, "1.2.23");
    assert.match(asset.url, /^https:\/\/github\.com\/oven-sh\/bun\/releases\/download\/bun-v1\.2\.23\//);
  }
  // x64 uses the baseline builds, so a CPU or an emulator without AVX2 works; Apple Silicon has no baseline build.
  assert.match(bun.assets["win32-x64"].file, /^bun-windows-x64-baseline\.zip$/);
  assert.match(bun.assets["darwin-x64"].file, /^bun-darwin-x64-baseline\.zip$/);
  assert.match(bun.assets["darwin-arm64"].file, /^bun-darwin-aarch64\.zip$/);
  assert.match(bun.note, /baseline/);
  assert.match(bun.note, /AVX2/);
  assert.deepEqual(
    Object.fromEntries(Object.entries(bun.assets).map(([platform, a]) => [platform, a.sha256])),
    {
      "win32-x64": "bf8b6fd980fc09ffeba4b68bcfeab3babc2c10596dd916eb9163b503b6406866",
      "darwin-arm64": "22f5fa3fff72b0d3b8e7e0f8051ecadf2e41920d474ac62db5279144809c9005",
      "darwin-x64": "fcc6723c8aba646a58443586d1786b909e64061e584b4214a0b67e0451252845",
    },
  );
  assert.ok(assetsOf(stack).filter((a) => a.tool === "bun").every((a) => a.optional === true));
});

test("a stack without optionalTools is still valid", () => {
  assert.deepEqual(problems((s) => delete s.optionalTools), []);
  assert.deepEqual(optionalToolNames({ tools: {} }), []);
});

test("an optional tool with a wrong shape is refused", () => {
  assertRefused((s) => delete s.optionalTools.bun.assets["darwin-x64"], /missing darwin-x64/);
  assertRefused((s) => (s.optionalTools.bun.assets["win32-x64"].sha256 = "abc"), /sha256/);
  assertRefused((s) => delete s.optionalTools.bun.assets["win32-x64"].sha256, /missing sha256/);
  assertRefused((s) => (s.optionalTools.bun.assets["win32-x64"].version = "^1.2.23"), /version/);
  assertRefused((s) => (s.optionalTools.bun.assets["win32-x64"].file = "other.zip"), /optionalTools\.bun\.assets\.win32-x64: file other\.zip is not the last segment/);
  assertRefused((s) => (s.optionalTools.bun.assets["linux-x64"] = structuredClone(s.optionalTools.bun.assets["win32-x64"])), /unknown key linux-x64/);
  assertRefused((s) => delete s.optionalTools.bun.assets, /missing assets/);
  assertRefused((s) => delete s.optionalTools.bun.note, /missing note/);
  assertRefused((s) => (s.optionalTools.bun.note = "  "), /note must say why/);
  assertRefused((s) => (s.optionalTools.bun.optional = true), /unknown key optional/);
});

test("the optional tools are a closed set", () => {
  assertRefused((s) => (s.optionalTools.deno = structuredClone(s.optionalTools.bun)), /unknown key deno/);
  assertRefused((s) => (s.optionalTools.Bun = structuredClone(s.optionalTools.bun)), /unknown key Bun/);
  assertRefused((s) => (s.optionalTools = []), /expected object/);
});

test("an optional tool cannot reuse the name of a required tool", () => {
  // The schema is closed, so this guards the check itself, which stays right when a schema change adds a name.
  const stack = fresh();
  const schemaWithNode = structuredClone(schema);
  schemaWithNode.properties.optionalTools.properties.node = { $ref: "#/$defs/optionalTool" };
  stack.optionalTools.node = structuredClone(stack.optionalTools.bun);
  const errors = checkStack(stack, schemaWithNode);
  assert.ok(errors.some((e) => /node is also a required tool/.test(e)), errors.join(" | "));
});

test("an optional tool cannot take a folder name under tools/ or a hyphenated name", () => {
  // Same reason as above: the schema is closed, so a schema copy that adds the name tests the check itself.
  for (const [name, message] of [["bin", /bin is a folder under tools\//], ["bun-home", /does not match/], ["bun-x", /does not match/]]) {
    const stack = fresh();
    const widened = structuredClone(schema);
    widened.properties.optionalTools.properties[name] = { $ref: "#/$defs/optionalTool" };
    stack.optionalTools[name] = structuredClone(stack.optionalTools.bun);
    const errors = checkStack(stack, widened);
    assert.ok(errors.some((e) => message.test(e)), `${name}: ${errors.join(" | ")}`);
  }
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
