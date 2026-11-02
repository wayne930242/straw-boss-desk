import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { removeTree, sha256File } from "../src/main/bootstrap/fsutil.ts";
import { StateStore } from "../src/main/bootstrap/state.ts";
import type { Stage } from "../src/main/bootstrap/stage.ts";
import { FixtureServer } from "./harness/fixture-server.ts";
import { credUrl } from "./harness/cred-url.ts";
import { exeName, installsOf, leftovers, makeStack, publish, runEngine, scratchRoot, secretPatterns, testEngine, testLayout, testPlatform, toolStage } from "./harness/engine-fixture.ts";
import { EngineLockedError } from "../src/main/bootstrap/state.ts";
import { detectFromRecord, fileKey, type StageContext } from "../src/main/bootstrap/stage.ts";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

// The task 4 anchor: the engine against a local HTTP fixture server (test code only).

const server = new FixtureServer();
const scratch: string[] = [];
let root = "";
let installsLog = "";

before(async () => {
	await server.listen();
});
after(async () => {
	await server.close();
	for (const d of scratch) removeTree(d);
});
beforeEach(() => {
	const made = scratchRoot();
	scratch.push(made.base);
	root = made.root;
	installsLog = join(made.base, "installs.log");
});

const jsonOf = (file: string): Record<string, any> => JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
const bootstrapState = (): Record<string, any> => jsonOf(join(root, "state", "bootstrap.json"));
const currentState = (): Record<string, any> => jsonOf(join(root, "state", "current.json"));
const logLines = (): Record<string, any>[] =>
	readFileSync(join(root, "logs", "bootstrap.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);

describe("a wrong SHA256", () => {
	it("activates nothing, leaves no file behind, and is never retried", async () => {
		const wrong = "0".repeat(64);
		const alpha = publish(server, "alpha-wrong", { version: "1.0.0" }, wrong);
		const stack = makeStack({ "alpha-wrong": alpha });
		const stages = [toolStage("alpha-wrong", { installsLog }), toolStage("after-wrong", { needs: ["alpha-wrong"], installsLog })];
		const run = await runEngine(root, stack, stages);

		assert.equal(run.ok, false);
		const outcome = run.outcomes["alpha-wrong"];
		assert.equal(outcome?.status, "failed");
		assert.equal(outcome?.failure?.category, "integrity");
		assert.match(outcome?.failure?.sentence ?? "", /^The download of alpha-wrong did not match its published checksum, so nothing was installed\.$/);
		assert.equal(outcome?.attempts, 1, "one attempt: integrity is never retried");
		assert.equal(server.hits(alpha.path), 1, "the server saw one request");
		assert.equal(run.outcomes["after-wrong"]?.status, "blocked", "a stage that needs it does not run");

		assert.deepEqual(readdirSync(join(root, "tools", "alpha-wrong")), [], "no version folder, not even a staging one");
		assert.equal(existsSync(join(root, "state", "current.json")) ? currentState().versions["alpha-wrong"] : undefined, undefined, "nothing active");
		assert.deepEqual(readdirSync(join(root, "tools", "downloads")), [], "neither the bad bytes nor a part file stay in the cache");
		assert.deepEqual(leftovers(root), []);
		const record = bootstrapState().stages["alpha-wrong"];
		assert.equal(record.status, "failed");
		assert.equal(record.lastFailure.category, "integrity");
		assert.deepEqual(installsOf(installsLog), ["alpha-wrong"], "the dependent never installed");
	});
});

describe("killing the engine mid-stage", () => {
	it("resumes by re-running only that stage and leaves no staging folder", { timeout: 120_000 }, async () => {
		const alpha = publish(server, "alpha-kill", { version: "1.0.0" });
		const bravo = publish(server, "bravo-kill", { version: "1.0.0" });
		server.setMode(bravo.path, { kind: "hang" });
		const stack = makeStack({ "alpha-kill": alpha, "bravo-kill": bravo });
		const stages = (): Stage[] => [toolStage("alpha-kill", { installsLog }), toolStage("bravo-kill", { needs: ["alpha-kill"], installsLog })];

		// The engine runs in a process of its own and is killed while bravo's download hangs.
		const configFile = join(root, "..", "child-config.json");
		writeFileSync(configFile, JSON.stringify({ root, stack, secretPatterns, installsLog, tools: ["alpha-kill", "bravo-kill"] }));
		const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PI_") && !k.startsWith("HERDR_")));
		const asking = server.requested(bravo.path);
		const child = spawn(process.execPath, [fileURLToPath(new URL("./harness/engine-child.ts", import.meta.url)), configFile], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		child.stdout.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		const exited = once(child, "exit");
		const outcome = await Promise.race([asking.then(() => "asked"), exited.then(() => "exited")]);
		assert.equal(outcome, "asked", `the child reached the hanging download; it exited instead: ${stderr}`);
		await new Promise((r) => setTimeout(r, 300));
		child.kill("SIGKILL");
		await exited;

		assert.deepEqual(installsOf(installsLog), ["alpha-kill", "bravo-kill"], "alpha finished, bravo had begun");
		assert.equal(existsSync(join(root, "tools", "bravo-kill", "1.0.0.staging")), true, "the killed run left a staging folder");
		assert.equal(existsSync(join(root, "state", "engine.lock")), true, "and its lock");
		const killed = bootstrapState().stages;
		assert.equal(killed["alpha-kill"].status, "ok");
		assert.equal(killed["bravo-kill"].status, "running");
		assert.equal(currentState().versions["bravo-kill"], undefined, "nothing of bravo was activated");

		// Resume: the download now works.
		server.setMode(bravo.path, { kind: "ok" });
		const run = await runEngine(root, stack, stages());
		assert.equal(run.ok, true, JSON.stringify(run.error ?? run.outcomes));
		assert.equal(run.outcomes["alpha-kill"]?.status, "skipped-verified", "the finished stage is not run again");
		assert.equal(run.outcomes["bravo-kill"]?.status, "installed");
		assert.deepEqual(installsOf(installsLog), ["alpha-kill", "bravo-kill", "bravo-kill"], "only the interrupted stage ran again");
		assert.deepEqual(leftovers(root), [], "no staging folder, no part file");
		assert.equal(existsSync(join(root, "state", "engine.lock")), false, "the lock is released");
		assert.equal(currentState().versions["bravo-kill"], "1.0.0");
		assert.ok(logLines().some((l) => l.event === "swept"), "the sweep removed the leftover and logged it");

		// And a third run has nothing to do.
		const again = await runEngine(root, stack, stages());
		assert.deepEqual(Object.values(again.outcomes).map((o) => o.status), ["skipped-verified", "skipped-verified"]);
		assert.equal(installsOf(installsLog).length, 3);
	});
});

describe("a failing verify of a new version", () => {
	it("leaves the old version active, with its folder, hashes, and record", async () => {
		const v1 = publish(server, "alpha-v", { version: "1.0.0" });
		const stack1 = makeStack({ "alpha-v": v1 });
		const first = await runEngine(root, stack1, [toolStage("alpha-v", { installsLog })]);
		assert.equal(first.outcomes["alpha-v"]?.status, "installed");
		const exe = join(root, "tools", "alpha-v", "1.0.0", ...exeName("alpha-v").split("/"));
		const hashBefore = await sha256File(exe);
		assert.equal(currentState().versions["alpha-v"], "1.0.0");

		// Version 2.0.0 downloads and extracts, but the archive's VERSION file says otherwise, so the stage's verify fails.
		const v2 = publish(server, "alpha-v", { version: "2.0.0", inside: "9.9.9" });
		const stack2 = makeStack({ "alpha-v": v2 });
		const second = await runEngine(root, stack2, [toolStage("alpha-v", { installsLog })]);
		assert.equal(second.ok, false);
		assert.equal(second.outcomes["alpha-v"]?.status, "failed");
		assert.equal(second.outcomes["alpha-v"]?.failure?.category, "other");
		assert.match(second.outcomes["alpha-v"]?.failure?.detail ?? "", /says it is 9\.9\.9/);

		assert.equal(currentState().versions["alpha-v"], "1.0.0", "version A is still the active one");
		assert.equal(existsSync(join(root, "tools", "alpha-v", "2.0.0")), false, "version B was not activated");
		assert.deepEqual(leftovers(root), [], "and its staging folder is gone");
		assert.equal(await sha256File(exe), hashBefore, "version A's executable is untouched");
		const record = bootstrapState().stages["alpha-v"];
		assert.equal(record.status, "ok");
		assert.equal(record.version, "1.0.0");
		assert.equal(record.lastFailure.version, "2.0.0");
		assert.equal(record.lastFailure.category, "other");

		// The old stack still finds version A verified.
		const third = await runEngine(root, stack1, [toolStage("alpha-v", { installsLog })]);
		assert.equal(third.outcomes["alpha-v"]?.status, "skipped-verified");
	});

	it("rolls a tool back by pointing current.json at the previous version, and writes the dependent stage again", async () => {
		const v1 = publish(server, "alpha-r", { version: "1.0.0" });
		const v2 = publish(server, "alpha-r", { version: "2.0.0" });
		// `paths-r` stands for tool-paths: it is installed from the same pin file but names alpha-r's version in its evidence.
		const stackFor = (a: typeof v1) => makeStack({ "alpha-r": a, "paths-r": publish(server, "paths-r", { version: "1.0.0" }) });
		const withDependsOn = (): Stage[] => [toolStage("alpha-r", { installsLog }), toolStage("paths-r", { needs: ["alpha-r"], dependsOn: ["alpha-r"], installsLog })];

		await runEngine(root, stackFor(v1), withDependsOn());
		assert.deepEqual(installsOf(installsLog), ["alpha-r", "paths-r"]);
		await runEngine(root, stackFor(v2), withDependsOn());
		assert.deepEqual(installsOf(installsLog), ["alpha-r", "paths-r", "alpha-r", "paths-r"], "a change of alpha's version writes the dependent stage again");
		assert.equal(currentState().versions["alpha-r"], "2.0.0");
		assert.equal(currentState().previous["alpha-r"], "1.0.0");
		assert.equal(existsSync(join(root, "tools", "alpha-r", "1.0.0")), true, "the previous version stays beside the new one");

		const { processes } = testPlatform();
		const store = new StateStore(testLayout(root));
		assert.equal(await store.rollbackTool("alpha-r", processes), "1.0.0");
		assert.equal(currentState().versions["alpha-r"], "1.0.0");
		assert.equal(await new StateStore(testLayout(root)).rollbackTool("alpha-r", processes), null, "there is nothing older to go back to");

		// The old stack is back: alpha-r is made active again from the cached archive without a request, and the dependent follows.
		const hitsBefore = server.hits(v1.path);
		const back = await runEngine(root, stackFor(v1), withDependsOn());
		assert.equal(back.ok, true);
		assert.equal(server.hits(v1.path), hitsBefore, "the rollback needed no network");
		assert.equal(currentState().versions["alpha-r"], "1.0.0");
		assert.deepEqual(installsOf(installsLog).slice(-2), ["alpha-r", "paths-r"]);

		// Once a start succeeds, the folder of the version that is not active goes.
		assert.deepEqual(await new StateStore(testLayout(root)).pruneInactive("alpha-r", processes), []);
		assert.equal(existsSync(join(root, "tools", "alpha-r", "2.0.0")), false);
		assert.equal(existsSync(join(root, "tools", "alpha-r", "1.0.0")), true);
	});
});

describe("a corrupted installed binary", () => {
	it("fails detect, so the stage installs again and the file is whole", async () => {
		const alpha = publish(server, "alpha-c", { version: "1.0.0" });
		const stack = makeStack({ "alpha-c": alpha });
		const stages = (): Stage[] => [toolStage("alpha-c", { installsLog })];
		const exe = join(root, "tools", "alpha-c", "1.0.0", ...exeName("alpha-c").split("/"));

		await runEngine(root, stack, stages());
		const good = readFileSync(exe);
		const recorded = bootstrapState().stages["alpha-c"].hashes;
		assert.deepEqual(Object.keys(recorded), [`tools/alpha-c/1.0.0/${exeName("alpha-c")}`], "the hash is recorded at activation, relative to the root");

		assert.equal((await runEngine(root, stack, stages())).outcomes["alpha-c"]?.status, "skipped-verified", "an untouched binary passes detect");

		// One byte changed, the size the same: `--version` or a size check would not notice.
		const flipped = Buffer.from(good);
		flipped[flipped.length - 2] = (flipped[flipped.length - 2] ?? 0) ^ 0xff;
		writeFileSync(exe, flipped);
		const run = await runEngine(root, stack, stages());
		assert.equal(run.outcomes["alpha-c"]?.status, "installed", "detect failed, the stage ran again");
		assert.ok(readFileSync(exe).equals(good), "the binary is the published one again");
		const failed = logLines().filter((l) => l.event === "detect-failed");
		assert.match(String(failed.at(-1)?.reason), /no longer has its recorded SHA-256/);
		assert.deepEqual(leftovers(root), [], "the corrupted folder moved aside was deleted");

		// A deleted binary fails detect as well.
		removeTree(exe);
		assert.equal((await runEngine(root, stack, stages())).outcomes["alpha-c"]?.status, "installed");
		assert.ok(existsSync(exe));
		assert.deepEqual(installsOf(installsLog), ["alpha-c", "alpha-c", "alpha-c"]);
	});
});

describe("redaction", () => {
	it("keeps a planted token, a GUI URL, and a registered secret out of every log and state file", async () => {
		const ghToken = ["gh", "p_"].join("") + "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";
		const guiToken = "Qw3rTy9UiOp2AsDf5GhJk8Lz";
		const gui = `http://127.0.0.1:43210/${guiToken}`;
		const registered = "registered-secret-from-main-1234";
		const sneaky = 'has "quotes" and \\ backslashes';
		const leaky: Stage = {
			name: "leaky",
			needs: [],
			plannedVersion: () => "1.0.0",
			async detect() {
				return null;
			},
			async install(ctx) {
				// Output of a tool, with the secrets in it, goes to the stage's raw log; the arguments are logged too.
				const script = `console.log(${JSON.stringify(`out ${ghToken} ${registered} ${gui} ${sneaky}`)})`;
				await ctx.exec(process.execPath, ["-e", script]);
				throw new Error(`install broke: ${ghToken} ${gui} ${registered} ${sneaky}`);
			},
			async verify() {
				throw new Error("not reached");
			},
			async activate() {},
		};
		const run = await runEngine(root, makeStack({}), [leaky], {}, [registered, sneaky]);
		assert.equal(run.outcomes["leaky"]?.status, "failed");

		const planted = [ghToken, guiToken, registered, sneaky, `43210/${guiToken}`];
		const files: string[] = [];
		const walk = (dir: string): void => {
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				if (e.isDirectory()) walk(join(dir, e.name));
				else files.push(join(dir, e.name));
			}
		};
		walk(join(root, "logs"));
		walk(join(root, "state"));
		assert.ok(files.some((f) => f.endsWith("bootstrap.jsonl")) && files.some((f) => f.endsWith("stage-leaky.log")) && files.some((f) => f.endsWith("bootstrap.json")));
		for (const file of files) {
			const text = readFileSync(file, "utf8");
			for (const secret of planted) assert.ok(!text.includes(secret), `${file} holds ${secret}`);
		}
		const raw = readFileSync(join(root, "logs", "stage-leaky.log"), "utf8");
		assert.match(raw, /127\.0\.0\.1:43210\/<token>/);
		// What the UI gets passes the redactor too.
		const detail = run.outcomes["leaky"]?.failure?.detail ?? "";
		for (const secret of planted) assert.ok(!detail.includes(secret), `the failure detail holds ${secret}`);
		assert.ok(detail.includes("install broke"));
	});
});

describe("redaction of URL userinfo (T6-F011)", () => {
	it("keeps a proxy URL's user and password out of the logs, the stage log, the state files, a recorded evidence, and a failure's detail", async () => {
		const proxy = credUrl("http://corp-user<c>corp-pass-9@proxy.corp.example:8080");
		const noisy: Stage = {
			name: "noisy",
			needs: [],
			plannedVersion: () => "1.0.0",
			async detect() {
				return null;
			},
			async install(ctx) {
				await ctx.exec(process.execPath, ["-e", `console.log(${JSON.stringify(`HTTPS_PROXY=${proxy}`)})`]);
			},
			async verify() {
				return { text: `reached the registry through ${proxy}`, version: "1.0.0" };
			},
			async activate() {},
		};
		const broken: Stage = {
			name: "broken",
			needs: [],
			plannedVersion: () => "1.0.0",
			async detect() {
				return null;
			},
			async install() {
				throw new Error(`npm could not use ${proxy}`);
			},
			async verify() {
				throw new Error("not reached");
			},
			async activate() {},
		};
		const run = await runEngine(root, makeStack({}), [noisy, broken]);
		assert.equal(run.outcomes["noisy"]?.status, "installed");
		assert.equal(run.outcomes["broken"]?.status, "failed");
		for (const { file, text } of filesUnder(join(root, "logs"), join(root, "state"))) {
			for (const secret of ["corp-user", "corp-pass-9"]) assert.ok(!text.includes(secret), `${file} holds ${secret}`);
		}
		assert.match(readFileSync(join(root, "logs", "stage-noisy.log"), "utf8"), /http:\/\/<redacted>@proxy\.corp\.example:8080/);
		for (const text of [run.outcomes["noisy"]?.evidence ?? "", run.outcomes["broken"]?.failure?.detail ?? ""]) assert.ok(!text.includes("corp-pass-9"), text);
		assert.ok((run.outcomes["broken"]?.failure?.detail ?? "").includes("proxy.corp.example"), "the host is kept for the PM");
	});
});

/** Every file under logs/ and state/ of a root, with its text. */
function filesUnder(...dirs: string[]): { file: string; text: string }[] {
	const found: { file: string; text: string }[] = [];
	const walk = (dir: string): void => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (e.isDirectory()) walk(join(dir, e.name));
			else found.push({ file: join(dir, e.name), text: readFileSync(join(dir, e.name), "utf8") });
		}
	};
	for (const dir of dirs) walk(dir);
	return found;
}

