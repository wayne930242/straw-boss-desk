import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { downloadVerified } from "../src/main/bootstrap/download.ts";
import { classifyError, failureSentence, StageError, RETRIED_ONCE } from "../src/main/bootstrap/errors.ts";
import { GraphError, orderStages, runGraph } from "../src/main/bootstrap/graph.ts";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { assetFor, parseStack, platformKey, StackError } from "../src/main/bootstrap/stack.ts";
import type { Stage, StageOutcome } from "../src/main/bootstrap/stage.ts";
import { acquireEngineLock, EngineLockedError, StateStore } from "../src/main/bootstrap/state.ts";
import { createEngine, type EngineEvent } from "../src/main/bootstrap/engine.ts";
import { FixtureServer } from "./harness/fixture-server.ts";
import { sha256Hex } from "./harness/hash.ts";
import { makeStack, publish, runEngine, scratchRoot, secretPatterns, testLayout, testPlatform, toolStage } from "./harness/engine-fixture.ts";

const server = new FixtureServer();
const scratch: string[] = [];
let root = "";

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
});

/** A stage that does not touch the disk: `body` runs as its install and verify. */
function plain(name: string, needs: string[], options: { lane?: "download" | "npm"; install?: () => Promise<void> } = {}): Stage {
	return {
		name,
		needs,
		...(options.lane ? { lane: options.lane } : {}),
		detect: async () => null,
		install: async () => options.install?.(),
		verify: async () => ({ text: `${name} ok`, version: "1" }),
		activate: async () => {},
	};
}
const ok = (name: string): StageOutcome => ({ stage: name, status: "installed", ms: 0, attempts: 1, fsErrors: [] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the graph", () => {
	it("refuses a duplicate name, an unknown need, and a cycle before anything runs", () => {
		assert.throws(() => orderStages([plain("a", []), plain("a", [])]), GraphError);
		assert.throws(() => orderStages([plain("a", ["nope"])]), /needs nope/);
		assert.throws(() => orderStages([plain("a", ["b"]), plain("b", ["c"]), plain("c", ["a"])]), /cycle: a -> b -> c -> a/);
		assert.deepEqual(orderStages([plain("c", ["b"]), plain("b", ["a"]), plain("a", [])]).map((s) => s.name), ["a", "b", "c"]);
	});

	it("runs a stage only after the stages it needs, and blocks the stages behind a failure while the independent ones still run", async () => {
		const order: string[] = [];
		const stages = [plain("c", ["b"]), plain("b", ["a"]), plain("a", []), plain("d", [])];
		const result = await runGraph({
			stages,
			async run(stage) {
				order.push(stage.name);
				return stage.name === "a" ? { ...ok("a"), status: "failed" } : ok(stage.name);
			},
		});
		assert.equal(result.ok, false);
		assert.deepEqual(result.outcomes.map((o) => [o.stage, o.status]), [["c", "blocked"], ["b", "blocked"], ["a", "failed"], ["d", "installed"]]);
		assert.equal(result.outcomes[1]?.blockedBy, "a");
		assert.equal(result.outcomes[0]?.blockedBy, "b");
		assert.deepEqual(order.sort(), ["a", "d"]);
	});

	it("runs independent downloads three at a time and npm steps one at a time", async () => {
		const peak = { download: 0, npm: 0 };
		const live = { download: 0, npm: 0 };
		const body = (lane: "download" | "npm") => async (): Promise<void> => {
			live[lane]++;
			peak[lane] = Math.max(peak[lane], live[lane]);
			await sleep(40);
			live[lane]--;
		};
		const stages = [
			...Array.from({ length: 7 }, (_, i) => plain(`d${i}`, [], { lane: "download", install: body("download") })),
			...Array.from({ length: 4 }, (_, i) => plain(`n${i}`, [], { lane: "npm", install: body("npm") })),
		];
		const result = await runGraph({ stages, run: async (stage) => { await stage.install({} as never); return ok(stage.name); } });
		assert.equal(result.ok, true);
		assert.equal(peak.download, 3);
		assert.equal(peak.npm, 1);
	});

	it("blocks what is left when it is cancelled", async () => {
		const controller = new AbortController();
		const result = await runGraph({
			stages: [plain("a", []), plain("b", ["a"])],
			signal: controller.signal,
			async run(stage) {
				controller.abort();
				return ok(stage.name);
			},
		});
		assert.deepEqual(result.outcomes.map((o) => o.status), ["installed", "blocked"]);
		assert.equal(result.outcomes[1]?.blockedBy, "cancelled");
	});
});

