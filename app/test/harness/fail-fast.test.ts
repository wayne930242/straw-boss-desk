import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { WizardView } from "../../src/shared/wizard.ts";
import { install } from "../../src/renderer/wizard/install.ts";
import { makeCtx } from "../../src/renderer/wizard/common.ts";
import { start } from "../../src/renderer/wizard/start.ts";
import { failedStages, failureEvents, firstFailure, installFailing, parseLines, readPageFailure, startFailing, terminalStartFailure, until, type PageFailure } from "./fail-fast.ts";
import { installMiniDom, MiniElement } from "./mini-dom.ts";

// The e2e waits that stop at the app's own failure (phase 2 stalls). The waits run on the CI runners only; what they read is checked here against the real pages (drawn without a browser) and
// against log and record files shaped as the app writes them.

const T0 = Date.parse("2026-11-08T12:08:00.000Z");
const at = (offsetSeconds: number): string => new Date(T0 + offsetSeconds * 1000).toISOString();

describe("until", () => {
	it("returns the first truthy answer", async () => {
		let n = 0;
		assert.equal(await until("three", 2000, () => (++n >= 3 ? n : undefined), 5), 3);
	});

	it("keeps the last error only while the latest probe threw it (the false 'start.json missing')", async () => {
		let n = 0;
		const probe = () => {
			if (++n === 1) throw new Error("ENOENT start.json");
			return undefined;
		};
		await assert.rejects(until("the stack", 120, probe, 5), (error: Error) => /^timed out after 0\.12 s waiting for the stack$/.test(error.message));
		await assert.rejects(
			until("the file", 80, () => Promise.reject(new Error("ENOENT start.json")), 5),
			(error: Error) => error.message.endsWith("waiting for the file: ENOENT start.json"),
		);
	});

	it("ends at once with the failure's words when failWhen answers, long before the timeout", async () => {
		const began = Date.now();
		let probes = 0;
		await assert.rejects(
			until("the claude step", 600_000, () => (++probes, undefined), { every: 5, failWhen: () => (probes >= 3 ? "the start failed: PowerShell did not answer" : undefined) }),
			(error: Error) => /^stopped after \d+ s waiting for the claude step: the app reported a failure: the start failed: PowerShell did not answer$/.test(error.message),
		);
		assert.ok(Date.now() - began < 2000);
		assert.equal(probes, 3);
	});

	it("lets a success win over a failure that is reported in the same round, and treats a throwing failWhen as no failure", async () => {
		assert.equal(await until("up", 1000, () => "up", { failWhen: () => "failed" }), "up");
		let n = 0;
		const value = await until("later", 2000, () => (++n >= 3 ? "ok" : undefined), {
			every: 5,
			failWhen: () => {
				throw new Error("the page is gone");
			},
		});
		assert.equal(value, "ok");
	});

	it("firstFailure answers the first probe that has something to say", async () => {
		assert.equal(await firstFailure(() => undefined, () => "b", () => "c")(), "b");
		assert.equal(await firstFailure(() => undefined)(), undefined);
	});
});

