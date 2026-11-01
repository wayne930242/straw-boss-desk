import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./schema.mjs";

export const STACK_PATH = fileURLToPath(new URL("../../stack.json", import.meta.url));
export const SCHEMA_PATH = fileURLToPath(new URL("../../stack.schema.json", import.meta.url));

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Every download of the stack as { tool, platform, version, url, sha256, file }. */
export function assetsOf(stack) {
  return Object.entries(stack.tools).flatMap(([tool, entry]) =>
    Object.entries(entry.assets).map(([platform, asset]) => ({ tool, platform, ...asset })),
  );
}

/** Every npm package of the stack as { role, name, version, integrity }. */
export function packagesOf(stack) {
  return [
    ...stack.npmGlobal.map((p) => ({ role: p.optional ? "npmGlobal (optional)" : "npmGlobal", ...p })),
    { role: "profile", ...stack.profile },
    ...stack.piPackages.map((p) => ({ role: "piPackages", ...p })),
  ];
}

/**
 * The bytes of stack.json are what the Ed25519 signature covers, so they must be stable across checkouts:
 * LF line endings, one final newline, no byte order mark.
 */
export function checkBytes(bytes) {
  const errors = [];
  if (bytes.includes(0x0d)) errors.push("stack.json contains a carriage return; the signed bytes must use LF");
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) errors.push("stack.json must end with a newline");
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) errors.push("stack.json starts with a byte order mark");
  return errors;
}

/** The schema's violations, then the rules a schema cannot say. Returns the list of problems (empty when the stack is valid). */
export function checkStack(stack, schema) {
  const errors = validate(schema, stack);
  if (errors.length > 0) return errors;

  for (const a of assetsOf(stack)) {
    const where = `$.tools.${a.tool}.assets.${a.platform}`;
    const last = new URL(a.url).pathname.split("/").pop();
    if (last !== a.file && decodeURIComponent(last) !== a.file) errors.push(`${where}: file ${a.file} is not the last segment of its url (${last})`);
  }

  const seen = new Set();
  for (const p of packagesOf(stack)) {
    if (seen.has(p.name)) errors.push(`${p.role}: package ${p.name} is listed twice`);
    seen.add(p.name);
  }
  const bins = new Set();
  for (const p of stack.npmGlobal) {
    if (bins.has(p.bin)) errors.push(`npmGlobal: bin ${p.bin} is listed twice`);
    bins.add(p.bin);
  }
  if (!stack.npmGlobal.some((p) => p.bin === "pi" && !p.optional)) errors.push("npmGlobal: pi must be listed and not optional");
  return errors;
}
