// Test code only; never shipped. The e2e waits in one place: `until` polls a probe, and an optional `failWhen` probe ends the wait at once with the app's own words when the app has already reported
// a failure that no later step of the wait can undo (phase 2 stalls: Windows jobs ran 10 to 39 minutes after the app had said "failed" within 8 to 70 s, because every wait looked only for success).
//
// What counts as the app's failure, and where it is written:
//   - an install that failed: the wizard's install step, `[data-step="install"][data-status="failed"]` (renderer/wizard/install.ts:81, with a `.problem` sentence per failure and `#install-details`),
//     or a stage record `failed` in `state/bootstrap.json` (bootstrap/stage.ts:616; `lastFailure.at` dates it);
//   - a start that failed: the wizard's start step, `[data-step="start"][data-status="failed"]` (renderer/wizard/start.ts:34), or `#start-failure` with its `data-kind` (start.ts:18; steps 6 and 9 draw it),
//     or a `start-failed` line in `logs/start.jsonl` (runtime/supervisor.ts:241, 245) that no later `begin` or `sb-server-up` follows (a start the PM or the app tried again is not a failure).
// A wait uses a probe only where the failure is not what the case expects: the cases that fail on purpose (a refused code, Try again, the failure screen) never get one.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { CLOCK_SKEW_MS } from "./log-events.ts";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Answers the app's failure as a sentence for the person reading the CI log, or nothing while the app has reported none. */
export type FailWhen = () => string | undefined | Promise<string | undefined>;

export interface UntilOptions {
	/** Milliseconds between probes (400). */
	every?: number;
	/** Checked after each probe that did not succeed; a sentence ends the wait at once. A probe that throws counts as no failure. */
	failWhen?: FailWhen;
}

/**
 * Polls `probe` until it answers something truthy, for at most `ms`. The message of a timeout carries the last error the probe threw, but only while the latest probe threw it: a probe that answers
 * falsy without throwing clears it, so a first-probe error (a file that was not there yet) is not printed ten minutes after the file appeared (the false "start.json missing").
 */