describe("secrets registered with one engine process (T4-F001)", () => {
	it("keep masking in every later run, for a value registered before, between, or during runs, until it is dropped", async () => {
		const first = "control-secret-from-server-json-0123";
		const between = "registered-between-the-runs-98765";
		let plant = "";
		const stage: Stage = {
			name: "leaky",
			needs: [],
			plannedVersion: () => "1.0.0",
			detect: async () => null,
			async install(ctx) {
				if (plant === "") return;
				await ctx.exec(process.execPath, ["-e", `console.log(${JSON.stringify(`tool said ${plant}`)})`]);
				throw new Error(`install broke: ${plant}`);
			},
			verify: async () => ({ text: "ok", version: "1.0.0" }),
			activate: async () => {},
		};
		const t = testEngine(root, () => [stage]);
		const stack = makeStack({});
		const leaks = (secret: string): string[] => [
			...filesUnder(join(root, "logs"), join(root, "state")).filter((f) => f.text.includes(secret) || f.text.includes(encodeURIComponent(secret))).map((f) => f.file),
			...(JSON.stringify(t.events).includes(secret) ? ["the events sent to main"] : []),
		];

		await t.engine.handle({ type: "secret", op: "add", value: first });
		assert.equal((await t.run(stack)).outcomes["leaky"]?.status, "installed", "run 1 is clean");

		plant = first;
		const second = await t.run(stack);
		assert.equal(second.outcomes["leaky"]?.status, "failed");
		assert.ok(second.outcomes["leaky"]?.failure?.detail.includes("install broke"), "the failure is the planted one");
		assert.deepEqual(leaks(first), [], "run 2: the value registered before run 1 is still masked everywhere");
		assert.ok(!bootstrapState().stages["leaky"].lastFailure.message.includes(first));

		await t.engine.handle({ type: "secret", op: "add", value: between });
		plant = between;
		assert.equal((await t.run(stack)).outcomes["leaky"]?.status, "failed");
		assert.deepEqual(leaks(between), [], "run 3: a value registered between runs is masked");
		assert.deepEqual(leaks(first), []);

		await t.engine.handle({ type: "secret", op: "remove", value: between });
		assert.equal((await t.run(stack)).outcomes["leaky"]?.status, "failed");
		assert.notDeepEqual(leaks(between), [], "run 4: a dropped value is no longer masked (so the checks above were not vacuous)");
		plant = first;
		await t.run(stack);
		assert.ok(!bootstrapState().stages["leaky"].lastFailure.message.includes(first), "and the others still are");
	});

	it("refuses a value shorter than 4 characters with a named error event instead of an unhandled rejection (T4-F011)", async () => {
		const t = testEngine(root, () => []);
		await t.engine.handle({ type: "secret", op: "add", value: "abc" });
		const refusal = t.events.find((e) => e.type === "error");
		assert.equal(refusal?.type === "error" && refusal.name, "SecretRefusedError");
		assert.match(refusal?.type === "error" ? refusal.message : "", /at least 4/);
		assert.ok(!JSON.stringify(t.events).includes('"abc"'), "the refused value is not echoed");
		// The engine still works, and the short value was not kept.
		assert.equal((await t.run(makeStack({}))).ok, true);
		await t.engine.handle({ type: "secret", op: "remove", value: "abc" });
	});

	it("masks the registered values and the GUI URL in the error message main receives (T4-F011)", async () => {
		const secret = "plant-in-the-stack-key-55555";
		const t = testEngine(root, () => []);
		await t.engine.handle({ type: "secret", op: "add", value: secret });
		const bad = { schema: 1, generation: 1, minShell: "0.0.1", profile: { name: "p", version: "1", integrity: "i" }, tools: { x: { assets: { [`${secret} at http://127.0.0.1:4321/Qw3rTy9UiOp2AsDf5GhJk8Lz`]: {} } } } };
		const run = await t.run(bad as never);
		assert.equal(run.error?.name, "StackError");
		assert.match(run.error?.message ?? "", /unknown platform key/);
		assert.ok(!(run.error?.message ?? "").includes(secret), run.error?.message);
		assert.ok(!(run.error?.message ?? "").includes("Qw3rTy9UiOp2AsDf5GhJk8Lz"), run.error?.message);
		assert.ok(!JSON.stringify(run.error?.details).includes(secret));

		// A run that fails before it has a logger (bad patterns) is masked too, with the registered values alone.
		const early = testEngine(root, () => []);
		await early.engine.handle({ type: "secret", op: "add", value: secret });
		await early.engine.handle({ type: "run", config: { root, stack: {}, secretPatterns: { patterns: [{ id: secret, regex: "" }] } } });
		const failure = early.events.find((e) => e.type === "error");
		assert.match(failure?.type === "error" ? failure.message : "no error event", /secret pattern .* has no regex/);
		assert.ok(!JSON.stringify(early.events).includes(secret), "the registered value is masked even before the run has patterns");
	});
});

