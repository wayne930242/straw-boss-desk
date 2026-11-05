import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { Layout } from "../paths.ts";
import { firstLineOf } from "../runtime/failure.ts";
import type { RuntimeEvent } from "../runtime/log.ts";
import { parseStack, StackError, type PlatformKey, type Stack } from "../bootstrap/stack.ts";
import { renameRetry, writeFileAtomic } from "../bootstrap/fsutil.ts";
import type { ChangeLine, StackRefusal, StackUpdateState } from "../../shared/updates.ts";
import { compareVersions, isVersion, verifyDetached, type SignatureFailure } from "./verify.ts";
import { readRecord, recordFile, type UpdateRecord } from "./record.ts";

// The stack channel (spec: Updater, `stack.json`; Precedence). The app carries its own `stack.json`; the channel offers `stack.json` and `stack.json.sig` (an Ed25519 signature over the exact
// bytes). A candidate is applied only when its signature verifies against the built-in key list, its generation is higher than the active one, its `minShell` is at most the app's version,
// and it still lists every optional tool the active recipe names. Applying stops the stack, runs the engine against the candidate, and starts the stack; when a stage fails, the engine runs
// against `previous.json` and the stack starts on the old generation. The files are `stack/active.json`, `previous.json` and `candidate.json` with `candidate.json.sig`.

/** A stack file this large is not a stack: the real one is about 10 KB. */
export const MAX_STACK_BYTES = 256 * 1024;

export const STACK_FILE = "stack.json";
export const SIGNATURE_FILE = "stack.json.sig";

const SIGNATURE_REFUSAL: Record<SignatureFailure, StackRefusal> = {
	"no-keys": "no-keys",
	"bad-key-list": "bad-key-list",
	"malformed-signature": "malformed-signature",
	"bad-signature": "bad-signature",
};

export type CandidateVerdict =
	| { kind: "newer"; stack: Stack; raw: unknown; keyIndex: number }
	/** Verified, and not newer than the active stack: nothing to apply. */
	| { kind: "same"; generation: number }
	| { kind: "refused"; refusal: StackRefusal; generation?: number; minShell?: string; tools?: string[] };

export interface CandidateInput {
	bytes: Uint8Array;
	/** The `.sig` text or bytes; null when the channel offered none. */
	signature: string | Uint8Array | null;
	keys: readonly string[];
	/** The running app's version. */
	shellVersion: string;
	active: Stack;
	/** The optional tools the active recipe names. */
	recipeTools: readonly string[];
}

/**
 * The whole decision about a candidate, in the order that never parses bytes nobody vouched for: size, signature, then the file's own shape, generation, `minShell`, and the recipe's
 * tools. The verdict names the first rule that failed.
 */
export function checkCandidate(input: CandidateInput): CandidateVerdict {
	if (input.bytes.length > MAX_STACK_BYTES) return { kind: "refused", refusal: "too-large" };
	if (input.signature === null) return { kind: "refused", refusal: "no-signature" };
	const signed = verifyDetached(input.bytes, input.signature, input.keys);
	if (!signed.ok) return { kind: "refused", refusal: SIGNATURE_REFUSAL[signed.reason] };
	let raw: unknown;
	let stack: Stack;
	try {
		raw = JSON.parse(Buffer.from(input.bytes).toString("utf8"));
		stack = parseStack(raw);
	} catch {
		return { kind: "refused", refusal: "invalid" };
	}
	if (!isVersion(stack.minShell)) return { kind: "refused", refusal: "invalid" };
	if (stack.generation < input.active.generation) return { kind: "refused", refusal: "older", generation: stack.generation };
	if (compareVersions(stack.minShell, input.shellVersion) > 0) return { kind: "refused", refusal: "min-shell", generation: stack.generation, minShell: stack.minShell };
	const dropped = input.recipeTools.filter((tool) => !(tool in stack.optionalTools));
	if (dropped.length > 0) return { kind: "refused", refusal: "recipe-tool", generation: stack.generation, tools: dropped };
	if (stack.generation === input.active.generation) return { kind: "same", generation: stack.generation };
	return { kind: "newer", stack, raw, keyIndex: signed.keyIndex };
}

// ---- the change list ---------------------------------------------------------------------------------------------------

const toolVersion = (stack: Stack, kind: "tools" | "optionalTools", name: string, key: PlatformKey): string | null => stack[kind][name]?.assets[key]?.version ?? null;

