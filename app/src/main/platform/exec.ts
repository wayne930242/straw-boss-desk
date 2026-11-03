import { execFile } from "node:child_process";
import type { CommandRunner } from "./types.ts";

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * The production runner: no shell, hidden window on Windows, the child killed at the time limit. `base` is the environment the children get (default: the app's own).
 * `signal` ends every child this runner started when it aborts (the engine's cancel: a quit must not leave an npm or an extractor running, T9-F002).
 */
export function execRunner(base: Readonly<Record<string, string | undefined>> = process.env, signal?: AbortSignal): CommandRunner {
	return (file, args, options) =>
		new Promise((resolve) => {
			// Node starts a child even when the signal has aborted already, and ends it on the next tick: a cancelled run starts nothing, not even for a moment (R9-F004 a).
			if (signal?.aborted === true) return resolve({ code: null, stdout: "", stderr: "cancelled" });
			const env: Record<string, string | undefined> = options?.replaceEnv && options.env ? { ...options.env } : { ...base, ...options?.env };
			const child = execFile(
				file,
				[...args],
				{ env, ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}), timeout: options?.timeoutMs ?? 0, killSignal: "SIGKILL", windowsHide: true, ...(signal !== undefined ? { signal } : {}), maxBuffer: MAX_BUFFER, encoding: "utf8" },
				(error, stdout, stderr) => {
					if (!error) return resolve({ code: 0, stdout, stderr });
					const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
					const timedOut = e.killed === true && options?.timeoutMs !== undefined && signal?.aborted !== true;
					const code = typeof e.code === "number" ? e.code : null;
					resolve({ code, stdout, stderr: code === null ? `${stderr}${e.message}` : stderr, ...(timedOut ? { timedOut: true } : {}) });
				},
			);
			// A child that exits before reading its input closes the pipe; that is its answer, not an error of ours.
			child.stdin?.on("error", () => {});
			child.stdin?.end(options?.stdin);
		});
}
