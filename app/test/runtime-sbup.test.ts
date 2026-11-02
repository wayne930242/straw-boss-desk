import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KIT_EXIT_CODE, START_FAILURE_KINDS, StartFailureError, hideToken } from "../src/main/runtime/failure.ts";
import { catalogs } from "../src/renderer/i18n/index.ts";
import { checkUpAnswer, classifyUp, lastJsonLine, runUp, upAnswerOf, upSuccessOf, type UpAnswer, type UpDeps } from "../src/main/runtime/sbup.ts";

// `cli.mjs up` and its failure table (spec: Start; desk B7 plan, Exit codes). Every row is a case with no process.

const TOKEN = "0123456789abcdef0123456789abcdef";
const URL = `http://127.0.0.1:41234/${TOKEN}/`;
const okJson = (over: Record<string, unknown> = {}) => ({
	url: URL,
	pid: 4321,
	started: "Mon Nov  2 10:00:00 2026",
	log: "/agent/straw-boss/server.log",
	desk: true,
	server: "started",
	version: "0.51.0",
	workspace: "w1",
	pane: "p1",
	tower: "t1",
	created: true,
	integration: "installed",
	warnings: [],
	...over,
});
const answer = (over: Partial<UpAnswer> & { err?: Record<string, unknown> | null }): UpAnswer => ({ exit: 0, timedOut: false, ok: null, err: null, stdout: "", stderr: "", ...over });
const failure = (err: Record<string, unknown>, exit = 1): UpAnswer => answer({ exit, err, stderr: `${JSON.stringify(err)}\n` });
const success = (over: Record<string, unknown> = {}): UpAnswer => answer({ exit: 0, ok: okJson(over), stdout: `${JSON.stringify(okJson(over))}\n` });

function deps(answers: UpAnswer[], over: Partial<UpDeps> = {}): UpDeps & { ran: number; slept: number[]; events: Array<Record<string, unknown>>; calls: string[] } {
	const state = { ran: 0, slept: [] as number[], events: [] as Array<Record<string, unknown>>, calls: [] as string[] };
	return Object.assign(state, {
		async runUp() {
			const next = answers[state.ran++];
			if (next === undefined) throw new Error("up ran more often than the test expected");
			return next;
		},
		async herdrAnswers() {
			state.calls.push("herdrAnswers");
			return true;
		},
		async restartHerdr() {
			state.calls.push("restartHerdr");
			return true;
		},
		async downgrade() {
			state.calls.push("downgrade");
			return true;
		},
		async repairPackage(code: "loader" | "intercom") {
			state.calls.push(`repair ${code}`);
			return true;
		},
		async sleep(ms: number) {
			state.slept.push(ms);
		},
		log: (f: Record<string, unknown>) => state.events.push(f),
		herdrReused: false,
		...over,
	}) as never;
}

const failureOf = async (p: Promise<unknown>): Promise<StartFailureError> => {
	try {
		await p;
	} catch (error) {
		assert.ok(error instanceof StartFailureError, String(error));
		return error;
	}
	throw new Error("expected a StartFailureError");
};

describe("the kit's exit codes are typed failures with a sentence in both catalogs", () => {
	it("carries every code of start.ps1 (2 to 27) as a kind", () => {
		const expected: Record<string, number> = {
			"tool-missing": 2, "foreign-stack": 3, "herdr-silent": 4, lock: 10, start: 11, hello: 12, exit: 13, herdr: 14, version: 15, server: 16, gui: 17, other: 18,
			"cannot-run": 19, loader: 19, intercom: 19, acl: 19, usage: 20, "no-url": 21, slot: 22, "base-busy": 23, base: 24, integration: 25, "no-base": 26, tower: 27,
		};
		for (const [kind, code] of Object.entries(expected)) assert.equal(KIT_EXIT_CODE[kind as keyof typeof KIT_EXIT_CODE], code, kind);
		assert.deepEqual([...new Set(Object.values(expected))].sort((x, y) => x - y), [2, 3, 4, ...Array.from({ length: 18 }, (_, i) => i + 10)], "2 to 4 and 10 to 27: the codes 5 to 9 were reserved or never used");
	});

	it("has a screen sentence for every kind in en and zh-TW", () => {
		for (const locale of ["en", "zh-TW"] as const) {
			const sentences = catalogs[locale].start.failure as Record<string, string>;
			for (const kind of START_FAILURE_KINDS) assert.ok(typeof sentences[kind] === "string" && sentences[kind] !== "", `${locale} lacks start.failure.${kind}`);
			assert.deepEqual(Object.keys(sentences).sort(), [...START_FAILURE_KINDS].sort(), `${locale} names a kind that does not exist`);
		}
	});
});