/** The engine stage that installs a tool: `fd` and `rg` share one. */
const toolStage = (name: string): string => (name === "fd" || name === "rg" ? "fd-rg" : name);

/** The tools and packages whose version differs between two stacks, for the machine's platform key (spec: Updater: show the change list). */
export function changeList(from: Stack, to: Stack, key: PlatformKey): ChangeLine[] {
	const lines: ChangeLine[] = [];
	const add = (kind: ChangeLine["kind"], name: string, stage: string, a: string | null, b: string | null): void => {
		if (a !== b) lines.push({ kind, name, stage, from: a, to: b });
	};
	for (const kind of ["tools", "optionalTools"] as const) {
		for (const name of new Set([...Object.keys(from[kind]), ...Object.keys(to[kind])])) {
			add(kind === "tools" ? "tool" : "optionalTool", name, kind === "tools" ? toolStage(name) : `opt:${name}`, toolVersion(from, kind, name, key), toolVersion(to, kind, name, key));
		}
	}
	const pins = (kind: "npm" | "package", a: ReadonlyArray<{ name: string; version: string; bin?: string }>, b: ReadonlyArray<{ name: string; version: string; bin?: string }>): void => {
		const before = new Map(a.map((p) => [p.name, p]));
		const after = new Map(b.map((p) => [p.name, p]));
		for (const name of new Set([...before.keys(), ...after.keys()])) {
			const pin = after.get(name) ?? before.get(name);
			add(kind, name, kind === "npm" && pin?.bin === "pi" ? "pi" : `pkg:${name}`, before.get(name)?.version ?? null, after.get(name)?.version ?? null);
		}
	};
	pins("npm", from.npmGlobal, to.npmGlobal);
	pins("package", from.piPackages, to.piPackages);
	if (from.profile.name === to.profile.name) add("profile", to.profile.name, "profile", from.profile.version, to.profile.version);
	else {
		add("profile", from.profile.name, "profile", from.profile.version, null);
		add("profile", to.profile.name, "profile", null, to.profile.version);
	}
	return lines;
}

// ---- files -------------------------------------------------------------------------------------------------------------

export interface StackFiles {
	active: string;
	previous: string;
	candidate: string;
	candidateSig: string;
}

export const stackFiles = (layout: Layout): StackFiles => ({
	active: join(layout.stack, "active.json"),
	previous: join(layout.stack, "previous.json"),
	candidate: join(layout.stack, "candidate.json"),
	candidateSig: join(layout.stack, "candidate.json.sig"),
});

/** Writes exact bytes by rename: the signature covers them, so they are never re-encoded. */
export function writeBytesAtomic(file: string, bytes: Uint8Array): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(tmp, bytes);
		renameRetry(tmp, file);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

