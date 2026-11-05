import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { checkEntryName, dosTime, ZipWriter } from "../src/main/diagnostics/zip.ts";
import { readZip } from "./harness/unzip.ts";

const dirs: string[] = [];
const scratch = (): string => {
	const d = mkdtempSync(join(tmpdir(), "sbd-zip-"));
	dirs.push(d);
	return d;
};
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("the zip writer", () => {
	it("writes entries a reader gets back byte for byte: text, an empty file, random bytes and a CJK name", () => {
		const file = join(scratch(), "out", "a.zip");
		const random = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7919) % 251));
		const w = new ZipWriter(file);
		w.add({ name: "logs/shell.jsonl", data: Buffer.from('{"a":1}\n'.repeat(500)) });
		w.add({ name: "state/空.json", data: Buffer.alloc(0) });
		w.add({ name: "bin.dat", data: random });
		w.finish();
		const back = readZip(file);
		assert.deepEqual(back.map((e) => e.name), ["logs/shell.jsonl", "state/空.json", "bin.dat"]);
		assert.equal(back[0]?.data.toString(), '{"a":1}\n'.repeat(500));
		assert.equal(back[1]?.data.length, 0);
		assert.ok(back[2]?.data.equals(random));
	});

	it("leaves no half-written file: a finished archive has the final name only, an aborted one nothing", () => {
		const dir = scratch();
		const done = new ZipWriter(join(dir, "done.zip"));
		done.add({ name: "a.txt", data: Buffer.from("a") });
		done.finish();
		const aborted = new ZipWriter(join(dir, "aborted.zip"));
		aborted.add({ name: "a.txt", data: Buffer.from("a") });
		aborted.abort();
		assert.deepEqual(readdirSync(dir).sort(), ["done.zip"]);
		assert.ok(!existsSync(join(dir, "aborted.zip")));
	});

	it("refuses a name that climbs out, is absolute, has a drive or a backslash, or repeats", () => {
		for (const bad of ["", "/etc/passwd", "../x", "a/../x", "a//b", "C:/x", "a\\b", "./a", "a\u0000b"]) assert.throws(() => checkEntryName(bad), /not a zip entry name/, JSON.stringify(bad));
		const w = new ZipWriter(join(scratch(), "d.zip"));
		w.add({ name: "a", data: Buffer.from("1") });
		assert.throws(() => w.add({ name: "a", data: Buffer.from("2") }), /twice/);
		w.abort();
	});

	it("packs the DOS time and date words", () => {
		assert.deepEqual(dosTime(new Date(2026, 10, 5, 14, 30, 12)), { time: (14 << 11) | (30 << 5) | 6, date: ((2026 - 1980) << 9) | (11 << 5) | 5 });
	});
});