describe("failure categories and retries", () => {
	it("has the sentence of the spec for each category", () => {
		assert.equal(failureSentence("network", { host: "nodejs.org" }), "Could not reach nodejs.org. Check the network and try again.");
		assert.equal(failureSentence("integrity", { tool: "node" }), "The download of node did not match its published checksum, so nothing was installed.");
		assert.match(failureSentence("registry", { what: "pi@1.4.0" }), /^The npm registry could not be reached or is out of date, so pi@1\.4\.0 was not installed\./);
		assert.equal(failureSentence("disk", {}), "There is not enough free space on the disk.");
		assert.equal(failureSentence("locked", {}), "A file was in use (often antivirus scanning it).");
		assert.equal(failureSentence("other", { stage: "git-helpers" }), "git-helpers failed.");
		assert.deepEqual(RETRIED_ONCE, { network: true, integrity: false, registry: true, disk: false, locked: true, other: false });
	});

	it("classifies by error code", () => {
		const coded = (code: string): Error => Object.assign(new Error(code), { code });
		assert.equal(classifyError(coded("ENOSPC"), "s").category, "disk");
		assert.equal(classifyError(coded("EBUSY"), "s").category, "locked");
		assert.equal(classifyError(coded("ECONNRESET"), "s").category, "network");
		assert.equal(classifyError(new Error("fetch failed", { cause: coded("ENOTFOUND") }), "s").category, "network");
		assert.equal(classifyError(new Error("boom"), "s").category, "other");
		const own = new StageError("registry", { what: "x@1" }, "detail");
		assert.equal(classifyError(own, "s"), own);
	});

	const stageThatFails = (name: string, failures: Error[], attempts: { n: number }): Stage => ({
		name,
		needs: [],
		detect: async () => null,
		async install() {
			attempts.n++;
			const next = failures.shift();
			if (next) throw next;
		},
		verify: async () => ({ text: "fine", version: "1" }),
		activate: async () => {},
	});
	const coded = (code: string): Error => Object.assign(new Error(code), { code });

	it("retries a network, registry, or locked failure once and gives up on the second", async () => {
		for (const [first, category] of [[coded("ECONNRESET"), "network"], [new StageError("registry", { what: "p@1" }, "registry down"), "registry"], [coded("EBUSY"), "locked"]] as const) {
			const once = { n: 0 };
			const recovered = await runEngine(root, makeStack({}), [stageThatFails(`once-${category}`, [first], once)]);
			assert.equal(recovered.outcomes[`once-${category}`]?.status, "installed", category);
			assert.equal(once.n, 2, category);

			const twice = { n: 0 };
			const failed = await runEngine(root, makeStack({}), [stageThatFails(`twice-${category}`, [first, first], twice)]);
			assert.equal(failed.outcomes[`twice-${category}`]?.status, "failed", category);
			assert.equal(failed.outcomes[`twice-${category}`]?.failure?.category, category);
			assert.equal(twice.n, 2, `${category}: one retry, no more`);
		}
	});

	it("never retries a disk, integrity, or other failure", async () => {
		for (const [error, category] of [[coded("ENOSPC"), "disk"], [new StageError("integrity", { tool: "t" }, "bad bytes"), "integrity"], [new Error("plain"), "other"]] as const) {
			const attempts = { n: 0 };
			const run = await runEngine(root, makeStack({}), [stageThatFails(`no-${category}`, [error, error], attempts)]);
			assert.equal(run.outcomes[`no-${category}`]?.failure?.category, category);
			assert.equal(attempts.n, 1, category);
		}
	});

	it("waits the retry delay before the second attempt", async () => {
		const times: number[] = [];
		const stage: Stage = { ...stageThatFails("wait", [coded("ECONNRESET")], { n: 0 }), install: async () => { times.push(Date.now()); if (times.length === 1) throw coded("ECONNRESET"); } };
		await runEngine(root, makeStack({}), [stage], { retryDelayMs: 250 });
		assert.equal(times.length, 2);
		assert.ok((times[1] ?? 0) - (times[0] ?? 0) >= 240);
	});

	it("retries a flaky server once (HTTP 503), then installs; a server that stays down fails as network with the host named", async () => {
		const flaky = publish(server, "flaky", { version: "1.0.0" });
		server.setMode(flaky.path, { kind: "status", code: 503, times: 1 });
		const run = await runEngine(root, makeStack({ flaky }), [toolStage("flaky")]);
		assert.equal(run.outcomes["flaky"]?.status, "installed");
		assert.equal(run.outcomes["flaky"]?.attempts, 2);
		assert.equal(server.hits(flaky.path), 2);

		const down = publish(server, "down", { version: "1.0.0" });
		server.setMode(down.path, { kind: "status", code: 503 });
		const failed = await runEngine(scratchRootOf(), makeStack({ down }), [toolStage("down")]);
		assert.equal(failed.outcomes["down"]?.failure?.category, "network");
		assert.equal(failed.outcomes["down"]?.failure?.sentence, `Could not reach 127.0.0.1:${server.port}. Check the network and try again.`);
		assert.equal(server.hits(down.path), 2);
	});

	it("fails a download that goes quiet, with no headers or in the middle of the body, as a network failure that is retried once (T4-F006)", { timeout: 30_000 }, async () => {
		for (const kind of ["silent", "hang"] as const) {
			const quiet = publish(server, `quiet-${kind}`, { version: "1.0.0" });
			server.setMode(quiet.path, { kind });
			const started = Date.now();
			const run = await runEngine(scratchRootOf(), makeStack({ [`quiet-${kind}`]: quiet }), [toolStage(`quiet-${kind}`)], { downloadIdleMs: 250 });
			const outcome = run.outcomes[`quiet-${kind}`];
			assert.equal(outcome?.status, "failed", kind);
			assert.equal(outcome?.failure?.category, "network", kind);
			assert.equal(outcome?.attempts, 2, `${kind}: retried once`);
			assert.equal(server.hits(quiet.path), 2, kind);
			assert.match(outcome?.failure?.detail ?? "", /no (data|response) for 250 ms/, kind);
			assert.ok(Date.now() - started < 10_000, `${kind}: gave up promptly`);
		}
	});

	it("installs when the retry after a stalled download gets through, leaving no part file", { timeout: 30_000 }, async () => {
		const once = publish(server, "stall-once", { version: "1.0.0" });
		server.setMode(once.path, { kind: "hang", times: 1 });
		const run = await runEngine(root, makeStack({ "stall-once": once }), [toolStage("stall-once")], { downloadIdleMs: 250 });
		assert.equal(run.outcomes["stall-once"]?.status, "installed");
		assert.equal(run.outcomes["stall-once"]?.attempts, 2);
		assert.deepEqual(readdirSync(join(root, "tools", "downloads")), [`stall-once-1.0.0.${process.platform === "win32" ? "zip" : "tar.gz"}`]);
	});

	it("takes a connection cut mid-download as a network failure and removes the partial file", async () => {
		const cut = publish(server, "cut", { version: "1.0.0" });
		server.setMode(cut.path, { kind: "drop" });
		const run = await runEngine(root, makeStack({ cut }), [toolStage("cut")]);
		assert.equal(run.outcomes["cut"]?.failure?.category, "network");
		assert.deepEqual(readdirSync(join(root, "tools", "downloads")), []);
	});

	it("takes HTTP 404 on a pinned URL as a failure of the stage, not a network failure, and does not retry", async () => {
		const gone = publish(server, "gone", { version: "1.0.0" });
		server.setMode(gone.path, { kind: "status", code: 404 });
		const run = await runEngine(root, makeStack({ gone }), [toolStage("gone")]);
		assert.equal(run.outcomes["gone"]?.failure?.category, "other");
		assert.equal(server.hits(gone.path), 1);
	});

	it("reports a cancelled run as failed and leaves no staging folder", async () => {
		const slow = publish(server, "slow", { version: "1.0.0" });
		server.setMode(slow.path, { kind: "hang" });
		const events: EngineEvent[] = [];
		const engine = createEngine({
			emit: (e) => events.push(e),
			fetch: (url, init) => fetch(url, init),
			layout: testLayout(root),
			platform: testPlatform(),
			retryDelayMs: 0,
			stages: () => [toolStage("slow")],
		});
		const asking = server.requested(slow.path);
		const running = engine.handle({ type: "run", config: { root, stack: makeStack({ slow }), secretPatterns } });
		await asking;
		await sleep(100);
		await engine.handle({ type: "cancel" });
		await running;
		const done = events.find((e) => e.type === "done");
		assert.equal(done?.type === "done" && done.ok, false);
		assert.deepEqual(readdirSync(join(root, "tools", "slow")), [], "no staging folder");
		assert.equal(existsSync(join(root, "state", "engine.lock")), false);
	});
});

