import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";

// Opening a folder as a base through the HTTP endpoint pi-straw-boss's GUI already serves for "+ New base" (spec: First run, step 10; team-profile section 5, "What the wizard does with it"),
// called the way the kit's `gui-client.mjs` calls it, which sends the same requests the page sends:
//   POST /<token>/api/open/base {dir, label, deploy, joinWaitMs?}   a new workspace in `dir` whose first tab holds a member; the answer comes when the member has joined the net
//       The server records an opening by its `deploy` id and folder (`openings.json`, pi-straw-boss 0.60.2): a repeat with the same id and folder answers with the workspace the first try made, and
//       a repeat while that first try is still joining is answered 429 `busy`. `joinWaitMs` (a whole number, 10 s to 5 min; 400 otherwise) sets how long the new pi may take to join (default 60 s).
//       The answer is {workspace, tab, pane, session?, delivery?}; `delivery` (`sent`, `unknown`, `not_sent`) is there only when the open carried a first message, which this app's opens do not.
//       A 502 `prompt_failed` and a 503 `unavailable` come after the workspace was made and are kept: the base is open, the message is not known to have arrived.
//   POST /<token>/api/open/progress {id}                  how far the opening with that `deploy` id has got; `trust` is present while a project trust question holds it
// A POST carries `Host: 127.0.0.1:<port>`, `Origin: http://127.0.0.1:<port>`, `Content-Type: application/json` and the page's CSRF value (`gui.json`'s `csrf`, header `x-sb-csrf`). The record is read
// again for every open: the token rotates on every restart of the server. The server opens one base at a time and answers 429 `busy` to a second; nothing here is a Herdr client or reimplements
// any of the server's logic.

export interface GuiRecord {
	port: number;
	token: string;
	csrf: string;
}

/** `gui.json` of the primary slot, or null when it is missing, does not parse, or lacks a field the call needs. */
export function readGuiRecord(slotDir: string): GuiRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(slotDir, "gui.json"), "utf8").replace(/^\uFEFF/, ""));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const r = parsed as Record<string, unknown>;
	if (!Number.isInteger(r.port) || typeof r.token !== "string" || r.token === "" || typeof r.csrf !== "string") return null;
	return { port: r.port as number, token: r.token, csrf: r.csrf };
}

export interface PostResult {
	status: number;
	body: unknown;
}

/** One POST to the GUI, resolved with the status and the parsed body (undefined when the body is not JSON). Rejects on a connection error or an abort. */
export type Post = (record: GuiRecord, path: string, json: unknown, signal: AbortSignal) => Promise<PostResult>;

export const post: Post = (record, path, json, signal) =>
	new Promise((resolve, reject) => {
		const body = JSON.stringify(json);
		const origin = `http://127.0.0.1:${record.port}`;
		const req = request(
			{
				host: "127.0.0.1",
				port: record.port,
				path: `/${record.token}${path}`,
				method: "POST",
				headers: { host: `127.0.0.1:${record.port}`, origin, "content-type": "application/json", "x-sb-csrf": record.csrf, "content-length": Buffer.byteLength(body) },
				agent: false,
				signal,
			},
			(res) => {
				let text = "";
				res.setEncoding("utf8").on("data", (chunk: string) => (text += chunk)).on("end", () => {
					let parsed: unknown;
					try {
						parsed = JSON.parse(text);
					} catch {
						parsed = undefined;
					}
					resolve({ status: res.statusCode ?? 0, body: parsed });
				});
				res.on("error", reject);
			},
		);
		req.on("error", reject);
		req.end(body);
	});

/** What the server says of an open's first message. */
export type Delivery = "sent" | "unknown" | "not_sent";

/** The bounds of `joinWaitMs` the server accepts (`MIN_JOIN_WAIT_MS` and `MAX_JOIN_WAIT_MS` of pi-straw-boss `src/spawn.ts`). */
export const MIN_JOIN_WAIT_MS = 10_000;
export const MAX_JOIN_WAIT_MS = 300_000;

export const isJoinWaitMs = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= MIN_JOIN_WAIT_MS && value <= MAX_JOIN_WAIT_MS;

export interface OpenInput {
	dir: string;
	label: string;
	/** The opening's id: the same one for every try of one open, so the server finds the workspace its first try made. */
	deploy: string;
	/** How long the new pi may take to join the net, in `MIN_JOIN_WAIT_MS` to `MAX_JOIN_WAIT_MS`; the server's own 60 s when absent. A value outside the bounds throws. */
	joinWaitMs?: number;
}

export type OpenOutcome =
	/** `delivery`: what the server says of the first message, when it names one (a 502 `prompt_failed` is `unknown`, a 503 `unavailable` is `not_sent`: the base is open either way). */
	| { ok: true; delivery?: Delivery }
	/** `step`: the step the server says the opening failed at (`create`, `start`, `join`, `deliver`, `trust`), when it names one. */
	| { ok: false; cause: "settings-unsafe" | "not-allowed" | "gui-unavailable" | "busy" | "refused" | "timeout"; reason: string; step?: string };

export interface OpenBaseDeps {
	/** `<agent>/straw-boss`: where `gui.json` lives. */
	slotDir: string;
	post?: Post;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	/** How often the progress is asked, and how long an opening may take in all (a trust question can hold it; the server itself gives up after ten minutes). */
	pollMs?: number;
	totalMs?: number;
	/** How long a `busy` answer is waited out in all, and between tries. */
	busyMs?: number;
	busyPollMs?: number;
}

