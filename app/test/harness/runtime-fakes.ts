// Test code for the runtime supervisor's unit tests: a process table that is a Map, a clock that advances by sleeping, a child process that exits when the test says,
// and a command runner that answers from a script. Nothing here starts a real program, lists the real process table, or touches the real Herdr socket.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import { isInside, type Layout } from "../../src/main/paths.ts";
import { nodeBinaryPath } from "../../src/main/bootstrap/npm.ts";
import { agentPackageDir } from "../../src/main/bootstrap/pi-cli.ts";
import { herdrBinary } from "../../src/main/paths.ts";
import type { Clock } from "../../src/main/runtime/clock.ts";
import { STACK_STAGE } from "../../src/main/runtime/readiness.ts";
import type { HerdrChild } from "../../src/main/runtime/herdr.ts";
import type { CommandRunner, ProcessInfo, Processes, RunOptions, RunResult } from "../../src/main/platform/types.ts";

export interface FakeProc {
	startTime: string | null;
	executable: string | null;
}

/** A process table: `inspect`, `listUnder`, and `kill` answer from a Map, and every call is kept. */
export class FakeProcesses implements Processes {
	readonly table = new Map<number, FakeProc>();
	readonly inspectCalls: number[][] = [];
	readonly listCalls: string[] = [];
	readonly killed: number[] = [];
	/** The most `inspect` calls that ran at the same time (two must never overlap on Windows). */
	maxConcurrentInspect = 0;
	#inFlight = 0;
	/** Called when `kill` ends a process, so a test can make the pid stop being alive. */
	onKill: ((pid: number) => void) | null = null;
	/** A pause inside `inspect`, to let a test see two calls overlap. */
	inspectDelayMs = 0;

	add(pid: number, proc: FakeProc): this {
		this.table.set(pid, proc);
		return this;
	}

	async inspect(pids: readonly number[]): Promise<ProcessInfo[]> {
		this.inspectCalls.push([...pids]);
		this.#inFlight++;
		this.maxConcurrentInspect = Math.max(this.maxConcurrentInspect, this.#inFlight);
		try {
			if (this.inspectDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.inspectDelayMs));
			return pids.map((pid) => {
				const p = this.table.get(pid);
				return { pid, startTime: p?.startTime ?? null, executable: p?.executable ?? null };
			});
		} finally {
			this.#inFlight--;
		}
	}

	async listUnder(dir: string): Promise<ProcessInfo[]> {
		this.listCalls.push(dir);
		const P = dir.includes("\\") ? win32 : posix;
		return [...this.table].filter(([, p]) => p.executable !== null && p.executable !== dir && isInside(dir, p.executable, P)).map(([pid, p]) => ({ pid, startTime: p.startTime, executable: p.executable }));
	}

	kill(pid: number): boolean {
		this.killed.push(pid);
		const had = this.table.delete(pid);
		this.onKill?.(pid);
		return had;
	}

	has(pid: number): boolean {
		return this.table.has(pid);
	}
}

/** A clock whose `sleep` advances `now` and returns at once, so a 45 s wait costs nothing. */
export function fakeClock(start = 1_000_000): Clock & { advance(ms: number): void; slept: number[] } {
	let t = start;
	const slept: number[] = [];
	return {
		now: () => t,
		sleep: async (ms) => {
			slept.push(ms);
			t += ms;
		},
		advance: (ms) => {
			t += ms;
		},
		slept,
	};
}

/** A `ChildProcess` stand-in: it has a pid, ends when `end` is called, and records `kill`. */
export class FakeChild implements HerdrChild {
	pid: number | undefined;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	readonly signals: Array<NodeJS.Signals | number | undefined> = [];
	unrefs = 0;
	#exit: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
	#error: Array<(error: Error) => void> = [];
	/** What the process table does when this child is killed. */
	onKill: (() => void) | null = null;

	constructor(pid: number | undefined) {
		this.pid = pid;
	}

	once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	once(event: "error", listener: (error: Error) => void): this;
	once(event: "exit" | "error", listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void)): this {
		if (event === "exit") this.#exit.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
		else this.#error.push(listener as (error: Error) => void);
		return this;
	}

	unref(): void {
		this.unrefs++;
	}

	kill(signal?: NodeJS.Signals | number): boolean {
		this.signals.push(signal);
		this.onKill?.();
		this.end(null, "SIGKILL");
		return true;
	}

	/** The process ends (by itself or killed). */
	end(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
		if (this.exitCode !== null || this.signalCode !== null) return;
		this.exitCode = signal === null ? code : null;
		this.signalCode = signal;
		const listeners = this.#exit;
		this.#exit = [];
		for (const l of listeners) l(code, signal);
	}

	/** The app that held this handle is gone: nothing listens for the exit any more. */
	forget(): void {
		this.#exit = [];
		this.#error = [];
	}

	fail(error: Error): void {
		for (const l of this.#error) l(error);
	}
}

export interface Call {
	file: string;
	args: string[];
	options: RunOptions | undefined;
}

export type Answer = Partial<RunResult> | ((call: Call) => Partial<RunResult> | Promise<Partial<RunResult>>);

/** A command runner that answers from the first rule whose `match` accepts the call, and keeps every call. A call no rule matches fails the test. */
export function scriptedRun(rules: Array<{ match: (call: Call) => boolean; answer: Answer }>): CommandRunner & { calls: Call[] } {
	const calls: Call[] = [];
	const run = (async (file: string, args: readonly string[], options?: RunOptions): Promise<RunResult> => {
		const call: Call = { file, args: [...args], options };
		calls.push(call);
		const rule = rules.find((r) => r.match(call));
		if (rule === undefined) throw new Error(`no rule for ${file} ${args.join(" ")}`);
		const answer = typeof rule.answer === "function" ? await rule.answer(call) : rule.answer;
		return { code: 0, stdout: "", stderr: "", ...answer };
	}) as CommandRunner & { calls: Call[] };
	run.calls = calls;
	return run;
}

/** Writes the files a start looks for under a layout: the active tool versions, the three programs, and pi-straw-boss's CLI. Returns their paths. */
export function installFake(layout: Layout): { node: string; herdr: string; sbCli: string; current: Record<string, string> } {
	const versions = { node: "24.0.0", git: "2.0.0", herdr: "0.9.5" };
	mkdirSync(layout.state, { recursive: true });
	writeFileSync(join(layout.state, "current.json"), `${JSON.stringify({ schema: 1, versions, previous: {} })}\n`);
	const node = nodeBinaryPath(layout, versions.node);
	const herdr = herdrBinary(layout, versions);
	const sbCli = join(agentPackageDir(layout, "pi-straw-boss"), "dist", "server", "cli.mjs");
	for (const file of [node, herdr, sbCli]) {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, "stub");
	}
	// The stack package's stage is `ok`: a start refuses to run its `cli.mjs` otherwise (R7-F002).
	writeFileSync(join(layout.state, "bootstrap.json"), `${JSON.stringify({ schema: 1, stages: { [STACK_STAGE]: { status: "ok", version: "0.51.0", evidence: "", at: "t", hashes: {}, dependsOn: {} } } })}\n`);
	return { node, herdr, sbCli, current: versions };
}
