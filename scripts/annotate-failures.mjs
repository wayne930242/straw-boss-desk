// Prints the failing lines of a node:test log as one GitHub annotation, so a failure can be read from the job page without the raw log.
// Usage: node scripts/annotate-failures.mjs <log file> <title>
import { readFileSync } from "node:fs";

const [file, title = "test failures"] = process.argv.slice(2);
let lines = [];
try {
	lines = readFileSync(file, "utf8").split(/\r?\n/);
} catch {
	// No log: the job failed before the tests started.
}
const keep = lines.filter((l) => /(^\s*not ok\b|✖|AssertionError|\bError:|^\s*(message|error|expected|actual):|timed out|ENOENT|EACCES)/.test(l));
const text = [...new Set(keep.map((l) => l.trim()).filter(Boolean))].join("\n").slice(0, 3500);
const escape = (v) => v.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
console.log(`::error title=${escape(title).replace(/,/g, "%2C")}::${escape(text === "" ? "no failing lines found in the log" : text)}`);