export async function until<T>(what: string, ms: number, probe: () => T | Promise<T>, options: number | UntilOptions = {}): Promise<NonNullable<T>> {
	const { every = 400, failWhen } = typeof options === "number" ? { every: options } : options;
	const began = Date.now();
	const deadline = began + ms;
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			const value = await probe();
			if (value) return value as NonNullable<T>;
			last = undefined;
		} catch (error) {
			last = error;
		}
		if (failWhen !== undefined) {
			let failure: string | undefined;
			try {
				failure = await failWhen();
			} catch {
				failure = undefined;
			}
			if (failure) throw new Error(`stopped after ${Math.round((Date.now() - began) / 1000)} s waiting for ${what}: the app reported a failure: ${failure}`);
		}
		await sleep(every);
	}
	throw new Error(`timed out after ${ms / 1000} s waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
}

/** The first sentence the probes give. */
export const firstFailure =
	(...probes: FailWhen[]): FailWhen =>
	async () => {
		for (const probe of probes) {
			const failure = await probe();
			if (failure) return failure;
		}
		return undefined;
	};

// ---- the app's folders ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The two folders of the app's layout that these probes read (`world.layout` has them). */
export interface AppFolders {
	state: string;
	logs: string;
}

export type LogLine = Record<string, unknown>;

/** The JSON lines of a text; a line that is cut or not JSON is left out. */
export function parseLines(text: string): LogLine[] {
	return text.split("\n").flatMap((line) => {
		if (line === "") return [];
		try {
			const value: unknown = JSON.parse(line);
			return typeof value === "object" && value !== null && !Array.isArray(value) ? [value as LogLine] : [];
		} catch {
			return [];
		}
	});
}

const readLines = (file: string): LogLine[] => {
	try {
		return existsSync(file) ? parseLines(readFileSync(file, "utf8")) : [];
	} catch {
		return [];
	}
};

/** Whether a line was written at or after `sinceMs` (the test's `Date.now()` mark), counting a line stamped up to the clock skew before it. */
const since = (line: LogLine, sinceMs: number): boolean => Date.parse(String(line.t)) >= sinceMs - CLOCK_SKEW_MS;

// ---- the logs ------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The `start-failed` line that ends the supervisor's latest start since `sinceMs`: the last of `begin`, `sb-server-up` and `start-failed` says how that start ended, and only a `start-failed` is a failure
 * (a start the PM or the app began again after it logged a new `begin`). Undefined when the latest start is running, up, or none was made.
 */
export function terminalStartFailure(lines: readonly LogLine[], sinceMs: number): LogLine | undefined {
	let last: LogLine | undefined;
	for (const line of lines) {
		if (!since(line, sinceMs)) continue;
		if (line.event === "begin" || line.event === "sb-server-up" || line.event === "start-failed") last = line;
	}
	return last?.event === "start-failed" ? last : undefined;
}

export interface FailedStage {
	stage: string;
	category: string;
	message: string;
}

/**
 * The stages `state/bootstrap.json` records as `failed` with a failure noted at or after `sinceMs`. A cancelled stage is not a failure of the app: a quit in the middle of an install leaves the stages it
 * cancelled `failed` with the message "cancelled" (bootstrap/stage.ts:593) until the relaunch runs them again, and a wait that began right after the quit must not stop on them. An older record is not
 * this run's either.
 */
export function failedStages(folders: AppFolders, sinceMs: number): FailedStage[] {
	let stages: Record<string, { status?: unknown; lastFailure?: { at?: unknown; category?: unknown; message?: unknown } }>;
	try {
		const file = join(folders.state, "bootstrap.json");
		if (!existsSync(file)) return [];
		stages = (JSON.parse(readFileSync(file, "utf8")) as { stages?: typeof stages }).stages ?? {};
	} catch {
		return [];
	}
	return Object.entries(stages).flatMap(([stage, record]) => {
		const note = record.lastFailure;
		if (record.status !== "failed" || note === undefined || note.message === "cancelled" || !(Date.parse(String(note.at)) >= sinceMs - CLOCK_SKEW_MS)) return [];
		return [{ stage, category: String(note.category ?? ""), message: String(note.message ?? "") }];
	});
}

const KEYS = ["stage", "status", "category", "kind", "class", "step", "wait", "exit", "timedOut", "reason", "sentence", "detail", "results"] as const;
const RELEVANT = new Set(["reach", "retry", "result", "up-attempt-failed", "fail", "start-failed", "sb-log-tail", "run-error"]);

const cut = (value: unknown, width: number): string => {
	const text = Array.isArray(value) ? value.map(String).join("; ") : typeof value === "string" ? value : JSON.stringify(value);
	return text.length > width ? `${text.slice(0, width)}...` : text;
};

/**
 * The last relevant events of `bootstrap.jsonl` and `start.jsonl` since `sinceMs`, with their reasons and not only their names: `reach` (which host answered what), a stage's failed `result`, `retry`,
 * `up-attempt-failed`, `fail`, `start-failed`, and the tail of the sb server's own log. Oldest first, `count` of them.
 */
export function failureEvents(folders: AppFolders, sinceMs: number, count = 6): string[] {
	const lines = [...readLines(join(folders.logs, "bootstrap.jsonl")), ...readLines(join(folders.logs, "start.jsonl"))]
		.filter((l) => since(l, sinceMs) && typeof l.event === "string" && RELEVANT.has(l.event) && !(l.event === "result" && l.status !== "failed"))
		.sort((a, b) => Date.parse(String(a.t)) - Date.parse(String(b.t)))
		.slice(-count);
	return lines.map((l) => {
		const fields = KEYS.filter((k) => l[k] !== undefined && l[k] !== null && l[k] !== "").map((k) => `${k}=${cut(l[k], 240)}`);
		if (l.event === "sb-log-tail" && typeof l.text === "string") fields.push(`text=...${l.text.slice(-500)}`);
		return `${String(l.t).slice(11, 23)} ${String(l.event)} ${fields.join(" ")}`;
	});
}

// ---- the page ------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface PageFailure {
	where: "install" | "start";
	/** The sentences the page shows for the failure, in the language of the page. */
	sentences: string[];
	/** `data-kind` of `#start-failure`; empty for the install step, whose sentences carry the category. */
	kind: string;
	/** The text of the failure's Details (open or closed), which is the reason. */
	details: string;
}

