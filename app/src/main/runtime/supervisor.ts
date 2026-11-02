import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { StateStore } from "../bootstrap/state.ts";
import { buildEnv, resolveOsProxy, type EnvLike, type EnvMap, type ProxyResolver } from "../env.ts";
import type { PaneFindings } from "../pane-path.ts";
import { WSL_SENTENCE } from "../pane-path.ts";
import type { Layout } from "../paths.ts";
import type { CommandRunner, Platform } from "../platform/types.ts";
import { realClock, type Clock } from "./clock.ts";
import { assertEngineIdle, ENGINE_LOCKED_SENTENCE, EngineLockedError, repairEngineLock, type RepairResult } from "./engine-lock.ts";
import { StartFailureError, firstLineOf, type StartFailure } from "./failure.ts";
import { HerdrControl, type HerdrChild, type SpawnFn } from "./herdr.ts";
import { SerialQueue, killOwned } from "./identity.ts";
import type { RuntimeEvent } from "./log.ts";
import { isInstalled, readInstalled, readStartGate, type Installed, type StartGate } from "./readiness.ts";
import { checkUpAnswer, runUp, upAnswerOf, type UpSuccess } from "./sbup.ts";
import { resolveShortNames } from "./short-names.ts";
import { fingerprintOf, sameFingerprint, StartFile, type StartRecord } from "./start-file.ts";
import { StartTimes } from "./start-times.ts";
import { homeBaseDir, type StartConfig } from "./config.ts";
import { readServerRecordFile, runStop, stopTimeoutsFor, type StopReport, type StopTimeouts } from "./stop.ts";

// The runtime supervisor (spec: Runtime supervisor; tasks 8a and 8b). This file owns the order of a start (Herdr, then `up`, then the GUI), the stop sequence, the start
// times in `state/start.json`, and the restart of a Herdr server that ended. It starts only the programs the spec names, from the constructed environment, and it
// kills nothing but by the rule of `identity.ts`. Following the GUI, the crash budgets, power, and the page are task 8b's; the one thing a restart needs from them, the
// re-recording of a new `server.json` pid, is here as `noteSbServer` and a small poll that 8b's follower replaces with its own calls.

export type SupervisorState = "idle" | "starting" | "running" | "stopping" | "failed";

export interface StartResult {
	/** The GUI's address with its page token. Held in memory; never logged or written. */
	url: string;
	slotDir: string;
	/** `found`, `started`, `restarted`, or `upgraded`. */
	server: string;
	herdrReused: boolean;
	notices: string[];
}

export type SupervisorEvent =
	| { type: "gui-url"; url: string; reason: "start" | "restart" }
	| { type: "notice"; kind: string; sentence: string; path?: string }
	| { type: "failure"; failure: StartFailure }
	| { type: "stopped"; report: StopReport }
	| { type: "state"; state: SupervisorState };

export interface SyncRunResult {
	code: number | null;
}

export interface SupervisorTimeouts {
	/** Herdr must answer within this long after it is started (45 s). */
	herdrStartMs: number;
	/** `--timeout` of `up`, in seconds, counted from when `up` starts its steps (120). */
	upTimeoutSec: number;
	/** The process limit of `up` (150 s). */
	upProcessMs: number;
	/** The poll of `server.json` for a new pid; 0 turns it off (a test calls `pollServerRecord`). */
	pollMs: number;
	/** The session-end stop: `cli.mjs stop` with this limit (10 s). */
	sessionEndStopMs: number;
}

export const DEFAULT_TIMEOUTS: SupervisorTimeouts = { herdrStartMs: 45_000, upTimeoutSec: 120, upProcessMs: 150_000, pollMs: 2_000, sessionEndStopMs: 10_000 };

