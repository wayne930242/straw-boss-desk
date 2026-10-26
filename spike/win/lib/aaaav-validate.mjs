// What pi-aaaav's tool_result hook does after a write or edit, run without a model.
// It copies the spawn from pi-aaaav/pi/validate-tool-use.ts (the file is read first and the call is asserted to be unchanged),
// so the message printed is the one pi would append to the tool result on this machine.
// usage: node aaaav-validate.mjs <pi-aaaav package dir> <file to "write"> <cwd>
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const [pkg, filePath, cwd] = process.argv.slice(2);
const src = readFileSync(join(pkg, "pi", "validate-tool-use.ts"), "utf8");
const faithful = src.includes('spawnSync("python3", [HOOK_SCRIPT]');
const hook = join(pkg, "hooks", "validate_tool_use.py");
const payload = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: filePath }, cwd });
const proc = spawnSync("python3", [hook], { input: payload, encoding: "utf-8", timeout: 15_000 });
let message;
if (proc.error || proc.status !== 0) message = `Validator did not run: ${proc.error?.message || (proc.stderr || "").trim() || `exit ${proc.status}`}`;
else if (!(proc.stdout || "").trim()) message = "(validator ran, no advice)";
else message = JSON.parse(proc.stdout).additionalContext;
console.log(JSON.stringify({ faithfulToSource: faithful, python3Ran: !proc.error && proc.status === 0, message }));
