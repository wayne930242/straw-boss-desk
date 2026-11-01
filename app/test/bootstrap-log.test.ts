import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Logger, REDACTED, Redactor, RotatingFile, loadSecretPatterns, tailLines } from "../src/main/bootstrap/log.ts";

const patterns = loadSecretPatterns(JSON.parse(readFileSync(new URL("../../recipe/secret-patterns.json", import.meta.url), "utf8")));
const scratch: string[] = [];
const dir = (): string => {
	const d = realpathSync.native(mkdtempSync(join(tmpdir(), "sbd-log-")));
	scratch.push(d);
	return d;
};
after(() => {
	for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// Token-shaped values are built at run time, so this file holds no literal that a secret scanner would flag.
const ghToken = ["gh", "p_"].join("") + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const gitlabToken = ["gl", "pat-"].join("") + "abcdEFGH1234ijklMNOP";
const guiUrl = "http://127.0.0.1:41234/" + "k3Jx9QwErTyUiOp0AsDfGhJk";
const guiToken = "k3Jx9QwErTyUiOp0AsDfGhJk";
const exact = "plain-secret-value-with-no-token-shape";
const awkward = 'quote"back\\slash secret';

describe("Redactor", () => {
	it("replaces token shapes, the GUI URL token, and registered values by exact match", () => {
		const r = new Redactor(patterns);
		r.add(exact);
		r.add(awkward);
		const text = `a ${ghToken} b ${gitlabToken} c ${guiUrl}/status d ${exact} e ${awkward} f`;
		const out = r.redact(text);
		for (const secret of [ghToken, gitlabToken, guiToken, exact, awkward]) assert.ok(!out.includes(secret), `${secret} was removed`);
		assert.ok(out.includes("127.0.0.1:41234/<token>/status"), "the GUI URL keeps host and port and loses the token");
		assert.ok(out.includes(REDACTED));
	});

	it("catches the percent-encoded form of a registered value and replaces a longer secret whole", () => {
		const r = new Redactor(patterns);
		r.add("abc def&ghi");
		r.add("abc def&ghi-and-more");
		assert.equal(r.redact("q=abc%20def%26ghi and abc def&ghi-and-more!"), `q=${REDACTED} and ${REDACTED}!`);
	});

	it("leaves a download URL on the loopback fixture server alone", () => {
		const r = new Redactor(patterns);
		const url = "http://127.0.0.1:5555/alpha-1.0.0.tar.gz";
		assert.equal(r.redact(url), url);
		assert.equal(r.redact("http://127.0.0.1:5555/fixture-archive-of-alpha.zip"), "http://127.0.0.1:5555/fixture-archive-of-alpha.zip");
	});

	it("forgets a value that is removed, and refuses a value too short to be a secret", () => {
		const r = new Redactor(patterns);
		r.add(exact);
		r.remove(exact);
		assert.equal(r.redact(exact), exact);
		assert.throws(() => r.add("abc"), /at least 4/);
		assert.throws(() => r.add(""), /at least 4/);
	});

	it("refuses a pattern file without patterns", () => {
		assert.throws(() => loadSecretPatterns({}), /no patterns/);
		assert.throws(() => loadSecretPatterns({ patterns: [{ id: "x" }] }), /no regex/);
	});
});

describe("Logger", () => {
	it("writes JSON lines that hold no planted secret, in events, stage output split across chunks, and the tail", () => {
		const logs = dir();
		const redactor = new Redactor(patterns);
		redactor.add(exact);
		redactor.add(awkward);
		const logger = new Logger({ dir: logs, redactor });
		logger.event({ event: "plain", detail: `token ${ghToken}`, nested: { url: guiUrl, list: [exact, awkward] } });
		logger.event({ event: "key", [ghToken]: "as a key" });
		const stage = logger.stage("pkg:thing");
		// The secret is split across two chunks: the line is redacted whole, once it is complete.
		stage.raw(`output ${exact.slice(0, 10)}`);
		stage.raw(`${exact.slice(10)} and ${gitlabToken}\nsecond line ${guiUrl}`);
		stage.flush();
		logger.flush();

		const names = readdirSync(logs).sort();
		assert.deepEqual(names, ["bootstrap.jsonl", "stage-pkg_thing.log"]);
		for (const name of names) {
			const text = readFileSync(join(logs, name), "utf8");
			for (const secret of [ghToken, gitlabToken, guiToken, exact, awkward]) assert.ok(!text.includes(secret), `${name} holds ${secret}`);
		}
		for (const line of readFileSync(join(logs, "bootstrap.jsonl"), "utf8").split("\n").filter(Boolean)) JSON.parse(line);

		// A value registered after the line was written is still removed from the tail that Details shows.
		const late = "registered-after-the-fact-12345";
		logger.event({ event: "late", detail: late });
		redactor.add(late);
		assert.ok(logger.tail(40).every((l) => !l.includes(late)));
	});

	it("returns the last 40 lines", () => {
		const logger = new Logger({ dir: dir(), redactor: new Redactor(patterns) });
		for (let i = 0; i < 100; i++) logger.event({ event: "n", i });
		const tail = logger.tail(40);
		assert.equal(tail.length, 40);
		assert.equal(JSON.parse(tail[39] ?? "{}").i, 99);
		assert.equal(JSON.parse(tail[0] ?? "{}").i, 60);
	});
});

describe("rotation", () => {
	it("rotates at the size limit and keeps ten files, every line whole", () => {
		const logs = dir();
		const logger = new Logger({ dir: logs, redactor: new Redactor(patterns), maxBytes: 400, keep: 10 });
		for (let i = 0; i < 300; i++) logger.event({ event: "line", i, pad: "x".repeat(30) });
		const names = readdirSync(logs).filter((n) => n.startsWith("bootstrap.jsonl")).sort();
		assert.equal(names.length, 10, names.join(","));
		let last = -1;
		for (const name of ["bootstrap.jsonl.9", "bootstrap.jsonl.8", "bootstrap.jsonl.1", "bootstrap.jsonl"]) {
			const lines = readFileSync(join(logs, name), "utf8").split("\n").filter(Boolean);
			assert.ok(lines.length > 0, `${name} has lines`);
			for (const line of lines) {
				const n = (JSON.parse(line) as { i: number }).i;
				assert.ok(n > last, "lines stay in order across files");
				last = n;
				assert.ok(Buffer.byteLength(line) < 400);
			}
		}
		assert.equal(last, 299, "the live file holds the newest line");
		const tail = tailLines(join(logs, "bootstrap.jsonl"), 25);
		assert.equal(tail.length, 25);
		assert.equal((JSON.parse(tail[24] ?? "{}") as { i: number }).i, 299);
	});

	it("rotates a stage log too, and a log larger than the limit from earlier runs rotates on the first append", () => {
		const logs = dir();
		const file = join(logs, "x.log");
		const first = new RotatingFile(file, { maxBytes: 50, keep: 3 });
		first.append("a".repeat(40) + "\n");
		const second = new RotatingFile(file, { maxBytes: 50, keep: 3 });
		second.append("b".repeat(40) + "\n");
		assert.equal(readFileSync(`${file}.1`, "utf8"), "a".repeat(40) + "\n");
		assert.equal(readFileSync(file, "utf8"), "b".repeat(40) + "\n");
		for (let i = 0; i < 5; i++) second.append("c".repeat(40) + "\n");
		assert.deepEqual(readdirSync(logs).sort(), ["x.log", "x.log.1", "x.log.2"]);
	});
});
