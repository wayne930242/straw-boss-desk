import { dirname } from "node:path";
import { sameFolder } from "../bootstrap/stages/paths-launchers.ts";
import { firstLineOf, hideToken, StartFailureError, type StartFailure, type StartFailureKind } from "./failure.ts";
import type { RuntimeEvent } from "./log.ts";

// `cli.mjs up --dir <home base> --label "Straw Boss" --timeout 120 --exact` and its failure table (spec: Runtime supervisor, Start; desk B7 plan, **Exit codes,
// `wait` values, and warnings**), as `start.ps1` implements them on pi-straw-boss 0.51.0. This module runs nothing itself: the supervisor gives it the call
// that runs `up` and the few actions a retry needs, so every row of the table is a unit case with no process.

export interface UpAnswer {
	/** Null when the process did not exit by itself (timeout, spawn failure). */
	exit: number | null;
	timedOut: boolean;
	/** The last `{` line of stdout that parses: `up`'s answer when it works. */
	ok: Record<string, unknown> | null;
	/** The last `{` line of stderr that parses: `{step, wait?, reason, startError?, ...}` when `up` fails. */
	err: Record<string, unknown> | null;
	stdout: string;
	stderr: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The last line of `text` that starts with `{` and parses as a JSON object (cli.mjs prints one on stdout when it works, one on stderr when `up` fails). */
export function lastJsonLine(text: string): Record<string, unknown> | null {
	let found: Record<string, unknown> | null = null;
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim().startsWith("{")) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (isObject(parsed)) found = parsed;
		} catch {
			// not JSON: the next line may be
		}
	}
	return found;
}

export function upAnswerOf(run: { code: number | null; stdout: string; stderr: string; timedOut?: boolean }): UpAnswer {
	return { exit: run.code, timedOut: run.timedOut === true, ok: lastJsonLine(run.stdout), err: lastJsonLine(run.stderr), stdout: run.stdout, stderr: run.stderr };
}

/** Which row of the `up` exit table an answer is. `ok` also needs a URL. */
export type UpClass = "ok" | "nourl" | "usage" | "loader" | "intercom" | "acl" | "acladmin" | "cannotrun" | "lock" | "start" | "hello" | "exit" | "herdr" | "version" | "server" | "gui" | "base" | "basebusy" | "integration" | "tower" | "other";

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * True when the text of an `acl` refusal names the Administrators group (`BA`, `S-1-5-32-544`, or its name). pi-straw-boss 0.51.0 protects its folder with
 * `icacls /inheritance:r /grant:r <user> SYSTEM` and then wants exactly the owner and SYSTEM; under a full administrator token (Run as administrator, UAC off, the
 * built-in Administrator) the folder also carries an explicit `BA` entry, and the refusal says "the folder grants BA, who is neither the owner nor SYSTEM"
 * (seam U12). The app never touches that folder's ACL; it only says what to do.
 */
export const namesAdministrators = (text: string): boolean => /\bBA\b|S-1-5-32-544|\bAdministrators\b/.test(text);

export function classifyUp(answer: UpAnswer): UpClass {
	if (answer.exit === 0) return typeof answer.ok?.url === "string" && answer.ok.url !== "" ? "ok" : "nourl";
	if (answer.exit === 2) return "usage";
	const err = answer.err;
	if (answer.exit === 3) {
		const startError = isObject(err?.startError) ? err.startError : null;
		const code = str(startError?.code);
		if (code === "acl") return namesAdministrators(`${str(startError?.text)}\n${str(err?.reason)}`) ? "acladmin" : "acl";
		return code === "loader" || code === "intercom" ? code : "cannotrun";
	}
	if (answer.exit === 1 && err !== null) {
		const step = str(err.step);
		const wait = str(err.wait);
		if (wait === "lock" || wait === "start" || wait === "hello" || wait === "exit") return wait;
		// A busy `base` is another `up --dir` holding desk.lock; any other `base` failure is the folder or Herdr.
		if (step === "base" && /^busy/.test(str(err.reason))) return "basebusy";
		if (step === "herdr" || step === "version" || step === "server" || step === "gui" || step === "base" || step === "integration" || step === "tower") return step;
	}
	return "other";
}

