import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { redactedServerLogTail } from "./harness/server-log-tail.ts";

const dirs: string[] = [];
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("the e2e's server.log tail", () => {
	it("keeps the last lines and hides the page token in any form", () => {
		const agent = mkdtempSync(join(tmpdir(), "sbd-slt-"));
		dirs.push(agent);
		mkdirSync(join(agent, "straw-boss"));
		const token = "0123456789abcdef0123456789abcdef";
		const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
		lines.push(`GUI at http://127.0.0.1:4000/${token}/`, `token=${token}`);
		writeFileSync(join(agent, "straw-boss", "server.log"), lines.join("\n"));
		const out = redactedServerLogTail(agent, (t) => t, 5);
		assert.ok(!out.includes(token));
		assert.ok(out.includes("<token>") && out.includes("<hex>"));
		assert.ok(!out.includes("line 90") && out.includes("line 99"));
		assert.match(redactedServerLogTail(join(agent, "none"), (t) => t), /^\(no /);
	});
});
