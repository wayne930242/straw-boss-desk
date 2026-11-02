import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { checkPaneLookups } from "../src/main/pane-path.ts";
import { createPlatform } from "../src/main/platform/index.ts";
import { execRunner } from "../src/main/platform/exec.ts";
import { loadStartConfig } from "../src/main/runtime/config.ts";
import { RuntimeLog } from "../src/main/runtime/log.ts";
import { readInstalled, isInstalled } from "../src/main/runtime/readiness.ts";
import { Supervisor, type SupervisorEvent } from "../src/main/runtime/supervisor.ts";
import type { SpawnFn } from "../src/main/runtime/herdr.ts";
import { childEnvOf, createWorld, disposeWorld, isWindows, noteUserPath, run, runWorld, type RunSummary, type World } from "./harness/e2e-light.ts";
import { hostedCase } from "./harness/hosted.ts";

// The task 8a anchor, supervisor half (spec: Tasks 8a): from a root tasks 5 to 7 filled, a real Herdr, a real sb server and a real pi are started, restarted and stopped
// by the supervisor. It starts programs and kills one of them, so it runs only on a GitHub-hosted runner (the six-signal check); under SBD_REQUIRE_HOSTED_FIXTURES=1 a
// refusal fails instead of skipping. The Electron half (the app's main process killed, a second launch, `--stop-stack`) is test/e2e/runtime.e2e.ts.
// Like the other e2e files it runs only where the workflow asks (SBD_E2E_RUNTIME=1), not in `npm test`.
const ON = process.env.SBD_E2E_RUNTIME === "1";
const hosted = hostedCase("the runtime e2e (task 8a)");
const skip = !ON ? "SBD_E2E_RUNTIME=1 is not set: this test starts a real Herdr, sb server and pi from the installed stack" : hosted.run ? false : hosted.reason;

