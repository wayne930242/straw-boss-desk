import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Logger, REDACTED, Redactor, RotatingFile, SecretRefusedError, loadSecretPatterns, tailLines } from "../src/main/bootstrap/log.ts";

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

// Built at run time, so this file holds no literal that a secret scanner would flag.
const pemOf = (label: string, body: string[]): string => [`-----${"BEGIN"} ${label}-----`, ...body, `-----${"END"} ${label}-----`].join("\n");
const keyBody = ["b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW", "QyNTUxOQAAACDfakefakefakefakefakefakefakefakefakefakeAAAAAAAAAAAAAAAA"];

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

	it("forgets a value that is removed, and refuses a value too short to be a secret with a named error", () => {
		const r = new Redactor(patterns);
		r.add(exact);
		r.remove(exact);
		assert.equal(r.redact(exact), exact);
		assert.throws(() => r.add("abc"), (e: unknown) => e instanceof SecretRefusedError && e.name === "SecretRefusedError" && /at least 4/.test(e.message) && !e.message.includes("abc"));
		assert.throws(() => r.add(""), /at least 4/);
	});

	it("masks the GUI token when punctuation, a closing bracket, or a quote follows it (T4-F003)", () => {
		const r = new Redactor(patterns);
		const around: [string, string][] = [["open ", "."], ["", ", next"], ["(", ")"], ["<", ">"], ["", "&x=1"], ["", ";"], ["'", "'"], ['"', '"'], ["[", "]"], ["{", "}"], ["see ", ".\n"], ["", ""]];
		for (const [before, after] of around) {
			const out = r.redact(`${before}${guiUrl}${after}`);
			assert.ok(!out.includes(guiToken), `${before}<url>${after} came out as ${out}`);
			assert.ok(out.includes("127.0.0.1:41234/<token>"), out);
			assert.ok(out.startsWith(before) && out.endsWith(after), `the text around the URL is kept: ${out}`);
		}
	});

	it("still leaves a long file name with an extension alone, even with a sentence dot after it (T4-F003)", () => {
		const r = new Redactor(patterns);
		for (const url of ["http://127.0.0.1:5555/fixture-archive-of-alpha.zip", "http://localhost:5555/node-v24.22.1-win-x64.zip", "http://127.0.0.1:5555/a-very-long-file-name-here.tar.gz"]) {
			assert.equal(r.redact(url), url);
			assert.equal(r.redact(`fetched ${url}.`), `fetched ${url}.`);
		}
	});

	it("masks a whole PEM block, header to footer, and keeps the text around it (T4-F012)", () => {
		const r = new Redactor(patterns);
		for (const label of ["OPENSSH PRIVATE KEY", "RSA PRIVATE KEY", "PRIVATE KEY", "CERTIFICATE"]) {
			const out = r.redact(`before\n${pemOf(label, keyBody)}\nafter`);
			assert.equal(out, `before\n${REDACTED}\nafter`, label);
		}
		const unfinished = r.redact(`start ${pemOf("EC PRIVATE KEY", keyBody).split("\n").slice(0, 2).join("\n")}`);
		assert.ok(!unfinished.includes(keyBody[0] as string) && unfinished.startsWith("start "), unfinished);
	});

	it("refuses a pattern file without patterns", () => {
		assert.throws(() => loadSecretPatterns({}), /no patterns/);
		assert.throws(() => loadSecretPatterns({ patterns: [{ id: "x" }] }), /no regex/);
	});
});

describe("URL userinfo (T6-F011)", () => {
	const r = new Redactor([]);
	it("masks the user and the password of a proxy URL and keeps the scheme and the host", () => {
		assert.equal(r.redact("HTTPS_PROXY=http://alice:s3cret@proxy.corp.example:8080"), `HTTPS_PROXY=http://${REDACTED}@proxy.corp.example:8080`);
		assert.equal(r.redact("via https://u:p%40ss%3A@10.0.0.1:3128/path?x=1"), `via https://${REDACTED}@10.0.0.1:3128/path?x=1`);
		assert.equal(r.redact("socks5h://dom\\user:pw@host:1080"), `socks5h://${REDACTED}@host:1080`);
	});

	it("masks a password that holds an @ or a colon, every URL on a line, and stops at a quote, a space, or a slash", () => {
		assert.equal(r.redact("http://a:p@ss:w@host:80/"), `http://${REDACTED}@host:80/`);
		assert.equal(r.redact('{"proxy":"http://a:b@h:1","other":"http://c:d@k:2"} done'), `{"proxy":"http://${REDACTED}@h:1","other":"http://${REDACTED}@k:2"} done`);
		assert.equal(r.redact("see <http://a:b@h:1> and http://c:d@k:2 now"), `see <http://${REDACTED}@h:1> and http://${REDACTED}@k:2 now`);
	});

	it("leaves a URL with no password, a port, and an @ after the path alone", () => {
		for (const text of ["ssh://git@github.com/org/repo.git", "http://127.0.0.1:8080/a@b:c", "https://registry.npmjs.org/@earendil-works/pi-coding-agent", "mail to alice@example.com", "C:\\Users\\x\\a:b@c"]) {
			assert.equal(r.redact(text), text);
		}
	});

	it("is applied in events, in stage output, and in the tail, whichever way the line arrives", () => {
		const logs = dir();
		const logger = new Logger({ dir: logs, redactor: new Redactor(patterns) });
		const url = "http://corp-user:corp-pass-9@proxy.corp.example:8080";
		logger.event({ event: "env", HTTPS_PROXY: url, nested: { list: [url, `x ${url} y`] }, [url]: "as a key" });
		const stage = logger.stage("npm");
		stage.raw(`npm http fetch GET 200 ${url.slice(0, 20)}`);
		stage.raw(`${url.slice(20)}/registry\nsecond ${url}\n`);
		stage.flush();
		logger.flush();
		for (const name of ["bootstrap.jsonl", "stage-npm.log"]) {
			const text = readFileSync(join(logs, name), "utf8");
			for (const secret of ["corp-user", "corp-pass-9"]) assert.ok(!text.includes(secret), `${name} holds ${secret}`);
			assert.ok(text.includes("proxy.corp.example:8080"), `${name} keeps the host`);
		}
		assert.ok(logger.tail(40).every((l) => !l.includes("corp-pass-9")));
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

	it("writes none of a PEM block to a stage log, whichever chunks it arrives in, and writes the lines around it (T4-F012)", () => {
		const logs = dir();
		const logger = new Logger({ dir: logs, redactor: new Redactor(patterns) });
		const stage = logger.stage("pem");
		const block = pemOf("OPENSSH PRIVATE KEY", keyBody);
		const cut = block.indexOf(keyBody[0] as string) + 20;
		stage.raw(`line before\ncat key: ${block.slice(0, cut)}`);
		stage.raw(`${block.slice(cut)}\nline after\n`);
		// A block that never closes ends with the command's output, not with the log.
		stage.raw(`${pemOf("RSA PRIVATE KEY", keyBody).split("\n").slice(0, 2).join("\n")}\n`);
		stage.flush();
		stage.raw("next command\n");
		stage.flush();
		const text = readFileSync(join(logs, "stage-pem.log"), "utf8");
		for (const line of keyBody) assert.ok(!text.includes(line), text);
		assert.ok(!/PRIVATE KEY/.test(text), text);
		assert.deepEqual(text.split("\n").filter(Boolean), ["line before", `cat key: ${REDACTED}`, "line after", REDACTED, "next command"]);
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
