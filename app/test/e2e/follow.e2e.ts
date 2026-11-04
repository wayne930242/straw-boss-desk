// The task 8b anchor: the packaged app follows the GUI of the real sb server and keeps the page safe. From a root tasks 5 to 7 filled, on a GitHub-hosted runner only:
// `cli.mjs restart` is logged as a restart with the window live; a killed sb server is followed within 15 s; `/boss gui stop` shows the shell screen and Start brings the GUI back;
// an emitted `suspend` and `resume` with the URL down runs no `up`; a fourth restart within 10 minutes shows the failure screen and Retry starts again; `pickFolder` (the dialog
// stubbed) opens a base under the work folder, and the preload is absent on a page of another origin; navigation off the GUI's origin is refused and the preview links open; and a
// pi started as a pane starts it resolves gh, git and pi to the app's folders and dispatches a subagent through the scripted stub model (spec: Workflows, step 7).
//   SBD_E2E=1 SBD_E2E_KIND=dev npm run test:e2e        (a GitHub-hosted runner only; the six-signal check refuses anywhere else)
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { join, basename } from "node:path";
import { after, before, describe, it } from "node:test";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import { createPlatform } from "../../src/main/platform/index.ts";
import { loadStartConfig } from "../../src/main/runtime/config.ts";
import { readInstalled, isInstalled } from "../../src/main/runtime/readiness.ts";
import { childEnvOf, createWorld, disposeWorld, isWindows, noteUserPath, plantShellStartupDecoy, run, runWorld, WorldHerdr, type World } from "../harness/e2e-light.ts";
import { hostedCase } from "../harness/hosted.ts";
import { locatePackaged, type Packaged } from "../harness/packaged.ts";
import { CHILD_NAME, LOOKUP_COMMAND, modelsJson, RESULT_PREFIX, startStubModel, SUBAGENT_MARKER, type StubModel } from "../harness/stub-model.ts";
import { assertElevatedRunner } from "../harness/elevation.ts";

const kind = process.env.SBD_E2E_KIND === "release" ? "release" : "dev";
const enabled = process.env.SBD_E2E === "1";
const hosted = hostedCase("the follow e2e (task 8b)");
// The code is the same in both builds, and each run installs a whole root: the development build carries it.
const skip = !enabled ? "opens real windows and starts a real stack: runs on the CI runners only (SBD_E2E=1)" : kind !== "dev" ? "the follow checks are exercised by the development build" : hosted.run ? false : hosted.reason;
const packaged: Packaged | undefined = enabled && kind === "dev" ? locatePackaged(kind) : undefined;

if (enabled && kind === "dev" && !hosted.run && hosted.fail) {
	it("runs on a hosted runner", () => {
		assert.fail(`${hosted.reason} (SBD_REQUIRE_HOSTED_FIXTURES=1)`);
	});
}

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

const statusOf = (url: string): Promise<number> =>
	new Promise((resolve) => {
		const req = request(url, { method: "GET", timeout: 5000 }, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("timeout", () => req.destroy());
		req.on("error", () => resolve(0));
		req.end();
	});

/** The text of every string anywhere in a JSON value. */
function strings(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const v of value) strings(v, out);
	else if (typeof value === "object" && value !== null) for (const v of Object.values(value)) strings(v, out);
	return out;
}

/** A Node program that copies what is appended to its first argument's file to its stdout and ends when the reader goes away: the stdin of a pi started in a Windows pane. */
const FEEDER = [
	'import { closeSync, openSync, readSync } from "node:fs";',
	"const fd = openSync(process.argv[2], 'r');",
	"const buf = Buffer.alloc(65536);",
	"let pos = 0;",
	"process.stdout.on('error', () => process.exit(0));",
	"setInterval(() => {",
	"  const n = readSync(fd, buf, 0, buf.length, pos);",
	"  if (n > 0) { pos += n; process.stdout.write(Buffer.from(buf.subarray(0, n))); }",
	"}, 100);",
	"process.on('exit', () => closeSync(fd));",
	"",
].join("\n");

const GUI_URL = /^http:\/\/127\.0\.0\.1:\d+\//;