describe("classifyUp", () => {
	it("reads each row of the exit table", () => {
		assert.equal(classifyUp(success()), "ok");
		assert.equal(classifyUp(answer({ exit: 0, ok: { pid: 1 } })), "nourl");
		assert.equal(classifyUp(answer({ exit: 2 })), "usage");
		for (const code of ["loader", "intercom", "acl"]) assert.equal(classifyUp(failure({ startError: { code } }, 3)), code);
		assert.equal(classifyUp(failure({ startError: { code: "other" } }, 3)), "cannotrun");
		assert.equal(classifyUp(answer({ exit: 3 })), "cannotrun");
		for (const wait of ["lock", "start", "hello", "exit"]) assert.equal(classifyUp(failure({ step: "server", wait })), wait);
		for (const step of ["herdr", "version", "server", "gui", "base", "integration", "tower"]) assert.equal(classifyUp(failure({ step })), step);
		assert.equal(classifyUp(failure({ step: "base", reason: "busy: desk.lock is held" })), "basebusy");
		assert.equal(classifyUp(failure({ step: "base", reason: "the folder is not there" })), "base");
		assert.equal(classifyUp(failure({ step: "mystery" })), "other");
		assert.equal(classifyUp(answer({ exit: null, timedOut: true })), "other");
		assert.equal(classifyUp(answer({ exit: 1 })), "other");
	});

	it("takes the last JSON line of the output", () => {
		assert.deepEqual(lastJsonLine('warming up\n{"a":1}\nnot json {\n{"b":2}\n'), { b: 2 });
		assert.equal(lastJsonLine("nothing here"), null);
		assert.equal(upAnswerOf({ code: 0, stdout: `x\n${JSON.stringify(okJson())}\n`, stderr: '{"step":"gui"}' }).err?.step, "gui");
	});
});

describe("runUp: the retry rules", () => {
	it("returns a good answer at once", async () => {
		const d = deps([success()]);
		const up = await runUp(d);
		assert.equal(up.pid, 4321);
		assert.equal(up.server, "started");
		assert.equal(d.ran, 1);
	});

	it("retries lock, hello and exit once; a second failure of the same row is shown", async () => {
		for (const wait of ["lock", "hello", "exit"]) {
			const again = deps([failure({ step: "server", wait, reason: "r" }), success()]);
			assert.equal((await runUp(again)).pid, 4321, `${wait} then ok`);
			assert.deepEqual(again.slept, [1000]);
			const twice = deps([failure({ step: "server", wait, reason: "first" }), failure({ step: "server", wait, reason: "second" })]);
			const error = await failureOf(runUp(twice));
			assert.equal(error.failure.kind, wait);
			assert.equal(error.failure.reason, "second");
		}
	});

	it("shows start, gui, tower, server, and other at once, with the log tail asked for the ones a person needs it for", async () => {
		for (const [step, wait, kind, tail] of [["server", "start", "start", true], ["gui", undefined, "gui", true], ["tower", undefined, "tower", true], ["server", undefined, "server", false], ["integration", undefined, "integration", false], ["mystery", undefined, "other", true]] as const) {
			let tailAsked = 0;
			const d = deps([failure({ step, ...(wait ? { wait } : {}), reason: "boom" })], { logTail: async () => ((tailAsked += 1), `tail ${URL}`) });
			const error = await failureOf(runUp(d));
			assert.equal(error.failure.kind, kind);
			assert.equal(d.ran, 1, `${kind} is not retried`);
			assert.equal(tailAsked, tail ? 1 : 0, `${kind}: log tail`);
			assert.ok(!JSON.stringify(d.events).includes(TOKEN), "the tail is logged without the page token");
		}
	});

	it("herdr: a record that serves another socket is shown; a silent Herdr gets one look, then one restart when this run started it", async () => {
		const serves = deps([failure({ step: "herdr", reason: "the record serves another socket" })]);
		assert.equal((await failureOf(runUp(serves))).failure.kind, "herdr");
		assert.deepEqual(serves.calls, []);

		const answers = deps([failure({ step: "herdr", reason: "no Herdr answers" }), success()]);
		assert.equal((await runUp(answers)).pid, 4321);
		assert.deepEqual(answers.calls, ["herdrAnswers"], "it answered on the first look");

		let looks = 0;
		const silent = deps([failure({ step: "herdr", reason: "no Herdr answers" }), success()], {
			async herdrAnswers() {
				looks++;
				return false;
			},
		});
		assert.equal((await runUp(silent)).pid, 4321);
		assert.equal(looks, 30, "30 looks, 500 ms apart");
		assert.ok(silent.slept.filter((ms) => ms === 500).length === 30);
		assert.ok(silent.events.some((e) => e.event === "herdr-restarted-for-up" && e.ok === true));

		const reused = deps([failure({ step: "herdr", reason: "no Herdr answers" })], { herdrReused: true, herdrAnswers: async () => false });
		assert.equal((await failureOf(runUp(reused))).failure.kind, "herdr", "a reused server is not ours to restart");
	});

	it("version: downgrades the server to the pin, then asks again; a refused downgrade is shown", async () => {
		const ok = deps([failure({ step: "version", reason: "newer" }), success()]);
		assert.equal((await runUp(ok)).pid, 4321);
		assert.deepEqual(ok.calls, ["downgrade"]);
		const refused = deps([failure({ step: "version", reason: "newer" })], { downgrade: async () => false });
		assert.equal((await failureOf(runUp(refused))).failure.kind, "version");
	});

	it("loader and intercom: repair the package and ask again; acl is shown with its text", async () => {
		for (const code of ["loader", "intercom"] as const) {
			const d = deps([failure({ startError: { code, text: "tsx is missing" }, reason: "cannot run" }, 3), success()]);
			assert.equal((await runUp(d)).pid, 4321);
			assert.deepEqual(d.calls, [`repair ${code}`]);
		}
		const acl = deps([failure({ startError: { code: "acl", text: `Fix the folder ${URL}` }, reason: "cannot run" }, 3)]);
		const error = await failureOf(runUp(acl));
		assert.equal(error.failure.kind, "acl");
		assert.equal(error.failure.startError?.code, "acl");
		assert.ok(!error.failure.startError?.text.includes(TOKEN));
		const failedRepair = deps([failure({ startError: { code: "loader" } }, 3)], { repairPackage: async () => false });
		assert.equal((await failureOf(runUp(failedRepair))).failure.kind, "loader");
	});

	it("a busy base is tried three more times, 3, 6 and 12 s apart, then shown", async () => {
		const busy = () => failure({ step: "base", reason: "busy: another up --dir holds desk.lock" });
		const d = deps([busy(), busy(), busy(), busy()]);
		const error = await failureOf(runUp(d));
		assert.equal(error.failure.kind, "base-busy");
		assert.deepEqual(d.slept, [3000, 6000, 12000]);
		assert.equal(d.ran, 4);
		const recovers = deps([busy(), success()]);
		assert.equal((await runUp(recovers)).pid, 4321);
	});

	it("usage, no url, and a timeout are shown at once; a timeout says so", async () => {
		assert.equal((await failureOf(runUp(deps([answer({ exit: 2, stderr: "usage" })])))).failure.kind, "usage");
		assert.equal((await failureOf(runUp(deps([answer({ exit: 0, ok: { pid: 1 } })])))).failure.kind, "no-url");
		const timed = await failureOf(runUp(deps([answer({ exit: null, timedOut: true })])));
		assert.equal(timed.failure.kind, "other");
		assert.match(timed.failure.reason, /did not finish in time/);
	});

	it("never lets the page token into a failure", async () => {
		const leaky = deps([failure({ step: "gui", reason: `GUI at ${URL} did not start`, startError: { code: "x", text: `see ${URL}` } })]);
		const error = await failureOf(runUp(leaky));
		assert.ok(!JSON.stringify(error.failure).includes(TOKEN));
		assert.equal(hideToken(URL), "http://127.0.0.1:41234/<token>/");
	});
});

