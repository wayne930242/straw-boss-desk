import { spawn } from "node:child_process";
import { join } from "node:path";
import { run } from "./e2e-light.ts";

// Test code: starts a pi in `--mode rpc`, asks it for `get_commands`, and reports the command names and everything it wrote to stderr. Like `rpcProbe`
// (harness/e2e-light.ts), it closes stdin when the answer is in and, when pi has not exited, stops the process it started by its pid (the tree on Windows),
// so nothing it started outlives the call.

export interface RpcCommands {
	/** The `name` of each command pi listed (`skill:pm-workflow`, `plan`, ...), or null when no answer came. */
	commands: string[] | null;
	/** Each command with where it came from, for a diagnostic. */
	sources: Array<{ name: string; source: string; path: string | null }>;
	stderr: string;
	/** The JSON lines pi wrote to stdout. */
	lines: string[];
	pid: number | null;
}

const isWindows = process.platform === "win32";

export async function rpcCommands(file: string, args: readonly string[], options: { env: Readonly<Record<string, string>>; cwd?: string; timeoutMs?: number; graceMs?: number }): Promise<RpcCommands> {
	const child = spawn(file, [...args], { env: { ...options.env }, ...(options.cwd ? { cwd: options.cwd } : {}), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	const pid = child.pid ?? null;
	const lines: string[] = [];
	let stderr = "";
	let pending = "";
	let exited = false;
	child.on("exit", () => {
		exited = true;
	});
	child.on("error", () => {
		exited = true;
	});
	child.stdin?.on("error", () => {});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	child.stdout?.on("data", (chunk: Buffer) => {
		pending += chunk.toString("utf8");
		const parts = pending.split(/\r?\n/);
		pending = parts.pop() ?? "";
		lines.push(...parts.filter((l) => l !== ""));
	});
	child.stdin?.write('{"id":"commands","type":"get_commands"}\n');
	const answered = (): boolean => lines.some((l) => l.includes('"get_commands"'));
	const deadline = Date.now() + (options.timeoutMs ?? 90_000);
	while (Date.now() < deadline && !exited && !answered()) await new Promise((resolve) => setTimeout(resolve, 200));
	child.stdin?.end();
	const grace = Date.now() + (options.graceMs ?? 15_000);
	while (Date.now() < grace && !exited) await new Promise((resolve) => setTimeout(resolve, 200));
	if (!exited && pid !== null) {
		if (isWindows) await run(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/T", "/F", "/PID", String(pid)], { env: {}, timeoutMs: 30_000 });
		else child.kill("SIGKILL");
		const end = Date.now() + 10_000;
		while (Date.now() < end && !exited) await new Promise((resolve) => setTimeout(resolve, 200));
	}
	const line = lines.find((l) => l.includes('"get_commands"'));
	let sources: RpcCommands["sources"] = [];
	let commands: string[] | null = null;
	if (line !== undefined) {
		try {
			const parsed = JSON.parse(line) as { data?: { commands?: Array<{ name?: string; source?: string; sourceInfo?: { path?: string } }> } };
			sources = (parsed.data?.commands ?? []).map((c) => ({ name: String(c.name), source: String(c.source), path: c.sourceInfo?.path ?? null }));
			commands = sources.map((c) => c.name);
		} catch {
			commands = null;
		}
	}
	return { commands, sources, stderr, lines, pid };
}