describe("one run at a time (T4-F002)", () => {
	it("answers a second run with a named error while one is active, and leaves the first run's lock and staging alone", async () => {
		const alpha = publish(server, "alpha-busy", { version: "1.0.0" });
		const stack = makeStack({ "alpha-busy": alpha });
		let open!: () => void;
		const gate = new Promise<void>((resolve) => (open = resolve));
		let parked!: () => void;
		const atGate = new Promise<void>((resolve) => (parked = resolve));
		const inner = toolStage("alpha-busy", { installsLog });
		// The first install is parked inside `install`, after the archive was extracted into the staging folder; any later one runs through.
		let installs = 0;
		const parkedStage: Stage = {
			...inner,
			async install(ctx) {
				await inner.install(ctx);
				if (++installs > 1) return;
				parked();
				await gate;
			},
		};
		const t = testEngine(root, () => [parkedStage]);
		const first = t.run(stack);
		await atGate;
		const staging = join(root, "tools", "alpha-busy", "1.0.0.staging");
		const lock = join(root, "state", "engine.lock");
		try {
			assert.equal(existsSync(staging), true);
			const lockText = readFileSync(lock, "utf8");

			const second = await t.run(stack);
			assert.equal(second.ok, false);
			assert.equal(second.error?.name, "EngineBusyError");
			assert.match(second.error?.message ?? "", /already active/);
			assert.equal(existsSync(staging), true, "the second run did not sweep the first run's staging folder");
			assert.equal(readFileSync(lock, "utf8"), lockText, "and did not release or replace its lock");
			assert.ok(!logLines().some((l) => l.event === "swept"), "nothing was swept");
		} finally {
			open();
		}
		const done = await first;
		assert.equal(done.ok, true, JSON.stringify(done.events));
		assert.equal(done.outcomes["alpha-busy"]?.status, "installed");
		assert.equal(existsSync(lock), false, "the first run released its own lock");
		assert.deepEqual(leftovers(root), []);
		assert.deepEqual(installsOf(installsLog), ["alpha-busy"], "one install, not two");

		// Once it is over, a run is accepted again.
		assert.equal((await t.run(stack)).outcomes["alpha-busy"]?.status, "skipped-verified");
	});
});

