import { execFile } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import type { FixtureIO } from "./hosted.ts";

/** A fixture IO that runs commands with `base` as their environment. `realIO` is this over the process's own. */
export function processIO(base: Readonly<Record<string, string | undefined>>): FixtureIO {
	return {
		run: (command, args, options) =>
			new Promise((resolve) => {
				const env = { ...base, ...options?.env };
				const child = execFile(command, [...args], { env, timeout: options?.timeoutMs ?? 10_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
					const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
					const timedOut = error !== null && (error as { killed?: boolean }).killed === true;
					resolve({ code, stdout, stderr: error && code === null ? `${stderr}${error.message}` : stderr, ...(timedOut ? { timedOut: true } : {}) });
				});
				child.stdin?.on("error", () => {});
				child.stdin?.end(options?.stdin);
			}),
		writeFile: (path, data) => writeFileSync(path, data),
		removeFile: (path) => rmSync(path, { force: true }),
	};
}
