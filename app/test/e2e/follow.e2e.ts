// The task 8b anchor: the packaged app follows the GUI of the real sb server and keeps the page safe. From a root tasks 5 to 7 filled, on a GitHub-hosted runner only:
// `cli.mjs restart` is logged as a restart with the window live; a killed sb server is followed within 15 s; `/boss gui stop` shows the shell screen and Start brings the GUI back;
// an emitted `suspend` and `resume` with the URL down runs no `up`; a fourth restart within 10 minutes shows the failure screen and Retry starts again; `pickFolder` (the dialog
// stubbed) opens a base under the work folder, and the preload is absent on a page of another origin; navigation off the GUI's origin is refused and the preview links open; and a
// pi started as a pane starts it resolves gh, git and pi to the app's folders and dispatches a subagent through the scripted stub model (spec: Workflows, step 7).
//   SBD_E2E=1 SBD_E2E_KIND=dev npm run test:e2e        (a GitHub-hosted runner only; the six-signal check refuses anywhere else)
import assert from "node:assert/strict";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { join, basename } from "node:path";
import { after, before, describe, it } from "node:test";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import { createPlatform } from "../../src/main/platform/index.ts";
import { homeBaseDir, loadStartConfig } from "../../src/main/runtime/config.ts";
import { readInstalled, isInstalled } from "../../src/main/runtime/readiness.ts";
import { childEnvOf, createWorld, disposeWorld, isWindows, noteUserPath, plantShellStartupDecoy, run, runWorld, WorldHerdr, type World } from "../harness/e2e-light.ts";
import { hostedCase } from "../harness/hosted.ts";
import { prepareStateFolder } from "../harness/hosted-acl.ts";
import { locatePackaged, type Packaged } from "../harness/packaged.ts";
import { CHILD_NAME, LOOKUP_COMMAND, modelsJson, RESULT_PREFIX, startStubModel, SUBAGENT_MARKER, type StubModel } from "../harness/stub-model.ts";

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
		/** Types one RPC command into the pane. */
		send(command: Record<string, unknown>): Promise<void>;
		/** Types one RPC command and waits for its response. */
		call(command: Record<string, unknown> & { id: string }, waitMs: number): Promise<RpcAnswer>;
		/** What the runner can show of a run that went nowhere: the last events, and the other panes of the workspace with the end of what they print. */
		dump(): Promise<void>;
		close(): Promise<void>;
	}
	async function openRpcPi(label: string, splitFrom: string, cwd: string): Promise<RpcPi> {
		const h = new WorldHerdr(world);
		const split = await h.cli(["pane", "split", splitFrom, "--direction", "right", "--cwd", cwd, "--no-focus"]);
		assert.equal(split.code, 0, `${split.stdout} ${split.stderr}`);
		const pane = (JSON.parse(split.stdout) as { result: { pane: { pane_id: string } } }).result.pane.pane_id;
		const out = join(world.base, `${label}.jsonl`);
		// A shell needs a moment before it reads a typed line.
		await sleep(isWindows ? 4000 : 1500);
		// The pane starts pi by name, as Herdr's `agent start` does; its stdout goes to a file the test reads, and its stdin is the pane, where the test types the RPC commands.
		await h.type(pane, isWindows ? `cmd /d /c "pi --mode rpc --offline > ${out}"` : `pi --mode rpc --offline > '${out}'`);
		await until(`pi to start in the pane (${label})`, 120_000, () => existsSync(out) || undefined);
		const lines = (): unknown[] =>
			(existsSync(out) ? readFileSync(out, "utf8").split(/\r?\n/) : []).flatMap((l) => {
				try {
					return l.startsWith("{") ? [JSON.parse(l) as unknown] : [];
				} catch {
					return [];
				}
			});
		const answerTo = (id: string) => lines().find((l) => (l as RpcAnswer).id === id && (l as RpcAnswer).type === "response") as RpcAnswer | undefined;
		const send = (command: Record<string, unknown>) => h.type(pane, JSON.stringify(command));
		return {
			pane,
			lines,
			send,
			async call(command, waitMs) {
				await send(command);
				return until(`pi's answer to ${command.id} (${label})`, waitMs, () => answerTo(command.id));
			},
			async dump() {
				const events = lines().slice(-14).map((l) => JSON.stringify(l).replace(/[^\x20-\x7e]/g, "?").slice(0, 260));
				console.log(`--- ${label}: the last events ---\n${events.join("\n")}`);
				const panes = await h.cli(["pane", "list"], 20_000);
				console.log(`--- panes ---\n${panes.stdout.replace(/[^\x20-\x7e\n]/g, "?").slice(0, 1500)}`);
				for (const id of await paneIds()) {
					if (id === pane) continue;
					const read = await h.cli(["pane", "read", id, "--lines", "25"], 20_000);
					console.log(`--- pane ${id} ---\n${read.stdout.replace(/[^\x20-\x7e\n]/g, "?").slice(-1800)}`);
				}
			},
			close: async () => void (await h.cli(["pane", "close", pane]).catch(() => undefined)),
		};
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

	/** The member pi of the home base the `/boss` commands run in: opened by the first check that needs it, closed by `closeMember`. */
	let member: RpcPi | undefined;
	let bossSeq = 0;
	async function boss(line: string): Promise<void> {
		const home = startRecord()?.base?.pane as string;
		assert.ok(home, "start.json names the home base's pane");
		member ??= await openRpcPi("member", home, homeBaseDir(loadStartConfig(world.layout, world.home)));
		const answer = await member.call({ id: `boss-${++bossSeq}`, type: "prompt", message: `/boss ${line}` }, 120_000).catch(async (error: Error) => {
			await member?.dump();
			throw error;
		});
		assert.equal(answer.success, true, `/boss ${line}: ${JSON.stringify(answer)}`);
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
		world = createWorld("fol");
		await noteUserPath(world);
		const installed = await runWorld(world, { profile: true, recipe: { forges: [{ kind: "github", host: "github.com" }], tools: [], id: "ci-follow", name: "CI follow", version: "1.0.0", instructions: "- the CI rule" } });
		assert.ok(installed.ok, `the install failed: ${JSON.stringify(installed.error ?? Object.values(installed.outcomes).filter((o) => o.failure).map((o) => o.failure))}`);
		await prepareStateFolder(world);
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

	check("runs no `up` when the URL is down across an emitted suspend and resume, and follows the server back", async () => {
		const old = startRecord()?.sb?.pid as number;
		await emitPower("suspend");
		await killSb();
		await sleep(2000);
		const resumedAt = Date.now();
		await emitPower("resume");
		await sleep(12_000);
		assert.deepEqual(
			eventsSince("follow-up", resumedAt).map((l) => l.detail),
			[],
			"the 20 s after a resume are the sleep's gap, not an unanswered GUI",
		);
		assert.ok(eventsSince("follow-resume", resumedAt).length === 1 && eventsSince("power-resume", resumedAt).length === 1);
		await until("the new sb server recorded", 180_000, newSb(old));
		const url = (await until("the GUI view's address", 30_000, guiUrl)) as string;
		await until("the GUI to answer 200", 120_000, async () => (await statusOf(url)) === 200);
	});

	check("shows the failure screen at the fourth restart within 10 minutes, and Retry starts the stack again", async () => {
		for (let i = 0; i < 4; i++) {
			if ((await shellView())?.screen === "failed") break;
			const old = startRecord()?.sb?.pid as number;
			const r = await sbCli("restart", "--reason", "e2e budget");
			assert.equal(r.code, 0, `cli.mjs restart: ${r.stdout.slice(0, 300)} ${r.stderr.slice(0, 300)}`);
			await until("the restart seen", 120_000, async () => (await shellView())?.screen === "failed" || startRecord()?.sb?.pid !== old || undefined);
			await sleep(1500);
		}
		await until("the failure screen", 60_000, async () => (await shellView())?.screen === "failed" || undefined);
		const screen = await shellView();
		assert.equal(screen?.kind, "restart-budget");
		assert.equal(await shellVisible(), true);
		assert.ok(logLines().some((l) => l.event === "restart-budget" && l.which === "sb"), "logs/start.jsonl records that the budget stopped the retrying");
		await inPage("screen", `document.getElementById('retry').click()`);
		const url = await until("the GUI to come back and the screen to go", 180_000, async () => {
			const u = await guiUrl();
			return u && (await statusOf(u)) === 200 && (await shellVisible()) === false ? u : undefined;
		});
		assert.match(url, GUI_URL);
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
		await app.close();
		const deadline = Date.now() + 180_000;
		while (Date.now() < deadline && ((await underTools()).length > 0 || (await herdrAnswers()))) await sleep(1000);
		assert.deepEqual((await underTools()).map((p) => `${p.pid} ${basename(p.executable ?? "")}`), []);
		assert.equal(await herdrAnswers(), false);
		const quit = logLines().filter((l) => l.event === "quit-stop").at(-1);
		assert.equal(quit?.ok, true);
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