const KIND_OF: Readonly<Record<Exclude<UpClass, "ok">, StartFailureKind>> = {
	nourl: "no-url",
	usage: "usage",
	loader: "loader",
	intercom: "intercom",
	acl: "acl",
	acladmin: "acl-admin",
	cannotrun: "cannot-run",
	lock: "lock",
	start: "start",
	hello: "hello",
	exit: "exit",
	herdr: "herdr",
	version: "version",
	server: "server",
	gui: "gui",
	base: "base",
	basebusy: "base-busy",
	integration: "integration",
	tower: "tower",
	other: "other",
};

/** The typed failure for a class that was not retried (or whose retry failed). Nothing in it can hold the page token. */
export function failureOf(cls: Exclude<UpClass, "ok">, answer: UpAnswer): StartFailure {
	const err = answer.err;
	const reason = firstLineOf(str(err?.reason) || answer.stderr || answer.stdout);
	const failure: StartFailure = { kind: KIND_OF[cls], reason: answer.timedOut ? `up did not finish in time${reason ? `: ${reason}` : ""}` : reason };
	if (err !== null) {
		if (str(err.step) !== "") failure.step = str(err.step);
		if (str(err.wait) !== "") failure.wait = str(err.wait);
		if (isObject(err.startError)) failure.startError = { code: str(err.startError.code), text: hideToken(str(err.startError.text)).slice(0, 600) };
	}
	return failure;
}

export interface UpSuccess {
	/** The GUI's address with its page token: held in memory and handed to the GUI view, never logged or written. */
	url: string;
	pid: number;
	/** `up`'s own account of the server's start time; logged, not used as a record. */
	started: string | null;
	log: string;
	/** `found`, `started`, `restarted`, or `upgraded`. */
	server: string;
	desk: boolean | null;
	version: string | null;
	workspace: string | null;
	pane: string | null;
	tower: string | null;
	/** Whether this `up` made the home base (true) or found it (false); null when `up` did not say. */
	created: boolean | null;
	integration: string | null;
	/** Warnings a person should see (`breakaway_failed`, `server_unreachable`). */
	notices: string[];
	/** Every warning code, for the log. */
	warnings: string[];
}

/** `up`'s answer as a typed value. Throws `StartFailureError` (`other`) when a field has the wrong type: the shell does not guess. */
export function upSuccessOf(ok: Record<string, unknown>): UpSuccess {
	const pid = ok.pid;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) throw new StartFailureError({ kind: "other", reason: "up answered without a usable server pid" });
	const opt = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
	const warnings = Array.isArray(ok.warnings) ? ok.warnings.filter(isObject) : [];
	const notices: string[] = [];
	for (const w of warnings) {
		const code = str(w.code);
		if (code === "breakaway_failed" || code === "server_unreachable") notices.push(`sb server: ${firstLineOf(str(w.text))}`);
	}
	return {
		url: str(ok.url),
		pid,
		started: opt(ok.started),
		log: str(ok.log),
		server: str(ok.server),
		desk: typeof ok.desk === "boolean" ? ok.desk : null,
		version: opt(ok.version),
		workspace: opt(ok.workspace),
		pane: opt(ok.pane),
		tower: opt(ok.tower),
		created: typeof ok.created === "boolean" ? ok.created : null,
		integration: opt(ok.integration),
		notices,
		warnings: warnings.map((w) => str(w.code)),
	};
}

export interface UpDeps {
	/** Runs `up` once. */
	runUp(): Promise<UpAnswer>;
	/** `herdr workspace list` on the app's socket. */
	herdrAnswers(): Promise<boolean>;
	/** Stops the Herdr this run started and starts it again; false when it cannot (the server was reused, or it did not come back). */
	restartHerdr(): Promise<boolean>;
	/** `cli.mjs restart --downgrade --reason "stack.json pin"`: true when it exited 0. */
	downgrade(): Promise<boolean>;
	/** The engine's repair of the pinned package (`pkg:pi-straw-boss` for `loader`, `pkg:pi-intercom` for `intercom`): true when it finished ok. */
	repairPackage(code: "loader" | "intercom"): Promise<boolean>;
	/** `cli.mjs logs --lines 40`, for a start that did not answer; its text is masked and logged. */
	logTail?(): Promise<string>;
	sleep(ms: number): Promise<void>;
	log: RuntimeEvent;
	herdrReused: boolean;
}

