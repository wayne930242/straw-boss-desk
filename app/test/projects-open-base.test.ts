import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { isJoinWaitMs, MAX_JOIN_WAIT_MS, MIN_JOIN_WAIT_MS, OpenBaseClient, readGuiRecord, totalMsFor } from "../src/main/projects/open-base.ts";

// The open-base call, against a stand-in of the endpoints pi-straw-boss 0.75.2 serves (`src/spawn.ts`): the same path under the page token, the same headers the kit's `gui-client.mjs` sends
// (Host, Origin, the CSRF value), the progress question while the opening is on its way, and the server's answers (409 settings_unsafe, 400 not_allowed, 429 busy). Nothing of the package runs.

let server: Server;
let port = 0;
let dir = "";
const TOKEN = "0123456789abcdef0123456789abcdef";
const CSRF = "csrf-value-for-the-test";
let requests: Array<{ path: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> }> = [];
let onOpen: (respond: (status: number, body: unknown) => void) => void = (respond) => respond(200, { workspace: "w1", tab: "t1", pane: "p1" });
let trust: unknown;

before(async () => {
	dir = mkdtempSync(join(tmpdir(), "sbd-open-"));
	server = createServer((req: IncomingMessage, res: ServerResponse) => {
		let text = "";
		req.on("data", (c) => (text += c)).on("end", () => {
			const body = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
			requests.push({ path: req.url ?? "", headers: req.headers, body });
			const respond = (status: number, json: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
			if (req.url === `/${TOKEN}/api/open/progress`) return respond(200, { steps: [], finished: false, ...(trust === undefined ? {} : { trust }) });
			if (req.url === `/${TOKEN}/api/open/base`) return onOpen(respond);
			respond(404, { error: "not_found" });
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
	writeFileSync(join(dir, "gui.json"), JSON.stringify({ pid: 1, port, remotePort: port, token: TOKEN, csrf: CSRF }));
});
after(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	removeTree(dir);
});
beforeEach(() => {
	requests = [];
	trust = undefined;
	onOpen = (respond) => respond(200, { workspace: "w1", tab: "t1", pane: "p1" });
});

const client = (extra: Partial<ConstructorParameters<typeof OpenBaseClient>[0]> = {}) => new OpenBaseClient({ slotDir: dir, pollMs: 20, busyPollMs: 20, ...extra });
const input = { dir: "/home/pm/StrawBoss/web", label: "官網", deploy: "sbd-abcdef123456" };
const hooks = () => ({ onTrust: () => undefined, signal: new AbortController().signal });

describe("reading gui.json", () => {
	it("takes port, token and csrf, and nothing less", () => {
		assert.deepEqual(readGuiRecord(dir), { port, token: TOKEN, csrf: CSRF });
		const empty = mkdtempSync(join(tmpdir(), "sbd-open-empty-"));
		assert.equal(readGuiRecord(empty), null);
		writeFileSync(join(empty, "gui.json"), JSON.stringify({ port: 1, token: "" , csrf: "x" }));
		assert.equal(readGuiRecord(empty), null);
		writeFileSync(join(empty, "gui.json"), "{ not json");
		assert.equal(readGuiRecord(empty), null);
		writeFileSync(join(empty, "gui.json"), `\uFEFF${JSON.stringify({ port: 2, token: "t", csrf: "c" })}`);
		assert.deepEqual(readGuiRecord(empty), { port: 2, token: "t", csrf: "c" });
		mkdirSync(empty, { recursive: true });
		removeTree(empty);
	});
});

describe("the call", () => {
	it("posts to /<token>/api/open/base with the headers the page sends, and says ok on 200", async () => {
		assert.deepEqual(await client().open(input, hooks()), { ok: true });
		const open = requests.find((r) => r.path.endsWith("/api/open/base"));
		assert.ok(open);
		assert.deepEqual(open.body, { dir: input.dir, label: input.label, deploy: input.deploy });
		assert.equal(open.headers.host, `127.0.0.1:${port}`);
		assert.equal(open.headers.origin, `http://127.0.0.1:${port}`);
		assert.equal(open.headers["x-sb-csrf"], CSRF);
		assert.equal(open.headers["content-type"], "application/json");
	});

	it("maps the server's refusals to causes", async () => {
		onOpen = (respond) => respond(409, { error: "settings_unsafe", reason: "unsafe settings\nsecond line", settings: {} });
		assert.deepEqual(await client().open(input, hooks()), { ok: false, cause: "settings-unsafe", reason: "unsafe settings" });
		onOpen = (respond) => respond(400, { error: "not_allowed", reason: "Only folders in your home" });
		assert.equal((await client().open(input, hooks())).ok, false);
		assert.equal((await client().open(input, hooks()) as { cause: string }).cause, "not-allowed");
		onOpen = (respond) => respond(502, { error: "open_failed", reason: "pi did not join" });
		assert.equal((await client().open(input, hooks()) as { cause: string }).cause, "refused");
	});

	it("carries the step the server says the opening failed at, and nothing when it names none (CIN-F002)", async () => {
		onOpen = (respond) => respond(502, { error: "open_failed", reason: "The pi in pane 3 did not join the net within 60 s\nsecond line", step: "join" });
		assert.deepEqual(await client().open(input, hooks()), { ok: false, cause: "refused", reason: "The pi in pane 3 did not join the net within 60 s", step: "join" });
		onOpen = (respond) => respond(502, { error: "open_failed", reason: "pi did not join" });
		assert.deepEqual(await client().open(input, hooks()), { ok: false, cause: "refused", reason: "pi did not join" });
		onOpen = (respond) => respond(502, { error: "open_failed", reason: "x", step: 7 });
		assert.deepEqual(await client().open(input, hooks()), { ok: false, cause: "refused", reason: "x" });
	});

	it("waits out busy and tries again, and gives up as busy after its limit", async () => {
		let n = 0;
		onOpen = (respond) => (++n < 3 ? respond(429, { error: "busy", reason: "Another opening" }) : respond(200, {}));
		assert.deepEqual(await client().open(input, hooks()), { ok: true });
		assert.equal(n, 3);
		onOpen = (respond) => respond(429, { error: "busy", reason: "Another opening" });
		assert.equal((await client({ busyMs: 100 }).open(input, hooks()) as { cause: string }).cause, "busy");
	});

	it("says gui-unavailable without gui.json, with a stale token, and when the server is gone", async () => {
		const none = mkdtempSync(join(tmpdir(), "sbd-open-none-"));
		assert.equal((await new OpenBaseClient({ slotDir: none }).open(input, hooks()) as { cause: string }).cause, "gui-unavailable");
		onOpen = (respond) => respond(404, { error: "not_found" });
		assert.equal((await client().open(input, hooks()) as { cause: string }).cause, "gui-unavailable");
		const gone = mkdtempSync(join(tmpdir(), "sbd-open-gone-"));
		writeFileSync(join(gone, "gui.json"), JSON.stringify({ port: 9, token: TOKEN, csrf: CSRF }));
		assert.equal((await new OpenBaseClient({ slotDir: gone }).open(input, hooks()) as { cause: string }).cause, "gui-unavailable");
		removeTree(none);
		removeTree(gone);
	});

	it("reports the trust question while the opening is held, and that it is gone afterwards", async () => {
		const seen: boolean[] = [];
		let finish: () => void = () => undefined;
		onOpen = (respond) => {
			trust = { id: "q1", digest: "d", folder: "x", found: [] };
			finish = () => {
				trust = undefined;
				respond(200, {});
			};
		};
		const done = client().open(input, { onTrust: (a) => seen.push(a), signal: new AbortController().signal });
		for (let i = 0; i < 100 && !seen.includes(true); i++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(seen, [true]);
		finish();
		assert.deepEqual(await done, { ok: true });
		assert.deepEqual(seen, [true, false]);
		assert.ok(requests.some((r) => r.path.endsWith("/api/open/progress") && r.body.id === input.deploy), "the progress was asked for the deploy id");
	});

	it("stops at an abort and at the total limit", async () => {
		onOpen = () => undefined;
		const abort = new AbortController();
		setTimeout(() => abort.abort(), 100);
		const aborted = await client().open(input, { onTrust: () => undefined, signal: abort.signal });
		assert.deepEqual(aborted, { ok: false, cause: "refused", reason: "aborted" });
		const late = await client({ totalMs: 150 }).open(input, hooks());
		assert.equal((late as { cause: string }).cause, "timeout");
	});
});

describe("the opening id, busy, joinWaitMs and the first message (pi-straw-boss 0.60.2 contract)", () => {
	const opens = () => requests.filter((r) => r.path.endsWith("/api/open/base"));

	it("asks under one id in every try: a busy answer is waited out and the same id is sent again", async () => {
		let n = 0;
		onOpen = (respond) => (++n < 3 ? respond(429, { error: "busy", reason: "Another opening is still on its way." }) : respond(200, { workspace: "w1", tab: "t1", pane: "p1" }));
		assert.deepEqual(await client().open(input, hooks()), { ok: true });
		assert.equal(opens().length, 3);
		assert.deepEqual(opens().map((r) => r.body.deploy), [input.deploy, input.deploy, input.deploy]);
		assert.deepEqual(opens().map((r) => r.body.dir), [input.dir, input.dir, input.dir], "the server matches the id and the folder");
	});

	it("reads a 429 by its status or its error, never gives up before busyMs, and says busy after it", async () => {
		let n = 0;
		onOpen = (respond) => (++n < 2 ? respond(429, {}) : respond(200, {}));
		assert.deepEqual(await client().open(input, hooks()), { ok: true });
		onOpen = (respond) => respond(429, { error: "busy", reason: "Another opening is still on its way." });
		assert.deepEqual(await client({ busyMs: 80 }).open(input, hooks()), { ok: false, cause: "busy", reason: "Another opening is still on its way." });
	});

	it("stops waiting out a busy answer when the signal aborts", async () => {
		onOpen = (respond) => respond(429, { error: "busy", reason: "x" });
		const abort = new AbortController();
		setTimeout(() => abort.abort(), 60);
		assert.deepEqual(await client({ busyPollMs: 10_000 }).open(input, { onTrust: () => undefined, signal: abort.signal }), { ok: false, cause: "refused", reason: "aborted" });
	});

	it("sends joinWaitMs as a number when the caller gives one, and not at all when it does not", async () => {
		await client().open({ ...input, joinWaitMs: 180_000 }, hooks());
		assert.equal(opens()[0]?.body.joinWaitMs, 180_000);
		requests = [];
		await client().open(input, hooks());
		assert.ok(!("joinWaitMs" in (opens()[0]?.body ?? {})));
	});

	it("takes joinWaitMs from 10 s to 5 min as the server does, and throws before any request for anything else", async () => {
		assert.equal(MIN_JOIN_WAIT_MS, 10_000);
		assert.equal(MAX_JOIN_WAIT_MS, 300_000);
		for (const ok of [10_000, 60_000, 300_000]) {
			assert.equal(isJoinWaitMs(ok), true, String(ok));
			assert.deepEqual(await client().open({ ...input, joinWaitMs: ok }, hooks()), { ok: true });
		}
		requests = [];
		for (const bad of [9_999, 300_001, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "60000" as unknown as number]) {
			assert.equal(isJoinWaitMs(bad), false, String(bad));
			await assert.rejects(client().open({ ...input, joinWaitMs: bad }, hooks()), RangeError);
		}
		assert.equal(requests.length, 0, "nothing was asked");
	});

	it("a 400 the server answers for joinWaitMs is a refusal that names its reason, not a retry", async () => {
		onOpen = (respond) => respond(400, { error: "bad_request", reason: "joinWaitMs is a whole number of milliseconds from 10000 to 300000." });
		assert.deepEqual(await client().open(input, hooks()), { ok: false, cause: "refused", reason: "joinWaitMs is a whole number of milliseconds from 10000 to 300000." });
		assert.equal(opens().length, 1);
	});

	it("carries what the server says of the first message: sent, unknown and not_sent, and nothing when it says nothing or something else", async () => {
		for (const delivery of ["sent", "unknown", "not_sent"] as const) {
			onOpen = (respond) => respond(200, { workspace: "w1", tab: "t1", pane: "p1", delivery });
			assert.deepEqual(await client().open(input, hooks()), { ok: true, delivery }, delivery);
		}
		onOpen = (respond) => respond(200, { workspace: "w1", tab: "t1", pane: "p1" });
		assert.deepEqual(await client().open(input, hooks()), { ok: true });
		onOpen = (respond) => respond(200, { workspace: "w1", tab: "t1", pane: "p1", delivery: "maybe" });
		assert.deepEqual(await client().open(input, hooks()), { ok: true });
	});

	it("the client's total follows joinWaitMs: the server's join wait, its ten minutes on a trust question, and a margin", () => {
		assert.equal(totalMsFor(undefined), 60_000 + 600_000 + 60_000);
		assert.equal(totalMsFor(180_000), 180_000 + 600_000 + 60_000);
		assert.ok(totalMsFor(180_000) > 13 * 60_000, "longer than the server's worst case on three minutes");
		assert.ok(totalMsFor(MAX_JOIN_WAIT_MS) > totalMsFor(MIN_JOIN_WAIT_MS));
	});

	it("keeps the base when the first message did not arrive: 502 prompt_failed reads unknown, 503 unavailable reads not_sent, and neither is repeated", async () => {
		onOpen = (respond) => respond(502, { error: "prompt_failed", reason: "The agent opened, but the first message did not arrive: timeout", step: "deliver" });
		assert.deepEqual(await client().open(input, hooks()), { ok: true, delivery: "unknown" });
		onOpen = (respond) => respond(503, { error: "unavailable", reason: "The agent opened, but this server cannot type into it; send the first message from its comms.", step: "deliver" });
		assert.deepEqual(await client().open(input, hooks()), { ok: true, delivery: "not_sent" });
		assert.equal(opens().length, 2, "one request each");
		// A 503 `unavailable` with no deliver step is a server that opens nothing: a failure, not an open base.
		onOpen = (respond) => respond(503, { error: "unavailable", reason: "This server opens nothing." });
		assert.equal((await client().open(input, hooks())).ok, false);
		onOpen = (respond) => respond(502, { error: "prompt_failed", reason: "x" });
		assert.equal((await client().open(input, hooks())).ok, false);
		// Another 502, or a 503 with another error, is still a failure of the open.
		onOpen = (respond) => respond(502, { error: "open_failed", reason: "x", step: "create" });
		assert.equal((await client().open(input, hooks())).ok, false);
		onOpen = (respond) => respond(503, { error: "down", reason: "x" });
		assert.equal((await client().open(input, hooks())).ok, false);
	});
});