export interface SupervisorDeps {
	layout: Layout;
	/** `$HOME` / `%USERPROFILE%`. */
	home: string;
	platform: Pick<Platform, "processes" | "locate">;
	run: CommandRunner;
	spawn: SpawnFn;
	/** The app's own environment: read for the allow-listed names only. */
	appEnv: EnvLike;
	config(): StartConfig;
	log: RuntimeEvent;
	clock?: Clock;
	/** Chromium's `session.resolveProxy`; absent in a test that has no OS setting. */
	resolveProxy?: ProxyResolver;
	/** The engine's repair of one package (`loader` and `intercom` failures); absent: the failure is shown. */
	repairPackage?: (code: "loader" | "intercom") => Promise<boolean>;
	/** The Linear key, decrypted, for the Herdr server's environment only. */
	linearKey?: () => Promise<string | undefined>;
	/** Windows only (the caller passes it there): what a pane's `bash` resolves to, for the WSL check at every start. */
	checkPane?: () => Promise<PaneFindings>;
	/** True when `pid` is an engine this app holds (a `utilityProcess` handle); Repair leaves its lock alone. */
	isOurEngine?: (pid: number) => boolean;
	pidAlive?: (pid: number) => boolean;
	/** Runs a program to the end and waits, for `session-end`, where the app cannot wait for a promise. Default: `spawnSync`. */
	runSync?: (file: string, args: readonly string[], options: { env: EnvMap; timeoutMs: number }) => SyncRunResult;
	timeouts?: Partial<SupervisorTimeouts>;
	stopTimeouts?: Partial<StopTimeouts>;
	/** Read start times at once (macOS) or after the GUI shows (Windows). Default: by platform; a test sets it. */
	eagerStartTimes?: boolean;
}

/** More than this many Herdr restarts by the supervisor within the window shows the failure screen instead of another restart. Task 8b owns the budgets of both servers. */
const HERDR_RESTARTS = 3;
const RESTART_WINDOW_MS = 10 * 60 * 1000;

/** The stack could not be stopped, so the npm stages must not run in its prefix (T6-F006). */
export class StackBusyError extends Error {
	readonly report: StopReport;
	constructor(report: StopReport) {
		super(`the stack could not be stopped: ${report.notes.join("; ")}`);
		this.name = "StackBusyError";
		this.report = report;
	}
}

export class Supervisor {
	readonly #d: SupervisorDeps;
	readonly #clock: Clock;
	readonly #timeouts: SupervisorTimeouts;
	readonly #queue = new SerialQueue();
	readonly #startFile: StartFile;
	readonly #times: StartTimes;
	readonly #listeners = new Set<(event: SupervisorEvent) => void>();
	#state: SupervisorState = "idle";
	#env: EnvMap | null = null;
	#installed: Installed | null = null;
	#config: StartConfig | null = null;
	#herdr: HerdrControl | null = null;
	#herdrChild: HerdrChild | null = null;
	#slotDir: string | null = null;
	#lastSbPid: number | null = null;
	#watch: NodeJS.Timeout | null = null;
	#restarts: number[] = [];
	#after: Promise<void> = Promise.resolve();

	constructor(deps: SupervisorDeps) {
		this.#d = deps;
		this.#clock = deps.clock ?? realClock;
		this.#timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
		this.#startFile = new StartFile(deps.layout);
		this.#times = new StartTimes({ layout: deps.layout, processes: deps.platform.processes, startFile: this.#startFile, log: deps.log, ...(deps.eagerStartTimes !== undefined ? { eager: deps.eagerStartTimes } : {}) });
	}

	get state(): SupervisorState {
		return this.#state;
	}

	get startFile(): StartFile {
		return this.#startFile;
	}

	get times(): StartTimes {
		return this.#times;
	}

