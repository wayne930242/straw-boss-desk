#!/usr/bin/env node
// Signs files for the update channels with the one Ed25519 key.
//
//   node scripts/sign-stack.mjs [--key <jwk-or-base64-pkcs8> | --key-env <NAME>] [--out-dir <dir>] stack.json
//   node scripts/sign-stack.mjs [--key ... | --key-env ...] [--out-dir <dir>] --shell-version <version> <installer-or-dmg>...
//   node scripts/sign-stack.mjs [--key ... | --key-env ...] --print-public
//
// stack.json gets a detached signature over its exact bytes (`stack.json.sig`); its `generation` sits inside the signed bytes. An installer or a dmg gets a manifest that names the kind
// (`shell`), the version, the file's name and its SHA512 (`<file>.manifest`) and a signature of that manifest (`<file>.manifest.sig`), so the app takes the version from the signed text and
// a genuine older installer cannot be served as a newer one. Any other file is refused.
//
// The key comes from --key or from the environment variable --key-env names (default SBD_SIGNING_KEY); it is never read from a file and never written. stack.json is checked against
// stack.schema.json first and is not signed when it fails. Exit 0 when every file is signed, 1 when one is not, 2 on a usage error.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { SCHEMA_PATH, checkBytes, checkStack, readJson } from "./lib/stack.mjs";
import { isVersion, parsePrivateKey, publicKeyOf, shellManifest, signBytes } from "./lib/sign.mjs";

let args;
try {
  args = parseArgs({
    options: {
      key: { type: "string" },
      "key-env": { type: "string", default: "SBD_SIGNING_KEY" },
      "out-dir": { type: "string" },
      "print-public": { type: "boolean", default: false },
      "shell-version": { type: "string" },
    },
    allowPositionals: true,
  });
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
const { values, positionals } = args;

let privateKey;
try {
  privateKey = parsePrivateKey(values.key ?? process.env[values["key-env"]]);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

if (values["print-public"]) {
  console.log(publicKeyOf(privateKey));
  process.exit(0);
}
if (positionals.length === 0) {
  console.error("name at least one file to sign");
  process.exit(2);
}
if (values["shell-version"] !== undefined && !isVersion(values["shell-version"])) {
  console.error(`--shell-version ${JSON.stringify(values["shell-version"])} is not a version`);
  process.exit(2);
}
if (values["out-dir"] !== undefined) mkdirSync(values["out-dir"], { recursive: true });

let failures = 0;
for (const file of positionals) {
  const name = basename(file);
  try {
    const bytes = readFileSync(file);
    const where = (suffix) => (values["out-dir"] === undefined ? `${file}${suffix}` : join(values["out-dir"], `${name}${suffix}`));
    if (values["shell-version"] !== undefined) {
      if (name === "stack.json") throw new Error("stack.json is signed without --shell-version: a stack and a shell file never share a signature");
      const manifest = shellManifest(bytes, name, values["shell-version"]);
      writeFileSync(where(".manifest"), manifest);
      writeFileSync(where(".manifest.sig"), signBytes(Buffer.from(manifest), privateKey));
      console.log(`signed ${file} -> ${where(".manifest")}, ${where(".manifest.sig")}`);
      continue;
    }
    if (name !== "stack.json") throw new Error("only stack.json is signed as it is; an installer or a dmg needs --shell-version <version>");
    const problems = checkBytes(bytes);
    if (problems.length === 0) {
      try {
        problems.push(...checkStack(JSON.parse(bytes.toString("utf8")), readJson(SCHEMA_PATH)));
      } catch (error) {
        problems.push(error.message);
      }
    }
    if (problems.length > 0) throw new Error(`stack.json is not valid: ${problems[0]}`);
    const out = where(".sig");
    writeFileSync(out, signBytes(bytes, privateKey));
    console.log(`signed ${file} -> ${out}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${file}: ${error.message}`);
  }
}
process.exit(failures === 0 ? 0 : 1);
