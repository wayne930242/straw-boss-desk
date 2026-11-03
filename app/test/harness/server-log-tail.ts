// The tail of the sb server's own log, for the e2e output when a start fails ("hello not answered": the log named the path, its content never reached the CI log). The GUI address
// carries the page token, so every address and every long hex run is hidden, and the runtime log's redactor goes over the rest.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hideToken } from "../../src/main/runtime/failure.ts";

export function redactedServerLogTail(agentDir: string, redact: (text: string) => string, lines = 60): string {
	const file = join(agentDir, "straw-boss", "server.log");
	if (!existsSync(file)) return `(no ${file})`;
	const tail = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
	return redact(hideToken(tail).replace(/\b[0-9a-f]{24,}\b/gi, "<hex>"));
}
