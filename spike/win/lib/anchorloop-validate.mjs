// What pi-anchorloop's tool_result hook does after a write or edit, run without a model.
// pi-anchorloop 2.2.x validates in-process (pi/support/validators.ts, no Python). This loads that TypeScript validator itself and calls it
// the way pi/validate-tool-use.ts does, after asserting that file still does (`faithfulToSource`). Node refuses to strip types inside
// node_modules, so the validator is copied to a scratch folder first (it imports only node builtins).
// usage: node anchorloop-validate.mjs <pi-anchorloop package dir> <file to "write"> <cwd> [<scratch dir>]
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [pkg, filePath, cwd, scratchArg] = process.argv.slice(2);
const hook = readFileSync(join(pkg, "pi", "validate-tool-use.ts"), "utf8");
const faithful = hook.includes('from "./support/validators.ts"') && hook.includes("validateFile(filePath, cwd)");
const version = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
const scratch = scratchArg ? (mkdirSync(scratchArg, { recursive: true }), scratchArg) : mkdtempSync(join(tmpdir(), "anchorloop-validate-"));
let ran = false;
let message;
try {
  const copy = join(scratch, "validators.ts");
  copyFileSync(join(pkg, "pi", "support", "validators.ts"), copy);
  const { validateFile } = await import(pathToFileURL(copy).href);
  message = validateFile(filePath, cwd) || "(validator ran, no advice)";
  ran = true;
} catch (error) {
  message = `Validator did not run: ${error instanceof Error ? error.message : String(error)}`;
} finally {
  if (!scratchArg) rmSync(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify({ version, faithfulToSource: faithful, ran, message }));
