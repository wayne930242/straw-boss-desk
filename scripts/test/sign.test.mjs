import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkSignature, MANIFEST_HEADER, parsePrivateKey, publicKeyOf, shellManifest, signBytes } from "../lib/sign.mjs";

// The keys of these tests exist for the run only: made here, passed in memory or in an environment variable, never written to a file.
const script = fileURLToPath(new URL("../sign-stack.mjs", import.meta.url));
const stackFile = fileURLToPath(new URL("../../stack.json", import.meta.url));
const pair = () => generateKeyPairSync("ed25519");
const pkcs8 = (privateKey) => privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
const jwk = (privateKey) => JSON.stringify(privateKey.export({ format: "jwk" }));

const run = (args, env = {}) => spawnSync(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });

test("a signature over the exact bytes verifies under the public half, from either key form", () => {
  const { privateKey } = pair();
  const bytes = Buffer.from('{"generation":2}\n');
  for (const form of [pkcs8(privateKey), jwk(privateKey)]) {
    const key = parsePrivateKey(form);
    const sig = signBytes(bytes, key);
    assert.match(sig, /^[A-Za-z0-9+/]{86}==\n$/);
    assert.equal(checkSignature(bytes, sig, publicKeyOf(key)), true);
    assert.equal(checkSignature(Buffer.from('{"generation":3}\n'), sig, publicKeyOf(key)), false, "one byte changed");
  }
});

test("refuses a PEM, an empty value, junk and a key of another kind, without echoing the value", () => {
  const { privateKey } = pair();
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  assert.throws(() => parsePrivateKey(pem), /PEM/);
  assert.throws(() => parsePrivateKey(""), /no signing key/);
  assert.throws(() => parsePrivateKey("not a key"), /neither a JWK nor/);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  assert.throws(() => parsePrivateKey(pkcs8(rsa)), /not ed25519/);
  try {
    parsePrivateKey(`${pkcs8(privateKey)}x`);
  } catch (error) {
    assert.ok(!String(error.message).includes(pkcs8(privateKey).slice(0, 20)), "the message holds no part of the key");
  }
});

test("the command signs stack.json next to it, and an installer or a dmg into a manifest with its signature, from an environment variable, and prints the public key", () => {
  const { privateKey } = pair();
  const dir = mkdtempSync(join(tmpdir(), "sbd-sign-"));
  try {
    const installer = join(dir, "setup.exe");
    const dmg = join(dir, "app.dmg");
    writeFileSync(installer, "an installer");
    writeFileSync(dmg, "a disk image");
    const r = run(["--shell-version", "1.2.3", installer, dmg], { SBD_SIGNING_KEY: pkcs8(privateKey) });
    assert.equal(r.status, 0, r.stderr);
    const pub = run(["--print-public"], { SBD_SIGNING_KEY: jwk(privateKey) }).stdout.trim();
    assert.equal(pub, publicKeyOf(privateKey));
    for (const file of [installer, dmg]) {
      const manifest = readFileSync(`${file}.manifest`, "utf8");
      assert.equal(manifest, shellManifest(readFileSync(file), file.slice(dir.length + 1), "1.2.3"));
      assert.ok(manifest.startsWith(`${MANIFEST_HEADER}\nkind: shell\nversion: 1.2.3\nfile: ${file.slice(dir.length + 1)}\nsha512: `));
      assert.equal(checkSignature(Buffer.from(manifest), readFileSync(`${file}.manifest.sig`, "utf8"), pub), true, file);
    }
    assert.deepEqual(readdirSync(dir).sort(), ["app.dmg", "app.dmg.manifest", "app.dmg.manifest.sig", "setup.exe", "setup.exe.manifest", "setup.exe.manifest.sig"], "no signature over the installer's own bytes was written, and no .pem");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an installer is not signed as it is, stack.json is not signed as a shell file, and a bad version is a usage error (R13-F002)", () => {
  const { privateKey } = pair();
  const env = { SBD_SIGNING_KEY: pkcs8(privateKey) };
  const dir = mkdtempSync(join(tmpdir(), "sbd-sign-"));
  try {
    const installer = join(dir, "setup.exe");
    writeFileSync(installer, "an installer");
    const asIs = run([installer], env);
    assert.equal(asIs.status, 1);
    assert.match(asIs.stderr, /--shell-version/);
    const stackDir = mkdtempSync(join(dir, "stack-"));
    writeFileSync(join(stackDir, "stack.json"), readFileSync(stackFile));
    const asShell = run(["--shell-version", "1.0.0", join(stackDir, "stack.json")], env);
    assert.equal(asShell.status, 1);
    assert.match(asShell.stderr, /never share a signature/);
    assert.equal(run(["--shell-version", "soon", installer], env).status, 2);
    assert.deepEqual(readdirSync(dir).sort().filter((n) => n.startsWith("setup")), ["setup.exe"], "nothing was written for a refused file");
    assert.deepEqual(readdirSync(stackDir), ["stack.json"]);
    assert.throws(() => shellManifest(Buffer.from("x"), "../x.exe", "1.0.0"), /plain file name/);
    assert.throws(() => shellManifest(Buffer.from("x"), "x.exe", "one"), /not a version/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--key and --key-env name the key, --out-dir moves the signatures, and a missing key is a usage error", () => {
  const { privateKey } = pair();
  const dir = mkdtempSync(join(tmpdir(), "sbd-sign-"));
  try {
    const file = join(dir, "a.bin");
    writeFileSync(file, "bytes");
    assert.equal(run(["--key", pkcs8(privateKey), "--out-dir", join(dir, "sigs"), "--shell-version", "0.0.2", file]).status, 0);
    assert.deepEqual(readdirSync(join(dir, "sigs")).sort(), ["a.bin.manifest", "a.bin.manifest.sig"]);
    assert.equal(run(["--key-env", "MY_KEY", "--shell-version", "0.0.2", file], { MY_KEY: pkcs8(privateKey) }).status, 0);
    const none = run([file]);
    assert.equal(none.status, 2);
    assert.match(none.stderr, /no signing key/);
    assert.equal(run(["--key", pkcs8(privateKey)]).status, 2, "no file named");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("signs the repository's stack.json, and refuses a stack.json the schema rejects", () => {
  const { privateKey } = pair();
  const env = { SBD_SIGNING_KEY: pkcs8(privateKey) };
  const dir = mkdtempSync(join(tmpdir(), "sbd-sign-"));
  try {
    // the check keys on the file's name, so each file sits in a folder of its own
    const goodDir = mkdtempSync(join(dir, "good-"));
    const badDir = mkdtempSync(join(dir, "bad-"));
    writeFileSync(join(goodDir, "stack.json"), readFileSync(stackFile));
    writeFileSync(join(badDir, "stack.json"), `${JSON.stringify({ ...JSON.parse(readFileSync(stackFile, "utf8")), generation: 0 }, null, 2)}\n`);
    const ok = run([join(goodDir, "stack.json")], env);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(checkSignature(readFileSync(join(goodDir, "stack.json")), readFileSync(join(goodDir, "stack.json.sig"), "utf8"), publicKeyOf(privateKey)), true);
    const refused = run([join(badDir, "stack.json")], env);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /stack\.json is not valid/);
    assert.equal(readdirSync(badDir).includes("stack.json.sig"), false, "no signature was written for an invalid stack");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