const DEFAULT_POLL_MS = 1000;
const DEFAULT_TOTAL_MS = 12 * 60_000;
const DEFAULT_BUSY_MS = 5 * 60_000;
const DEFAULT_BUSY_POLL_MS = 3000;

const sleepFor = (ms: number, signal: AbortSignal): Promise<void> =>
	new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done(): void {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});

const asRecord = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const deliveryOf = (value: unknown): Delivery | undefined => (value === "sent" || value === "unknown" || value === "not_sent" ? value : undefined);
const firstLine = (value: unknown): string => (typeof value === "string" ? (value.split(/\r?\n/)[0] ?? "").slice(0, 300) : "");

export class OpenBaseClient {
	readonly #d: OpenBaseDeps;

	constructor(deps: OpenBaseDeps) {
		this.#d = deps;
	}

	/**
	 * Opens `dir` as a base labeled `label`. `onTrust(true)` is called when the server holds the opening on a project trust question, and `onTrust(false)` when the question is gone. The call
	 * returns when the server answers, or when `signal` aborts (then `refused` with the reason `aborted`).
	 */
	async open(input: OpenInput, hooks: { onTrust(asking: boolean): void; signal: AbortSignal }): Promise<OpenOutcome> {
		if (input.joinWaitMs !== undefined && !isJoinWaitMs(input.joinWaitMs)) throw new RangeError(`joinWaitMs must be a whole number from ${MIN_JOIN_WAIT_MS} to ${MAX_JOIN_WAIT_MS}`);
		const send = this.#d.post ?? post;
		const sleep = this.#d.sleep ?? sleepFor;
		const started = Date.now();
		const busyUntil = started + (this.#d.busyMs ?? DEFAULT_BUSY_MS);
		for (;;) {
			const record = readGuiRecord(this.#d.slotDir);
			if (record === null) return { ok: false, cause: "gui-unavailable", reason: "gui.json is missing or unreadable" };
			const total = new AbortController();
			const timer = setTimeout(() => total.abort(), this.#d.totalMs ?? DEFAULT_TOTAL_MS);
			const signal = AbortSignal.any([hooks.signal, total.signal]);
			let asking = false;
			let over = false;
			const watch = (async (): Promise<void> => {
				// The opening is asked about while its own request is on its way; the server keeps the last few by the id the caller made.
				while (!over && !signal.aborted) {
					await sleep(this.#d.pollMs ?? DEFAULT_POLL_MS, signal);
					if (over || signal.aborted) return;
					try {
						const progress = await send(record, "/api/open/progress", { id: input.deploy }, signal);
						if (over) return;
						if (progress.status === 200) {
							const now = asRecord(progress.body).trust !== undefined;
							if (now !== asking) {
								asking = now;
								hooks.onTrust(now);
							}
						}
					} catch {
						// A progress question that fails is no information; the opening's own answer decides.
					}
				}
			})();
			let answer: PostResult;
			try {
				answer = await send(record, "/api/open/base", { dir: input.dir, label: input.label, deploy: input.deploy, ...(input.joinWaitMs !== undefined ? { joinWaitMs: input.joinWaitMs } : {}) }, signal);
			} catch (error) {
				over = true;
				clearTimeout(timer);
				if (asking) hooks.onTrust(false);
				await watch;
				if (hooks.signal.aborted) return { ok: false, cause: "refused", reason: "aborted" };
				if (total.signal.aborted) return { ok: false, cause: "timeout", reason: "the opening did not finish in time" };
				return { ok: false, cause: "gui-unavailable", reason: firstLine((error as Error).message) };
			}
			over = true;
			clearTimeout(timer);
			if (asking) hooks.onTrust(false);
			await watch;
			const body = asRecord(answer.body);
			if (answer.status === 200) return deliveryOf(body.delivery) === undefined ? { ok: true } : { ok: true, delivery: deliveryOf(body.delivery) };
			const error = typeof body.error === "string" ? body.error : "";
			// The workspace stands in both: the server keeps it, and a repeat of this id would find it. The base is open; only the first message is in doubt.
			if (answer.status === 502 && error === "prompt_failed") return { ok: true, delivery: "unknown" };
			if (answer.status === 503 && error === "unavailable") return { ok: true, delivery: "not_sent" };
			if (answer.status === 429 || error === "busy") {
				if (Date.now() >= busyUntil) return { ok: false, cause: "busy", reason: firstLine(body.reason) };
				await sleep(this.#d.busyPollMs ?? DEFAULT_BUSY_POLL_MS, hooks.signal);
				if (hooks.signal.aborted) return { ok: false, cause: "refused", reason: "aborted" };
				continue;
			}
			if (error === "settings_unsafe") return { ok: false, cause: "settings-unsafe", reason: firstLine(body.reason) };
			if (error === "not_allowed") return { ok: false, cause: "not-allowed", reason: firstLine(body.reason) };
			// A page token the server no longer knows answers 404 (the opening itself never does): the GUI has moved on.
			if (answer.status === 401 || answer.status === 403 || answer.status === 404) return { ok: false, cause: "gui-unavailable", reason: `the GUI answered ${answer.status}` };
			return { ok: false, cause: "refused", reason: firstLine(body.reason) || `the GUI answered ${answer.status}`, ...(typeof body.step === "string" && body.step !== "" ? { step: body.step.slice(0, 20) } : {}) };
		}
	}
}
