import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { privateOrLocalHost } from "../../recipe/validate.mjs";
import { isPublicAddress } from "../src/main/net/public-address.ts";
import { FetchRefused, MAX_BODY_BYTES, MAX_REDIRECTS, fetchPublicText, type FetchDeps, type FetchRefusalReason } from "../src/main/net/safe-fetch.ts";
import { createTestCa } from "./harness/test-ca.ts";

// The fetch rules of a recipe's `updateUrl` (spec: team-profile section 5; phase 2 spec, task 12): https only, no credentials, at most 3 redirects, 256 KB, and a public host checked on the
// resolved address and on every redirect. Each rule is proved against a local HTTPS server (a throw-away CA, names that resolve to scripted addresses, and a dial that sends every checked address to
// the server), and for each refusal the test also says what the server did NOT see: a refused request is never sent.

const HOSTS: Record<string, string[]> = {
	"recipes.fetch-test.example": ["93.184.216.34"],
	"other.fetch-test.example": ["93.184.216.35"],
	"internal.fetch-test.example": ["10.1.2.3"],
	"loopback.fetch-test.example": ["127.0.0.1"],
	"mixed.fetch-test.example": ["93.184.216.34", "192.168.0.9"],
	"mapped.fetch-test.example": ["::ffff:127.0.0.1"],
	"nothing.fetch-test.example": [],
};

const ca = createTestCa("fetch", Object.keys(HOSTS));
let server: Server;
let port = 0;
/** What the server saw, in order. */
let seen: Array<{ url: string; headers: IncomingMessage["headers"] }> = [];
let route: (request: IncomingMessage, response: ServerResponse) => void = () => undefined;
let lookups: string[] = [];

