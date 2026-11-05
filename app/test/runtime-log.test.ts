import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { RuntimeLog, runtimeRedactor } from "../src/main/runtime/log.ts";
import { credUrl } from "./harness/cred-url.ts";
import { scratchRoot, secretPatterns } from "./harness/engine-fixture.ts";

// `logs/start.jsonl` keeps the output of other tools (the sb server's log tail, a CLI's stderr), so it is redacted with the credential shapes of recipe/secret-patterns.json (T8A-F007).

const scratch: string[] = [];
after(() => {
	for (const d of scratch) removeTree(d);
});

// Token-shaped text is assembled at run time, so this repository holds no literal of that shape.
const fake = (prefix: string, rest: string): string => `${prefix}${rest}`;
const TOKENS = {
	github: fake("ghp", "_0123456789abcdefghijABCDEFGHIJ012345"),
	gitlab: fake("glpat", "-0123456789abcdefABCD"),
	anthropic: fake("sk-ant", "-api03-0123456789abcdef0123456789abcdef"),
};

function logWith(redactor: ReturnType<typeof runtimeRedactor>) {
	const made = scratchRoot("sbd-rlog-");
	scratch.push(made.base);
	const log = new RuntimeLog({ dir: join(made.base, "logs"), redactor });
	return { log, text: () => readFileSync(join(made.base, "logs", "start.jsonl"), "utf8") };
}

describe("a muted log (Remove all data deletes the folder it writes to)", () => {
	it("writes nothing after mute, and does not throw when the folder is gone", () => {
		const made = scratchRoot("sbd-rlog-mute-");
		scratch.push(made.base);
		const dir = join(made.base, "logs");
		const log = new RuntimeLog({ dir, redactor: runtimeRedactor(secretPatterns) });
		log.event({ event: "before" });
		log.mute();
		removeTree(dir);
		assert.doesNotThrow(() => log.event({ event: "after" }));
		assert.equal(existsSync(dir), false, "a muted log does not make its folder again");
	});

	it("an unmuted log still throws when its folder is gone: the failure is not hidden", () => {
		const made = scratchRoot("sbd-rlog-gone-");
		scratch.push(made.base);
		const dir = join(made.base, "logs");
		const log = new RuntimeLog({ dir, redactor: runtimeRedactor(secretPatterns) });
		log.event({ event: "before" });
		removeTree(dir);
		assert.throws(() => log.event({ event: "after" }), /ENOENT/);
	});
});

describe("logs/start.jsonl", () => {
	it("masks the credential shapes of the recipe's secret patterns in tool output, as well as the page token and a proxy's userinfo", () => {
		const { log, text } = logWith(runtimeRedactor(secretPatterns));
		log.event({ event: "sb-log-tail", text: `gh: token ${TOKENS.github}` });
		log.event({ event: "stop-note", detail: TOKENS.gitlab });
		log.event({ event: "up-attempt-failed", reason: `rejected ${TOKENS.anthropic}`, nested: { list: [TOKENS.github] } });
		log.event({ event: "probe", gui: "http://127.0.0.1:41234/0123456789abcdef0123456789abcdef/", proxy: credUrl("HTTPS_PROXY=http://alice<c>s3cr3t@proxy.corp:8080") });
		const written = text();
		for (const [name, token] of Object.entries(TOKENS)) assert.ok(!written.includes(token), `${name} token is in the log`);
		assert.ok(!written.includes("0123456789abcdef0123456789abcdef/"), "the page token is in the log");
		assert.ok(!written.includes("s3cr3t"), "the proxy password is in the log");
		assert.ok(written.includes("<redacted>"));
	});

	it("never runs without its patterns: a missing or empty list throws", () => {
		assert.throws(() => runtimeRedactor({}), /no patterns/);
		assert.throws(() => runtimeRedactor(undefined), /no patterns/);
		assert.throws(() => runtimeRedactor({ patterns: [] }), /no patterns/);
	});
});