describe("the packaged app follows the GUI and keeps the page safe (e2e, task 8b)", { skip }, () => {
	assert.ok(!enabled || kind !== "dev" || packaged, "no packaged development build in app/out/dev");
	let world: World;
	let stub: StubModel;
	let probeServer: Server | undefined;
	let app: ElectronApplication;
	let workFolder = "";
	const platform = createPlatform();
	const apps: ElectronApplication[] = [];

	const env = (): Record<string, string> => {
		const base: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(PI_|HERDR_|ELECTRON_RUN_AS_NODE$)/.test(k)) base[k] = v;
		return { ...base, ...world.appEnv, STRAW_BOSS_DESK_ROOT: world.root };
	};
	const slotFile = (name: string) => join(world.layout.agent, "straw-boss", name);
	const readJson = <T>(file: string): T | undefined => {
		try {
			return JSON.parse(readFileSync(file, "utf8")) as T;
		} catch {
			return undefined;
		}
	};
	const startRecord = () => readJson<{ herdr: { pid: number; startTime: string | null } | null; sb: { pid: number; startTime: string | null } | null; base: { pane: string | null; workspace: string | null } | null }>(join(world.layout.state, "start.json"));
	const serverRecord = () => readJson<{ pid: number; started?: string }>(slotFile("server.json"));
	const logLines = (): Array<Record<string, unknown>> => {
		const file = join(world.layout.logs, "start.jsonl");
		return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
	};
	const eventsSince = (event: string, since: number) => logLines().filter((l) => l.event === event && Date.parse(String(l.t)) >= since);
	/** On a failed check, the tail of the start log (events and their short details only): the CI log is all there is of a runner. */
	const check = (name: string, fn: () => Promise<void>): void => {
		it(name, async () => {
			try {
				await fn();
			} catch (error) {
				const tail = logLines().slice(-40).map((l) => `${String(l.t).slice(11, 23)} ${String(l.event)} ${["detail", "which", "pid", "kind", "exit"].filter((k) => l[k] !== undefined).map((k) => `${k}=${JSON.stringify(l[k]).slice(0, 120)}`).join(" ")}`);
				console.log(`--- start.jsonl tail after "${name}" failed ---\n${tail.join("\n")}\n---`);
				throw error;
			}
		});
	};
	const underTools = () => platform.processes.listUnder(world.layout.tools.root);
	const herdrBinary = () => childEnvOf(world).HERDR_BIN_PATH as string;
	const herdr = (args: string[], timeoutMs = 30_000) => run(herdrBinary(), args, { env: childEnvOf(world), timeoutMs });
	const herdrAnswers = async () => (await herdr(["workspace", "list"], 15_000)).code === 0;
	const paneIds = async (): Promise<string[]> => [...(await herdr(["pane", "list"], 20_000)).stdout.matchAll(/"pane_id":"([^"]+)"/g)].map((m) => m[1] as string);
	const toolPids = async (): Promise<Set<number>> => new Set((await underTools()).map((p) => p.pid));

	interface RpcAnswer {
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
	interface RpcPi {
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
			close: async () => void (await h.cli(["pane", "close", pane]).catch(() => undefined)),
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

	/**
	 * The pi the `/boss` commands run in: a pi in a split pane of the base the folder hook opened (a pi outside Herdr answers a `/boss gui` command with success and does nothing,
	 * since its session has no way to the sb server; one in a pane of the home base was silent or ended at once on the Windows runners, in the pane and not in pi, while the panes
	 * of this base always ran one). Opened by the first check that needs it, closed by `closeMember`.
	 */
	let member: RpcPi | undefined;
	let bossSeq = 0;
	async function boss(line: string): Promise<void> {
		assert.ok(base, "the base was opened");
		member ??= await openRpcPi("member", base.pane, join(workFolder, "e2e-repo"));
		const open = member;
		const seen = open.lines().length;
		const answer = await open.call({ id: `boss-${++bossSeq}`, type: "prompt", message: `/boss ${line}` }, 90_000).catch(async (error: Error) => {
			await open.dump();
			throw error;
		});
		assert.equal(answer.success, true, `/boss ${line}: ${JSON.stringify(answer)}`);
		// What pi-straw-boss told the user of this command (it answers "success" for a command that said it could not do its work).
		const told = open
			.lines()
			.slice(seen)
			.filter((l) => (l as { type?: string; method?: string }).type === "extension_ui_request" && (l as { method?: string }).method === "notify") as Array<{ message?: string; notifyType?: string }>;
		for (const n of told) console.log(`/boss ${line} told (${n.notifyType ?? "info"}): ${String(n.message).replace(/[^\x20-\x7e]/g, "?").slice(0, 300)}`);
		assert.deepEqual(told.filter((n) => n.notifyType === "error").map((n) => n.message), [], `/boss ${line} reported an error`);
	}
	async function closeMember(): Promise<void> {
		const open = member;
		member = undefined;
		await open?.close();
	}

	/** Runs `code` in the page of the first web contents whose URL passes `test`; `test` is source text, since it runs inside the app. */
	const inPage = (urlTest: "gui" | "screen", code: string): Promise<unknown> =>
		app.evaluate(
			({ webContents }, { which, source }) => {
				const found = webContents.getAllWebContents().find((w) => (which === "gui" ? /^http:\/\/127\.0\.0\.1:\d+\//.test(w.getURL()) : w.getURL().endsWith("screen.html")));
				return found ? found.executeJavaScript(source, true) : undefined;
			},
			{ which: urlTest, source: code },
		);
	const guiUrl = (): Promise<string | undefined> => app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getURL()).find((u) => /^http:\/\/127\.0\.0\.1:\d+\//.test(u)));
	const shellView = () =>
		inPage(
			"screen",
			`(() => { const c = document.getElementById('card'); return { mode: document.body.dataset.mode, screen: c.hidden ? null : c.dataset.screen ?? null, kind: c.hidden ? null : c.dataset.failureKind ?? null }; })()`,
		) as Promise<{ mode: string; screen: string | null; kind: string | null } | undefined>;
	/** Whether the shell view (the second child of the first window) is showing. */
	const shellVisible = () => app.evaluate(({ BaseWindow }) => (BaseWindow.getAllWindows()[0]?.contentView.children[1] as unknown as { getVisible(): boolean } | undefined)?.getVisible());
	const background = () => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.getBackgroundColor());
	const emitPower = (event: "suspend" | "resume") => app.evaluate(({ powerMonitor }, e) => void powerMonitor.emit(e), event);

	async function sbCli(...args: string[]) {
		const found = readInstalled(world.layout);
		assert.ok(isInstalled(found));
		return run(found.node, [found.sbCli, ...args], { env: childEnvOf(world), timeoutMs: 180_000 });
	}

	/** The sb server's pid, killed the way a crash would, after the platform confirms it is the app's own program. */
	async function killSb(): Promise<number> {
		const rec = serverRecord();
		assert.ok(rec?.pid, "server.json names the sb server");
		const info = (await platform.processes.inspect([rec.pid]))[0];
		assert.ok(info?.executable && info.executable.startsWith(world.layout.tools.root), `the sb server runs from the tools folder: ${info?.executable}`);
		process.kill(rec.pid, "SIGKILL");
		return rec.pid;
	}

	/** A new sb pid in start.json (any start time), different from `old`. */
	const newSb = (old: number) => () => {
		const r = startRecord();
		return r?.sb && r.sb.pid !== old ? r.sb : undefined;
	};

	before(async () => {
		// S53-F004: the claim that pi-straw-boss starts under a full administrator token holds only while this runner's token is one.
		assertElevatedRunner();
		world = createWorld("fol");
		await noteUserPath(world);
		const installed = await runWorld(world, { profile: true, recipe: { forges: [{ kind: "github", host: "github.com" }], tools: [], id: "ci-follow", name: "CI follow", version: "1.0.0", instructions: "- the CI rule" } });
		assert.ok(installed.ok, `the install failed: ${JSON.stringify(installed.error ?? Object.values(installed.outcomes).filter((o) => o.failure).map((o) => o.failure))}`);
		// The scripted stub model is the agent folder's default: every pi of the stack answers from it, and nothing leaves the machine.
		stub = await startStubModel();
		writeFileSync(join(world.layout.agent, "models.json"), modelsJson(stub.baseUrl));
		const settingsFile = join(world.layout.agent, "settings.json");
		const settings = readJson<Record<string, unknown>>(settingsFile) ?? {};
		writeFileSync(settingsFile, JSON.stringify({ ...settings, defaultProvider: "stub", defaultModel: "stub-1", enabledModels: ["stub/stub-1"] }, null, 2));
		// The PM's own startup file and a fake gh and git ahead of the real ones: a pane that read them would run the fakes (a guarded fixture: written into the scratch home only).
		if (!isWindows) plantShellStartupDecoy(world);
		workFolder = loadStartConfig(world.layout, world.home).workFolder;
	});

	after(async () => {
		await closeMember().catch(() => undefined);
		for (const a of apps) await a.close().catch(() => undefined);
		if ((await underTools().catch(() => [])).length > 0) {
			// Whatever a failed test left: the second-instance stop is the stop the uninstaller runs.
			const child = packaged ? run(packaged.executable, ["--stop-stack"], { env: env(), timeoutMs: 180_000 }) : Promise.resolve();
			await child.catch(() => undefined);
		}
		await stub?.close().catch(() => undefined);
		await new Promise<void>((resolve) => (probeServer ? probeServer.close(() => resolve()) : resolve()));
		const before = world.userPathBefore;
		const real = world.realUserPath;
		const userPath = world.userPath;
		await disposeWorld(world);
		if (real) assert.deepEqual(await userPath.read(), before ?? null, "the user PATH is as it was before the run");
	});

	let firstUrl = "";
	/** The base the folder hook opened: its workspace and its first pane. */
	let base: { workspace: string; pane: string } | undefined;

	check("starts the stack, loads the GUI in its view, and paints the window in the standard view's background", async () => {
		app = await electron.launch({ executablePath: packaged?.executable, args: ["--lang=en-US"], env: env(), timeout: 60_000 });
		apps.push(app);
		firstUrl = await until("the GUI view to load the server's address", 240_000, guiUrl);
		assert.equal(await statusOf(firstUrl), 200);
		await until("both start times in start.json", 120_000, () => {
			const r = startRecord();
			return r?.herdr?.startTime && r.sb?.startTime ? r : undefined;
		});
		assert.match(String(await background()), /16161e/i, "the window background is the page's --bg until a view is set");
		const bridge = (await inPage("gui", `typeof window.strawBossDesk === 'object' && typeof window.strawBossDesk.pickFolder`)) as string | boolean;
		assert.equal(bridge, "function", "the GUI page has the folder hook");
	});

	check("logs `cli.mjs restart` as a restart by pid change while the window stays live, and start.json holds the new pid with its start time", async () => {
		const before = startRecord()?.sb?.pid as number;
		const since = Date.now();
		const restarted = await sbCli("restart", "--reason", "e2e follow");
		assert.equal(restarted.code, 0, `cli.mjs restart: ${restarted.stdout.slice(0, 300)} ${restarted.stderr.slice(0, 300)}`);
		const sb = await until("start.json to hold the new sb server with its start time", 120_000, () => {
			const r = startRecord()?.sb;
			return r && r.pid !== before && r.startTime ? r : undefined;
		});
		assert.notEqual(sb.pid, before);
		await until("the restart in logs/start.jsonl", 30_000, () => eventsSince("follow-restart", since).length >= 1);
		assert.equal(await guiUrl(), firstUrl, "the window stays on its page: a restart keeps the address");
		assert.equal(await statusOf(firstUrl), 200);
		assert.equal(JSON.stringify(startRecord()).includes(`"pid":${before},`), false, "the old sb record is gone");
	});

	check("follows a killed sb server within 15 s: the new pid is recorded and the GUI answers again", async () => {
		const old = startRecord()?.sb?.pid as number;
		const killed = await killSb();
		const began = Date.now();
		assert.equal(killed, old);
		// Followed: within 15 s the follower either sees a restart (the pi of the base started another server) or runs the gone rule; how long the new server then takes to come up
		// is the platform's (`up` on Windows takes about 25 s), and it has to be recorded and answer.
		await until("the follower to act on the kill", 15_000, () => eventsSince("follow-restart", began).length + eventsSince("follow-gone", began).length > 0);
		console.log(`followed the killed sb server after ${((Date.now() - began) / 1000).toFixed(1)} s`);
		await until("the new sb server recorded", 180_000, newSb(old));
		const url = await until("the GUI view's address", 30_000, guiUrl);
		await until("the GUI to answer 200", 120_000, async () => (await statusOf(url)) === 200);
		await until("the new sb start time", 120_000, () => startRecord()?.sb?.startTime);
		console.log(`the killed sb server was back after ${((Date.now() - began) / 1000).toFixed(1)} s`);
	});

	// S53-F001. This check runs before the folder-hook check opens a base: a pi of a base that finds the sb server gone starts another one within seconds (seen in run 41599338092,
	// where the URL answered again 2 ms after the resume), and then "no `up` in the grace" is true whatever the grace does. Here nothing but the follower can bring the server back,
	// and the check asserts that: the old address is still down just after the resume and at the sample point, and no restart or move was seen before it.
	check("runs no `up` when the URL is down across an emitted suspend and resume, and follows the server back", async () => {
		// T8B-F001: a leftover failure screen is cleared first, since a stopped follower would make "no `up`" true without testing anything.
		if (await onFailureScreen()) await pressRetry();
		assert.equal(base, undefined, "no base is open: a pi of a base would restart the server by itself");
		const old = startRecord()?.sb?.pid as number;
		const oldUrl = (await until("the GUI view's address", 30_000, guiUrl)) as string;
		assert.equal(await statusOf(oldUrl), 200, "the address answers before the suspend");
		const began = Date.now();
		await emitPower("suspend");
		await killSb();
		await sleep(2000);
		const resumedAt = Date.now();
		await emitPower("resume");
		await sleep(1000);
		assert.notEqual(await statusOf(oldUrl), 200, "the old address is down just after the resume: the check tests the grace");
		// 16.5 s after the resume: past the ~10 to 12 s at which the gone rule would fire without the grace, and inside the 20 s of the grace.
		await sleep(Math.max(0, resumedAt + 16_500 - Date.now()));
		assert.notEqual(await statusOf(oldUrl), 200, "nothing brought the server back during the grace: the follower was the only one that could");
		assert.deepEqual(
			eventsSince("follow-up", resumedAt).map((l) => l.detail),
			[],
			"the 20 s after a resume are the sleep's gap, not an unanswered GUI",
		);
		assert.deepEqual([...eventsSince("follow-restart", began), ...eventsSince("follow-moved", began)].map((l) => l.event), [], "no restart or move was seen before the sample");
		assert.ok(eventsSince("follow-resume", resumedAt).length === 1 && eventsSince("power-resume", resumedAt).length === 1);
		assert.deepEqual(eventsSince("restart-budget", began).map((l) => l.which), [], "the budget did not stop the follower, so the follower was running when it judged");
		assert.equal(await onFailureScreen(), false, "no failure screen: the follower is running");
		assert.deepEqual([...eventsSince("follow-screen", began), ...eventsSince("start-failed", began)].map((l) => l.detail ?? l.kind), [], "no shell screen was shown and no start failed since the suspend");
		// The grace ends and the gone rule runs its one `up`.
		await until("the follower's `up` after the grace", 120_000, () => eventsSince("follow-up", resumedAt).length >= 1 || eventsSince("follow-restart", resumedAt).length >= 1);
		assert.ok(Date.now() - resumedAt >= 16_500);
		await until("the new sb server recorded", 180_000, newSb(old));
		const url = (await until("the GUI view's address", 30_000, guiUrl)) as string;
		await until("the GUI to answer 200", 120_000, async () => (await statusOf(url)) === 200);
		assert.deepEqual(eventsSince("restart-budget", began).map((l) => l.which), [], "no restart-budget event during the suspend check");
		assert.equal(await onFailureScreen(), false);
	});

	check("opens a base under the work folder from the folder hook, with the dialog stubbed", async () => {
		const repo = join(workFolder, "e2e-repo");
		mkdirSync(repo, { recursive: true });
		writeFileSync(join(repo, "README.md"), "# e2e\n");
		await app.evaluate(
			({ dialog }, folder) => {
				const g = globalThis as unknown as { __dialog: unknown[] };
				g.__dialog = [];
				(dialog as { showOpenDialog: unknown }).showOpenDialog = async (...args: unknown[]) => {
					g.__dialog.push(args.slice(-1)[0]);
					return { canceled: false, filePaths: [folder] };
				};
			},
			repo,
		);
		const picked = await inPage("gui", `window.strawBossDesk.pickFolder({ defaultPath: '/somewhere/else', title: 'Choose a folder' })`);
		assert.equal(picked, repo);
		const options = (await app.evaluate(() => (globalThis as unknown as { __dialog: unknown[] }).__dialog)) as Array<{ title?: string; defaultPath?: string; properties?: string[] }>;
		assert.equal(options.length, 1);
		assert.equal(options[0]?.defaultPath, workFolder, "the dialog opens in the work folder, not where the page asks");
		assert.equal(options[0]?.title, "Choose a folder");
		assert.ok(options[0]?.properties?.includes("openDirectory"));

		// A cancelled dialog reads as null.
		await app.evaluate(({ dialog }) => void ((dialog as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: true, filePaths: [] as string[] })));
		assert.equal(await inPage("gui", `window.strawBossDesk.pickFolder({})`), null);

		// The picked folder opens as a base through the GUI's own route, as its picker does (the page carries the CSRF secret).
		await inPage(
			"gui",
			`window.__open = undefined; (async () => { const csrf = document.querySelector('meta[name="sb-csrf"]').content;
				const r = await fetch('api/open/base', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sb-csrf': csrf }, body: JSON.stringify({ dir: ${JSON.stringify(repo)}, label: 'e2e-repo' }) });
				window.__open = { status: r.status, body: await r.json() }; })().catch((e) => { window.__open = { status: 0, body: String(e) }; }); true`,
		);
		const opened = (await until("the base to open", 180_000, () => inPage("gui", "window.__open"))) as { status: number; body: { workspace?: string; pane?: string } };
		assert.equal(opened.status, 200, JSON.stringify(opened.body));
		assert.ok(opened.body.workspace && opened.body.pane);
		const list = await herdr(["workspace", "list"]);
		assert.ok(list.stdout.includes("e2e-repo"), `the base is in Herdr's list: ${list.stdout.slice(0, 300)}`);
		base = { workspace: opened.body.workspace as string, pane: opened.body.pane as string };
	});

	check("shows the shell screen after `/boss gui stop`, and Start brings the GUI back", async () => {
		const since = Date.now();
		await boss("gui stop");
		await until("the gui-stopped screen", 90_000, async () => (await shellView())?.screen === "gui-stopped");
		assert.equal(await shellVisible(), true);
		await inPage("screen", `document.getElementById('retry').click()`);
		await until("the GUI to come back and the screen to go", 120_000, async () => {
			const url = await guiUrl();
			return url && (await statusOf(url)) === 200 && (await shellVisible()) === false ? url : undefined;
		});
		assert.ok(eventsSince("follow-up", since).some((l) => l.detail === "start button"), "the Start button ran `up`");
		assert.equal(readJson<{ gui?: { stopped?: boolean } }>(slotFile("server.json"))?.gui?.stopped ?? false, false);
	});

	check("paints the window in the colour of the server's default view when it changes", async () => {
		try {
			await boss("gui view zen");
			await until("the Zen background", 60_000, async () => /14110e/i.test(String(await background())) || undefined);
			await boss("gui view geek");
			await until("the geek background", 60_000, async () => /000000/.test(String(await background())) || undefined);
			await boss("gui view standard");
			await until("the standard background", 60_000, async () => /16161e/i.test(String(await background())) || undefined);
		} finally {
			// The next checks kill and restart the sb server: a pi session of the base would look for it too.
			await closeMember();
		}
	});

	/** Retry on the failure screen: a whole start, which begins both crash budgets again. Waits until the GUI answers and the screen is gone. */
	const pressRetry = async (): Promise<string> => {
		await inPage("screen", `document.getElementById('retry').click()`);
		return until("the GUI to come back and the screen to go", 180_000, async () => {
			const u = await guiUrl();
			return u && (await statusOf(u)) === 200 && (await shellVisible()) === false ? u : undefined;
		});
	};
	// The card keeps a failure's text after Retry hides the shell view (run 41595908673 read it 12 s after Retry), so a screen counts only while the view shows.
	const onFailureScreen = async () => (await shellView())?.screen === "failed" && (await shellVisible()) === true;
	/** One `cli.mjs restart`, and the wait until the follower saw it (a new pid in start.json) or the failure screen came. */
	const restartOnce = async (reason: string): Promise<void> => {
		const old = startRecord()?.sb?.pid as number;
		const r = await sbCli("restart", "--reason", reason);
		assert.equal(r.code, 0, `cli.mjs restart: ${r.stdout.slice(0, 300)} ${r.stderr.slice(0, 300)}`);
		await until("the restart seen", 120_000, async () => (await onFailureScreen()) || startRecord()?.sb?.pid !== old || undefined);
		await sleep(1500);
	};

	// T8B-F001. The earlier checks restarted the sb server already (inside the same 10 minutes), so counting from here would trip the budget at an unknown restart. The check first spends
	// whatever budget is left (restarts until the screen shows) and presses Retry, which is a whole start and begins the budget again; the four restarts after it are then its own, and
	// the first three are asserted to leave the page alone and log no `restart-budget`.
	check("shows the failure screen at the fourth restart within 10 minutes, and Retry starts the stack again", async () => {
		for (let i = 0; i < 4 && !(await onFailureScreen()); i++) await restartOnce("e2e budget drain");
		assert.equal(await onFailureScreen(), true, "the budget of the earlier restarts is spent");
		const fresh = Date.now();
		assert.match(await pressRetry(), GUI_URL);
		for (let n = 1; n <= 3; n++) {
			await restartOnce(`e2e budget ${n}`);
			assert.equal(await onFailureScreen(), false, `no failure screen after restart ${n} of 3`);
			assert.deepEqual(eventsSince("restart-budget", fresh).map((l) => l.which), [], `no restart-budget event after restart ${n} of 3`);
		}
		await restartOnce("e2e budget 4");
		await until("the failure screen", 60_000, async () => (await onFailureScreen()) || undefined);
		const screen = await shellView();
		assert.equal(screen?.kind, "restart-budget");
		assert.equal(await shellVisible(), true);
		assert.deepEqual(eventsSince("restart-budget", fresh).map((l) => l.which), ["sb"], "logs/start.jsonl records that the fourth restart stopped the retrying, once");
		assert.match(await pressRetry(), GUI_URL);
	});

	check("has no folder hook on a page of another origin", async () => {
		probeServer = createServer((_req, res) => void res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>other</title>"));
		await new Promise<void>((resolve) => probeServer?.listen(0, "127.0.0.1", () => resolve()));
		const port = (probeServer.address() as { port: number }).port;
		const seen = (await app.evaluate(
			async ({ app: electronApp, WebContentsView }, { url }) => {
				const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, preload: `${electronApp.getAppPath()}/dist/preload/gui.cjs` } });
				await view.webContents.loadURL(url);
				const type = await view.webContents.executeJavaScript("typeof window.strawBossDesk");
				view.webContents.close();
				return type;
			},
			{ url: `http://127.0.0.1:${port}/` },
		)) as string;
		assert.equal(seen, "undefined");
	});

	check("refuses navigation off the GUI's origin, and opens only https and preview links in the browser", async () => {
		await app.evaluate(({ shell }) => {
			const g = globalThis as unknown as { __external: string[] };
			g.__external = [];
			(shell as { openExternal: unknown }).openExternal = async (u: string) => void g.__external.push(u);
		});
		const external = async () => (await app.evaluate(() => (globalThis as unknown as { __external: string[] }).__external)) as string[];
		const before = (await guiUrl()) as string;
		const act = async (code: string) => {
			await inPage("gui", `${code}; true`);
			await sleep(1500);
		};
		// The preview links: each form calls openExternal once with the URL, and the GUI view stays on its page.
		await act(`window.open('http://127.0.0.1:8080/')`);
		assert.deepEqual(await external(), ["http://127.0.0.1:8080/"]);
		await act(`location.href = 'http://localhost:8100/'`);
		assert.deepEqual(await external(), ["http://127.0.0.1:8080/", "http://localhost:8100/"]);
		assert.equal(await guiUrl(), before, "the GUI view stays on its page");
		// Port 8101 in either form calls it zero times.
		await act(`window.open('http://127.0.0.1:8101/')`);
		await act(`location.href = 'http://127.0.0.1:8101/'`);
		assert.equal((await external()).length, 2);
		assert.equal(await guiUrl(), before);
		// Any other http host and a port outside the range open nothing and leave the page where it is (the other schemes are unit cases: the browser would hand them to the OS).
		for (const target of ["http://example.com:8080/", "http://127.0.0.1:9/"]) {
			await act(`location.href = ${JSON.stringify(target)}`);
			assert.equal((await external()).length, 2, target);
			assert.equal(await guiUrl(), before, target);
		}
		// An https link opens, from a new-window request and from a navigation.
		await act(`window.open('https://example.com/a')`);
		assert.equal((await external()).at(-1), "https://example.com/a");
		await act(`location.href = 'https://example.com/b'`);
		assert.equal((await external()).at(-1), "https://example.com/b");
		assert.equal((await external()).length, 4);
		assert.equal(await guiUrl(), before, "the GUI view never left its page");
		assert.equal(await statusOf(before), 200);
	});

	check("resolves gh, git and pi in a pane of the base to the app's folders, and a subagent does too", async () => {
		assert.ok(base, "the base was opened");
		const repo = join(workFolder, "e2e-repo");
		const knownPanes = await paneIds();
		const programsBefore = await toolPids();
		const parent = await openRpcPi("parent", base.pane, repo);
		try {
			const lookup = await parent.call({ id: "lookup", type: "bash", command: LOOKUP_COMMAND }, 180_000);
			assert.equal(lookup.success, true, JSON.stringify(lookup));
			const resolved = resolutions(lookup.data?.output ?? "");
			assertAppFolders(resolved, ["gh", "git", "pi"]);
			console.log(`pane resolves: ${JSON.stringify(Object.fromEntries(Object.entries(resolved).map(([k, v]) => [k, v.replace(/[^\x20-\x7e]/g, "?")])))}`);

			// One subagent through the scripted stub: the parent calls `subagent`, the child runs the lookup in its bash tool, and the parent hears of its completion. The `bash`
			// command above makes pi run a turn of its own (pi-robot-hand's follow-up), so the prompt is queued behind it when that turn still runs.
			const dispatched = await parent.call({ id: "dispatch", type: "prompt", message: `${SUBAGENT_MARKER} go`, streamingBehavior: "followUp" }, 60_000);
			assert.equal(dispatched.success, true, JSON.stringify(dispatched));
			const heard = await until("the parent to hear of the child", 300_000, () => {
				const all = strings(parent.lines());
				return all.find((s) => s.includes(`Sub-agent "${CHILD_NAME}"`) && /completed|failed/.test(s));
			}).catch(async (error: Error) => {
				await parent.dump();
				throw error;
			});
			assert.match(heard, new RegExp(`Sub-agent "${CHILD_NAME}" completed`), `the child's result: ${heard.slice(0, 600)}`);
			assert.ok(heard.includes(RESULT_PREFIX), "the child's final answer carries what it saw");
			const child = resolutions(heard);
			assertAppFolders(child, ["gh", "git", "pi"]);
			if (isWindows) assertAppFolders(child, ["bash"]);
		} finally {
			await settlePanes(knownPanes, programsBefore);
		}
	});

	check("quits with nothing left under <root>/tools and no answering Herdr", async () => {
		// While the app quits (macOS), every program under the tools folder is noted with its parent, working folder and birth, so a program that is still there when the stop looks is
		// explained by who started it. Only `ps` (pid, parent pid, elapsed time) and `lsof` (the working folder) are read; no command line.
		interface Seen {
			ppid: number | null;
			cwd: string | null;
			/** When the program was born, from its age at the first look (to a second). */
			bornAt: number;
			file: string;
			first: number;
			last: number;
		}
		const seen = new Map<number, Seen>();
		const began = Date.now();
		let sampling = !isWindows;
		const ageSeconds = (etime: string): number => {
			const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
			return m ? Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]) : 0;
		};
		const look = async (pid: number, file: string, now: number): Promise<Seen> => {
			const env = { PATH: "/bin:/usr/bin:/usr/sbin" };
			const ps = (await run("ps", ["-o", "ppid=,etime=", "-p", String(pid)], { env, timeoutMs: 5000 })).stdout.trim().split(/\s+/);
			const cwd = (await run("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], { env, timeoutMs: 8000 })).stdout.split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? null;
			return { ppid: ps[0] ? Number(ps[0]) : null, cwd, bornAt: now - ageSeconds(ps[1] ?? "") * 1000, file, first: now, last: now };
		};
		const sampler = (async () => {
			while (sampling) {
				const now = Date.now();
				for (const p of await underTools().catch(() => [])) {
					const known = seen.get(p.pid);
					if (known) known.last = now;
					else seen.set(p.pid, await look(p.pid, basename(p.executable ?? "?"), now));
				}
				await sleep(100);
			}
		})();
		// U13 evidence: what `herdr pane get` answers once Herdr is gone, which is the call `balance.mjs after-close` of pi-straw-boss polls (every 250 ms, for 30 s) to learn that its pane is gone.
		// The helper calls an answer "gone" by the rule below, copied from `src/balance.mjs` of pi-straw-boss 0.56.0 (HERDR_GONE and `paneGone`). One answer is read after the stack is down and printed
		// with whether the rule takes it for gone, so a macOS answer that the rule does not know is read straight from the run. (One call per run: a polling probe would itself be a program under tools.)
		const HERDR_GONE = /\b(ENOENT|ECONNREFUSED)\b|os error (2|3|61|111)\b/;
		const panesBeforeQuit = await paneIds().catch(() => [] as string[]);
		const probedPane = panesBeforeQuit[0] ?? "p_none";
		const answerOf = async (args: string[]): Promise<string> => {
			const r = await herdr(args, 15_000);
			const stderr = r.stderr ?? "";
			const first = (text: string): string => text.trim().split(/\r?\n/)[0]?.replace(/\s+/g, " ").replace(/\/[^\s"']*/g, "<path>").slice(0, 300) ?? "";
			// balance.mjs reads only the stderr of the failed call (`error.stderr`), so the two streams are shown apart.
			const gone = r.code !== 0 && (stderr.includes("pane_not_found") || HERDR_GONE.test(stderr));
			return `\`herdr ${args.slice(0, 2).join(" ")}\`: exit ${r.code}${r.timedOut ? " (timed out)" : ""}, balance.mjs would call it ${gone ? "gone" : "NOT gone"}\n  stdout: ${first(r.stdout) || "(empty)"}\n  stderr: ${first(stderr) || "(empty)"}`;
		};
		let goneAnswers = "(the stack did not go down within the wait)";
		const brokerFile = join(world.layout.agent, "intercom", "broker.pid");
		const facts = () =>
			`broker.pid=${existsSync(brokerFile) ? readFileSync(brokerFile, "utf8").trim() : "(none)"}; server.json=${JSON.stringify(serverRecord() ?? null)}; the start log's last stop: ${JSON.stringify(logLines().filter((l) => l.event === "stop-end").at(-1) ?? null)}`;
		try {
			await app.close();
			const deadline = Date.now() + 180_000;
			while (Date.now() < deadline && ((await underTools()).length > 0 || (await herdrAnswers()))) await sleep(1000);
			goneAnswers = `${await answerOf(["pane", "get", probedPane])}\n${await answerOf(["workspace", "list"])}`;
			assert.deepEqual((await underTools()).map((p) => `${p.pid} ${basename(p.executable ?? "")}`), []);
			assert.equal(await herdrAnswers(), false);
			const quit = logLines().filter((l) => l.event === "quit-stop").at(-1);
			const stop = logLines().filter((l) => l.event === "stop-end").at(-1);
			assert.ok(quit !== undefined && stop !== undefined, "the quit ran the stop sequence to its end");
			assert.equal(stop.herdrAnswers, false, "the stop saw Herdr's socket go quiet");
			if (isWindows) assert.equal(quit.ok, true, `the quit's stop was not ok: ${JSON.stringify(stop)}`);
			else if (quit.ok !== true) {
				// Upstream seam U13, still present on macOS with pi-straw-boss 0.56.0 although 0.54.0 made `balance.mjs after-close` end when Herdr is gone (Windows never shows it). The evidence, from CI:
				// `runtime e2e (macos-15)` failed this check in 3 of 7 runs (jobs 126381502036, 126385298298, 126391054666) and passed in the others; in every failure the stop reported one `node`
				// and nothing else, with a base's folder as its working folder, a child of the pane's quitting pi, born +1081 ms after the quit began (the moment the pi left, with the Herdr server
				// that was seen to the same instant) and alive until +31026 ms: the helper's whole 30 s CLOSE_WAIT. The helper started after Herdr was gone and still did not take its `pane get`
				// for "gone", so on macOS that call answers something `paneGone` does not know; the log above this check prints what `herdr pane get` answers while the app quits. The product's
				// stop and its kill rule stay as they are (a program left running under tools is reported, never killed). So the stop may report that helper and nothing else: no refusal of
				// the kill rule, and every program it reports a detached one (parent 1, or the quitting pi that started it) with a base's folder as its working folder, born after Herdr exited,
				// a `node` that lived about 30 s. Any other report fails.
				assert.deepEqual(stop.refused, [], `the stop refused to kill something: ${JSON.stringify(stop)}`);
				const reported = (stop.leftovers ?? []) as Array<{ pid: number; file: string }>;
				assert.ok(reported.length > 0, `the stop was not ok and reported no program: ${JSON.stringify(stop)}`);
				const exited = Date.parse(String(logLines().filter((l) => l.event === "herdr-exit" && Date.parse(String(l.t)) >= began).at(-1)?.t));
				assert.ok(Number.isFinite(exited), "the log shows the Herdr server exit during the quit");
				const home = realpathSync(world.home);
				for (const l of reported) {
					const v = seen.get(l.pid);
					const why = `${l.pid} ${l.file}: ${JSON.stringify(v)}`;
					assert.ok(v !== undefined, `a program the stop reported was never looked at (${why})`);
					// Detached means the parent is gone or going: parent 1, or the quitting pi that started it, which the sampler saw leave within a second of the helper's birth.
					const parent = v.ppid === null ? undefined : seen.get(v.ppid);
					assert.ok(v.ppid === 1 || (parent !== undefined && parent.last <= v.first + 1000), `not detached (${why}; parent ${JSON.stringify(parent)})`);
					assert.ok(v.cwd !== null && realpathSync(v.cwd).startsWith(realpathSync(workFolder)) && realpathSync(v.cwd).startsWith(home), `its working folder is not a base's (${why})`);
					assert.ok(v.bornAt >= exited - 1500, `born before Herdr exited (${why}; Herdr exited at ${exited})`);
					// S53-F005: the helper is a `node` (told by its executable's path, never by a command line) that lives its 30 s and leaves; any other short-lived program of a quitting pi fails here.
					assert.match(basename(v.file), /^node(\.exe)?$/i, `the reported program is not node (${why})`);
					assert.ok(v.last - v.bornAt <= 36_000, `it lived longer than the helper's ~30 s (${why}: ${Math.round((v.last - v.bornAt) / 1000)} s)`);
				}
				console.log(`U13: the stop reported ${reported.length} pane-balance helper(s) (${reported.map((l) => l.pid).join(", ")}); each is detached (or was read while its quitting parent left), in a base's folder, and born after Herdr exited, and all had left when the wait ended`);
			}
		} finally {
			sampling = false;
			await sampler;
			console.log(`--- what herdr answered once the app had quit and Herdr was gone, pane ${probedPane} (U13 evidence; pi-straw-boss 0.56.0's balance.mjs calls an answer "gone" on pane_not_found, ENOENT, ECONNREFUSED or os error 2/3/61/111) ---\n${goneAnswers}`);
			if (seen.size > 0) console.log(`--- programs under the tools folder seen while the app quit (ms after the quit began) ---\n${[...seen].map(([pid, v]) => `${pid} ${v.file}, ppid ${v.ppid}, cwd ${v.cwd}, born +${v.bornAt - began} ms, seen from +${v.first - began} to +${v.last - began} ms`).join("\n")}\n${facts()}`);
		}
	});

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
});