const readBytes = (file: string): Buffer | null => {
	try {
		return readFileSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
};

interface ParsedFile {
	bytes: Buffer;
	raw: unknown;
	stack: Stack;
}

/** A stack file read and parsed, or null when it is missing or unusable. */
function readStack(file: string): ParsedFile | null {
	try {
		const bytes = readBytes(file);
		if (bytes === null) return null;
		const raw: unknown = JSON.parse(bytes.toString("utf8"));
		return { bytes, raw, stack: parseStack(raw) };
	} catch (error) {
		if (error instanceof SyntaxError || error instanceof StackError) return null;
		throw error;
	}
}

// ---- the updater -------------------------------------------------------------------------------------------------------

/** How an engine run ended, as the updater needs it. `interrupted`: the app is quitting and the run was cancelled; nobody can run a rollback now. */
export interface EngineRunResult {
	ok: boolean;
	failed?: { stage: string; category: string };
	interrupted?: boolean;
}

export interface FetchedBytes {
	status: number;
	body: Uint8Array;
}

export interface StackUpdaterDeps {
	layout: Layout;
	/** The running app's version. */
	shellVersion: string;
	key: PlatformKey;
	keys: readonly string[];
	/** The folder URL that holds `stack.json` and `stack.json.sig`; null when no channel is configured. */
	base: string | null;
	/** One GET. A refusal to fetch (a network failure, a body over `maxBytes`) throws; any HTTP status is a result. */
	fetchBytes(url: string, maxBytes: number): Promise<FetchedBytes>;
	/** Runs the engine against `stack` (the parsed JSON) with the active recipe; `onStage` hears each stage that starts and ends. */
	runEngine(stack: unknown, onStage: (event: { type: "start" | "end"; stage: string }) => void): Promise<EngineRunResult>;
	/** The supervisor's `withStackStopped`: the stack stops, `work` runs, and the stack starts again if it was running. */
	withStackStopped<T>(work: () => Promise<T>, options?: { waitForTools?: boolean }): Promise<T>;
	/**
	 * The optional tools the recipe names, read against `stack` (the stack the PM has), never against whatever the wizard has seeded since: a bundled file that drops a tool would make
	 * the recipe read as invalid and name nothing.
	 */
	recipeTools(stack: Stack): readonly string[];
	/** The wizard re-reads `stack/active.json` after the file changed. */
	reloadStack(): void;
	log: RuntimeEvent;
	now?: () => Date;
}

/** What an error thrown around an engine run is for the card: the stack could not be stopped, or an engine run was refused because another is active, or anything else. */
function errorKindOf(error: unknown): "busy" | "other" {
	const { name, message } = error as Error;
	return name === "StackBusyError" || /already active/.test(message) ? "busy" : "other";
}

export class StackUpdater {
	readonly #d: StackUpdaterDeps;
	readonly #files: StackFiles;
	readonly #recordFile: string;
	readonly #listeners = new Set<() => void>();
	#state: StackUpdateState;
	#busy = false;
	#generation = 0;

	constructor(deps: StackUpdaterDeps) {
		this.#d = deps;
		this.#files = stackFiles(deps.layout);
		this.#recordFile = recordFile(deps.layout);
		this.#generation = readStack(this.#files.active)?.stack.generation ?? 0;
		const last = readRecord(this.#recordFile).last;
		this.#state = last ?? { phase: "idle", checkedAt: null };
	}

	get state(): StackUpdateState {
		return this.#state;
	}

	/** The generation of the stack in force: `stack/active.json`'s, or the bundled one's before the wizard has seeded it. */
	get generation(): number {
		return this.#generation;
	}

	/** Called when a bundled file is the one in force (the wizard seeded it). */
	noteGeneration(generation: number): void {
		this.#generation = generation;
	}

	get busy(): boolean {
		return this.#busy;
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#set(state: StackUpdateState): void {
		this.#state = state;
		for (const l of this.#listeners) l();
	}

	#now(): string {
		return (this.#d.now ?? (() => new Date()))().toISOString();
	}

	#writeRecord(change: (record: UpdateRecord) => void): void {
		const record = readRecord(this.#recordFile);
		change(record);
		writeFileAtomic(this.#recordFile, `${JSON.stringify(record, null, "\t")}\n`);
	}

	#activeStack(): ParsedFile | null {
		const active = readStack(this.#files.active);
		if (active !== null) this.#generation = active.stack.generation;
		return active;
	}

	// ---- checking --------------------------------------------------------------------------------------------------

	/**
	 * Fetches the channel's `stack.json` and its signature and decides (`checkCandidate`). A newer, verified candidate is saved as `candidate.json` with its `.sig` and offered with its change
	 * list; every other outcome is a state the card words. A check does not run while another check or an apply does.
	 */
	async check(): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		const previous = this.#state;
		this.#set({ phase: "checking" });
		try {
			this.#set(await this.#checkOnce(previous));
		} catch (error) {
			this.#d.log({ event: "stack-check-failed", detail: firstLineOf((error as Error).message) });
			this.#set({ phase: "error", kind: "network", detail: firstLineOf((error as Error).message) });
		} finally {
			this.#busy = false;
		}
	}

	async #checkOnce(previous: StackUpdateState): Promise<StackUpdateState> {
		const base = this.#d.base;
		if (base === null) return { phase: "idle", checkedAt: this.#now() };
		const active = this.#activeStack();
		if (active === null) return { phase: "error", kind: "other", detail: "the active stack file is missing or unreadable" };
		const stack = await this.#d.fetchBytes(new URL(STACK_FILE, base).href, MAX_STACK_BYTES);
		// Nothing published yet is not a failure.
		if (stack.status === 404) return { phase: "idle", checkedAt: this.#now() };
		if (stack.status !== 200) return { phase: "error", kind: "network", detail: `stack.json answered ${stack.status}` };
		const sig = await this.#d.fetchBytes(new URL(SIGNATURE_FILE, base).href, 4096);
		const verdict = checkCandidate({
			bytes: stack.body,
			signature: sig.status === 200 ? Buffer.from(sig.body) : null,
			keys: this.#d.keys,
			shellVersion: this.#d.shellVersion,
			active: active.stack,
			recipeTools: this.#d.recipeTools(active.stack),
		});
		this.#d.log({ event: "stack-check", verdict: verdict.kind, ...(verdict.kind === "refused" ? { refusal: verdict.refusal, ...(verdict.generation !== undefined ? { generation: verdict.generation } : {}) } : {}), active: active.stack.generation });
		if (verdict.kind === "refused") {
			// Nothing of a refused file stays on disk as a candidate.
			rmSync(this.#files.candidate, { force: true });
			rmSync(this.#files.candidateSig, { force: true });
			return { phase: "refused", reason: verdict.refusal, ...(verdict.generation !== undefined ? { generation: verdict.generation } : {}), ...(verdict.minShell !== undefined ? { minShell: verdict.minShell } : {}), ...(verdict.tools !== undefined ? { tools: verdict.tools } : {}) };
		}
		if (verdict.kind === "same") {
			rmSync(this.#files.candidate, { force: true });
			rmSync(this.#files.candidateSig, { force: true });
			// The card goes on showing the last apply or rollback until a newer candidate replaces it.
			return previous.phase === "applied" || previous.phase === "rolled-back" ? previous : { phase: "idle", checkedAt: this.#now() };
		}
		writeBytesAtomic(this.#files.candidate, stack.body);
		writeBytesAtomic(this.#files.candidateSig, sig.body);
		return { phase: "available", generation: verdict.stack.generation, changes: changeList(active.stack, verdict.stack, this.#d.key) };
	}

	// ---- applying --------------------------------------------------------------------------------------------------

	/**
	 * Applies the offered candidate: the file and its signature are read from disk and decided again (the active stack may have changed, and a file on disk is not the one that was checked),
	 * then the stack stops, the engine runs against the candidate, and the stack starts. A candidate whose run fails is rolled back to `previous.json`.
	 */
	async apply(): Promise<void> {
		if (this.#busy || this.#state.phase !== "available") return;
		this.#busy = true;
		try {
			const active = this.#activeStack();
			const bytes = readBytes(this.#files.candidate);
			const sig = readBytes(this.#files.candidateSig);
			if (active === null || bytes === null) {
				this.#set({ phase: "error", kind: "other", detail: "the candidate file is missing" });
				return;
			}
			const verdict = checkCandidate({ bytes, signature: sig, keys: this.#d.keys, shellVersion: this.#d.shellVersion, active: active.stack, recipeTools: this.#d.recipeTools(active.stack) });
			if (verdict.kind !== "newer") {
				this.#d.log({ event: "stack-apply-refused", verdict: verdict.kind, ...(verdict.kind === "refused" ? { refusal: verdict.refusal } : {}) });
				this.#set(verdict.kind === "refused" ? { phase: "refused", reason: verdict.refusal, ...(verdict.generation !== undefined ? { generation: verdict.generation } : {}) } : { phase: "idle", checkedAt: this.#now() });
				return;
			}
			await this.#run({ source: "channel", candidate: { bytes, raw: verdict.raw, stack: verdict.stack }, previous: active });
		} finally {
			this.#busy = false;
		}
	}

	/**
	 * The shared run: `previous` is kept as `previous.json`; the engine runs against `candidate`; on success `candidate` is the active stack, on failure `previous` is (after the engine ran
	 * against it). `source: "bundled"` is a new app's own `stack.json` taking over (Precedence): `active.json` already holds it when this runs, and a failure puts `previous` back.
	 */
	async #run(plan: { source: "channel" | "bundled"; candidate: ParsedFile; previous: ParsedFile }): Promise<void> {
		const { candidate, previous } = plan;
		const generation = candidate.stack.generation;
		const done = new Set<string>();
		let current: string | null = null;
		const progress = (): void => this.#set({ phase: "applying", generation, stage: current, done: done.size });
		// The marker goes first: a cut-short apply that finds it and `active.json` at this generation knows the candidate was in force (`finish`).
		const promote = (): void => {
			this.#writeRecord((r) => {
				if (r.inFlight !== undefined) r.inFlight.promoted = true;
			});
			writeBytesAtomic(this.#files.active, candidate.bytes);
		};
		// A bundled file that does not finish is that shell's one try: it is recorded before the wizard is told to read the stack again, so the read does not seed it.
		const demote = (): void => {
			if (plan.source === "bundled") this.#refuseBundled(generation);
			if (plan.source === "bundled") writeBytesAtomic(this.#files.active, previous.bytes);
		};
		writeBytesAtomic(this.#files.previous, previous.bytes);
		this.#writeRecord((r) => {
			r.inFlight = { generation, source: plan.source, at: this.#now() };
		});
		progress();
		this.#d.log({ event: "stack-apply-begin", generation, from: previous.stack.generation, source: plan.source });
		type Outcome = { kind: "applied" } | { kind: "rolled-back"; failed: { stage: string; category: string }; restored: boolean } | { kind: "interrupted" };
		let outcome: Outcome;
		try {
			outcome = await this.#d.withStackStopped(
				async (): Promise<Outcome> => {
					const first = await this.#d.runEngine(candidate.raw, (event) => {
						if (event.type === "start") current = event.stage;
						else {
							done.add(event.stage);
							if (current === event.stage) current = null;
						}
						progress();
					});
					if (first.interrupted === true) return { kind: "interrupted" };
					if (first.ok) {
						try {
							promote();
							this.#d.reloadStack();
							return { kind: "applied" };
						} catch (error) {
							this.#d.log({ event: "stack-promote-failed", detail: firstLineOf((error as Error).message) });
							first.failed = { stage: "stack-file", category: "other" };
						}
					}
					const failed = first.failed ?? { stage: "engine", category: "other" };
					this.#d.log({ event: "stack-apply-failed", generation, stage: failed.stage, category: failed.category });
					current = null;
					this.#set({ phase: "applying", generation, stage: null, done: done.size });
					const back = await this.#d.runEngine(previous.raw, () => undefined);
					if (back.interrupted === true) return { kind: "interrupted" };
					// The old stack file is in force again whether or not the engine could make the machine match it: the next Repair works to it.
					demote();
					this.#d.reloadStack();
					return { kind: "rolled-back", failed, restored: back.ok };
				},
				{ waitForTools: true },
			);
		} catch (error) {
			// The stack could not be stopped (a program still runs from the tools folder), or the work itself broke: nothing was changed or the old stack is in force.
			this.#d.log({ event: "stack-apply-error", detail: firstLineOf((error as Error).message) });
			demote();
			this.#d.reloadStack();
			this.#writeRecord((r) => {
				delete r.inFlight;
			});
			this.#set({ phase: "error", kind: errorKindOf(error), detail: firstLineOf((error as Error).message) });
			return;
		}
		if (outcome.kind === "interrupted") {
			// The marker stays: the next launch runs the old stack's engine pass (`reconcile`).
			this.#d.log({ event: "stack-apply-interrupted", generation });
			return;
		}
		const at = this.#now();
		const last = outcome.kind === "applied" ? ({ phase: "applied", generation, at } as const) : ({ phase: "rolled-back", generation, stage: outcome.failed.stage, category: outcome.failed.category, restored: outcome.restored, at } as const);
		this.#writeRecord((r) => {
			delete r.inFlight;
			r.last = last;
		});
		rmSync(this.#files.candidate, { force: true });
		rmSync(this.#files.candidateSig, { force: true });
		this.#generation = outcome.kind === "applied" ? generation : previous.stack.generation;
		this.#d.log({ event: "stack-apply-end", outcome: outcome.kind, generation });
		this.#set(last);
	}

	/** Records that the bundled stack of `generation` is not taken up again (`UpdateRecord.bundledRolledBack`). */
	#refuseBundled(generation: number): void {
		this.#writeRecord((r) => {
			r.bundledRolledBack = generation;
		});
	}

	// ---- the launch ------------------------------------------------------------------------------------------------

	/**
	 * Runs before the stack starts at a launch (Precedence). If an apply was cut short, the engine runs against the stack in force. If this app's bundled `stack.json` has a higher generation than
	 * the one in force, the bundled one takes over through the same run, with a rollback to the one it replaced. Call it before the wizard reads the stack, so the old file is still there to
	 * be kept as `previous.json`: `prepare()` does that and `finish()` runs the engine.
	 */
	prepare(bundledFile: string): Plan | null {
		const record = readRecord(this.#recordFile);
		const active = readStack(this.#files.active);
		if (record.inFlight !== undefined && active !== null) return { kind: "heal", active };
		if (active === null) return null;
		const bundled = readStack(bundledFile);
		if (bundled === null || bundled.stack.generation <= active.stack.generation) return null;
		// A bundled stack applies at the shell's first start only: one that did not finish is not run again at every launch (a newer shell, or the channel, brings the next try).
		if (record.bundledRolledBack === bundled.stack.generation) return null;
		// The same rule as for a downloaded candidate: a stack that drops an optional tool the recipe names could not be applied to this PM. Nothing is run, and the wizard does not seed it.
		const dropped = this.#d.recipeTools(active.stack).filter((tool) => !(tool in bundled.stack.optionalTools));
		if (dropped.length > 0) {
			this.#refuseBundled(bundled.stack.generation);
			this.#d.log({ event: "stack-bundled-refused", refusal: "recipe-tool", generation: bundled.stack.generation, tools: dropped });
			this.#set({ phase: "refused", reason: "recipe-tool", generation: bundled.stack.generation, tools: dropped });
			return null;
		}
		// The wizard seeds `active.json` from the bundled file as soon as it reads the stack; the old bytes are kept first.
		writeBytesAtomic(this.#files.previous, active.bytes);
		this.#writeRecord((r) => {
			r.inFlight = { generation: bundled.stack.generation, source: "bundled", at: this.#now() };
		});
		return { kind: "bundled", previous: active, bundled };
	}

	/**
	 * An apply or a Repair that a stop of the app cut short (the PM clicked Restart to update, and the installer then could not start) leaves its marker and, for an apply, the card on "applying". This
	 * finishes it as a launch would, before the stack starts again on tools that may be half updated. Nothing happens when no marker is there.
	 */
	async healInterrupted(): Promise<void> {
		const active = readStack(this.#files.active);
		if (active === null || readRecord(this.#recordFile).inFlight === undefined) return;
		await this.finish({ kind: "heal", active });
	}

	async finish(plan: Plan | null): Promise<void> {
		if (plan === null) return;
		this.#busy = true;
		try {
			if (plan.kind === "heal") {
				// An apply was cut short: the machine may be in between. Either the candidate was in force already (`promoted` was set and `active.json` is at its generation: only the start
				// or the record was cut off), or the stack in force is the old one (an apply writes the new file last) and the engine brings the machine back to it.
				const record = readRecord(this.#recordFile);
				const inFlight = record.inFlight;
				const finished = inFlight?.promoted === true && plan.active.stack.generation === inFlight.generation;
				const previous = readStack(this.#files.previous);
				const bundledBack = !finished && inFlight?.source === "bundled" && previous !== null;
				const target = bundledBack ? previous : plan.active;
				if (bundledBack) {
					// The bundled file's one try is spent: the old stack stays in force, and the wizard does not seed the bundled file again.
					this.#refuseBundled(inFlight.generation);
					writeBytesAtomic(this.#files.active, previous.bytes);
				}
				this.#generation = target.stack.generation;
				this.#d.log({ event: "stack-heal-begin", generation: target.stack.generation, finished });
				const result = await this.#d.withStackStopped(() => this.#d.runEngine(target.raw, () => undefined), { waitForTools: true }).catch((error: Error) => ({ ok: false, failed: { stage: "engine", category: firstLineOf(error.message) } }) as EngineRunResult);
				this.#d.reloadStack();
				if (result.interrupted === true) return;
				const at = this.#now();
				const last = finished
					? ({ phase: "applied", generation: target.stack.generation, at } as const)
					: ({ phase: "rolled-back", generation: inFlight?.generation ?? target.stack.generation, stage: "interrupted", category: "other", restored: result.ok, at } as const);
				this.#writeRecord((r) => {
					delete r.inFlight;
					r.last = last;
				});
				// The candidate was in force and the engine could not confirm the machine against it: that is not a rollback, and the card says the check failed (Repair works to the new stack).
				if (finished && !result.ok) this.#set({ phase: "error", kind: "other", detail: `the engine run after the restart stopped at ${result.failed?.stage ?? "engine"}` });
				else this.#set(last);
				return;
			}
			const bundled: ParsedFile = { bytes: plan.bundled.bytes, raw: plan.bundled.raw, stack: plan.bundled.stack };
			await this.#run({ source: "bundled", candidate: bundled, previous: plan.previous });
		} finally {
			this.#busy = false;
		}
	}
}

export type Plan = { kind: "heal"; active: ParsedFile } | { kind: "bundled"; previous: ParsedFile; bundled: ParsedFile };
