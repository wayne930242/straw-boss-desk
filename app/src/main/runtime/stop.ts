import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { EnvMap } from "../env.ts";
import type { Layout } from "../paths.ts";
import { osPidAlive } from "../bootstrap/state.ts";
import type { CommandRunner, Processes } from "../platform/types.ts";
import { firstLineOf } from "./failure.ts";
import type { Clock } from "./clock.ts";
import type { HerdrControl } from "./herdr.ts";
import { handleHeld, isUnderTools, killOwned, listLeftovers, type KillOutcome, type Leftover, type ProcHandle } from "./identity.ts";
import type { RuntimeEvent } from "./log.ts";
import { lastJsonLine } from "./sbup.ts";
import type { ProcessRecord, StartFile } from "./start-file.ts";

// The stop sequence (spec: Runtime supervisor, Stop; desk B7 plan, **Stop order**), as `stop.ps1` and `99-stop.sh` run it:
//   1. `cli.mjs stop` (120 s on Windows, 45 s on macOS). It marks the sb server stopped on purpose, so a pi session's look cannot start a new one while Herdr shuts down.
//      It starts a new process that loads the package's files from disk now, so it runs only when the `pkg:pi-straw-boss` stage is `ok`, whatever runs already (T8C-F001).
//      Otherwise it is skipped: a running sb server that start.json names is stopped by the kill rule alone (step 2), and one that no record names is reported and left alone
//      (R8A-F001).
//   2. wait 10 s for the sb server to go; one that stays is killed only while the kill rule allows it. With the package unverified there was no CLI to wait for, so a recorded
//      sb server is killed at once, and one the rule does not allow (its start time is missing or differs) is reported like an unrecorded one.
//   3. `herdr server stop` on the app's socket, then wait for the server's pid. Workspaces stay open: Herdr restores them at the next start.
//   4. kill what is left of the recorded processes, and the pi-intercom broker, only by the kill rule (`identity.ts`).
//   5. one listing for whatever still runs from `<root>/tools`, and a look at whether the app's Herdr socket still answers.
// `gui.json` and `server.json` stay: the server owns them, and `server.json`'s `gui.port` is how the next start keeps the port.

export interface StopTimeouts {
	/** `cli.mjs stop`: 120 s on Windows, 45 s elsewhere. */
	cliStopMs: number;
	/** How long to wait for the sb server to leave after `cli.mjs stop`. */
	sbWaitMs: number;
	herdrStopMs: number;
	/** How long to wait for the Herdr server's pid after `herdr server stop`. */
	herdrWaitMs: number;
}

export const stopTimeoutsFor = (platform: "win32" | "darwin"): StopTimeouts => ({ cliStopMs: platform === "win32" ? 120_000 : 45_000, sbWaitMs: 10_000, herdrStopMs: 30_000, herdrWaitMs: 10_000 });

export interface StopDeps {
	layout: Layout;
	processes: Processes;
	run: CommandRunner;
	startFile: StartFile;
	herdr: HerdrControl;
	/** The constructed environment every `cli.mjs` call gets (the same one `herdr` runs with). */
	env: EnvMap;
	nodePath: string;
	/** `<agent>/npm/node_modules/pi-straw-boss/dist/server/cli.mjs`. */
	sbCli: string;
	/** True when the `pkg:pi-straw-boss` stage is `ok`: the only case in which `cli.mjs` runs, whatever sb server runs already (R8A-F001, T8C-F001). */
	sbPackageVerified: boolean;
	/** The handle of the Herdr server this app started in this run, when it did. */
	herdrHandle: ProcHandle | null;
	clock: Clock;
	log: RuntimeEvent;
	timeouts?: Partial<StopTimeouts>;
	/** Default: signal 0. */
	pidAlive?: (pid: number) => boolean;
	/**
	 * Records the pid `server.json` names now (the follower's re-recording, with the executable check), for a server that restarted since the last record.
	 * Absent: the stop uses the record it has.
	 */
	syncSbRecord?: (pid: number) => Promise<void>;
	/** Reads `<slot>/server.json`: `pid`, `started`, `stopped`. Absent or null: no record to follow. */
	readServerRecord?: (slotDir: string) => { pid: number; stopped: boolean } | null;
	/** A fast stop (Windows `session-end`): only `cli.mjs stop`, with this limit. */
	onlyCliStopMs?: number;
}

