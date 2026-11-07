// Test code only; never shipped. The panes half of the follow and wizard anchors (spec: Workflows, step 7): a pi started in a Herdr pane of a base as the pane starts it (`pi`, by name, in RPC
// mode), driven by typed RPC commands, and the lookups that show where `gh`, `git`, `pi` and `bash` resolve in it. It was written for `follow.e2e.ts` (task 8b) and moved here so `wizard.e2e.ts`
// runs the same machinery in the root the wizard installed (task 15). Task 15 added the end of a Windows pi's input (`FEEDER_END`, and `RpcPi.close()` appending it) to what was moved.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { createPlatform } from "../../src/main/platform/index.ts";
import { childEnvOf, isWindows, run, WorldHerdr, type World } from "./e2e-light.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(what: string, ms: number, probe: () => T | Promise<T>): Promise<NonNullable<T>> {
	const deadline = Date.now() + ms;
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			const value = await probe();
			if (value) return value as NonNullable<T>;
		} catch (error) {
			last = error;
		}
		await sleep(400);
	}
	throw new Error(`timed out after ${ms / 1000} s waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
}

/** The text of every string anywhere in a JSON value. */
function strings(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const v of value) strings(v, out);
	else if (typeof value === "object" && value !== null) for (const v of Object.values(value)) strings(v, out);
	return out;
}

/** What the test appends to a pi's input file to say "no more input": the feeder below ends there, so the pipe closes and pi sees the end of its input and exits by itself. */
export const FEEDER_END = "##END-OF-INPUT##";

/**
 * A Node program that copies what is appended to its first argument's file to its stdout, and ends when the reader goes away or when `FEEDER_END` is appended: the stdin of a pi started in a
 * Windows pane. Without the second rule a pi whose pane was closed kept reading from a feeder that was never going to end (task 15: in some runs it was still under `<root>/tools` 90 s later, and
 * at the quit the stop sequence reported it and its console host as left).
 */
export const FEEDER = [
	'import { closeSync, openSync, readSync } from "node:fs";',
	"const fd = openSync(process.argv[2], 'r');",
	"const buf = Buffer.alloc(65536);",
	"let pos = 0;",
	`const END = Buffer.from(${JSON.stringify(FEEDER_END)});`,
	// The marker can arrive in two reads (an append caught half written, or input that fills the buffer): the longest tail of what was read that is the start of the marker is held back until the
	// next read, so a split marker still ends the feeder and no part of it reaches pi. A tail that is not the start of the marker (every line of JSON ends in a newline) is never held (T15R-F006).
	"let held = Buffer.alloc(0);",
	"process.stdout.on('error', () => process.exit(0));",
	"setInterval(() => {",
	"  const n = readSync(fd, buf, 0, buf.length, pos);",
	"  if (n <= 0) return;",
	"  pos += n;",
	"  const text = Buffer.concat([held, buf.subarray(0, n)]);",
	"  const at = text.indexOf(END);",
	"  if (at >= 0) { process.stdout.write(text.subarray(0, at), () => process.exit(0)); return; }",
	"  let keep = Math.min(END.length - 1, text.length);",
	"  while (keep > 0 && !text.subarray(text.length - keep).equals(END.subarray(0, keep))) keep--;",
	"  held = Buffer.from(text.subarray(text.length - keep));",
	"  process.stdout.write(text.subarray(0, text.length - keep));",
	"}, 100);",
	"process.on('exit', () => closeSync(fd));",
	"",
].join("\n");

export { strings };

export interface RpcAnswer {
	id?: string;
	type?: string;
	success?: boolean;
	error?: string;
	data?: { output?: string; exitCode?: number };
}
/**
 * A pi started in a pane of a base as the pane starts it (`pi`, by name, in RPC mode): its stdout goes to a file the test reads, and the test types the RPC commands into the pane.
 * It is a member of the base like any pi a PM opens, so its `/boss` commands are the PM's (the base's own pane is the tower's prompt, which takes no `/boss`).
 */
export interface RpcPi {
	pane: string;
	lines(): unknown[];
	/** Types one line into the pane's shell (or into pi, while pi runs). */
	type(line: string): Promise<void>;
	/** Types one RPC command into the pane. */
	send(command: Record<string, unknown>): Promise<void>;
	/** Types one RPC command and waits for its response. */
	call(command: Record<string, unknown> & { id: string }, waitMs: number): Promise<RpcAnswer>;
	/** What the runner can show of a run that went nowhere: the last events, and the other panes of the workspace with the end of what they print. */
	dump(): Promise<void>;
	close(): Promise<void>;
}

export interface RpcPanes {
	underTools: () => ReturnType<ReturnType<typeof createPlatform>["processes"]["listUnder"]>;
	herdr: (args: string[], timeoutMs?: number) => ReturnType<typeof run>;
	herdrAnswers: () => Promise<boolean>;
	paneIds: () => Promise<string[]>;
	toolPids: () => Promise<Set<number>>;
	openRpcPi: (label: string, splitFrom: string, cwd: string) => Promise<RpcPi>;
	settlePanes: (known: readonly string[], programsBefore: ReadonlySet<number>) => Promise<void>;
	/** `name=path` lines from the lookup command's output, and the check that each resolves under the app's tools folder (not to a planted fake or the runner's own). */
	resolutions: (text: string) => Record<string, string>;
	assertAppFolders: (found: Record<string, string>, names: string[]) => void;
}

export function rpcPanes(world: World, platform: ReturnType<typeof createPlatform>): RpcPanes {
	const underTools = () => platform.processes.listUnder(world.layout.tools.root);
	const herdrBinary = () => childEnvOf(world).HERDR_BIN_PATH as string;
	const herdr = (args: string[], timeoutMs = 30_000) => run(herdrBinary(), args, { env: childEnvOf(world), timeoutMs });
	const herdrAnswers = async () => (await herdr(["workspace", "list"], 15_000)).code === 0;
	const paneIds = async (): Promise<string[]> => [...(await herdr(["pane", "list"], 20_000)).stdout.matchAll(/"pane_id":"([^"]+)"/g)].map((m) => m[1] as string);
	const toolPids = async (): Promise<Set<number>> => new Set((await underTools()).map((p) => p.pid));
	/** Whether the pane's shell has printed its prompt (PowerShell: `PS C:\...>`), read from the pane's screen. */
	async function promptShown(h: WorldHerdr, pane: string): Promise<boolean> {
		const read = await h.cli(["pane", "read", pane, "--lines", "5"], 20_000);
		// The pane is narrow and PowerShell's prompt (`PS <folder>> `) wraps over several lines.
		return read.code === 0 && /PS [^>]*>$/.test(read.stdout.replace(/\r?\n/g, "").replace(/\s+$/, ""));
	}
	/**
	 * Opens a pane next to `splitFrom`, starts pi in it and returns before pi has answered anything. The pane's shell starts pi by name, as Herdr's `agent start` does, and its stdout
	 * goes to a file the test reads. On macOS the test types the RPC commands into the pane. On Windows a line typed into a pane whose pi the shell has just started was lost
	 * (the pi ended at once and PowerShell parsed the line instead), so pi reads its commands from a file that a small Node program streams into a pipe cmd makes (`FEEDER`), and its
	 * error output and exit code go to files that a failure prints.
	 */
	async function startRpcPi(label: string, splitFrom: string, cwd: string): Promise<RpcPi> {
		const h = new WorldHerdr(world);
		const split = await h.cli(["pane", "split", splitFrom, "--direction", "right", "--cwd", cwd, "--no-focus"]);
		assert.equal(split.code, 0, `${split.stdout} ${split.stderr}`);
		const pane = (JSON.parse(split.stdout) as { result: { pane: { pane_id: string } } }).result.pane.pane_id;
		const stem = join(world.base, `${label}-${pane.replace(/\W/g, "_")}`);
		const out = `${stem}.jsonl`;
		const input = `${stem}.in`;
		const err = `${stem}.err`;
		const code = `${stem}.code`;
		const feeder = join(world.base, "feed-input.mjs");
		if (isWindows) {
			// The first prompt means PowerShell has loaded; a line typed before it is read by a shell that is not ready for it.
			await until(`the shell's prompt in the pane (${label})`, 40_000, () => promptShown(h, pane)).catch(async (error: Error) => {
				const screen = await h.cli(["pane", "read", pane, "--lines", "8"], 20_000);
				console.log(`${label}: ${error.message}; the pane shows ${JSON.stringify(screen.stdout.replace(/[^\x20-\x7e\n]/g, "?").slice(-300))}; typing anyway`);
			});
			await sleep(1000);
			writeFileSync(input, "");
			writeFileSync(feeder, FEEDER);
			for (const path of [process.execPath, feeder, input, out, err, code]) assert.ok(!/\s/.test(path), `a path without a space is typed here unquoted: ${path}`);
			// cmd makes the pipe itself, so the shell's console is not pi's stdin; `%errorlevel%` is read when the line runs, which `!errorlevel!` does with delayed expansion.
			await h.type(pane, `cmd /d /v:on /c "${process.execPath} ${feeder} ${input} | pi --mode rpc --offline > ${out} 2> ${err} & echo !errorlevel! > ${code}"`);
		} else {
			// A shell needs a moment before it reads a typed line.
			await sleep(1500);
			await h.type(pane, `pi --mode rpc --offline > '${out}'`);
		}
		await until(`the shell to start pi in the pane (${label})`, 120_000, () => existsSync(out) || undefined);
		const lines = (): unknown[] =>
			(existsSync(out) ? readFileSync(out, "utf8").split(/\r?\n/) : []).flatMap((l) => {
				try {
					return l.startsWith("{") ? [JSON.parse(l) as unknown] : [];
				} catch {
					return [];
				}
			});
		const answerTo = (id: string) => lines().find((l) => (l as RpcAnswer).id === id && (l as RpcAnswer).type === "response") as RpcAnswer | undefined;
		const send = async (command: Record<string, unknown>): Promise<void> => {
			if (isWindows) appendFileSync(input, `${JSON.stringify(command)}\n`);
			else await h.type(pane, JSON.stringify(command));
		};
		const text = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").replace(/[^\x20-\x7e\n]/g, "?").trim().slice(-1500) : "(none)");
		return {
			pane,
			lines,
			type: (line) => h.type(pane, line),
			send,
			async call(command, waitMs) {
				await send(command);
				return until(`pi's answer to ${command.id} (${label})`, waitMs, () => answerTo(command.id));
			},
			async dump() {
				const events = lines().slice(-14).map((l) => JSON.stringify(l).replace(/[^\x20-\x7e]/g, "?").slice(0, 260));
				console.log(`--- ${label}: the last events (${lines().length} in all, ${existsSync(out) ? readFileSync(out).length : -1} bytes in ${out}) ---\n${events.join("\n")}`);
				if (isWindows) console.log(`--- ${label}: pi's error output ---\n${text(err)}\n--- ${label}: pi's exit code (empty while it runs) ---\n${text(code)}`);
				const panes = await h.cli(["pane", "list"], 20_000);
				console.log(`--- panes ---\n${panes.stdout.replace(/[^\x20-\x7e\n]/g, "?").slice(0, 3000)}`);
				// Every pane of the workspace with the end of what it prints, this one included: a shell that could not start pi says so there.
				for (const id of await paneIds()) {
					const read = await h.cli(["pane", "read", id, "--lines", "30"], 20_000);
					console.log(`--- pane ${id}${id === pane ? ` (${label})` : ""} ---\n${read.stdout.replace(/[^\x20-\x7e\n]/g, "?").slice(-2400)}`);
				}
			},
			close: async () => {
				// Windows: the pane's shell is cmd with a pipe from the feeder. Closing the pane alone leaves pi reading from a feeder that never ends, so pi is told its input is over first and given
				// time to end (the shell writes its exit code to a file when it does), and then the pane is closed.
				if (isWindows) {
					appendFileSync(input, FEEDER_END);
					const ended = await until(`pi to end by itself in the pane (${label})`, 30_000, () => existsSync(code) || undefined).then(() => true, () => false);
					if (!ended) console.log(`${label}: pi did not end within 30 s of the end of its input; its pane is closed under it (T15R-F006)`);
				}
				await h.cli(["pane", "close", pane]).catch(() => undefined);
			},
		};
	}
	/**
	 * What a pane whose pi went away says about it: where `pi` resolves, whether `pi --version` runs, and what `pi --mode rpc` does with an empty stdin, each printed to the pane
	 * and read back. Test code that explains a failure; it changes nothing.
	 */
	let explained = false;
	async function explainShell(rpc: RpcPi, label: string): Promise<void> {
		if (explained) return;
		explained = true;
		const h = new WorldHerdr(world);
		const steps: Array<[string, number]> = isWindows
			? [
					["where.exe pi", 4000],
					['cmd /d /c "pi --version & echo EXITCODE=%errorlevel%"', 10_000],
					['cmd /d /c "pi --mode rpc --offline < NUL & echo EXITCODE=%errorlevel%"', 14_000],
					['"DESK=$env:STRAW_BOSS_DESK ROOT=$env:STRAW_BOSS_DESK_ROOT AGENT=$env:PI_CODING_AGENT_DIR"', 3000],
				]
			: [["command -v pi", 2000], ["pi --version; echo EXITCODE=$?", 6000]];
		for (const [line, wait] of steps) {
			await rpc.type(line);
			await sleep(wait);
		}
		const read = await h.cli(["pane", "read", rpc.pane, "--lines", "60"], 20_000);
		console.log(`--- ${label}: what the shell says (where pi resolves, pi --version, pi with an empty stdin) ---\n${read.stdout.replace(/[^\x20-\x7e\n]/g, "?").slice(-4000)}`);
	}
	/**
	 * A pi in a pane of a base, answering `get_state`. A pi that goes away at once is explained in the log and started once more in a fresh pane a little later (the first
	 * failure is evidence, the second is the check).
	 */
	async function openRpcPi(label: string, splitFrom: string, cwd: string): Promise<RpcPi> {
		for (let attempt = 1; ; attempt++) {
			const rpc = await startRpcPi(label, splitFrom, cwd);
			try {
				// The shell creates the output file before pi runs, so the file proves nothing: pi is up when it answers a read-only command.
				await rpc.call({ id: `ready-${label}-${attempt}`, type: "get_state" }, 60_000);
				return rpc;
			} catch (error) {
				await rpc.dump();
				await explainShell(rpc, label);
				await rpc.close();
				if (attempt >= 2) throw error;
				console.log(`${label}: pi did not answer in its first pane (${(error as Error).message}); trying once more in a fresh pane`);
				await sleep(20_000);
			}
		}
	}
	/**
	 * Closes every pane that was not there at `known` and waits until the programs those panes ran have left `<root>/tools`: the quit check below has to find nothing the checks started,
	 * and a pi whose pane was closed a moment ago is still ending.
	 */
	async function settlePanes(known: readonly string[], programsBefore: ReadonlySet<number>): Promise<void> {
		for (const id of await paneIds()) if (!known.includes(id)) await herdr(["pane", "close", id], 20_000).catch(() => undefined);
		await until("the closed panes' programs to leave the tools folder", 90_000, async () => {
			const now = [...(await toolPids())].filter((pid) => !programsBefore.has(pid));
			return now.length === 0 ? true : undefined;
		}).catch((error: Error) => console.log(`panes settle: ${error.message}`));
	}


	/** `name=path` lines from the lookup command's output (or a message that holds them, with JSON's escaped newlines already decoded). */
	function resolutions(text: string): Record<string, string> {
		const found: Record<string, string> = {};
		for (const m of text.matchAll(/(?:^|\s)(gh|git|pi|bash)=([^\r\n]*)/g)) found[m[1] as string] = (m[2] ?? "").trim();
		return found;
	}

	/** Each name resolves to a file under the app's tools folder, not to the fake gh and git of the planted startup file or to the runner's own. */
	function assertAppFolders(found: Record<string, string>, names: string[]): void {
		for (const name of names) {
			const path = found[name];
			assert.ok(path, `${name} resolves to something: ${JSON.stringify(found)}`);
			const normal = path.replaceAll("\\", "/").toLowerCase();
			assert.ok(normal.includes("/tools/"), `${name} resolves under the app's tools folder: ${path}`);
			assert.ok(!normal.includes("decoy-bin"), `${name} is not the planted fake: ${path}`);
			// An ASCII root is compared whole; the Windows root has CJK characters, which a bash may print in its own way.
			if (/^[\x20-\x7e]*$/.test(world.root)) assert.ok(normal.startsWith(world.root.replaceAll("\\", "/").toLowerCase().replace(/^([a-z]):/, "$1:")) || normal.startsWith(`/${world.root[0]?.toLowerCase()}/`), `${name} lies under the root: ${path}`);
		}
	}

	return { underTools, herdr, herdrAnswers, paneIds, toolPids, openRpcPi, settlePanes, resolutions, assertAppFolders };
}