/** Retries `up` as the table says. At most 8 rounds; a class that was retried once is shown on its second failure. Resolves with `up`'s answer, throws `StartFailureError`. */
export async function runUp(deps: UpDeps): Promise<UpSuccess> {
	const attempts = new Map<UpClass, number>();
	let last: UpAnswer | null = null;
	for (let round = 1; round <= 8; round++) {
		const answer = await deps.runUp();
		last = answer;
		const cls = classifyUp(answer);
		if (cls === "ok") return upSuccessOf(answer.ok as Record<string, unknown>);
		const tried = attempts.get(cls) ?? 0;
		deps.log({ event: "up-attempt-failed", round, class: cls, exit: answer.exit, timedOut: answer.timedOut, reason: firstLineOf(str(answer.err?.reason)) });
		let retry = false;
		let pause = 1000;
		// A real concurrent `up --dir` holds desk.lock for the length of its run: a busy base is retried three times with a doubling wait (3, 6, 12 s), 21 s at most.
		if (cls === "basebusy" && tried < 3) {
			retry = true;
			pause = 3000 * 2 ** tried;
		}
		if (tried === 0) {
			switch (cls) {
				// A start under way ahead of this call, or another requester's, did not finish: one more `up`.
				case "lock":
				case "hello":
				case "exit":
					retry = true;
					break;
				case "herdr":
					retry = await retryAfterHerdr(deps, answer);
					break;
				case "version": {
					// --exact: the running server is newer than the pin, and the pin is this app's decision.
					retry = await deps.downgrade();
					deps.log({ event: "downgrade", ok: retry });
					break;
				}
				case "loader":
				case "intercom":
					retry = await deps.repairPackage(cls);
					deps.log({ event: "repair", class: cls, ok: retry });
					break;
				default:
					break;
			}
		}
		if (!retry) throw await failed(deps, cls, answer);
		attempts.set(cls, tried + 1);
		await deps.sleep(pause);
	}
	throw await failed(deps, "other", last as UpAnswer);
}

/** A record that serves another socket is a broken install and is shown; a silent Herdr gets one more look, then one restart if this run started it. */
async function retryAfterHerdr(deps: UpDeps, answer: UpAnswer): Promise<boolean> {
	if (/serves/.test(str(answer.err?.reason))) return false;
	for (let i = 0; i < 30; i++) {
		if (await deps.herdrAnswers()) return true;
		await deps.sleep(500);
	}
	if (deps.herdrReused) return false;
	const restarted = await deps.restartHerdr();
	deps.log({ event: "herdr-restarted-for-up", ok: restarted });
	return restarted;
}

async function failed(deps: UpDeps, cls: Exclude<UpClass, "ok">, answer: UpAnswer): Promise<StartFailureError> {
	const failure = failureOf(cls, answer);
	deps.log({ event: "fail", kind: failure.kind, step: failure.step, wait: failure.wait, exit: answer.exit, timedOut: answer.timedOut, reason: failure.reason, startError: failure.startError?.code });
	// The log's tail is what a person needs for a start that did not answer, a GUI that did not start, or a tower that did not come up.
	if (deps.logTail && (cls === "start" || cls === "gui" || cls === "tower" || cls === "other" || cls === "hello")) {
		try {
			deps.log({ event: "sb-log-tail", text: hideToken(await deps.logTail()) });
		} catch {
			// the tail is a courtesy
		}
	}
	return new StartFailureError(failure);
}

const GUI_URL = /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{16,}\/$/;

/**
 * The checks after `up` answered (kit exit 26, 21, 22): the answer names a home base, the URL has the GUI's shape (it is checked, never logged), and the
 * server's folder is the primary slot `<agent>/straw-boss` (anything else means the Herdr socket or XDG_CONFIG_HOME did not reach the server). Throws `StartFailureError`.
 */
export function checkUpAnswer(up: UpSuccess, primaryDir: string, same: (a: string, b: string) => boolean = (a, b) => sameFolder(a, b)): { slotDir: string } {
	if (up.workspace === null) throw new StartFailureError({ kind: "no-base", reason: "up answered without a home base (workspace)" });
	if (!GUI_URL.test(up.url)) throw new StartFailureError({ kind: "no-url", reason: "up answered with a URL of an unexpected shape (not shown)" });
	const slotDir = up.log === "" ? "" : dirname(up.log);
	if (slotDir === "" || !same(slotDir, primaryDir)) {
		throw new StartFailureError({ kind: "slot", reason: `the sb server is not in the primary slot: its folder is ${hideToken(slotDir)}, expected ${primaryDir}` });
	}
	return { slotDir };
}
