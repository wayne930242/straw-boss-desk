import type { SpawnOptions } from "node:child_process";
import type { EnvMap } from "../env.ts";
import type { CommandRunner } from "../platform/types.ts";
import type { ProcHandle } from "./identity.ts";
import type { Clock } from "./clock.ts";
import type { RuntimeEvent } from "./log.ts";

// The Herdr server of the app (spec: Runtime supervisor, Start, step 1). It is `herdr server` started detached and hidden with `stdio: "ignore"` (a redirect
// would make a long-lived server inherit the pipes of whoever started it), with the constructed environment and nothing else. The app keeps the child handle
// of a server it started: the handle is what lets it kill that process without a start time. Every call on the app's socket carries the same environment.

/** The child as the supervisor uses it: the kill rule's handle, plus the events and the detach. A `ChildProcess` is one. */
export interface HerdrChild extends ProcHandle {
	once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	once(event: "error", listener: (error: Error) => void): this;
	unref(): void;
}

export type SpawnFn = (file: string, args: readonly string[], options: SpawnOptions) => HerdrChild;

export interface HerdrOptions {
	binary: string;
	/** The constructed environment (`buildEnv`): `HERDR_SOCKET_PATH`, `XDG_CONFIG_HOME`, `PI_CODING_AGENT_DIR`, `STRAW_BOSS_DESK=1`, ... */
	env: EnvMap;
	run: CommandRunner;
	spawn: SpawnFn;
	clock: Clock;
	log: RuntimeEvent;
	/** One `workspace list` has this long (default 10 s). */
	answerLimitMs?: number;
}

export class HerdrControl {
	readonly #o: HerdrOptions;

	constructor(options: HerdrOptions) {
		this.#o = options;
	}

	get binary(): string {
		return this.#o.binary;
	}

	/** True when `herdr workspace list` on the app's socket exits 0. */
	async answers(): Promise<boolean> {
		const r = await this.#o.run(this.#o.binary, ["workspace", "list"], { env: this.#o.env, replaceEnv: true, timeoutMs: this.#o.answerLimitMs ?? 10_000 });
		return r.code === 0;
	}

	/** Starts `herdr server`, detached and hidden; the handle is returned, and the app's exit does not wait for it. */
	start(): HerdrChild {
		const child = this.#o.spawn(this.#o.binary, ["server"], { env: this.#o.env, stdio: "ignore", detached: true, windowsHide: true });
		child.once("error", (error) => this.#o.log({ event: "herdr-spawn-error", detail: error.message }));
		child.unref();
		return child;
	}

	/**
	 * Waits until the server answers. Gives up when `child` has exited (a server that died at start never answers) or after `timeoutMs`. With no `child`, only the time limit applies
	 * (a reused server that is alive but silent).
	 */
	async waitUntilAnswers(child: HerdrChild | null, timeoutMs: number): Promise<boolean> {
		const deadline = this.#o.clock.now() + timeoutMs;
		for (;;) {
			if (child !== null && (child.exitCode !== null || child.signalCode !== null)) return false;
			if (await this.answers()) return true;
			if (this.#o.clock.now() >= deadline) return false;
			await this.#o.clock.sleep(500);
		}
	}

	/** `herdr server stop` on the app's socket. Workspaces stay open: Herdr restores them at the next start. */
	async stopServer(timeoutMs = 30_000): Promise<{ code: number | null; text: string }> {
		const r = await this.#o.run(this.#o.binary, ["server", "stop"], { env: this.#o.env, replaceEnv: true, timeoutMs });
		return { code: r.code, text: `${r.stdout}\n${r.stderr}`.trim().split(/\r?\n/)[0] ?? "" };
	}

	/** Waits until the server no longer answers (it has stopped), up to `timeoutMs`. */
	async waitUntilSilent(timeoutMs: number): Promise<boolean> {
		const deadline = this.#o.clock.now() + timeoutMs;
		while (await this.answers()) {
			if (this.#o.clock.now() >= deadline) return false;
			await this.#o.clock.sleep(500);
		}
		return true;
	}
}
