import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { OpenBaseClient, readGuiRecord } from "../src/main/projects/open-base.ts";

// The open-base call, against a stand-in of the endpoints pi-straw-boss 0.58.2 serves (`src/spawn.ts`): the same path under the page token, the same headers the kit's `gui-client.mjs` sends
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
