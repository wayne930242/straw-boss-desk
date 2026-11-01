import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { mapLimit, verifyAsset, verifyPackage } from "../lib/verify.mjs";

const BODY = Buffer.from("the bytes of a pinned download\n".repeat(1000));
const GOOD = createHash("sha256").update(BODY).digest("hex");
const NO_DELAY = { delays: [0, 0] };

let server;
let base;
const hits = new Map();

before(async () => {
  server = createServer((req, res) => {
    hits.set(req.url, (hits.get(req.url) ?? 0) + 1);
    if (req.url === "/ok") return res.end(BODY);
    if (req.url === "/missing") return res.writeHead(404).end();
    if (req.url === "/flaky") return hits.get(req.url) < 3 ? res.writeHead(503).end() : res.end(BODY);
    if (req.url === "/down") return res.writeHead(503).end();
    res.writeHead(500).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const asset = (path, sha256 = GOOD) => ({ url: `${base}${path}`, sha256 });

test("an asset whose bytes hash to the pin passes", async () => {
  const result = await verifyAsset(asset("/ok"), NO_DELAY);
  assert.equal(result.ok, true, result.detail);
});

test("an asset whose bytes hash to something else fails and names both values", async () => {
  const wrong = "0".repeat(64);
  const result = await verifyAsset(asset("/ok", wrong), NO_DELAY);
  assert.equal(result.ok, false);
  assert.ok(result.detail.includes(wrong) && result.detail.includes(GOOD), result.detail);
});

test("a 404 fails at once, without a retry", async () => {
  hits.clear();
  const result = await verifyAsset(asset("/missing"), NO_DELAY);
  assert.equal(result.ok, false);
  assert.match(result.detail, /HTTP 404/);
  assert.equal(hits.get("/missing"), 1);
});

test("a 503 is retried and can recover", async () => {
  hits.clear();
  const result = await verifyAsset(asset("/flaky"), NO_DELAY);
  assert.equal(result.ok, true, result.detail);
  assert.equal(hits.get("/flaky"), 3);
});

test("a server that stays down fails after the retries", async () => {
  hits.clear();
  const result = await verifyAsset(asset("/down"), NO_DELAY);
  assert.equal(result.ok, false);
  assert.equal(hits.get("/down"), 3);
});

const INTEGRITY = `sha512-${"A".repeat(86)}==`;
const pkg = { name: "@scope/pkg", version: "1.2.3", integrity: INTEGRITY };
const registryAnswering = (answer, seen = []) => async (url) => {
  seen.push(String(url));
  return answer;
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a package whose registry integrity equals the pin passes, and the scoped name is encoded", async () => {
  const seen = [];
  const result = await verifyPackage(pkg, { fetchImpl: registryAnswering(json({ version: "1.2.3", dist: { integrity: INTEGRITY } }), seen), ...NO_DELAY });
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(seen, ["https://registry.npmjs.org/@scope%2Fpkg/1.2.3"]);
});

test("a package whose registry integrity differs fails", async () => {
  const other = `sha512-${"B".repeat(86)}==`;
  const result = await verifyPackage(pkg, { fetchImpl: registryAnswering(json({ version: "1.2.3", dist: { integrity: other } })), ...NO_DELAY });
  assert.equal(result.ok, false);
  assert.ok(result.detail.includes(INTEGRITY) && result.detail.includes(other), result.detail);
});

test("a version the registry does not have fails", async () => {
  const result = await verifyPackage(pkg, { fetchImpl: registryAnswering(json({}, 404)), ...NO_DELAY });
  assert.equal(result.ok, false);
  assert.match(result.detail, /not on the registry/);
});

test("a registry that cannot be reached fails with the reason", async () => {
  const fetchImpl = async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  };
  const result = await verifyPackage(pkg, { fetchImpl, ...NO_DELAY });
  assert.equal(result.ok, false);
  assert.match(result.detail, /ENOTFOUND/);
});

test("mapLimit keeps the order and never exceeds the limit", async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 4, 2, 3, 6], 2, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, n));
    running--;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30, 60]);
  assert.equal(peak, 2);
});
