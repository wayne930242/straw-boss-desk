import { execFile } from "node:child_process";
import type { CommandRunner } from "./types.ts";

const MAX_BUFFER = 64 * 1024 * 1024;

/** The production runner: no shell, hidden window on Windows, the child killed at the time limit. `base` is the environment the children get (default: the app's own). */
export function execRunner(base: Readonly<Record<string, string | undefined>> = process.env): CommandRunner {
	return (file, args, options) =>
		new Promise((resolve) => {
			const env: Record<string, string | undefined> = { ...base, ...options?.env };
			const child = execFile(
				file,
				[...args],
				{ env, timeout: options?.timeoutMs ?? 0, killSignal: "SIGKILL", windowsHide: true, maxBuffer: MAX_BUFFER, encoding: "utf8" },
				(error, stdout, stderr) => {
					if (!error) return resolve({ code: 0, stdout, stderr });
					const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
					const timedOut = e.killed === true && options?.timeoutMs !== undefined;
					const code = typeof e.code === "number" ? e.code : null;
					resolve({ code, stdout, stderr: code === null ? `${stderr}${e.message}` : stderr, ...(timedOut ? { timedOut: true } : {}) });
				},
			);
			// A child that exits before reading its input closes the pipe; that is its answer, not an error of ours.
			child.stdin?.on("error", () => {});
			child.stdin?.end(options?.stdin);
		});
}
