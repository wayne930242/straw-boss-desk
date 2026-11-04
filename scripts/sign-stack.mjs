#!/usr/bin/env node
// Signs files for the update channels: stack.json, installers and dmgs, each as a detached Ed25519 signature next to the file (`<file>.sig`).
//
//   node scripts/sign-stack.mjs [--key <jwk-or-base64-pkcs8> | --key-env <NAME>] [--out-dir <dir>] <file>...
//   node scripts/sign-stack.mjs [--key ... | --key-env ...] --print-public
//
// The key comes from --key or from the environment variable --key-env names (default SBD_SIGNING_KEY); it is never read from a file and never written. A file named stack.json is
// checked against stack.schema.json first and is not signed when it fails. Exit 0 when every file is signed, 1 when one is not, 2 on a usage error.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { SCHEMA_PATH, checkBytes, checkStack, readJson } from "./lib/stack.mjs";
import { parsePrivateKey, publicKeyOf, signBytes } from "./lib/sign.mjs";

let args;
try {
  args = parseArgs({
    options: {
      key: { type: "string" },
      "key-env": { type: "string", default: "SBD_SIGNING_KEY" },
      "out-dir": { type: "string" },
      "print-public": { type: "boolean", default: false },
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
if (values["out-dir"] !== undefined) mkdirSync(values["out-dir"], { recursive: true });

let failures = 0;
for (const file of positionals) {
  const name = basename(file);
  try {
    const bytes = readFileSync(file);
    if (name === "stack.json") {
      const problems = checkBytes(bytes);
      if (problems.length === 0) {
        try {
          problems.push(...checkStack(JSON.parse(bytes.toString("utf8")), readJson(SCHEMA_PATH)));
        } catch (error) {
          problems.push(error.message);
        }
      }
      if (problems.length > 0) throw new Error(`stack.json is not valid: ${problems[0]}`);
    }
    const out = values["out-dir"] === undefined ? `${file}.sig` : join(values["out-dir"], `${name}.sig`);
    writeFileSync(out, signBytes(bytes, privateKey));
    console.log(`signed ${file} -> ${out}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${file}: ${error.message}`);
  }
}
process.exit(failures === 0 ? 0 : 1);