	on(listener: (event: SupervisorEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(event: SupervisorEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch (error) {
				this.#d.log({ event: "listener-threw", detail: (error as Error).message });
			}
		}
	}

	#setState(state: SupervisorState): void {
		if (this.#state === state) return;
		this.#state = state;
		this.#emit({ type: "state", state });
	}

	// ---- start -------------------------------------------------------------------------------------------------------

	/** Starts the stack, or finds it running, and answers with the GUI's address. Emits `gui-url`. Throws `StartFailureError`; the failure is emitted as well. */
	start(): Promise<StartResult> {
		return this.#queue.run(() => this.#start());
	}

	async #start(): Promise<StartResult> {
		const { layout, log } = this.#d;
		this.#setState("starting");
		const began = this.#clock.now();
		log({ event: "begin", platform: layout.platform, socket: layout.herdrSocket, agentDir: layout.agent });
		try {
			const config = this.#d.config();
			const installed = this.#requireInstalled();
			await this.#requireSafeToRun();
			const base = homeBaseDir(config, join);
			this.#makeFolders(config.workFolder, base);
			const env = await this.#constructEnv(installed, config);
			this.#env = env;
			this.#installed = installed;
			this.#config = config;
			await this.#paneNotice();

			const herdr = this.#herdrControl(env, installed);
			const reused = await this.#ensureHerdr(herdr);
			const up = await this.#up(herdr, env, installed, base, config.homeBaseLabel, reused);
			const { slotDir } = checkUpAnswer(up, join(layout.agent, "straw-boss"));
			await this.#recordUp(up, slotDir, base);
			this.#slotDir = slotDir;
			this.#lastSbPid = up.pid;
			// A warning code that is not a notice is logged, never shown; the URL is checked for its shape and never logged.
			log({ event: "sb-server-up", pid: up.pid, server: up.server, desk: up.desk, version: up.version, workspace: up.workspace, pane: up.pane, tower: up.tower, created: up.created, integration: up.integration, started: up.started, warnings: up.warnings, ms: this.#clock.now() - began });
			for (const notice of up.notices) this.#emit({ type: "notice", kind: "sb-server", sentence: notice });
			if (up.desk === false) log({ event: "env-bug", detail: "up reports desk false although STRAW_BOSS_DESK=1 is set" });
			if (up.warnings.includes("desk_on")) log({ event: "env-bug", detail: "warning desk_on: the shell always sets STRAW_BOSS_DESK=1" });
			this.#setState("running");
			await this.#startFile.update((record) => (record ? { ...record, guiMs: this.#clock.now() - began } : record));
			this.#emit({ type: "gui-url", url: up.url, reason: "start" });
			return { url: up.url, slotDir, server: up.server, herdrReused: reused, notices: up.notices };
		} catch (error) {
			this.#fail(error);
			throw error;
		}
	}

	#fail(error: unknown): void {
		this.#setState("failed");
		if (error instanceof StartFailureError) {
			this.#d.log({ event: "start-failed", kind: error.failure.kind, step: error.failure.step, wait: error.failure.wait, reason: error.failure.reason });
			this.#emit({ type: "failure", failure: error.failure });
		} else {
			const failure: StartFailure = { kind: "other", reason: firstLineOf((error as Error).message) };
			this.#d.log({ event: "start-failed", kind: "other", reason: failure.reason, detail: (error as Error).stack?.split("\n").slice(0, 4).join(" | ") });
			this.#emit({ type: "failure", failure });
		}
	}

	#requireInstalled(): Installed {
		const found = readInstalled(this.#d.layout);
		if (!isInstalled(found)) throw new StartFailureError({ kind: "tool-missing", reason: `not installed yet: ${found.missing.join(", ")}`, offerRepair: true });
		return found;
	}

	/**
	 * Everything that must hold before the app runs a program that loads the stack's packages (Herdr restoring panes, `cli.mjs`): no engine runs, and one full read of
	 * `state/bootstrap.json`, taken after that check, shows nothing forbids it. The engine check comes first because a package stage is `running` while an engine holds
	 * the lock, and the read comes after it because an engine that finishes while its lock is checked writes a block or a failed stage (T8A-F002). Every path that reaches
	 * Herdr or `cli.mjs up` goes through here: the start, the Herdr restart, and `upOnce`.
	 */
	async #requireSafeToRun(): Promise<void> {
		await this.#requireIdleEngine();
		this.#refuseUnsafeState(readStartGate(this.#d.layout));
	}