export interface StopReport {
	/** Nothing of the app runs from `<root>/tools` and its Herdr socket does not answer. */
	ok: boolean;
	cliStop: { ran: boolean; exit: number | null; outcome: string; timedOut: boolean; detail: string };
	/**
	 * The pid of a running sb server of a package that is not verified, which the stop could not end: no record names it, or the record's start time did not allow the kill.
	 * Reported with its own failure kind (`sb-unverified`), never stopped without the rule (R8A-F001, T8C-F001, T8C-F002).
	 */
	unverifiedSb: number | null;
	killed: KillOutcome[];
	/** A kill the rule refused: the process is not known to be ours, so it was left alone and (if it still runs) is in `leftovers`. */
	refused: Array<{ what: string; pid: number; reason: string }>;
	leftovers: Leftover[];
	herdrAnswers: boolean;
	/** Plain lines for the failure screen and the log. */
	notes: string[];
}

const pidFile = (layout: Layout): string => join(layout.agent, "intercom", "broker.pid");

/** The pid in `broker.pid` of this agent folder, or null. */
function readBrokerPid(layout: Layout): number | null {
	try {
		const text = readFileSync(pidFile(layout), "utf8").trim();
		return /^\d+$/.test(text) && Number(text) > 0 ? Number(text) : null;
	} catch {
		return null;
	}
}

const parseServerRecord = (slotDir: string): { pid: number; stopped: boolean } | null => {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(slotDir, "server.json"), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const r = parsed as Record<string, unknown>;
		return typeof r.pid === "number" && Number.isInteger(r.pid) && r.pid > 0 ? { pid: r.pid, stopped: r.stopped === true } : null;
	} catch {
		return null;
	}
};

export const readServerRecordFile = parseServerRecord;

