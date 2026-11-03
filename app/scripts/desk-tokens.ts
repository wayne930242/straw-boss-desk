// `node scripts/desk-tokens.ts --write` regenerates `src/renderer/desk-tokens.css` from the pinned pi-straw-boss package; `--check` (the build runs it) fails when the file differs from what the pin gives.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectedTokens } from "./lib/desk-tokens.ts";

const root = join(import.meta.dirname, "..");
const target = join(root, "src", "renderer", "desk-tokens.css");
const mode = process.argv[2];
if (mode !== "--write" && mode !== "--check") throw new Error("usage: desk-tokens.ts --write | --check");

const expected = await expectedTokens(readFileSync(join(root, "..", "stack.json"), "utf8"), process.env.SBD_TOKENS_CACHE);
if (mode === "--write") {
	writeFileSync(target, expected);
	console.log("desk-tokens.css written");
} else if (!existsSync(target) || readFileSync(target, "utf8") !== expected) {
	throw new Error("src/renderer/desk-tokens.css differs from the pinned pi-straw-boss stylesheet: run `npm run tokens`");
} else console.log("desk-tokens.css matches the pin");
