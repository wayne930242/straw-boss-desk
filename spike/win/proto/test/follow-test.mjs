// Exercises follow.ts (compiled) under plain Node with a fake slot folder and fake GUI listeners; no Electron, no kit.
// Usage: npm run test:follow   (or: node test/follow-test.mjs src/follow.ts)
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
// The compiled file (dist/follow.js, CommonJS) or the source (src/follow.ts, which Node runs by type stripping) both work.
const mod = await import(new URL(process.argv[2], `file://${process.cwd()}/`).href);
const { Follower, parseGuiUrl, urlOf } = mod.default ?? mod;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tok = (n) => n.toString(16).padStart(32, "0");

const dir = mkdtempSync(join(process.env.SBD_TEST_TMP ?? tmpdir(), "follow-"));
const write = (name, obj) => { const t = join(dir, name + ".tmp"); writeFileSync(t, typeof obj === "string" ? obj : JSON.stringify(obj)); renameSync(t, join(dir, name)); };

// A fake GUI: answers 200 only on the current token's path, 403 on any other (as the real one does after a rotation).
function listener(token) {
	let up = true;
	const srv = createServer((req, res) => { res.writeHead(req.url === `/${token}/` ? 200 : 403).end("x"); });
	return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ port: srv.address().port, token, srv, close: () => new Promise((d) => { up = false; srv.close(d); srv.closeAllConnections?.(); }) })));
}

const events = [];
let upCalls = 0, nextUp;
const host = {
	log: (e, d) => events.push(["log", e, d?.detail]),
	load: async (url) => events.push(["load", url]),
	screen: (s) => events.push(["screen", s.kind]),
	banner: (t) => events.push(["banner", t]),
	runUp: async () => { upCalls++; events.push(["runUp"]); return nextUp(); },
};
const kinds = () => events.map((e) => e[0] + ":" + (e[1] ?? "")).join(" | ");
const loads = () => events.filter((e) => e[0] === "load").map((e) => e[1]);
const timing = { tickMs: 100, goneMs: 600, freshMs: 1000, moveWaitMs: 3000, movePollMs: 50 };

let a = await listener(tok(1));
const record = (l, extra = {}) => write("server.json", { pid: 1, version: "0.46.0", desk: true, gui: { port: l.port, token: l.token }, ...extra });
record(a);
write("gui.json", { port: a.port, token: a.token, csrf: "c" });
const f = new Follower(dir, host, urlOf(a), timing);
f.start();

// 1. live: nothing happens
await sleep(700);
assert.equal(loads().length, 0); assert.equal(upCalls, 0);
console.log("1 live: no load, no up");

// 2. rotation (restart): a new listener on a new port, old token path 403s; the record moves; the window follows
const b = await listener(tok(2));
record(b);
await sleep(500);
assert.deepEqual(loads(), [urlOf(b)]);
console.log("2 moved: loaded the new URL once", loads().length);

// 3. same port, new token (the usual restart): old url path now 403 on the same listener
const c = { ...b, token: tok(3) };
await b.close();
const c2 = await new Promise((r) => { const srv = createServer((q, s) => s.writeHead(q.url === `/${tok(3)}/` ? 200 : 403).end("x")); srv.listen(b.port, "127.0.0.1", () => r(srv)); });
// the record names the new token on the same port only AFTER the listener answers; before that a restarting marker holds the window
record(c, { restarting: { since: new Date().toISOString(), reason: "test", by: "test", began: new Date().toISOString() } });
await sleep(300);
assert.equal(upCalls, 0);
const bannersNow = events.filter((e) => e[0] === "banner" && e[1]).length;
assert.ok(bannersNow >= 1, "banner while restarting");
record(c); // restart done
await sleep(500);
assert.deepEqual(loads(), [urlOf(b), urlOf(c)]);
console.log("3 restarting banner, then moved to same port new token");

// 4. unreadable record: no action
writeFileSync(join(dir, "server.json"), "{ broken");
writeFileSync(join(dir, "gui.json"), "");
await sleep(400);
assert.equal(upCalls, 0); assert.equal(loads().length, 2);
console.log("4 parse failure: no action");
record(c);

// 5. gui stopped (server.json gui.stopped): screen, no further loads or up
record(c, { gui: { port: c.port, token: c.token, stopped: true } });
await sleep(400);
assert.ok(events.some((e) => e[0] === "screen" && e[1] === "gui-stopped"));
assert.equal(upCalls, 0);
console.log("5 gui stopped screen");

// 6. Start button: runUp returns a new URL; loaded
const d = await listener(tok(4));
nextUp = async () => { record(d); return { ok: true, url: urlOf(d) }; };
await f.startFromScreen();
await sleep(300);
assert.equal(upCalls, 1);
assert.equal(loads().at(-1), urlOf(d));
console.log("6 Start button: up once, new URL loaded");

// 7. server stopped screen
record(d, { stopped: true });
await sleep(400);
assert.ok(events.some((e) => e[0] === "screen" && e[1] === "server-stopped"));
console.log("7 server stopped screen");

// 8. gone: record healthy but nothing answers for goneMs, no restarting -> exactly one up
record(d);
await sleep(300);
const e = await listener(tok(5));
nextUp = async () => { record(e); return { ok: true, url: urlOf(e) }; };
await d.close();
await sleep(1500);
assert.equal(upCalls, 2, "one more up for gone, got " + upCalls);
assert.equal(loads().at(-1), urlOf(e));
console.log("8 gone: one up, new URL loaded");

// 9. gone again, up fails: failed screen once; no repeated up
await e.close();
nextUp = async () => ({ ok: false, code: 11, text: "the sb server did not answer in time" });
await sleep(1800);
const ups = upCalls;
assert.equal(ups, 3);
assert.ok(events.some((x) => x[0] === "screen" && x[1] === "failed"));
await sleep(1200);
assert.equal(upCalls, ups, "no automatic retry after a failure");
console.log("9 failed screen, no retry loop");

// 9b. the record still names the dead listener: the move gives up once, then is skipped (no looping 30 s polls, no repeated banner)
const timeouts = () => events.filter((x) => x[1] === "follow-move-timeout").length;
for (let i = 0; i < 80 && timeouts() < 1; i++) await sleep(100);
assert.equal(timeouts(), 1, "first move gave up");
await sleep(timing.moveWaitMs + 1000);
assert.equal(timeouts(), 1, "a given-up target is not polled again");
console.log("9b given-up target skipped");

// 9c. a Start press during a running move is not lost: it runs next
const dead = await listener(tok(6)); await dead.close();
record(dead); // a new, never-answering target: a move starts and runs for moveWaitMs
await sleep(500);
const g = await listener(tok(7));
nextUp = async () => { record(g); return { ok: true, url: urlOf(g) }; };
const upsBefore = upCalls;
await f.startFromScreen(); // returns at once: the move runs
await sleep(timing.moveWaitMs + 1500);
assert.equal(upCalls, upsBefore + 1, "the Start press ran after the move");
assert.equal(loads().at(-1), urlOf(g));
console.log("9c Start during a move: ran next");

// 10. the log never holds a token
for (const ev of events) if (ev[0] === "log") assert.ok(!/[0-9a-f]{32}/.test(String(ev[2] ?? "")), "token in log: " + ev[2]);
console.log("10 no token in follower logs");

assert.deepEqual(parseGuiUrl("http://127.0.0.1:1/zz/"), undefined);
assert.deepEqual(parseGuiUrl("http://example.com:1/" + tok(1) + "/"), undefined);
f.stop();
c2.close();
console.log("ALL OK");
process.exit(0);