export async function runStop(deps: StopDeps): Promise<StopReport> {
	const { layout, processes, log } = deps;
	const timeouts: StopTimeouts = { ...stopTimeoutsFor(layout.platform), ...deps.timeouts };
	const alive = deps.pidAlive ?? osPidAlive;
	const report: StopReport = { ok: false, cliStop: { ran: false, exit: null, outcome: "", timedOut: false, detail: "" }, unverifiedSb: null, killed: [], refused: [], leftovers: [], herdrAnswers: false, notes: [] };
	const note = (line: string): void => {
		report.notes.push(line);
		log({ event: "stop-note", detail: line });
	};
	const waitGone = async (pid: number, ms: number, handle?: ProcHandle | null): Promise<boolean> => {
		const deadline = deps.clock.now() + ms;
		const gone = (): boolean => (handle != null && handle.pid === pid ? handle.exitCode !== null || handle.signalCode !== null : !alive(pid));
		while (!gone()) {
			if (deps.clock.now() >= deadline) return false;
			await deps.clock.sleep(250);
		}
		return true;
	};

	let rec = deps.startFile.read((why) => log({ event: "start-file-unreadable", detail: why }));
	const slotDir = rec?.sb?.slotDir ?? join(layout.agent, "straw-boss");
	log({ event: "stop-begin", herdrPid: rec?.herdr?.pid ?? null, sbPid: rec?.sb?.pid ?? null, handle: deps.herdrHandle?.pid ?? null });

	// The sb server may have restarted since the last record (a pi session's restart, a crash and a new start): the server's own record in its folder names the one that runs now.
	// It is recorded (with the executable check) before it is relied on, so it is covered by the kill rule only when that read allows it.
	const current = (deps.readServerRecord ?? parseServerRecord)(slotDir);
	if (current !== null && !current.stopped && current.pid !== rec?.sb?.pid && deps.syncSbRecord) {
		await deps.syncSbRecord(current.pid);
		rec = deps.startFile.read();
	}
	const sbRecord: ProcessRecord | null = rec?.sb ?? null;
	const sbPid = sbRecord?.pid ?? (current !== null && !current.stopped ? current.pid : null);

	// The broker is detached from the pi that spawned it and outlives the stack. Its pid file lives in this agent folder; it is read now, while the stack is
	// up, and the process is a candidate only when its executable lies under `<root>/tools`. Its start time, read here, is the record the kill step compares with.
	let broker: ProcessRecord | null = null;
	const brokerPid = readBrokerPid(layout);
	if (brokerPid !== null && alive(brokerPid)) {
		const info = (await processes.inspect([brokerPid]))[0];
		if (info?.startTime && info.executable !== null && isUnderTools(layout, info.executable)) broker = { pid: brokerPid, startTime: info.startTime };
		else note(`broker.pid names pid ${brokerPid}, which is not a program of this app; it is left alone`);
	}

	// 1. the sb server stops itself.
	let killSb = true;
	const sbRunning = sbPid !== null && alive(sbPid);
	// `cli.mjs stop` is a new process: it loads the package's files from disk now, not the memory of a server that runs already. An unverified package's files must not run at all
	// (R8A-F001, T8C-F001), so a recorded server is left to the kill rule below, and one no record names is reported.
	if (!deps.sbPackageVerified) {
		note("pi-straw-boss is not installed and verified, so its CLI was not run");
		log({ event: "sb-cli-stop-skipped", reason: "package-not-ok", pid: sbPid });
		if (sbRunning && sbRecord === null) {
			report.unverifiedSb = sbPid;
			killSb = false;
			note(`an sb server (pid ${sbPid}) runs from a package that is not verified and no record names it; it was not stopped`);
			log({ event: "sb-server-unverified", pid: sbPid });
		}
	} else if (existsSync(deps.sbCli)) {
		const limit = deps.onlyCliStopMs ?? timeouts.cliStopMs;
		const r = await deps.run(deps.nodePath, [deps.sbCli, "stop"], { env: deps.env, replaceEnv: true, timeoutMs: limit });
		const outcome = String(lastJsonLine(r.stdout)?.outcome ?? "");
		// stderr always opens with a warning line about stopping on purpose; the reason of a failure is its last line.
		const why = r.code === 0 ? "" : firstLineOf(lastLine(`${r.stderr}\n${r.stdout}`.split(/\r?\n/).filter((l) => l.trim() !== "" && !/^Stopping the sb server on purpose/.test(l))));
		report.cliStop = { ran: true, exit: r.code, outcome, timedOut: r.timedOut === true, detail: why };
		log({ event: "sb-server-stop", exit: r.code, timedOut: r.timedOut === true, outcome, pid: sbPid, detail: why });
		if (r.code === 5) {
			// A `serve` server belongs to a supervisor: never expected for the desk, and never killed.
			killSb = false;
			note(`the sb server is a serve server (a supervisor's); not stopped: ${why}`);
		} else if (r.code === 3) note(`cli.mjs stop was refused (acl): ${why}`);
		else if (r.code !== 0) note(`cli.mjs stop ${r.timedOut ? "timed out" : `exited ${r.code}`}: ${why}`);
	}
	if (deps.onlyCliStopMs !== undefined) {
		// A fast stop (the session is ending): nothing more is waited for or killed; Windows ends the rest, and Herdr restores the workspaces at the next start.
		if (!deps.sbPackageVerified && sbRunning && report.unverifiedSb === null) {
			report.unverifiedSb = sbPid;
			log({ event: "sb-server-unverified", pid: sbPid });
		}
		report.ok = report.cliStop.exit === 0 || (!report.cliStop.ran && report.unverifiedSb === null);
		return report;
	}

	// 2. the sb server leaves; one that stays is killed only by the rule.
	if (sbPid !== null && report.unverifiedSb === null) {
		if (!deps.sbPackageVerified) {
			// Nothing asked the server to stop, so there is nothing to wait for: the record's start time decides, and a server it does not prove ours is reported.
			if (sbRunning) {
				const outcome = await killOwned(processes, { pid: sbPid, record: sbRecord, handle: null });
				settle(report, "sb-server", outcome, log);
				if (outcome.killed) await deps.clock.sleep(500);
				// A server that left before the verdict read it (`gone`), or between the verdict and the kill, is gone, not unverified: only a process that still runs is reported, whether the
				// rule refused it or the kill failed (T8B-F004, S53-F002). A pid reused by another program stays reported, which is the safe direction.
				else if (alive(sbPid)) {
					report.unverifiedSb = sbPid;
					note(`an sb server (pid ${sbPid}) runs from a package that is not verified and could not be shown to be this app's; it was not stopped`);
					log({ event: "sb-server-unverified", pid: sbPid });
				}
			}
		} else {
			const gone = await waitGone(sbPid, timeouts.sbWaitMs);
			if (!gone && killSb) {
				const outcome = await killOwned(processes, { pid: sbPid, record: sbRecord, handle: null });
				settle(report, "sb-server", outcome, log);
				await deps.clock.sleep(500);
			}
		}
	}

	// 3. Herdr stops after the sb server: if it stopped first, a detached server would run on, and the panes' pi sessions could start another in between.
	const stopped = await deps.herdr.stopServer(timeouts.herdrStopMs);
	log({ event: "herdr-server-stop", exit: stopped.code, detail: stopped.text });
	const herdrPid = rec?.herdr?.pid ?? deps.herdrHandle?.pid ?? null;
	if (herdrPid !== null) await waitGone(herdrPid, timeouts.herdrWaitMs, deps.herdrHandle);

	// 4. what is left of the recorded set goes now, by the rule: Herdr, then the broker.
	if (herdrPid !== null && ((handleHeld(deps.herdrHandle) && deps.herdrHandle.pid === herdrPid) || alive(herdrPid))) {
		const outcome = await killOwned(processes, { pid: herdrPid, record: rec?.herdr ?? null, handle: deps.herdrHandle });
		settle(report, "herdr", outcome, log);
	}
	if (broker !== null && alive(broker.pid)) {
		const outcome = await killOwned(processes, { pid: broker.pid, record: broker, handle: null });
		settle(report, "intercom-broker", outcome, log);
	}
	// A recorded sb server that the CLI could not stop and the wait did not see leave (its pid was not alive by `kill 0` but the kill step above refused) is in the listing below.

	// 5. what still runs.
	await deps.clock.sleep(700);
	report.leftovers = await listLeftovers(processes, layout);
	report.herdrAnswers = await deps.herdr.answers();
	for (const l of report.leftovers) note(`still running from the app's tools folder: pid ${l.pid} (${l.file})`);
	if (report.herdrAnswers) note("the Herdr server still answers on the app's socket");
	report.ok = report.leftovers.length === 0 && !report.herdrAnswers && report.unverifiedSb === null;
	log({
		event: "stop-end",
		ok: report.ok,
		killed: report.killed.map((k) => ({ pid: k.pid, killed: k.killed })),
		refused: report.refused.map((r) => ({ what: r.what, pid: r.pid, reason: r.reason })),
		leftovers: report.leftovers.map((l) => ({ pid: l.pid, file: l.file })),
		herdrAnswers: report.herdrAnswers,
	});

	// Herdr's own stale socket marker is cleared once its server is gone; start.json goes when nothing is left, and stays otherwise so a second stop can finish the job.
	if (!report.herdrAnswers && (herdrPid === null || !alive(herdrPid))) rmSync(layout.herdrSocket, { force: true });
	if (report.ok) await deps.startFile.update(() => null);
	return report;
}

function settle(report: StopReport, what: string, outcome: KillOutcome, log: RuntimeEvent): void {
	if (outcome.verdict.may) report.killed.push(outcome);
	else report.refused.push({ what, pid: outcome.pid, reason: outcome.verdict.reason });
	log({ event: "kill", what, pid: outcome.pid, killed: outcome.killed, may: outcome.verdict.may, via: outcome.verdict.may ? outcome.verdict.via : undefined, reason: outcome.verdict.may ? undefined : outcome.verdict.reason });
}

const lastLine = (lines: string[]): string => lines[lines.length - 1] ?? "";