function scratchRootOf(): string {
	const made = scratchRoot();
	scratch.push(made.base);
	return made.root;
}

describe("downloads", () => {
	const asset = (body: Buffer, path: string) => ({ url: server.url(path), sha256: sha256Hex(body), file: "thing.bin" });

	it("uses a cached file with the pinned hash without a request, and fetches again over a cached file that does not match", async () => {
		const body = Buffer.from("the pinned bytes");
		server.serve("/thing.bin", body);
		const dir = join(scratchRootOf(), "dl");
		const fetchFn = (url: string, init?: { signal?: AbortSignal }) => fetch(url, init);
		const first = await downloadVerified({ fetch: fetchFn, asset: asset(body, "/thing.bin"), tool: "thing", dir });
		assert.equal(first.cached, false);
		assert.equal(first.bytes, body.length);
		const second = await downloadVerified({ fetch: fetchFn, asset: asset(body, "/thing.bin"), tool: "thing", dir });
		assert.equal(second.cached, true);
		assert.equal(server.hits("/thing.bin"), 1);
		writeFileSync(join(dir, "thing.bin"), "tampered");
		const third = await downloadVerified({ fetch: fetchFn, asset: asset(body, "/thing.bin"), tool: "thing", dir });
		assert.equal(third.cached, false);
		assert.equal(readFileSync(join(dir, "thing.bin"), "utf8"), "the pinned bytes");
		assert.deepEqual(readdirSync(dir), ["thing.bin"]);
	});

	it("counts the idle time from the last byte, not from the start: a slow download that keeps sending is not cut (T4-F006)", async () => {
		const body = Buffer.from("s".repeat(4000));
		server.serve("/trickle.bin", body, { kind: "trickle", chunks: 8, gapMs: 100 });
		const started = Date.now();
		const done = await downloadVerified({
			fetch: (url, init) => fetch(url, init),
			asset: { url: server.url("/trickle.bin"), sha256: sha256Hex(body), file: "trickle.bin" },
			tool: "trickle",
			dir: join(scratchRootOf(), "dl"),
			idleTimeoutMs: 400,
		});
		assert.equal(done.bytes, body.length);
		assert.ok(Date.now() - started >= 600, "the whole transfer took longer than the idle limit");
	});

	it("rejects a stalled download with a network StageError and removes the part file", { timeout: 30_000 }, async () => {
		const body = Buffer.from("h".repeat(4000));
		const dir = join(scratchRootOf(), "dl");
		for (const kind of ["hang", "silent"] as const) {
			server.serve(`/${kind}.bin`, body, { kind });
			await assert.rejects(
				downloadVerified({ fetch: (url, init) => fetch(url, init), asset: { url: server.url(`/${kind}.bin`), sha256: sha256Hex(body), file: `${kind}.bin` }, tool: kind, dir, idleTimeoutMs: 200 }),
				(e: unknown) => e instanceof StageError && e.category === "network" && /no (data|response) for 200 ms/.test(e.message),
				kind,
			);
		}
		assert.deepEqual(readdirSync(dir), []);
	});

	it("refuses a pinned URL that is neither https nor loopback", async () => {
		await assert.rejects(
			downloadVerified({ fetch: async () => new Response("x"), asset: { url: "http://example.com/x.zip", sha256: "0".repeat(64), file: "x.zip" }, tool: "x", dir: join(scratchRootOf(), "dl") }),
			(e: unknown) => e instanceof StageError && e.category === "other" && /must be https/.test(e.message),
		);
	});
});