/**
 * Runs in the page (`page.evaluate`), so it uses nothing but `document`: the failure the wizard shows, or null. The install step shows its failures as `.problem` lines and Details; the start's failure
 * is `#start-failure` with Details in its `.refusal` block, and steps 6 and 9 both draw it.
 */
export function readPageFailure(): PageFailure | null {
	const text = (el: { textContent: string | null } | null): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
	const startFailure = document.querySelector("#start-failure");
	if (startFailure !== null || document.querySelector('[data-step="start"][data-status="failed"]') !== null) {
		return { where: "start", sentences: [text(startFailure)].filter(Boolean), kind: startFailure?.getAttribute("data-kind") ?? "", details: text(document.querySelector(".refusal pre")) };
	}
	if (document.querySelector('[data-step="install"][data-status="failed"]') !== null) {
		return { where: "install", sentences: [...document.querySelectorAll('[data-step="install"] .problem')].map(text).filter(Boolean), kind: "", details: text(document.querySelector("#install-details pre")) };
	}
	return null;
}

const pageFailureOf = (page: Pick<Page, "evaluate">): Promise<PageFailure | null> => page.evaluate(readPageFailure).catch(() => null);

// ---- the sentences ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** At most this many characters of a failure sentence: the callers add their own diagnostics, and a CI annotation is cut. */
const BUDGET = 2400;

function report(shown: PageFailure | null, headline: string, folders: AppFolders, sinceMs: number): string {
	const parts: string[] = [headline];
	if (shown !== null) {
		parts.push(`the page says ${JSON.stringify(shown.sentences.join(" / "))} (${shown.where} step${shown.kind === "" ? "" : `, data-kind=${shown.kind}`}) details: ${JSON.stringify(shown.details.slice(0, 600))}`);
	}
	const events = failureEvents(folders, sinceMs);
	if (events.length > 0) parts.push(`events: ${events.join(" | ")}`);
	return parts.join(" ;; ").slice(0, BUDGET);
}

/**
 * Stops a wait at an install that ended on a failure: the page shows the install step failed, or a stage record failed since `sinceMs`. The case's own diagnostics (`startTrouble`) follow it in the message; this carries the
 * sentence, the reason and the events that explain it.
 */
export const installFailing =
	(folders: AppFolders, sinceMs: number, page?: Pick<Page, "evaluate">): FailWhen =>
	async () => {
		const shown = page === undefined ? null : await pageFailureOf(page);
		const stages = failedStages(folders, sinceMs);
		if ((shown === null || shown.where !== "install") && stages.length === 0) return undefined;
		const headline = `the install failed: ${stages.map((s) => `${s.stage} (${s.category}): ${s.message.slice(0, 300)}`).join("; ") || "(no stage record yet)"}`;
		return report(shown?.where === "install" ? shown : null, headline, folders, sinceMs);
	};

/**
 * Stops a wait at a start that failed: the page shows the start's failure, or the supervisor's latest start since `sinceMs` ended in `start-failed`.
 */
export const startFailing =
	(folders: AppFolders, sinceMs: number, page?: Pick<Page, "evaluate">): FailWhen =>
	async () => {
		const shown = page === undefined ? null : await pageFailureOf(page);
		const logged = terminalStartFailure(readLines(join(folders.logs, "start.jsonl")), sinceMs);
		if ((shown === null || shown.where !== "start") && logged === undefined) return undefined;
		const headline = `the start failed: ${logged === undefined ? "(the log has no start-failed yet)" : `start-failed kind=${cut(logged.kind, 80)} step=${cut(logged.step ?? "", 80)} reason=${cut(logged.reason ?? logged.detail ?? "", 400)}`}`;
		return report(shown?.where === "start" ? shown : null, headline, folders, sinceMs);
	};
