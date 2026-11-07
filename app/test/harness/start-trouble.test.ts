import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { logTailsOf, pageLines } from "./start-trouble.ts";

// A failure message is cut at a fixed length, and the stage logs sort before `start.jsonl`: two Windows runs of task 15 lost the supervisor's log that way and said nothing of what the start did.
const scratch = mkdtempSync(join(tmpdir(), "sbd-trouble-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe("the tails of a log folder", () => {
	it("puts the supervisor's and the shell's logs first, with more lines and a wider cut, and the rest after them by name", () => {
		const lines = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => `${tag}${i}`).join("\n");
		writeFileSync(join(scratch, "bootstrap.jsonl"), lines(30, "b"));
		writeFileSync(join(scratch, "stage-git.log"), lines(30, "g"));
		writeFileSync(join(scratch, "start.jsonl"), `${lines(60, "s")}\n${"x".repeat(900)}`);
		writeFileSync(join(scratch, "shell.jsonl"), lines(3, "h"));
		const tails = logTailsOf(scratch);
		assert.deepEqual(tails.map((t) => t.slice(0, t.indexOf(":"))), ["shell.jsonl", "start.jsonl", "bootstrap.jsonl", "stage-git.log"]);
		const start = tails[1] as string;
		assert.equal(start.split(" | ").length, 40, "the supervisor's log keeps 40 lines");
		assert.ok(start.endsWith("x".repeat(520)), "and 520 characters of each");
		assert.equal((tails[2] as string).split(" | ").length, 14, "another log keeps 14 lines");
	});

	it("is empty for a folder that does not exist", () => {
		assert.deepEqual(logTailsOf(join(scratch, "nowhere")), []);
	});
});

describe("the lines about the windows", () => {
	const token = "0123456789abcdef0123456789abcdef";
	const window = (url: string, text: string) => ({ url: () => url, locator: () => ({ innerText: async () => text }) });
	it("never carries a page token, in the address or in the text, even when the cut would have hidden the address's front", async () => {
		const app = { windows: () => [window(`http://127.0.0.1:5123/${token}/`, `the GUI at http://127.0.0.1:5123/${token}/ is up`)] } as unknown as Parameters<typeof pageLines>[0];
		const lines = await pageLines(app);
		assert.equal(lines.length, 1);
		assert.equal((lines[0] ?? "").includes(token), false, lines[0] ?? "");
		assert.match(lines[0] as string, /<token>/);
	});
	it("names a window that cannot be read instead of failing", async () => {
		const app = { windows: () => { throw new Error("closed"); } } as unknown as Parameters<typeof pageLines>[0];
		assert.deepEqual(await pageLines(app), ["pages: (unreadable: closed)"]);
	});
});