describe("the stack", () => {
	it("parses the repository's stack.json and finds every tool for every platform key", () => {
		const stack = parseStack(JSON.parse(readFileSync(new URL("../../stack.json", import.meta.url), "utf8")));
		for (const key of ["win32-x64", "darwin-arm64", "darwin-x64"] as const) {
			for (const tool of ["node", "git", "herdr", "gh", "glab", "fd", "rg"]) assert.ok(assetFor(stack, tool, key).sha256.length === 64, `${tool} ${key}`);
		}
		assert.equal(platformKey("win32", "arm64"), "win32-x64", "Windows is x64 everywhere");
		assert.equal(platformKey("darwin", "arm64"), "darwin-arm64");
		assert.throws(() => platformKey("linux", "x64"), StackError);
	});

	it("refuses a bad pin before any download", () => {
		const good = JSON.parse(readFileSync(new URL("../../stack.json", import.meta.url), "utf8")) as Record<string, any>;
		const mutate = (change: (s: Record<string, any>) => void): unknown => {
			const copy = structuredClone(good);
			change(copy);
			return copy;
		};
		assert.throws(() => parseStack(mutate((s) => (s.tools.node.assets["win32-x64"].sha256 = "abc"))), /sha256/);
		assert.throws(() => parseStack(mutate((s) => (s.tools.node.assets["win32-x64"].url = "http://nodejs.org/x.zip"))), /https/);
		assert.throws(() => parseStack(mutate((s) => (s.tools.node.assets["linux-x64"] = s.tools.node.assets["win32-x64"]))), /unknown platform key/);
		assert.throws(() => parseStack(mutate((s) => (s.tools.node.assets["win32-x64"].version = "^24.0.0"))), /exact version/);
		assert.throws(() => parseStack(mutate((s) => (s.tools.node.assets["win32-x64"].file = "../x.zip"))), /plain file name/);
		for (const file of ["-", "-x.zip", "--help"]) assert.throws(() => parseStack(mutate((s) => (s.tools.node.assets["win32-x64"].file = file))), /must not start with `-`/, file);
		assert.throws(() => parseStack(mutate((s) => (s.schema = 2))), /schema/);
		assert.throws(() => assetFor(parseStack(good), "nope", "win32-x64"), /no nope/);
	});
});

