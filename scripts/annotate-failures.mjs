// Reads a node:test log and prints GitHub annotations.
// Usage: node scripts/annotate-failures.mjs <log file> <title> [--summary]
// Default: the failing lines as one error annotation, so a failure can be read from the job page without the raw log.
// --summary: the lines the accounts e2e prints (`accounts e2e: ...`, `token search: ...`) as one notice, so a green run shows what it did (a skipped case prints nothing).
import { readFileSync } from "node:fs";

const [file, title = "test failures", mode] = process.argv.slice(2);
let lines = [];
try {
	lines = readFileSync(file, "utf8").split(/\r?\n/);
} catch {
	// No log: the job failed before the tests started.
}
const escape = (v) => v.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const clean = (list) => [...new Set(list.map((l) => l.trim()).filter(Boolean))].join("\n").slice(0, 3500);

if (mode === "--summary") {
	const text = clean(lines.filter((l) => /^(accounts e2e:|token search:)/.test(l.trim())));
	console.log(`::notice title=${escape(title).replace(/,/g, "%2C")}::${escape(text === "" ? "no accounts e2e line was printed (the token cases were skipped, or the run stopped earlier)" : text)}`);
} else {
	const keep = lines.filter((l) => /(^\s*not ok\b|✖|AssertionError|\bError:|^\s*(message|error|expected|actual):|timed out|ENOENT|EACCES|programs under the tools folder|, ppid -?\d+, cwd |^broker\.pid=)/.test(l));
	const text = clean(keep);
	console.log(`::error title=${escape(title).replace(/,/g, "%2C")}::${escape(text === "" ? "no failing lines found in the log" : text)}`);
}