describe("files outside the data root (T4-F004)", () => {
	/** A stage that writes `file` at install and names `key` as the file to hash. */
	function writing(name: string, file: string, evidenceFile: (ctx: StageContext) => string, activated: { n: number }): Stage {
		return {
			name,
			needs: [],
			plannedVersion: () => "1.0.0",
			detect: (ctx) => detectFromRecord(ctx, { version: "1.0.0" }),
			async install() {
				mkdirSync(dirname(file), { recursive: true });
				writeFileSync(file, "the binary\n");
			},
			verify: async (ctx) => ({ text: "ok", version: "1.0.0", files: [evidenceFile(ctx)] }),
			async activate() {
				activated.n++;
			},
		};
	}

	it("hashes a file in an agent folder outside the root under an `agent:` key, and detects its corruption", async () => {
		const base = join(root, "..");
		const agentDir = join(base, "agent outside root");
		const layout = testLayout(root, { agentDir });
		const file = join(agentDir, "bin", "fd-tool");
		const activated = { n: 0 };
		const stage = (): Stage => writing("fd-like", file, (ctx) => fileKey(ctx.layout, file), activated);

		const first = await runEngine(root, makeStack({}), [stage()], { layout });
		assert.equal(first.outcomes["fd-like"]?.status, "installed", JSON.stringify(first.outcomes));
		assert.deepEqual(Object.keys(bootstrapState().stages["fd-like"].hashes), ["agent:bin/fd-tool"], "keyed by the agent role, not by a path that climbs out of the root");
		assert.equal((await runEngine(root, makeStack({}), [stage()], { layout })).outcomes["fd-like"]?.status, "skipped-verified");

		writeFileSync(file, "a different binary\n");
		const third = await runEngine(root, makeStack({}), [stage()], { layout });
		assert.equal(third.outcomes["fd-like"]?.status, "installed", "the corrupted file fails detect");
		assert.match(String(logLines().filter((l) => l.event === "detect-failed").at(-1)?.reason), /agent:bin\/fd-tool no longer has its recorded SHA-256/);
	});

	it("refuses a file that is under neither the root nor the agent folder, before anything is activated", async () => {
		const elsewhere = join(root, "..", "elsewhere", "tool");
		const activated = { n: 0 };
		const run = await runEngine(root, makeStack({}), [writing("outside", elsewhere, (ctx) => fileKey(ctx.layout, elsewhere), activated)]);
		assert.equal(run.outcomes["outside"]?.status, "failed");
		assert.match(run.outcomes["outside"]?.failure?.detail ?? "", /under neither the data root/);
		assert.equal(activated.n, 0, "activate never ran");
		assert.equal(existsSync(join(root, "state", "current.json")), false);
		assert.equal(bootstrapState().stages["outside"].status, "failed");
	});

	it("refuses an evidence key that climbs out or is absolute, before anything is activated", async () => {
		for (const [i, key] of ["../escape", "tools/../../escape", "agent:../escape", "C:/Windows/x", "/etc/passwd", ""].entries()) {
			const activated = { n: 0 };
			const run = await runEngine(root, makeStack({}), [writing(`raw-key-${i}`, join(root, "tools", "x", "tool"), () => key, activated)]);
			assert.equal(run.outcomes[`raw-key-${i}`]?.status, "failed", JSON.stringify(key));
			assert.match(run.outcomes[`raw-key-${i}`]?.failure?.detail ?? "", /outside the data root/, JSON.stringify(key));
			assert.equal(activated.n, 0, `${JSON.stringify(key)}: activate never ran`);
		}
	});
});