describe("state", () => {
	it("writes by rename, so no temporary file stays, and reads back what it wrote", async () => {
		const layout = testLayout(root);
		const store = new StateStore(layout);
		await store.setVersion("node", "1.0.0");
		await store.setRecord("node", { status: "ok", version: "1.0.0", evidence: "node 1", at: "t", hashes: { "tools/node/1.0.0/node": "ab" }, dependsOn: {} });
		assert.deepEqual(readdirSync(layout.state).sort(), ["bootstrap.json", "current.json"]);
		const again = new StateStore(layout);
		assert.equal(again.version("node"), "1.0.0");
		assert.equal(again.record("node")?.hashes["tools/node/1.0.0/node"], "ab");
	});

	it("serializes parallel writes from parallel stages", async () => {
		const layout = testLayout(root);
		const store = new StateStore(layout);
		await Promise.all(Array.from({ length: 30 }, (_, i) => store.setRecord(`s${i}`, { status: "ok", version: "1", evidence: "", at: "t", hashes: {}, dependsOn: {} })));
		assert.equal(Object.keys(new StateStore(layout).bootstrap().stages).length, 30);
	});

	it("moves an unreadable state file aside and starts from the disk, and says so", async () => {
		const layout = testLayout(root);
		mkdirSync(layout.state, { recursive: true });
		writeFileSync(join(layout.state, "bootstrap.json"), "{ not json");
		writeFileSync(join(layout.state, "current.json"), JSON.stringify({ schema: 1, versions: { node: 5 }, previous: {} }));
		const moved: string[] = [];
		const store = new StateStore(layout, { onQuarantine: (_file, to) => moved.push(to) });
		assert.deepEqual(store.bootstrap().stages, {});
		assert.deepEqual(store.current().versions, {});
		assert.equal(moved.length, 2);
		assert.ok(moved.every((m) => existsSync(m)));
	});
});