// Under SBD_REQUIRE_HOSTED_FIXTURES=1 a refusal is a failure, so the anchor can never pass by skipping unseen.
if (ON && !hosted.run && hosted.fail) {
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
		await sleep(500);
	}
	throw new Error(`timed out after ${ms / 1000} s waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
}

const statusOf = (url: string): Promise<number> =>
	new Promise((resolve, reject) => {
		const req = request(url, { method: "GET", timeout: 15_000 }, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("timeout", () => req.destroy(new Error("the GUI did not answer in 15 s")));
		req.on("error", reject);
		req.end();
	});

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

describe("the runtime supervisor against the real programs (e2e, task 8a)", { skip }, () => {
	let world: World;
	let installed: RunSummary;
	let supervisor: Supervisor;
	const events: SupervisorEvent[] = [];
	const platform = createPlatform();
	let pi: ChildProcess | null = null;

	const guiUrls = () => events.filter((e): e is Extract<SupervisorEvent, { type: "gui-url" }> => e.type === "gui-url");
	const startRecord = () => {
		const record = supervisor.startFile.read();
		assert.ok(record, "state/start.json exists");
		return record;
	};
	const logLines = (): Array<Record<string, unknown>> => {
		const file = join(world.layout.logs, "start.jsonl");
		return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
	};
	const underTools = () => platform.processes.listUnder(world.layout.tools.root);
	const herdrAnswers = async () => (await run(childEnvOf(world).HERDR_BIN_PATH as string, ["workspace", "list"], { env: childEnvOf(world), timeoutMs: 15_000 })).code === 0;

	before(async () => {
		world = createWorld("rt");
		await noteUserPath(world);
		installed = await runWorld(world, { profile: true, recipe: { forges: [{ kind: "github", host: "github.com" }], tools: [], id: "ci-runtime", name: "CI runtime", version: "1.0.0", instructions: "- the CI rule" } });
		assert.ok(installed.ok, `the install failed: ${JSON.stringify(installed.error ?? Object.values(installed.outcomes).filter((o) => o.failure).map((o) => o.failure))}`);
		assert.ok(isInstalled(readInstalled(world.layout)));
		const runtimeLog = new RuntimeLog({ dir: world.layout.logs });
		const runner = execRunner();
		supervisor = new Supervisor({
			layout: world.layout,
			home: world.home,
			platform,
			run: runner,
			spawn: spawn as unknown as SpawnFn,
			appEnv: world.appEnv,
			config: () => loadStartConfig(world.layout, world.home),
			log: (fields) => runtimeLog.event(fields),
			timeouts: { pollMs: 1000 },
			...(isWindows ? { checkPane: () => checkPaneLookups({ run: runner, locate: platform.locate, exists: existsSync, env: world.appEnv }) } : {}),
		});
		supervisor.on((e) => events.push(e));
	});

	after(async () => {
		// Nothing this test started may outlive it: the stack through the supervisor, a bare-name pi through its handle.
		if (pi?.pid !== undefined && alive(pi.pid)) await endPi();
		await supervisor?.stop().catch(() => undefined);
		const before = world.userPathBefore;
		const real = world.realUserPath;
		const userPath = world.userPath;
		await disposeWorld(world);
		if (real) assert.deepEqual(await userPath.read(), before ?? null, "the user PATH is as it was before the run");
	});

	async function endPi(): Promise<void> {
		const pid = pi?.pid;
		if (pid === undefined) return;
		if (isWindows) await run(join(world.appEnv.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/T", "/F", "/PID", String(pid)], { env: {}, timeoutMs: 30_000 });
		else pi?.kill("SIGKILL");
		await until("the bare-name pi to end", 30_000, () => !alive(pid) || undefined);
	}

	it("starts the stack and the GUI answers 200", async () => {
		const started = Date.now();
		const result = await supervisor.start();
		console.log(`start took ${Math.round((Date.now() - started) / 1000)} s`);
		assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{16,}\/?/);
		assert.equal(await statusOf(result.url), 200);
		assert.equal(supervisor.state, "running");
		assert.equal(guiUrls().length, 1);
	});

	it("records both start times once the GUI shows, each equal to the platform's own read", async () => {
		supervisor.guiShown();
		await supervisor.settled();
		const record = startRecord();
		assert.ok(record.herdr?.startTime, `Herdr's start time: ${JSON.stringify(record.herdr)}`);
		assert.ok(record.sb?.startTime, `the sb server's start time: ${JSON.stringify(record.sb)}`);
		const [h, s] = await platform.processes.inspect([record.herdr.pid, record.sb.pid]);
		assert.equal(h?.startTime, record.herdr.startTime);
		assert.equal(s?.startTime, record.sb.startTime);
		assert.ok(h?.executable && h.executable.startsWith(world.layout.tools.root), `Herdr runs from the tools folder: ${h?.executable}`);
		assert.ok(typeof record.guiMs === "number");
		assert.equal(JSON.stringify(record).match(/127\.0\.0\.1:\d+\/[0-9a-f]{16}/), null, "start.json holds no page token");
		assert.ok(logLines().some((l) => l.event === "start-time-recorded"), "logs/start.jsonl shows the recording");
	});

	it("starts Herdr again when its pid is killed, and start.json holds the new pid with its start time and not the old one", async () => {
		const old = startRecord().herdr?.pid as number;
		process.kill(old, "SIGKILL");
		await until("the supervisor's second gui-url", 180_000, () => guiUrls().length >= 2 || undefined);
		await supervisor.settled();
		await supervisor.times.idle();
		const record = startRecord();
		assert.notEqual(record.herdr?.pid, old, "a new Herdr pid");
		assert.ok(record.herdr?.startTime);
		assert.equal((await platform.processes.inspect([record.herdr.pid]))[0]?.startTime, record.herdr.startTime);
		assert.equal(guiUrls().at(-1)?.reason, "restart");
		assert.equal(await statusOf(guiUrls().at(-1)?.url as string), 200);
		assert.equal(alive(old), false);
	});

	it("records the sb server's new pid and start time after `cli.mjs restart`, and drops the old record", async () => {
		const found = readInstalled(world.layout);
		assert.ok(isInstalled(found));
		const before = startRecord().sb?.pid as number;
		const env = childEnvOf(world);
		const restarted = await run(found.node, [found.sbCli, "restart"], { env, timeoutMs: 180_000 });
		assert.equal(restarted.code, 0, `cli.mjs restart: ${restarted.stdout.slice(0, 300)} ${restarted.stderr.slice(0, 300)}`);
		const record = await until("start.json to hold the new sb server", 90_000, () => {
			const r = supervisor.startFile.read();
			return r?.sb && r.sb.pid !== before && r.sb.startTime ? r : undefined;
		});
		assert.equal((await platform.processes.inspect([record.sb?.pid as number]))[0]?.startTime, record.sb?.startTime);
		assert.ok(record.sb?.slotDir);
		assert.equal(JSON.stringify(record).includes(`"pid":${before},`), false, "the old sb record is gone");
	});

	it("reports a pi started by bare name (outside Herdr) by pid after the stop, kills nothing of it, and a second stop after the test ends it leaves nothing", async () => {
		const env = childEnvOf(world);
		const args = ["--mode", "rpc", "--no-session", "--offline"];
		// Bare name: macOS resolves `pi` on the constructed PATH (`#!/usr/bin/env node` makes the process the app's Node); Windows goes through cmd, which finds tools\bin\pi.cmd.
		pi = isWindows
			? spawn(join(world.appEnv.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), ["/d", "/c", "pi", ...args], { env, cwd: world.home, stdio: ["pipe", "ignore", "ignore"], windowsHide: true })
			: spawn("pi", args, { env, cwd: world.home, stdio: ["pipe", "ignore", "ignore"] });
		pi.on("error", () => undefined);
		pi.stdin?.on("error", () => undefined);
		assert.ok(pi.pid !== undefined);
		await until("pi to run from the tools folder", 60_000, async () => (await underTools()).some((p) => p.pid === pi?.pid || (isWindows && /[\\/]node\.exe$/i.test(p.executable ?? ""))));

		const report = await supervisor.stop();
		assert.equal(report.ok, false, "a program still runs from the tools folder");
		const leftover = isWindows ? report.leftovers.find((l) => /^node(\.exe)?$/i.test(l.file)) : report.leftovers.find((l) => l.pid === pi?.pid);
		assert.ok(leftover, `the pi is reported: ${JSON.stringify(report.leftovers)} ${report.notes.join("; ")}`);
		assert.equal(report.killed.some((k) => k.pid === leftover.pid), false, "an unrecorded process is never killed");
		assert.equal(alive(leftover.pid), true);
		const failure = events.find((e): e is Extract<SupervisorEvent, { type: "failure" }> => e.type === "failure" && (e.failure.leftovers ?? []).some((l) => l.pid === leftover.pid));
		assert.ok(failure, "the failure screen's event names it");
		const stopEnd = logLines().filter((l) => l.event === "stop-end").at(-1);
		assert.ok(JSON.stringify(stopEnd?.leftovers).includes(`"pid":${leftover.pid}`), `logs/start.jsonl names the pid: ${JSON.stringify(stopEnd)}`);
		assert.equal(JSON.stringify(stopEnd).includes("--mode"), false, "no command line is logged");

		await endPi();
		const second = await supervisor.stop();
		assert.equal(second.ok, true, second.notes.join("; "));
	});

	it("quit left no process whose executable lies under <root>/tools and no answering Herdr, found by the test and not from the records", async () => {
		assert.deepEqual((await underTools()).map((p) => `${p.pid} ${p.executable}`), []);
		assert.equal(await herdrAnswers(), false);
		assert.equal(existsSync(join(world.layout.state, "start.json")), false, "start.json goes when nothing is left");
		assert.equal(supervisor.state, "idle");
	});
});