describe("the state store and the engine lock (T4-F005)", () => {
	const hold = (pid: number, startTime: string) => {
		mkdirSync(join(root, "state"), { recursive: true });
		writeFileSync(join(root, "state", "engine.lock"), JSON.stringify({ pid, startTime }));
		return { ...testPlatform().processes, inspect: async (asked: readonly number[]) => asked.map((p) => ({ pid: p, startTime: p === pid ? startTime : null, executable: null })) };
	};

	it("does not delete the version an update just activated when its copy of current.json is stale", async () => {
		const v1 = publish(server, "alpha-s", { version: "1.0.0" });
		const v2 = publish(server, "alpha-s", { version: "2.0.0" });
		const { processes } = testPlatform();
		await runEngine(root, makeStack({ "alpha-s": v1 }), [toolStage("alpha-s")]);

		const main = new StateStore(testLayout(root));
		assert.equal(main.version("alpha-s"), "1.0.0", "main read current.json before the update");
		const update = await runEngine(root, makeStack({ "alpha-s": v2 }), [toolStage("alpha-s")]);
		assert.equal(update.outcomes["alpha-s"]?.status, "installed");
		assert.equal(main.version("alpha-s"), "1.0.0", "and its copy is stale now");

		assert.deepEqual(await main.pruneInactive("alpha-s", processes), []);
		assert.equal(currentState().versions["alpha-s"], "2.0.0", "the update was not undone");
		assert.equal(existsSync(join(root, "tools", "alpha-s", "2.0.0")), true, "the new version's folder is still there");
		assert.equal(existsSync(join(root, "tools", "alpha-s", "1.0.0")), false, "the old one went");
		assert.equal(currentState().previous["alpha-s"], undefined);
	});

	it("rolls back from what is on disk, not from a stale copy", async () => {
		const v1 = publish(server, "alpha-b", { version: "1.0.0" });
		const v2 = publish(server, "alpha-b", { version: "2.0.0" });
		const { processes } = testPlatform();
		await runEngine(root, makeStack({ "alpha-b": v1 }), [toolStage("alpha-b")]);
		const main = new StateStore(testLayout(root));
		main.current();
		await runEngine(root, makeStack({ "alpha-b": v2 }), [toolStage("alpha-b")]);
		assert.equal(await main.rollbackTool("alpha-b", processes), "1.0.0", "the stale copy had no previous version; the file has");
		assert.equal(currentState().versions["alpha-b"], "1.0.0");
	});

	it("keeps what another writer recorded when a store with a stale copy writes", async () => {
		const layout = testLayout(root);
		const stale = new StateStore(layout);
		stale.current();
		stale.bootstrap();
		const other = new StateStore(layout);
		await other.setVersion("a", "1.0.0");
		await other.setRecord("a", { status: "ok", version: "1.0.0", evidence: "a", at: "t", hashes: {}, dependsOn: {} });
		await stale.setVersion("b", "2.0.0");
		await stale.setRecord("b", { status: "ok", version: "2.0.0", evidence: "b", at: "t", hashes: {}, dependsOn: {} });
		assert.deepEqual(currentState().versions, { a: "1.0.0", b: "2.0.0" });
		assert.deepEqual(Object.keys(bootstrapState().stages).sort(), ["a", "b"]);
	});

	it("rollback and prune take the engine lock: they refuse while an engine runs and change nothing", async () => {
		const v1 = publish(server, "alpha-l", { version: "1.0.0" });
		const v2 = publish(server, "alpha-l", { version: "2.0.0" });
		await runEngine(root, makeStack({ "alpha-l": v1 }), [toolStage("alpha-l")]);
		await runEngine(root, makeStack({ "alpha-l": v2 }), [toolStage("alpha-l")]);
		const before = readFileSync(join(root, "state", "current.json"), "utf8");

		const processes = hold(4242, "start-4242");
		const store = new StateStore(testLayout(root));
		await assert.rejects(store.rollbackTool("alpha-l", processes), EngineLockedError);
		await assert.rejects(store.pruneInactive("alpha-l", processes), EngineLockedError);
		assert.equal(readFileSync(join(root, "state", "current.json"), "utf8"), before);
		assert.equal(existsSync(join(root, "tools", "alpha-l", "1.0.0")), true, "nothing was deleted");
		assert.equal(readFileSync(join(root, "state", "engine.lock"), "utf8").includes("4242"), true, "and the engine's lock was not touched");

		rmSync(join(root, "state", "engine.lock"));
		assert.deepEqual(await store.pruneInactive("alpha-l", processes), []);
		assert.equal(existsSync(join(root, "state", "engine.lock")), false, "the lock is released after the change");
	});

	it("is refused while a run in this very process is active", async () => {
		const alpha = publish(server, "alpha-q", { version: "1.0.0" });
		let open!: () => void;
		const gate = new Promise<void>((resolve) => (open = resolve));
		let parked!: () => void;
		const atGate = new Promise<void>((resolve) => (parked = resolve));
		const inner = toolStage("alpha-q");
		let installs = 0;
		const t = testEngine(root, () => [{ ...inner, async install(ctx) { await inner.install(ctx); if (++installs > 1) return; parked(); await gate; } }]);
		const running = t.run(makeStack({ "alpha-q": alpha }));
		await atGate;
		try {
			await assert.rejects(new StateStore(testLayout(root)).pruneInactive("alpha-q", testPlatform().processes), EngineLockedError);
			assert.equal(existsSync(join(root, "tools", "alpha-q", "1.0.0.staging")), true, "the running install's staging folder was not deleted");
		} finally {
			open();
		}
		assert.equal((await running).ok, true);
	});
});
