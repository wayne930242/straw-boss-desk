import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { FEEDER, FEEDER_END } from "./rpc-pane.ts";

// The feeder that stands in for a Windows pane's stdin (it is test code, but a pane's pi that never saw the end of its input was a flake of the wizard anchor): run on any system.
const scratch = mkdtempSync(join(tmpdir(), "sbd-feeder-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe("the pane's input feeder", () => {
	it("copies what is appended to its file, then ends at FEEDER_END without passing the marker on", async () => {
		const script = join(scratch, "feed.mjs");
		const input = join(scratch, "input");
		writeFileSync(script, FEEDER);
		writeFileSync(input, "");
		const child = spawn(process.execPath, [script, input], { stdio: ["ignore", "pipe", "inherit"] });
		let out = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
		const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
		appendFileSync(input, '{"id":"a"}\n');
		await new Promise<void>((resolve) => {
			const timer = setInterval(() => {
				if (out.includes('{"id":"a"}')) {
					clearInterval(timer);
					resolve();
				}
			}, 50);
		});
		assert.equal(child.exitCode, null, "it keeps running while the input may grow");
		appendFileSync(input, `{"id":"b"}\n${FEEDER_END}`);
		assert.equal(await exited, 0);
		assert.equal(out, '{"id":"a"}\n{"id":"b"}\n');
	});

	it("still ends when the marker arrives in two reads, and passes none of it on (T15R-F006)", async () => {
		const script = join(scratch, "feed-split.mjs");
		const input = join(scratch, "input-split");
		writeFileSync(script, FEEDER);
		writeFileSync(input, "");
		const child = spawn(process.execPath, [script, input], { stdio: ["ignore", "pipe", "inherit"] });
		let out = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
		const exited = new Promise<number | null | "running">((resolve) => child.once("exit", resolve));
		const until = async (what: string, ok: () => boolean): Promise<void> => {
			for (let i = 0; i < 100 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
			assert.ok(ok(), what);
		};
		try {
			appendFileSync(input, '{"id":"a"}\n');
			await until("the line reaches the reader at once, nothing held back after a newline", () => out === '{"id":"a"}\n');
			// The first half of the marker, then (in a later read) the second half.
			appendFileSync(input, `{"id":"b"}\n${FEEDER_END.slice(0, 7)}`);
			await until("the line before the half marker reaches the reader", () => out === '{"id":"a"}\n{"id":"b"}\n');
			await new Promise((resolve) => setTimeout(resolve, 400));
			assert.equal(out, '{"id":"a"}\n{"id":"b"}\n', "the half marker is held back, not passed on");
			assert.equal(child.exitCode, null);
			appendFileSync(input, FEEDER_END.slice(7));
			const result = await Promise.race([exited, new Promise<"running">((resolve) => setTimeout(() => resolve("running"), 5000))]);
			assert.equal(result, 0, "the split marker ends the feeder");
			assert.equal(out, '{"id":"a"}\n{"id":"b"}\n');
		} finally {
			child.kill();
		}
	});

	it("passes on a tail that only looks like the start of the marker once the next read shows it is not", async () => {
		const script = join(scratch, "feed-lookalike.mjs");
		const input = join(scratch, "input-lookalike");
		writeFileSync(script, FEEDER);
		writeFileSync(input, "");
		const child = spawn(process.execPath, [script, input], { stdio: ["ignore", "pipe", "inherit"] });
		let out = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
		try {
			appendFileSync(input, "##END-");
			await new Promise((resolve) => setTimeout(resolve, 400));
			const seen = (): string => out;
			assert.equal(seen(), "", "held while it may still be the marker");
			appendFileSync(input, "ING\n");
			for (let i = 0; i < 100 && seen() !== "##END-ING\n"; i++) await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(seen(), "##END-ING\n");
			assert.equal(child.exitCode, null);
		} finally {
			child.kill();
		}
	});
});