	/**
	 * What `state/bootstrap.json` forbids a start to do (T7-F002, R7-F001, R7-F002, R7-F007, T8A-F003), all with Repair offered: a file that cannot be read or is gone, a stage
	 * record with a start block, a package stage left `running` with no engine to own it, and a stack package that runs without pi (`DIRECT_PACKAGES`) whose stage is not `ok`.
	 */
	#refuseUnsafeState(gate: StartGate): void {
		const fail = (kind: StartFailure["kind"], reason: string): never => {
			throw new StartFailureError({ kind, reason, offerRepair: true });
		};
		if (gate.unreadable) fail("state-unreadable", "state/bootstrap.json cannot be read");
		if (gate.blocks.length > 0) {
			// The record's own sentence is what the screen shows (T7-F002); a record without one falls back to the package names and the catalog line.
			const sentences = gate.blocks.map((b) => b.sentence).filter((t) => t !== "");
			fail("package-unsafe", sentences.length > 0 ? firstLineOf(sentences.join(" ")) : gate.blocks.map((b) => b.package).join(", "));
		}
		if (gate.interrupted.length > 0) fail("install-interrupted", gate.interrupted.join(", "));
		if (gate.missing) fail("state-unreadable", "state/bootstrap.json is missing");
		const unverified = gate.direct.filter((d) => d.status !== "ok");
		if (unverified.length > 0) fail("package-unsafe", unverified.map((d) => `${d.package} is not installed and verified (${d.status ?? "no record"})`).join("; "));
	}

	async #requireIdleEngine(): Promise<void> {
		try {
			await assertEngineIdle(this.#d.layout, this.#d.platform.processes, this.#d.pidAlive);
		} catch (error) {
			if (!(error instanceof EngineLockedError)) throw error;
			throw new StartFailureError({ kind: "engine-locked", reason: ENGINE_LOCKED_SENTENCE, offerRepair: true });
		}
	}

	#makeFolders(workFolder: string, base: string): void {
		// `up --dir` only checks the folder, so the app makes the work folder and the home base first.
		try {
			mkdirSync(workFolder, { recursive: true });
			mkdirSync(base, { recursive: true });
		} catch (error) {
			throw new StartFailureError({ kind: "work-folder", reason: firstLineOf((error as Error).message) });
		}
	}

	/** The constructed environment for every child of this start, with the OS proxy resolved now (Herdr's environment is fixed for its lifetime). */
	async #constructEnv(installed: Installed, config: StartConfig): Promise<EnvMap> {
		const { layout, appEnv, log } = this.#d;
		let proxy;
		if (this.#d.resolveProxy) {
			try {
				proxy = await resolveOsProxy({ resolve: this.#d.resolveProxy, forgeHosts: config.forges.map((f) => f.host), appEnv });
				for (const line of proxy.log) log({ event: "proxy", detail: line });
			} catch (error) {
				log({ event: "proxy", detail: `the OS proxy setting was not used: ${(error as Error).message}` });
			}
		}
		const shortNames = layout.platform === "win32" && config.optionalTools.includes("bun")
			? await resolveShortNames({ layout, run: this.#d.run, locate: this.#d.platform.locate, appEnv, log: (line) => log({ event: "short-names", detail: line }) })
			: null;
		const linearApiKey = await this.#d.linearKey?.();
		return buildEnv({
			layout,
			current: installed.current,
			appEnv,
			optionalTools: config.optionalTools,
			...(proxy ? { proxy } : {}),
			...(linearApiKey ? { linearApiKey } : {}),
			...(shortNames ? { shortNames } : {}),
		});
	}

	/** The variables the engine's children get from the OS proxy setting (`EngineConfig.proxyEnv`), resolved now. Empty when nothing is to be set. */
	async engineProxyEnv(forgeHosts: readonly string[]): Promise<Record<string, string>> {
		if (!this.#d.resolveProxy) return {};
		try {
			const proxy = await resolveOsProxy({ resolve: this.#d.resolveProxy, forgeHosts, appEnv: this.#d.appEnv });
			for (const line of proxy.log) this.#d.log({ event: "proxy", detail: line });
			return proxy.env;
		} catch (error) {
			this.#d.log({ event: "proxy", detail: `the OS proxy setting was not used: ${(error as Error).message}` });
			return {};
		}
	}

	async #paneNotice(): Promise<void> {
		if (!this.#d.checkPane) return;
		try {
			const found = await this.#d.checkPane();
			if (found.wslBash && found.firstBash !== null) {
				this.#d.log({ event: "wsl-bash", path: found.firstBash });
				this.#emit({ type: "notice", kind: "wsl-bash", sentence: WSL_SENTENCE, path: found.firstBash });
			}
		} catch (error) {
			this.#d.log({ event: "pane-path-unreadable", detail: (error as Error).message });
		}
	}

	#herdrControl(env: EnvMap, installed: Installed): HerdrControl {
		this.#herdr = new HerdrControl({ binary: installed.herdr, env, run: this.#d.run, spawn: this.#d.spawn, clock: this.#clock, log: this.#d.log });
		return this.#herdr;
	}

	// ---- Herdr -------------------------------------------------------------------------------------------------------

	/** Step 1 of a start. Returns true when a server that was already running is reused. */
	async #ensureHerdr(herdr: HerdrControl): Promise<boolean> {
		const { layout, platform, log } = this.#d;
		const fingerprint = fingerprintOf(layout);
		const record = this.#startFile.read((why) => log({ event: "start-file-unreadable", detail: why }));
		const reuse = async (): Promise<boolean> => {
			await this.#startFile.update((r) => (r ? { ...r, fingerprint } : r));
			await this.#times.herdrReady("reused");
			log({ event: "herdr-reused", pid: record?.herdr?.pid ?? null });
			return true;
		};

		if (await herdr.answers()) {
			if (record !== null && sameFingerprint(record.fingerprint, fingerprint)) return reuse();
			// An answering server that was started under another environment, or that no record names, is stopped through the CLI and started again.
			log({ event: "herdr-foreign", why: record === null ? "no record" : "another fingerprint" });
			const stopped = await herdr.stopServer();
			log({ event: "herdr-server-stop", exit: stopped.code, detail: stopped.text });
			if (!(await herdr.waitUntilSilent(10_000))) {
				throw new StartFailureError({ kind: "foreign-stack", reason: "a Herdr server that answers on the app's socket would not stop", offerRepair: false });
			}
		} else if (record?.herdr?.startTime) {
			// A recorded server that is alive but silent may still be starting: give it the start time before a second one is started beside it.
			const alive = (await platform.processes.inspect([record.herdr.pid]))[0];
			if (alive?.startTime === record.herdr.startTime) {
				if (await herdr.waitUntilAnswers(null, this.#timeouts.herdrStartMs)) {
					if (sameFingerprint(record.fingerprint, fingerprint)) return reuse();
				} else {
					throw new StartFailureError({ kind: "herdr-silent", reason: "the recorded Herdr server is alive but does not answer" });
				}
			}
		}
		await this.#startHerdr(herdr, { restart: false, previous: record });
		return false;
	}

	/** Starts `herdr server`, records it at once, and waits for it to answer. A server that does not answer is killed through its handle. */
	async #startHerdr(herdr: HerdrControl, options: { restart: boolean; previous?: StartRecord | null }): Promise<void> {
		const { layout, log } = this.#d;
		// Herdr restores the workspaces, and their panes start pi: the gate holds again right before it starts, since a block can land while a start sets up (T8A-F002).
		await this.#requireSafeToRun();
		const child = herdr.start();
		this.#herdrChild = child;
		child.once("exit", (code, signal) => {
			log({ event: "herdr-exit", pid: child.pid ?? null, code, signal });
			this.#onHerdrExit(child);
		});
		const pid = child.pid;
		if (pid === undefined) {
			this.#herdrChild = null;
			throw new StartFailureError({ kind: "herdr-silent", reason: `${herdr.binary} could not be started` });
		}
		log({ event: "herdr-started", pid });
		// Recorded at once, without a start time (the handle covers it): a quit during the start finds this server instead of reporting that nothing is recorded.
		await this.#startFile.update((cur) => ({
			schema: 1,
			fingerprint: fingerprintOf(layout),
			startedAt: new Date().toISOString(),
			herdr: { pid, startTime: null },
			sb: options.previous?.sb ?? cur?.sb ?? null,
			base: options.previous?.base ?? cur?.base ?? null,
			guiMs: null,
		}));
		if (!(await herdr.waitUntilAnswers(child, this.#timeouts.herdrStartMs))) {
			const exited = child.exitCode !== null || child.signalCode !== null;
			log({ event: "herdr-silent", exited });
			if (!exited) await killOwned(this.#d.platform.processes, { pid, record: null, handle: child });
			this.#herdrChild = null;
			await this.#startFile.update((cur) => (cur ? { ...cur, herdr: null } : cur));
			throw new StartFailureError({ kind: "herdr-silent", reason: exited ? "the Herdr server exited before it answered" : "the Herdr server did not answer in time" });
		}
		if (options.restart) {
			// Drops the old record and reads the new pid's start time, queued behind any read in flight; on Windows the read does not hold the restart.
			const recorded = this.#times.rerecord("herdr", pid, { handle: child });
			if (layout.platform === "darwin") await recorded;
			else void recorded.catch((error: Error) => log({ event: "rerecord-failed", detail: error.message }));
		} else {
			await this.#times.herdrReady("started", child);
		}
	}

	#onHerdrExit(child: HerdrChild): void {
		if (child !== this.#herdrChild) return;
		this.#herdrChild = null;
		// During a start or a stop the flow in progress sees the exit itself.
		if (this.#state !== "running") return;
		void this.#queue
			.run(() => this.#restartAfterExit())
			.catch((error: unknown) => this.#d.log({ event: "restart-failed", detail: (error as Error).message }));
	}

	/** The Herdr server ended on its own: start it again, then `up`. Restored workspaces come back. */
	async #restartAfterExit(): Promise<void> {
		if (this.#state !== "running" || this.#env === null || this.#installed === null || this.#config === null) return;
		const now = this.#clock.now();
		this.#restarts = [...this.#restarts.filter((t) => now - t < RESTART_WINDOW_MS), now];
		if (this.#restarts.length > HERDR_RESTARTS) {
			const failure: StartFailure = { kind: "herdr", reason: `the Herdr server stopped more than ${HERDR_RESTARTS} times in 10 minutes` };
			this.#setState("failed");
			this.#d.log({ event: "restart-budget", restarts: this.#restarts.length });
			this.#emit({ type: "failure", failure });
			return;
		}
		this.#d.log({ event: "herdr-restart", count: this.#restarts.length });
		const herdr = this.#herdr as HerdrControl;
		try {
			await this.#startHerdr(herdr, { restart: true });
			const base = homeBaseDir(this.#config, join);
			const up = await this.#up(herdr, this.#env, this.#installed, base, this.#config.homeBaseLabel, false);
			const { slotDir } = checkUpAnswer(up, join(this.#d.layout.agent, "straw-boss"));
			await this.#recordUp(up, slotDir, base);
			this.#slotDir = slotDir;
			this.#lastSbPid = up.pid;
			this.#emit({ type: "gui-url", url: up.url, reason: "restart" });
		} catch (error) {
			this.#fail(error);
		}
	}

	// ---- up ----------------------------------------------------------------------------------------------------------

	/** Runs `up` once, with the retries of its failure table. Another caller (the follower's gone rule, task 8b) uses `upOnce`. */
	async #up(herdr: HerdrControl, env: EnvMap, installed: Installed, base: string, label: string, herdrReused: boolean): Promise<UpSuccess> {
		const { run, log } = this.#d;
		const node = installed.node;
		const cli = installed.sbCli;
		// Every `cli.mjs` call here loads pi-straw-boss and pi-intercom from node_modules, so each one passes the gate first (the start, the Herdr restart and `upOnce` all come through here).
		const call = async (args: string[], timeoutMs: number): Promise<Awaited<ReturnType<CommandRunner>>> => {
			await this.#requireSafeToRun();
			return run(node, [cli, ...args], { env, replaceEnv: true, timeoutMs });
		};
		return runUp({
			runUp: async () => upAnswerOf(await call(["up", "--dir", base, "--label", label, "--timeout", String(this.#timeouts.upTimeoutSec), "--exact"], this.#timeouts.upProcessMs)),
			herdrAnswers: () => herdr.answers(),
			restartHerdr: () => this.#restartOwnHerdr(herdr),
			downgrade: async () => (await call(["restart", "--downgrade", "--reason", "stack.json pin"], 150_000)).code === 0,
			repairPackage: async (code) => (this.#d.repairPackage ? this.#d.repairPackage(code) : false),
			logTail: async () => (await call(["logs", "--lines", "40"], 60_000)).stdout,
			sleep: (ms) => this.#clock.sleep(ms),
			log,
			herdrReused,
		});
	}

	/** One `up` after the stack is running (the follower's gone rule, a Start button): the GUI's address, with `gui-url` emitted. Queued with every other lifecycle step. */
	upOnce(): Promise<UpSuccess> {
		return this.#queue.run(async () => {
			if (this.#env === null || this.#installed === null || this.#config === null || this.#herdr === null) throw new StartFailureError({ kind: "other", reason: "the stack was not started by this run" });
			const base = homeBaseDir(this.#config, join);
			const up = await this.#up(this.#herdr, this.#env, this.#installed, base, this.#config.homeBaseLabel, this.#herdrChild === null);
			const { slotDir } = checkUpAnswer(up, join(this.#d.layout.agent, "straw-boss"));
			await this.#recordUp(up, slotDir, base);
			this.#slotDir = slotDir;
			this.#emit({ type: "gui-url", url: up.url, reason: "restart" });
			return up;
		});
	}

	/** Stops the Herdr this run started and starts it again (the `up` failure table's "still silent" row). False when the server was not started by this run, or did not come back. */
	async #restartOwnHerdr(herdr: HerdrControl): Promise<boolean> {
		const child = this.#herdrChild;
		if (child === null) return false;
		// A refusal reaches the caller as it is: swallowing it here would show "herdr" instead of the reason.
		await this.#requireSafeToRun();
		this.#herdrChild = null;
		const outcome = await killOwned(this.#d.platform.processes, { pid: child.pid as number, record: null, handle: child });
		if (!outcome.killed) return false;
		try {
			await this.#startHerdr(herdr, { restart: true });
			return true;
		} catch {
			return false;
		}
	}

	async #recordUp(up: UpSuccess, slotDir: string, base: string): Promise<void> {
		await this.#startFile.update((record) => {
			if (record === null) return null;
			// A found server keeps the record it had when the pid is the same (adoption compares its start time later); any other pid starts with no start time.
			const sb = up.server === "found" && record.sb?.pid === up.pid ? { ...record.sb, slotDir } : { pid: up.pid, startTime: null, slotDir };
			return { ...record, sb, base: { dir: base, workspace: up.workspace, pane: up.pane, tower: up.tower, created: up.created, integration: up.integration } };
		});
		await this.#times.sbReady(up.pid, up.server);
	}

	// ---- after the GUI shows -----------------------------------------------------------------------------------------

	/**
	 * The GUI view has loaded the page. Now the start times are read (on Windows one PowerShell call for Herdr and the sb server; macOS read them at the start), the
	 * `server.json` poll begins, and the previous versions of updated tools are pruned. Returns at once; `settled` resolves when the reads are written.
	 */
	guiShown(): void {
		this.#d.log({ event: "gui-shown" });
		this.#after = this.#after.then(() => this.#afterGui()).catch((error: Error) => this.#d.log({ event: "after-gui-failed", detail: error.message }));
	}

	/** Resolves when everything `guiShown` started has finished. */
	async settled(): Promise<void> {
		await this.#after;
		await this.#times.idle();
		await this.#startFile.idle();
	}

	async #afterGui(): Promise<void> {
		await this.#times.flush();
		this.#startWatch();
		await this.#prune();
	}

	async #prune(): Promise<void> {
		const store = new StateStore(this.#d.layout);
		for (const tool of Object.keys(store.current().previous)) {
			try {
				const errors = await store.pruneInactive(tool, this.#d.platform.processes);
				this.#d.log({ event: "prune", tool, errors: errors.length });
			} catch (error) {
				// An engine run holds the root: the previous version stays until the next successful start.
				this.#d.log({ event: "prune-skipped", tool, detail: (error as Error).message });
			}
		}
	}

	// ---- the sb server's pid -----------------------------------------------------------------------------------------

	#startWatch(): void {
		this.#stopWatch();
		if (this.#timeouts.pollMs <= 0 || this.#slotDir === null) return;
		this.#watch = setInterval(() => void this.pollServerRecord().catch((error: Error) => this.#d.log({ event: "poll-failed", detail: error.message })), this.#timeouts.pollMs);
		this.#watch.unref();
	}

	#stopWatch(): void {
		if (this.#watch !== null) clearInterval(this.#watch);
		this.#watch = null;
	}

	/** One look at `server.json`: a new `pid` is a restart (`cli.mjs restart`, a pi session's own restart), and is re-recorded. */
	async pollServerRecord(): Promise<void> {
		if (this.#slotDir === null || this.#state !== "running") return;
		const current = readServerRecordFile(this.#slotDir);
		if (current === null || current.stopped || current.pid === this.#lastSbPid) return;
		await this.noteSbServer(current.pid);
	}

	/** The sb server restarted under a new pid (the follower sees it in `server.json`): the old record goes and the new pid is recorded, if its executable is the app's. */
	noteSbServer(pid: number): Promise<void> {
		this.#lastSbPid = pid;
		this.#d.log({ event: "sb-server-restarted", pid });
		return this.#times.rerecord("sb", pid, { ...(this.#slotDir !== null ? { slotDir: this.#slotDir } : {}) });
	}

	// ---- stop --------------------------------------------------------------------------------------------------------

	/** The stop sequence. Always runs the CLIs; the kill step goes by the kill rule. Emits `stopped`. */
	stop(): Promise<StopReport> {
		return this.#queue.run(() => this.#stop());
	}

	async #stop(): Promise<StopReport> {
		const { layout, platform, run, log } = this.#d;
		this.#setState("stopping");
		this.#stopWatch();
		const prepared = this.#prepareForStop();
		if (prepared === null) {
			const report: StopReport = { ok: true, cliStop: { ran: false, exit: null, outcome: "", timedOut: false, detail: "" }, killed: [], refused: [], leftovers: [], herdrAnswers: false, notes: ["nothing is installed, so nothing was started"] };
			this.#setState("idle");
			this.#emit({ type: "stopped", report });
			return report;
		}
		const { env, installed } = prepared;
		const herdr = this.#herdr ?? this.#herdrControl(env, installed);
		const handle = this.#herdrChild;
		this.#herdrChild = null;
		try {
			const report = await runStop({
				layout,
				processes: platform.processes,
				run,
				startFile: this.#startFile,
				herdr,
				env,
				nodePath: installed.node,
				sbCli: installed.sbCli,
				herdrHandle: handle,
				clock: this.#clock,
				log,
				timeouts: { ...stopTimeoutsFor(layout.platform), ...this.#d.stopTimeouts },
				...(this.#d.pidAlive ? { pidAlive: this.#d.pidAlive } : {}),
				syncSbRecord: (pid) => this.noteSbServer(pid),
			});
			await this.#times.idle();
			this.#setState(report.ok ? "idle" : "failed");
			if (!report.ok) {
				this.#emit({ type: "failure", failure: { kind: "other", reason: report.notes.join("; "), leftovers: report.leftovers } });
			}
			this.#emit({ type: "stopped", report });
			return report;
		} catch (error) {
			this.#setState("failed");
			throw error;
		}
	}

	/** The environment and the install a stop needs: those of this run, else rebuilt from the state files (a stop after a restart of the app, or `--stop-stack`). */
	#prepareForStop(): { env: EnvMap; installed: Installed } | null {
		if (this.#env !== null && this.#installed !== null) return { env: this.#env, installed: this.#installed };
		const found = readInstalled(this.#d.layout);
		if (!isInstalled(found)) return null;
		const config = this.#d.config();
		const env = buildEnv({ layout: this.#d.layout, current: found.current, appEnv: this.#d.appEnv, optionalTools: config.optionalTools });
		this.#env = env;
		this.#installed = found;
		this.#config = config;
		return { env, installed: found };
	}

	/**
	 * Windows `session-end` (log off, shut down): `cli.mjs stop` with a 10 s limit, run to the end before the handler returns, and nothing else; Windows ends the rest, and Herdr restores
	 * the workspaces at the next start. Synchronous because the app cannot wait for a promise there.
	 */
	stopForSessionEnd(): void {
		const prepared = this.#prepareForStop();
		if (prepared === null) return;
		this.#stopWatch();
		const run = this.#d.runSync ?? defaultRunSync;
		const result = run(prepared.installed.node, [prepared.installed.sbCli, "stop"], { env: prepared.env, timeoutMs: this.#timeouts.sessionEndStopMs });
		this.#d.log({ event: "session-end-stop", exit: result.code });
	}

	// ---- maintenance -------------------------------------------------------------------------------------------------

	/**
	 * Runs `work` with the stack stopped, and starts the stack again when it was running (T6-F006, T7-F007). Repair, a stack update, and a recipe update run npm in the
	 * live prefixes (`tools/npm` and `<agent>/npm`) while the sb server and every pi extension run from them; the stages that install or remove a package must not
	 * run beside them. When the stack cannot be stopped (a program still runs from `<root>/tools`), `work` does not run and `StackBusyError` says what is left.
	 */
	async withStackStopped<T>(work: () => Promise<T>): Promise<T> {
		const wasRunning = this.#state === "running";
		const report = await this.stop();
		if (!report.ok) throw new StackBusyError(report);
		try {
			return await work();
		} finally {
			if (wasRunning) await this.start();
		}
	}

	/** Repair for the engine lock: removes a lock whose owner pid is not an engine of this app. */
	repairLock(): RepairResult {
		const result = repairEngineLock(this.#d.layout, { ...(this.#d.isOurEngine ? { isOurEngine: this.#d.isOurEngine } : {}) });
		this.#d.log({ event: "repair-engine-lock", result: result.result });
		return result;
	}
}

function defaultRunSync(file: string, args: readonly string[], options: { env: EnvMap; timeoutMs: number }): SyncRunResult {
	const r = spawnSync(file, [...args], { env: options.env, timeout: options.timeoutMs, windowsHide: true, stdio: "ignore" });
	return { code: r.status };
}