describe("the logs", () => {
	const line = (offset: number, event: string, extra: Record<string, unknown> = {}) => JSON.stringify({ t: at(offset), event, ...extra });

	it("parseLines skips a line that is cut or not an object", () => {
		assert.deepEqual(parseLines(`${line(0, "begin")}\n{"t":\nnot json\n[1]\n\n${line(1, "x")}`).map((l) => l.event), ["begin", "x"]);
	});

	it("a start is a failure when the latest of begin, sb-server-up and start-failed since the mark is start-failed", () => {
		const lines = parseLines([line(0, "begin"), line(1, "herdr-started"), line(61, "up-attempt-failed"), line(61, "fail", { kind: "start" }), line(62, "start-failed", { kind: "start", reason: "PowerShell did not answer" })].join("\n"));
		assert.equal(terminalStartFailure(lines, T0)?.reason, "PowerShell did not answer");
		assert.equal(terminalStartFailure(lines, T0 + 120_000), undefined, "a failure older than the mark is not this wait's");
		const retried = parseLines([line(0, "begin"), line(2, "start-failed", { kind: "start" }), line(30, "begin")].join("\n"));
		assert.equal(terminalStartFailure(retried, T0), undefined, "a start that was begun again is running, not failed");
		const up = parseLines([line(0, "begin"), line(2, "start-failed", { kind: "start" }), line(30, "begin"), line(40, "sb-server-up")].join("\n"));
		assert.equal(terminalStartFailure(up, T0), undefined);
		const justBefore = parseLines([line(-0.5, "begin"), line(-0.4, "start-failed", { kind: "start" })].join("\n"));
		assert.equal(terminalStartFailure(justBefore, T0), undefined, "a failure written just before the mark is the previous launch's (no clock-skew allowance)");
		assert.equal(terminalStartFailure([], T0), undefined);
		assert.equal(terminalStartFailure(parseLines(line(0, "begin")), T0), undefined);
	});

	it("failureEvents prints the reasons of reach, a failed result, up-attempt-failed, fail, start-failed and the sb log tail, and leaves out the rest", () => {
		const dir = mkdtempSync(join(tmpdir(), "ff-"));
		try {
			writeFileSync(
				join(dir, "bootstrap.jsonl"),
				[
					line(0, "run-begin"),
					line(1, "result", { stage: "node", status: "installed" }),
					line(8, "reach", { stage: "preflight", ms: 8073, results: ["github.com: path (no answer within 8 s)", "nodejs.org: ok (200)"] }),
					line(8, "result", { stage: "preflight", status: "failed", category: "network", sentence: "cannot reach github.com", detail: "cannot reach github.com (path: no answer within 8 s)" }),
				].join("\n"),
			);
			writeFileSync(
				join(dir, "start.jsonl"),
				[
					line(70, "begin"),
					line(131, "up-attempt-failed", { round: 1, class: "start", exit: 1, timedOut: false, reason: "the server did not answer hello within 60 s" }),
					line(131, "fail", { kind: "start", step: "up", reason: "PowerShell did not answer within 60 s" }),
					line(132, "sb-log-tail", { text: `${"x".repeat(900)}phase name=breakaway ms=60131 via=failed pid=0` }),
					line(132, "start-failed", { kind: "start", reason: "PowerShell did not answer within 60 s" }),
				].join("\n"),
			);
			const events = failureEvents({ state: dir, logs: dir }, T0);
			const text = events.join("\n");
			assert.match(text, /reach .*results=github\.com: path \(no answer within 8 s\); nodejs\.org: ok \(200\)/);
			assert.match(text, /result .*stage=preflight status=failed category=network .*detail=cannot reach github\.com \(path: no answer within 8 s\)/);
			assert.match(text, /up-attempt-failed .*class=start exit=1 .*reason=the server did not answer hello within 60 s/);
			assert.match(text, /fail .*kind=start .*reason=PowerShell did not answer within 60 s/);
			assert.match(text, /sb-log-tail .*phase name=breakaway ms=60131 via=failed pid=0/);
			assert.match(text, /start-failed .*kind=start/);
			assert.doesNotMatch(text, /run-begin|installed/);
			assert.equal(failureEvents({ state: dir, logs: dir }, T0, 2).length, 2);
			assert.deepEqual(failureEvents({ state: dir, logs: dir }, T0 + 1_000_000), []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the stage records", () => {
	const dir = mkdtempSync(join(tmpdir(), "ff-state-"));
	after(() => rmSync(dir, { recursive: true, force: true }));
	const write = (stages: Record<string, unknown>) => writeFileSync(join(dir, "bootstrap.json"), JSON.stringify({ schema: 1, stages }));
	const note = (offset: number, message = "cancelled") => ({ category: "other", version: null, message, at: at(offset) });

	it("counts a failed record noted since the mark, and not a cancelled one (a quit left it), an older one, nor running or ok ones", () => {
		write({
			preflight: { status: "ok", version: "1", lastFailure: note(500, "kept an older version") },
			node: { status: "failed", lastFailure: note(-60) },
			git: { status: "running", lastFailure: note(10) },
			herdr: { status: "failed", lastFailure: note(10, "cannot reach github.com") },
			pi: { status: "failed" },
			"pkg:a": { status: "failed", lastFailure: note(10) },
		});
		assert.deepEqual(failedStages({ state: dir, logs: dir }, T0).map((s) => [s.stage, s.message]), [["herdr", "cannot reach github.com"]]);
		assert.deepEqual(failedStages({ state: dir, logs: dir }, T0 + 20_000), []);
		write({ herdr: { status: "failed", lastFailure: note(-0.5, "failed just before the mark") } });
		assert.deepEqual(failedStages({ state: dir, logs: dir }, T0), [], "no clock-skew allowance");
	});

	it("is empty with no record, or a record that is not JSON", () => {
		assert.deepEqual(failedStages({ state: join(dir, "nowhere"), logs: dir }, T0), []);
		writeFileSync(join(dir, "bootstrap.json"), "{");
		assert.deepEqual(failedStages({ state: dir, logs: dir }, T0), []);
	});
});

// ---- the wizard's pages, drawn without a browser ------------------------------------------------------------------------------------------------------------------------------------------------

let undoDom = (): void => undefined;
before(() => {
	undoDom = installMiniDom();
});
after(() => undoDom());

const wizardView = (over: Partial<WizardView>): WizardView =>
	({
		step: "install",
		steps: ["welcome", "recipe", "trust", "folder", "install", "start", "claude", "hosts", "linear", "projects", "done"],
		locale: "en",
		root: "/r",
		dev: true,
		install: { status: "running", stages: [{ name: "node", badge: "working" }], current: "node", failures: [], tail: [], crashed: null },
		start: { status: "idle", failure: null },
		...over,
	}) as unknown as WizardView;

/** What `readPageFailure` sees on a page: the drawn step inside a body, with `document` standing for that body while it runs. */
function read(step: MiniElement): PageFailure | null {
	const body = new MiniElement("body");
	body.appendChild(step);
	const g = globalThis as unknown as { document?: unknown };
	const kept = g.document;
	g.document = body;
	try {
		return readPageFailure();
	} finally {
		g.document = kept;
	}
}
const ctxOf = (view: WizardView) => makeCtx(view, view.locale, () => undefined);

describe("readPageFailure reads the pages the wizard draws", () => {
	it("a running install is no failure", () => {
		assert.equal(read(install(ctxOf(wizardView({}))) as unknown as MiniElement), null);
	});

	it("a failed install: the sentence the page shows and its details", () => {
		const failure = { stage: "preflight", category: "network", params: { host: "github.com", cause: "path" }, detail: "cannot reach github.com (path: no answer within 8 s)" };
		const view = wizardView({ install: { status: "failed", stages: [{ name: "preflight", badge: "failed" }], current: null, failures: [failure], tail: [], crashed: null } } as Partial<WizardView>);
		const found = read(install(ctxOf(view)) as unknown as MiniElement);
		assert.equal(found?.where, "install");
		assert.ok((found?.sentences[0] ?? "").length > 0, "the page's own sentence");
		assert.match(found?.details ?? "", /cannot reach github\.com \(path: no answer within 8 s\)/);
	});

	it("a failed start: the sentence, its data-kind and the details, on the start step", () => {
		const failure = { kind: "start", reason: "the server did not answer hello within 60 s", offerRepair: false };
		const view = wizardView({ step: "start", start: { status: "failed", failure } } as Partial<WizardView>);
		const found = read(start(ctxOf(view)) as unknown as MiniElement);
		assert.equal(found?.where, "start");
		assert.equal(found?.kind, "start");
		assert.ok((found?.sentences[0] ?? "").length > 0);
		assert.equal(found?.details, "the server did not answer hello within 60 s");
		assert.equal(read(start(ctxOf(wizardView({ step: "start", start: { status: "starting", failure: null } } as Partial<WizardView>))) as unknown as MiniElement), null);
	});
});

describe("installFailing and startFailing", () => {
	const dir = mkdtempSync(join(tmpdir(), "ff-probe-"));
	after(() => rmSync(dir, { recursive: true, force: true }));
	const folders = { state: join(dir, "state"), logs: join(dir, "logs") };
	mkdirSync(folders.state, { recursive: true });
	mkdirSync(folders.logs, { recursive: true });
	const pageWith = (found: PageFailure | null) => ({ evaluate: async () => found }) as unknown as Parameters<typeof installFailing>[2];

	it("installFailing says nothing while the install runs, and gives the sentence, the stage and the reach reason when it fails", async () => {
		assert.equal(await installFailing(folders, T0, pageWith(null))(), undefined);
		writeFileSync(join(folders.state, "bootstrap.json"), JSON.stringify({ schema: 1, stages: { preflight: { status: "failed", lastFailure: { category: "network", message: "cannot reach github.com (path: no answer within 8 s)", at: at(8) } } } }));
		writeFileSync(join(folders.logs, "bootstrap.jsonl"), `${JSON.stringify({ t: at(8), event: "reach", results: ["github.com: path (no answer within 8 s)"] })}\n`);
		const said = await installFailing(folders, T0, pageWith({ where: "install", sentences: ["Could not reach github.com."], kind: "", details: "cannot reach github.com" }))();
		assert.match(said ?? "", /the install failed: preflight \(network\): cannot reach github\.com/);
		assert.match(said ?? "", /the page says "Could not reach github\.com\." \(install step\)/);
		assert.match(said ?? "", /reach .*github\.com: path \(no answer within 8 s\)/);
		assert.equal(await installFailing(folders, T0 + 60_000, pageWith(null))(), undefined, "the record is older than the wait");
		assert.match((await installFailing(folders, T0 + 60_000, pageWith({ where: "install", sentences: ["x"], kind: "", details: "" }))()) ?? "", /the install failed/, "the page alone is enough");
		assert.equal(await installFailing(folders, T0 + 60_000, pageWith({ where: "start", sentences: ["x"], kind: "start", details: "" }))(), undefined, "a start failure is not an install failure");
	});

	it("startFailing gives the app's sentence, data-kind and the reasons of up-attempt-failed and sb-log-tail", async () => {
		writeFileSync(
			join(folders.logs, "start.jsonl"),
			[
				{ t: at(70), event: "begin" },
				{ t: at(131), event: "up-attempt-failed", class: "start", exit: 1, reason: "PowerShell did not answer within 60 s" },
				{ t: at(132), event: "sb-log-tail", text: "phase name=breakaway via=failed pid=0" },
				{ t: at(132), event: "start-failed", kind: "start", step: "up", reason: "PowerShell did not answer within 60 s" },
			]
				.map((l) => JSON.stringify(l))
				.join("\n"),
		);
		const said = await startFailing(folders, T0, pageWith({ where: "start", sentences: ["Straw Boss could not start."], kind: "start", details: "PowerShell did not answer within 60 s" }))();
		assert.match(said ?? "", /the start failed: start-failed kind=start step=up reason=PowerShell did not answer within 60 s/);
		assert.match(said ?? "", /the page says "Straw Boss could not start\." \(start step, data-kind=start\)/);
		assert.match(said ?? "", /up-attempt-failed .*reason=PowerShell did not answer within 60 s/);
		assert.match(said ?? "", /sb-log-tail .*via=failed pid=0/);
		assert.ok((said ?? "").length <= 2400);
		// Too long: the oldest events are cut and the newest stay.
		const many = [{ t: at(70), event: "begin" }, ...Array.from({ length: 5 }, (_, i) => ({ t: at(100 + i), event: "reach", results: [`old-${i}: ${"y".repeat(230)}`] })), { t: at(131), event: "sb-log-tail", text: `${"z".repeat(900)}newest-log-end` }, { t: at(132), event: "start-failed", kind: "start", reason: "newest-reason" }];
		writeFileSync(join(folders.logs, "start.jsonl"), many.map((l) => JSON.stringify(l)).join("\n"));
		const long = (await startFailing(folders, T0, pageWith({ where: "start", sentences: ["s".repeat(900)], kind: "start", details: "d".repeat(900) }))()) ?? "";
		assert.ok(long.length <= 2400, `${long.length}`);
		assert.match(long, /newest-log-end/);
		assert.match(long, /start-failed .*newest-reason/);
		assert.doesNotMatch(long, /old-0/);
		assert.equal(await startFailing(folders, T0 + 600_000)(), undefined, "no start since the mark");
		writeFileSync(join(folders.logs, "start.jsonl"), `${JSON.stringify({ t: at(70), event: "begin" })}\n`);
		assert.equal(await startFailing(folders, T0)(), undefined, "a start under way");
		assert.match((await startFailing(folders, T0, pageWith({ where: "start", sentences: ["x"], kind: "start", details: "" }))()) ?? "", /the start failed/, "the page alone is enough");
	});
});
