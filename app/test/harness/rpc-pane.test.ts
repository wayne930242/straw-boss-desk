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
});
