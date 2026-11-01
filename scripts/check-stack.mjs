#!/usr/bin/env node
// Checks stack.json: its bytes and schema, then (unless --offline) every asset's SHA256 by download and every package's registry integrity.
//
//   node scripts/check-stack.mjs [--offline] [--stack <file>] [--schema <file>] [--registry <url>] [--concurrency <n>]
//
// Exit 0 when everything holds, 1 when a check fails, 2 on a usage error.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { STACK_PATH, SCHEMA_PATH, assetsOf, checkBytes, checkStack, packagesOf, readJson } from "./lib/stack.mjs";
import { mapLimit, verifyAsset, verifyPackage } from "./lib/verify.mjs";

let args;
try {
  args = parseArgs({
    options: {
      offline: { type: "boolean", default: false },
      stack: { type: "string", default: STACK_PATH },
      schema: { type: "string", default: SCHEMA_PATH },
      registry: { type: "string", default: process.env.STACK_CHECK_REGISTRY ?? "https://registry.npmjs.org" },
      concurrency: { type: "string", default: "4" },
    },
  }).values;
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
const concurrency = Number(args.concurrency);
if (!Number.isInteger(concurrency) || concurrency < 1) {
  console.error("--concurrency must be a positive integer");
  process.exit(2);
}

let failures = 0;
const report = (ok, label, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};

const bytes = readFileSync(args.stack);
const byteErrors = checkBytes(bytes);
byteErrors.forEach((message) => report(false, "bytes", message));
if (byteErrors.length === 0) report(true, "bytes", "LF, final newline");

let stack;
try {
  stack = JSON.parse(bytes.toString("utf8"));
} catch (error) {
  report(false, "json", error.message);
  process.exit(1);
}
const schemaErrors = checkStack(stack, readJson(args.schema));
schemaErrors.forEach((message) => report(false, "schema", message));
if (schemaErrors.length > 0) process.exit(1);
report(true, "schema", `generation ${stack.generation}, minShell ${stack.minShell}`);

if (args.offline) {
  console.log(failures === 0 ? "offline checks passed" : `${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

const assets = assetsOf(stack);
const packages = packagesOf(stack);
console.log(`checking ${assets.length} downloads and ${packages.length} packages, ${concurrency} at a time`);

const jobs = [
  ...assets.map((a) => ({ label: `${a.tool} ${a.version} ${a.platform}`, run: () => verifyAsset(a) })),
  ...packages.map((p) => ({ label: `${p.name}@${p.version}`, run: () => verifyPackage(p, { registry: args.registry }) })),
];
await mapLimit(jobs, concurrency, async (job) => {
  const result = await job.run();
  report(result.ok, job.label, result.detail);
});

console.log(failures === 0 ? `all ${jobs.length} checks passed` : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