before(async () => {
	server = createServer({ cert: ca.server.certPem, key: ca.server.keyPem }, (request, response) => {
		seen.push({ url: request.url ?? "", headers: request.headers });
		route(request, response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
});
after(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
	seen = [];
	lookups = [];
	route = (_request, response) => response.writeHead(200, { "content-type": "application/json" }).end("{}");
});

const deps = (extra: Partial<FetchDeps> = {}): FetchDeps => ({
	privateOrLocalHost,
	resolve: async (host) => {
		lookups.push(host);
		const found = HOSTS[host];
		if (found === undefined) throw new Error(`no such host ${host}`);
		return found;
	},
	dial: () => ({ host: "127.0.0.1", port }),
	ca: ca.caPem,
	timeoutMs: 5000,
	...extra,
});

const refusal = async (url: string, extra: Partial<FetchDeps> = {}): Promise<FetchRefused> => {
	try {
		await fetchPublicText(url, deps(extra));
	} catch (error) {
		assert.ok(error instanceof FetchRefused, `a FetchRefused, got ${String(error)}`);
		return error;
	}
	throw new Error(`${url} was fetched, a refusal was expected`);
};
const expectRefused = async (url: string, reason: FetchRefusalReason, extra: Partial<FetchDeps> = {}): Promise<FetchRefused> => {
	const error = await refusal(url, extra);
	assert.equal(error.reason, reason, `${url}: ${error.message} ${error.detail ?? ""}`);
	return error;
};
const redirect = (location: string, status = 302, headers: Record<string, string> = {}) => (_request: IncomingMessage, response: ServerResponse) => response.writeHead(status, { location, ...headers }).end();

describe("the fetch itself", () => {
	it("returns the text of a 200 and sends nothing but a plain request: no cookie, no authorization, the name as Host", async () => {
		route = (_request, response) => response.writeHead(200, { "set-cookie": "sid=abc" }).end('{"a":1}');
		const got = await fetchPublicText("https://recipes.fetch-test.example/r.json", deps());
		assert.equal(got.text, '{"a":1}');
		assert.equal(got.finalUrl, "https://recipes.fetch-test.example/r.json");
		assert.equal(got.redirects, 0);
		const headers = seen[0]?.headers ?? {};
		assert.equal(headers.host, "recipes.fetch-test.example");
		for (const name of ["cookie", "authorization", "proxy-authorization"]) assert.equal(headers[name], undefined, name);
		assert.equal(headers["accept-encoding"], "identity");
	});

	it("sends no cookie on a redirect either: a Set-Cookie is dropped, never stored or sent back", async () => {
		route = (request, response) => (request.url === "/start" ? redirect("https://other.fetch-test.example/next", 302, { "set-cookie": "sid=abc; Path=/" })(request, response) : response.writeHead(200).end("ok"));
		const got = await fetchPublicText("https://recipes.fetch-test.example/start", deps());
		assert.equal(got.text, "ok");
		assert.equal(seen.length, 2);
		assert.equal(seen[1]?.headers.cookie, undefined);
		assert.equal(seen[1]?.headers.host, "other.fetch-test.example", "the second hop is for the new name");
	});
});

describe("rule: https only", () => {
	it("refuses an http address before any connection", async () => {
		const error = await expectRefused("http://recipes.fetch-test.example/r.json", "scheme");
		assert.equal(error.url, "http://recipes.fetch-test.example/r.json");
		assert.equal(seen.length, 0);
		assert.deepEqual(lookups, [], "not even a lookup");
	});

	it("refuses an address that is not a URL, and other schemes", async () => {
		await expectRefused("not a url", "scheme");
		await expectRefused("ftp://recipes.fetch-test.example/r.json", "scheme");
		await expectRefused("file:///etc/passwd", "scheme");
		assert.equal(seen.length, 0);
	});

	it("refuses a redirect to http after the first request, and never connects to the target", async () => {
		route = redirect("http://other.fetch-test.example/r.json");
		await expectRefused("https://recipes.fetch-test.example/r.json", "scheme");
		assert.equal(seen.length, 1);
		assert.deepEqual(lookups, ["recipes.fetch-test.example"]);
	});
});

describe("rule: no credentials", () => {
	it("refuses an address with a user name or a password before any connection", async () => {
		await expectRefused("https://user@recipes.fetch-test.example/r.json", "credentials");
		const error = await expectRefused("https://user:secret@recipes.fetch-test.example/r.json", "credentials");
		assert.equal(error.url.includes("secret"), false, "the refusal never repeats the password");
		assert.equal(seen.length, 0);
	});

	it("refuses a redirect whose target carries credentials", async () => {
		route = redirect("https://admin:hunter2@other.fetch-test.example/r.json");
		const error = await expectRefused("https://recipes.fetch-test.example/r.json", "credentials");
		assert.equal(error.url.includes("hunter2"), false);
		assert.equal(seen.length, 1);
	});
});

describe("rule: at most 3 redirects", () => {
	it("follows three and returns the fourth answer", async () => {
		route = (request, response) => {
			const n = Number(/^\/hop(\d)$/.exec(request.url ?? "")?.[1] ?? "0");
			if (n < MAX_REDIRECTS) redirect(`/hop${n + 1}`)(request, response);
			else response.writeHead(200).end("end");
		};
		const got = await fetchPublicText("https://recipes.fetch-test.example/hop0", deps());
		assert.equal(got.text, "end");
		assert.equal(got.redirects, MAX_REDIRECTS);
		assert.equal(seen.length, MAX_REDIRECTS + 1);
	});

	it("refuses the fourth redirect and does not follow it", async () => {
		route = (request, response) => redirect(`/hop${Number(/^\/hop(\d+)$/.exec(request.url ?? "")?.[1] ?? "0") + 1}`)(request, response);
		await expectRefused("https://recipes.fetch-test.example/hop0", "redirects");
		assert.equal(seen.length, MAX_REDIRECTS + 1, "the first request and three redirects were sent, not a fifth");
	});

	it("refuses a redirect loop", async () => {
		route = redirect("/again");
		await expectRefused("https://recipes.fetch-test.example/again", "redirects");
		assert.equal(seen.length, MAX_REDIRECTS + 1);
	});
});

describe("rule: 256 KB", () => {
	it("accepts exactly 256 KB", async () => {
		route = (_request, response) => response.writeHead(200).end("x".repeat(MAX_BODY_BYTES));
		assert.equal((await fetchPublicText("https://recipes.fetch-test.example/big", deps())).text.length, MAX_BODY_BYTES);
	});

	it("refuses one byte more, with no Content-Length to warn it (a chunked answer)", async () => {
		route = (_request, response) => {
			response.writeHead(200, { "transfer-encoding": "chunked" });
			response.write("x".repeat(MAX_BODY_BYTES));
			response.end("y");
		};
		await expectRefused("https://recipes.fetch-test.example/big", "too-large");
	});

	it("refuses a Content-Length over the limit before the body starts", async () => {
		route = (_request, response) => {
			response.writeHead(200, { "content-length": String(MAX_BODY_BYTES + 1) });
			response.flushHeaders();
			// The body never comes: the refusal must not wait for it.
		};
		const began = Date.now();
		await expectRefused("https://recipes.fetch-test.example/big", "too-large");
		assert.ok(Date.now() - began < 4000, "refused on the header");
	});

	it("stops reading an endless body", async () => {
		route = (_request, response) => {
			response.writeHead(200);
			const timer = setInterval(() => response.write("x".repeat(64 * 1024)), 5);
			response.on("close", () => clearInterval(timer));
		};
		await expectRefused("https://recipes.fetch-test.example/endless", "too-large");
	});
});

describe("rule: the host is public, by name and by address, at every hop", () => {
	for (const host of ["localhost", "intranet", "localhost.", "printer.local", "nas.lan", "box.home.arpa", "svc.internal", "127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "100.64.0.1", "[::1]"]) {
		it(`refuses ${host} by its name, without a lookup or a connection`, async () => {
			await expectRefused(`https://${host}/r.json`, "host");
			assert.deepEqual(lookups, []);
			assert.equal(seen.length, 0);
		});
	}

	it("refuses a public name that resolves to a private address, before any connection", async () => {
		await expectRefused("https://internal.fetch-test.example/r.json", "host");
		await expectRefused("https://loopback.fetch-test.example/r.json", "host");
		await expectRefused("https://mapped.fetch-test.example/r.json", "host");
		assert.equal(seen.length, 0);
	});

	it("refuses a name with one public and one private address (which one the connection used must not matter)", async () => {
		await expectRefused("https://mixed.fetch-test.example/r.json", "host");
		assert.equal(seen.length, 0);
	});

	it("refuses a redirect to a private name, and one to a public name that resolves to a private address, without connecting to either", async () => {
		route = redirect("https://internal.fetch-test.example/r.json");
		await expectRefused("https://recipes.fetch-test.example/r.json", "host");
		assert.equal(seen.length, 1, "only the first request was sent");
		seen = [];
		route = redirect("https://localhost/r.json");
		await expectRefused("https://recipes.fetch-test.example/r.json", "host");
		assert.equal(seen.length, 1);
		seen = [];
		route = redirect("https://192.168.0.1/r.json");
		await expectRefused("https://recipes.fetch-test.example/r.json", "host");
		assert.equal(seen.length, 1);
	});

	it("refuses a redirect that lands on a private host after a public hop", async () => {
		route = (request, response) => (request.url === "/a" ? redirect("https://other.fetch-test.example/b")(request, response) : redirect("https://internal.fetch-test.example/c")(request, response));
		await expectRefused("https://recipes.fetch-test.example/a", "host");
		assert.equal(seen.length, 2);
	});

	it("takes a redirect to another public host", async () => {
		route = (request, response) => (request.url === "/a" ? redirect("https://other.fetch-test.example/b")(request, response) : response.writeHead(200).end("arrived"));
		const got = await fetchPublicText("https://recipes.fetch-test.example/a", deps());
		assert.equal(got.text, "arrived");
		assert.equal(got.finalUrl, "https://other.fetch-test.example/b");
	});

	it("dials the address it checked, not the name again", async () => {
		const dialled: Array<[string, number]> = [];
		route = (_request, response) => response.writeHead(200).end("ok");
		await fetchPublicText("https://recipes.fetch-test.example/r.json", deps({ dial: (address, p) => (dialled.push([address, p]), { host: "127.0.0.1", port }) }));
		assert.deepEqual(dialled, [["93.184.216.34", 443]]);
	});

	it("is not moved by a second answer from the resolver: one lookup per hop", async () => {
		await fetchPublicText("https://recipes.fetch-test.example/r.json", deps());
		assert.deepEqual(lookups, ["recipes.fetch-test.example"]);
	});
});

describe("other refusals", () => {
	it("refuses a status other than 200, and a redirect with no Location", async () => {
		route = (_request, response) => response.writeHead(404).end("nope");
		const error = await expectRefused("https://recipes.fetch-test.example/r.json", "status");
		assert.equal(error.status, 404);
		route = (_request, response) => response.writeHead(302).end();
		await expectRefused("https://recipes.fetch-test.example/r.json", "status");
	});

	it("reports a name that does not resolve, a refused connection, and an untrusted certificate as network", async () => {
		await expectRefused("https://unknown.fetch-test.example/r.json", "network");
		await expectRefused("https://nothing.fetch-test.example/r.json", "network");
		await expectRefused("https://recipes.fetch-test.example/r.json", "network", { dial: () => ({ host: "127.0.0.1", port: 9 }) });
		await expectRefused("https://recipes.fetch-test.example/r.json", "network", { ca: undefined });
	});

	it("gives up on a server that never answers", async () => {
		route = () => undefined;
		await expectRefused("https://recipes.fetch-test.example/r.json", "network", { timeoutMs: 300 });
	});
});

describe("isPublicAddress", () => {
	const yes = ["8.8.8.8", "93.184.216.34", "1.1.1.1", "172.15.255.255", "172.32.0.0", "100.63.255.255", "100.128.0.1", "198.17.0.1", "198.20.0.1", "2606:4700:4700::1111", "2a00:1450:4001::200e", "2001:4860:4860::8888", "::ffff:8.8.8.8", "2002:0808:0808::1", "64:ff9b::808:808"];
	const no = [
		"0.0.0.0", "10.0.0.1", "127.0.0.1", "127.255.255.254", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.0.1", "100.64.0.1", "100.127.255.255", "192.0.0.8", "192.0.2.1", "198.18.0.1", "198.19.255.255", "198.51.100.7",
		"203.0.113.9", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255", "::", "::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "fc00::1", "fd12:3456::1", "fe80::1", "fec0::1", "ff02::1", "2001:db8::1", "2001::1", "2001:10::1",
		"2002:7f00:0001::1", "2002:0a00:0001::", "64:ff9b::7f00:1", "64:ff9b::a00:1", "64:ff9b:1::1", "100::1", "not an address", "", "999.1.1.1", "8.8.8", "[::1]", "fe80::1%en0",
	];
	for (const address of yes) it(`${address} is public`, () => assert.equal(isPublicAddress(address), true));
	for (const address of no) it(`${JSON.stringify(address)} is not public`, () => assert.equal(isPublicAddress(address), false));
});