describe("the engine lock", () => {
	const alive = (pids: number[]) => ({
		...testPlatform().processes,
		inspect: async (asked: readonly number[]) => asked.map((pid) => ({ pid, startTime: pids.includes(pid) ? `start-${pid}` : null, executable: null })),
	});
	/** The OS answers that no pid exists, so a missing start time means the owner is gone. */
	const gone = { pidAlive: () => false, unreadableGraceMs: 0 };
	const lockFile = () => join(testLayout(root).state, "engine.lock");

	it("refuses a second engine while the first lives, and takes over the lock of one that is gone or whose pid was reused", async () => {
		const layout = testLayout(root);
		const first = await acquireEngineLock(layout, alive([1001]), 1001, gone);
		await assert.rejects(acquireEngineLock(layout, alive([1001, 1002]), 1002, gone), EngineLockedError);
		first.release();
		assert.equal(existsSync(join(layout.state, "engine.lock")), false);

		// The owner died: its lock is stale.
		await acquireEngineLock(layout, alive([1001]), 1001, gone);
		const taken = await acquireEngineLock(layout, alive([1002]), 1002, gone);
		assert.equal((JSON.parse(readFileSync(join(layout.state, "engine.lock"), "utf8")) as { pid: number }).pid, 1002);
		taken.release();

		// The pid is alive but belongs to another process now (a different start token).
		writeFileSync(join(layout.state, "engine.lock"), JSON.stringify({ pid: 1003, startTime: "an-older-start" }));
		const reused = await acquireEngineLock(layout, alive([1003, 1004]), 1004, gone);
		reused.release();

		// An unreadable lock that nobody is writing is stale too, and releasing someone else's lock removes nothing.
		writeFileSync(join(layout.state, "engine.lock"), "garbage");
		const over = await acquireEngineLock(layout, alive([1005]), 1005, gone);
		await acquireEngineLock(layout, alive([1005]), 1005, gone).catch(() => {});
		over.release();
		const mine = await acquireEngineLock(layout, alive([1006]), 1006, gone);
		writeFileSync(join(layout.state, "engine.lock"), JSON.stringify({ pid: 1007, startTime: "start-1007", token: "theirs" }));
		mine.release();
		assert.equal(existsSync(join(layout.state, "engine.lock")), true, "a lock someone else took over is theirs");
	});

	it("counts a lock that names this very process as held, never as stale (T4-F002)", async () => {
		const layout = testLayout(root);
		const first = await acquireEngineLock(layout, alive([2001]), 2001, gone);
		await assert.rejects(acquireEngineLock(layout, alive([2001]), 2001, gone), EngineLockedError);
		await assert.rejects(acquireEngineLock(layout, alive([2001]), 2001, gone), /another engine \(pid 2001\)/);
		assert.equal(JSON.parse(readFileSync(lockFile(), "utf8")).pid, 2001, "the held lock is still the first one's");
		first.release();
		assert.equal(existsSync(lockFile()), false);

		// A start token nobody can read fails closed; two known, different tokens are a reused pid, which is stale.
		const unknown = { ...testPlatform().processes, inspect: async (asked: readonly number[]) => asked.map((pid) => ({ pid, startTime: null, executable: null })) };
		await acquireEngineLock(layout, unknown, 2002, gone);
		await assert.rejects(acquireEngineLock(layout, unknown, 2002, gone), EngineLockedError);
		rmSync(lockFile());
		writeFileSync(lockFile(), JSON.stringify({ pid: 2003, startTime: "start-of-a-dead-incarnation" }));
		(await acquireEngineLock(layout, alive([2003]), 2003, gone)).release();
	});

	it("fails closed when the start time of a live owner cannot be read, and takes over only when the OS says the pid is gone (T4-F009)", async () => {
		const layout = testLayout(root);
		mkdirSync(layout.state, { recursive: true });
		const noStartTime = { ...testPlatform().processes, inspect: async (asked: readonly number[]) => asked.map((pid) => ({ pid, startTime: null, executable: null })) };
		writeFileSync(lockFile(), JSON.stringify({ pid: 3001, startTime: "start-3001" }));
		await assert.rejects(acquireEngineLock(layout, noStartTime, 3002, { pidAlive: (pid) => pid === 3001 }), /another engine \(pid 3001\)/, "ps answered nothing, the pid still exists: held");
		assert.equal(JSON.parse(readFileSync(lockFile(), "utf8")).pid, 3001, "and the lock was not touched");
		(await acquireEngineLock(layout, noStartTime, 3002, { pidAlive: () => false })).release();
	});

	it("lets exactly one of several contenders take over the same stale lock (T4-F009)", async () => {
		const layout = testLayout(root);
		mkdirSync(layout.state, { recursive: true });
		writeFileSync(lockFile(), JSON.stringify({ pid: 4000, startTime: "start-4000" }));
		const contenders = Array.from({ length: 12 }, (_, i) => 4001 + i);
		const everyone = alive(contenders);
		const results = await Promise.allSettled(contenders.map((pid) => acquireEngineLock(layout, everyone, pid, gone)));
		const winners = results.flatMap((r, i) => (r.status === "fulfilled" ? [contenders[i] as number] : []));
		assert.equal(winners.length, 1, `winners: ${winners.join(",")}`);
		for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof EngineLockedError);
		assert.equal(JSON.parse(readFileSync(lockFile(), "utf8")).pid, winners[0], "the lock on disk is the winner's");
		assert.deepEqual(readdirSync(layout.state).filter((n) => n.includes("stale")), [], "no moved-aside file stays");
	});

	it("does not take a lock that is being written, only one that has stayed unreadable (T4-F009)", async () => {
		const layout = testLayout(root);
		mkdirSync(layout.state, { recursive: true });
		writeFileSync(lockFile(), "");
		await assert.rejects(acquireEngineLock(layout, alive([5001]), 5001, { pidAlive: () => false }), /is writing/);
		const longAgo = new Date(Date.now() - 60_000);
		utimesSync(lockFile(), longAgo, longAgo);
		(await acquireEngineLock(layout, alive([5001]), 5001, { pidAlive: () => false })).release();
	});

	it("makes a run fail at once with an error event when another engine holds the root", async () => {
		const layout = testLayout(root);
		mkdirSync(layout.state, { recursive: true });
		const processes = alive([process.pid, 4242]);
		writeFileSync(join(layout.state, "engine.lock"), JSON.stringify({ pid: 4242, startTime: "start-4242" }));
		const run = await runEngine(root, makeStack({}), [plain("a", [])], { platform: { ...testPlatform(), processes } });
		assert.equal(run.ok, false);
		assert.match(run.error?.message ?? "", /another engine \(pid 4242\)/);
		assert.equal(run.error?.name, "EngineLockedError");
	});
});

describe("engine messages", () => {
	it("announces each stage, reports the outcomes, and answers a bad stack with an error event", async () => {
		const alpha = publish(server, "alpha-m", { version: "1.0.0" });
		const run = await runEngine(root, makeStack({ "alpha-m": alpha }), [toolStage("alpha-m")]);
		assert.deepEqual(run.events.map((e) => e.type), ["stage-start", "stage", "done"]);

		const bad = await runEngine(scratchRootOf(), { schema: 1 } as never, [plain("a", [])]);
		assert.equal(bad.ok, false);
		assert.match(bad.error?.message ?? "", /generation/);
		assert.ok(bad.error?.details.every((l) => typeof l === "string"));
	});

	it("is inert when imported outside a utilityProcess", async () => {
		const mod = await import("../src/main/bootstrap/engine.ts");
		assert.equal(mod.startEngine(undefined), null);
	});
});
