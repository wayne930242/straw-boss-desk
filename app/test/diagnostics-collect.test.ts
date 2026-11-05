import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { collectDiagnostics, MAX_FILE_BYTES } from "../src/main/diagnostics/collect.ts";
import { runtimeRedactor } from "../src/main/runtime/log.ts";
import { scratchRoot, secretPatterns, testLayout } from "./harness/engine-fixture.ts";
import { readZip } from "./harness/unzip.ts";

// **Collect diagnostics** (task 14 anchor): the zip holds no file from the excluded folders and no planted token. Token-shaped text is assembled at run time.
const PLANTED = `ghp${"_"}PlantedToken0123456789abcdefABCDEF`;
const ODD = "SBD-PLANTED-IN-AN-EXCLUDED-FOLDER";
const redactor = () => runtimeRedactor(secretPatterns);
const bases: string[] = [];
after(() => {
	for (const b of bases) rmSync(b, { recursive: true, force: true });
});

function world() {
	const made = scratchRoot("sbd-diag-");
	bases.push(made.base);
	const layout = testLayout(made.root);
	const put = (path: string, text: string | Buffer): void => {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, text);
	};
	return { ...made, layout, put, out: join(made.base, "out", "diag.zip") };
}

describe("Collect diagnostics", () => {
	it("zips logs, state without start.json, the active stack and the profile manifest, and nothing from the excluded folders or a planted token", () => {
		const w = world();
		const { layout, put } = w;
		put(join(layout.logs, "shell.jsonl"), '{"event":"x"}\n');
		put(join(layout.logs, "stage-node.log"), "ok\n");
		put(join(layout.state, "bootstrap.json"), "{}");
		put(join(layout.state, "accounts.json"), '{"schema":1}');
		put(join(layout.state, "start.json"), `{"pid":1,"${ODD}":1}`);
		put(join(layout.stack, "active.json"), '{"generation":7}');
		put(join(layout.stack, "candidate.json.sig"), "sig");
		put(join(layout.agent, ".straw-boss-profile", "manifest.json"), "{}");
		// Every place the spec says is never collected, each holding a planted value.
		const excluded = [
			join(layout.agent, "auth.json"),
			join(layout.agent, "npm", "package-lock.json"),
			join(layout.claude, ".credentials.json"),
			join(layout.ghConfig, "hosts.yml"),
			join(layout.glabConfig, "config.yml"),
			join(layout.secrets, "linear.bin"),
			layout.gitconfig,
			join(layout.electron, "Local State"),
			join(layout.tools.root, "bin", "gh.cmd"),
			join(layout.recipe, "team.json"),
		];
		for (const f of excluded) put(f, `${PLANTED} ${ODD}`);
		const result = collectDiagnostics({ layout, redactor: redactor(), file: w.out, facts: { app: "Straw Boss Desk Dev 0.0.1" } });
		const files = readZip(w.out);
		const names = files.map((f) => f.name).sort();
		assert.deepEqual(names, ["diagnostics.txt", "logs/shell.jsonl", "logs/stage-node.log", "profile/manifest.json", "stack/active.json", "state/accounts.json", "state/bootstrap.json"]);
		assert.deepEqual(result.names.sort(), names);
		for (const f of files) {
			assert.ok(!f.data.includes(PLANTED), `${f.name} holds the planted token`);
			assert.ok(!f.data.includes(ODD), `${f.name} holds the excluded folders' text`);
		}
	});

	it("passes every text file through the redactor, the summary included", () => {
		const w = world();
		w.put(join(w.layout.logs, "start.jsonl"), `{"detail":"rejected ${PLANTED}"}\n`);
		w.put(join(w.layout.state, "projects.json"), `{"note":"${PLANTED}","url":"http://127.0.0.1:41234/0123456789abcdef0123456789abcdef/"}`);
		collectDiagnostics({ layout: w.layout, redactor: redactor(), file: w.out, facts: { token: PLANTED } });
		for (const f of readZip(w.out)) {
			assert.ok(!f.data.includes(PLANTED), `${f.name} holds the token`);
			assert.ok(!f.data.includes("0123456789abcdef0123456789abcdef/"), `${f.name} holds the page token`);
		}
		assert.match(readZip(w.out).find((f) => f.name === "logs/start.jsonl")?.data.toString() ?? "", /<redacted>/);
	});

	it("leaves out start.json in any case, a file that is not text, and one too large, and says so in diagnostics.txt", () => {
		const w = world();
		w.put(join(w.layout.state, "Start.JSON"), "{}");
		w.put(join(w.layout.state, "wizard.json"), "{}");
		w.put(join(w.layout.logs, "binary.log"), Buffer.from([1, 2, 0, 3]));
		w.put(join(w.layout.logs, "huge.log"), Buffer.alloc(MAX_FILE_BYTES + 1, 97));
		const result = collectDiagnostics({ layout: w.layout, redactor: redactor(), file: w.out, facts: {} });
		const names = readZip(w.out).map((f) => f.name);
		assert.ok(!names.some((n) => /start\.json/i.test(n)), "start.json is not collected");
		assert.ok(names.includes("state/wizard.json"));
		assert.deepEqual(result.skipped.map((s) => `${s.name}:${s.reason}`).sort(), ["logs/binary.log:binary", "logs/huge.log:too-large"]);
		const summary = readZip(w.out).find((f) => f.name === "diagnostics.txt")?.data.toString() ?? "";
		assert.match(summary, /logs\/binary\.log \(binary\)/);
		assert.match(summary, /logs\/huge\.log \(too-large\)/);
	});

	it("never follows a link: a link in logs/ that points at secrets/ carries nothing in", { skip: process.platform === "win32" ? "creating a link needs a privilege on Windows" : false }, () => {
		const w = world();
		w.put(join(w.layout.secrets, "linear.bin"), ODD);
		mkdirSync(w.layout.logs, { recursive: true });
		symlinkSync(join(w.layout.secrets, "linear.bin"), join(w.layout.logs, "innocent.log"));
		symlinkSync(w.layout.secrets, join(w.layout.logs, "folder"));
		const result = collectDiagnostics({ layout: w.layout, redactor: redactor(), file: w.out, facts: {} });
		for (const f of readZip(w.out)) assert.ok(!f.data.includes(ODD), f.name);
		assert.deepEqual(result.skipped.map((s) => s.reason), ["link", "link"]);
	});

	it("writes no archive when the collection fails midway", () => {
		const w = world();
		w.put(join(w.layout.logs, "a.log"), "a");
		assert.throws(() => collectDiagnostics({ layout: w.layout, redactor: { redact: () => { throw new Error("redactor broke"); } }, file: w.out, facts: {} }), /redactor broke/);
		assert.throws(() => readZip(w.out));
	});
});