describe("checkUpAnswer", () => {
	const primary = "/agent/straw-boss";
	const same = (a: string, b: string) => a === b;
	it("accepts an answer with a base, a GUI-shaped URL and the primary slot", () => {
		assert.deepEqual(checkUpAnswer(upSuccessOf(okJson()), primary, same), { slotDir: primary });
	});

	it("refuses an answer without a home base (26), with a URL of another shape (21), or from another slot (22)", () => {
		const kind = (over: Record<string, unknown>): string => {
			try {
				checkUpAnswer(upSuccessOf(okJson(over)), primary, same);
			} catch (error) {
				return (error as StartFailureError).failure.kind;
			}
			return "accepted";
		};
		assert.equal(kind({ workspace: undefined }), "no-base");
		assert.equal(kind({ url: "http://127.0.0.1:1/short/" }), "no-url");
		assert.equal(kind({ url: `https://127.0.0.1:1/${TOKEN}/` }), "no-url");
		assert.equal(kind({ url: `http://localhost:1/${TOKEN}/` }), "no-url");
		assert.equal(kind({ log: "/elsewhere/straw-boss/server.log" }), "slot");
		assert.equal(kind({ log: "" }), "slot");
	});

	it("takes the notices a person should see and logs the other warnings by code", () => {
		const up = upSuccessOf(okJson({ warnings: [{ code: "breakaway_failed", text: "The server ends with its starter" }, { code: "remote_off", text: "x" }, { code: "server_unreachable", text: "elevated" }] }));
		assert.deepEqual(up.notices, ["sb server: The server ends with its starter", "sb server: elevated"]);
		assert.deepEqual(up.warnings, ["breakaway_failed", "remote_off", "server_unreachable"]);
	});

	it("refuses an answer without a usable server pid", () => {
		for (const pid of [undefined, "12", 0, -3, 1.5]) assert.throws(() => upSuccessOf(okJson({ pid })), StartFailureError);
	});
});
