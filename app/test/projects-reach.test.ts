import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Fetch } from "../src/main/bootstrap/download.ts";
import { hostProbe } from "../src/main/projects/reach.ts";

// R12-F004: the host probe of the projects step judges a host the way the preflight does (`reachHost`): a name that does not resolve and a host that never answers are `unreachable`, a certificate this
// computer does not trust is `tls`, and any HTTP answer is `ok`. Fakes stand in for Electron's `net.fetch`; no network is used.

const signal = new AbortController().signal;
const refuse = (code: string, message: string): Fetch => async () => {
	throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(message), { code }) });
};

describe("the projects step's host probe", () => {
	it("calls a name that does not resolve unreachable (the tailnet-only host seen off the tailnet)", async () => {
		const asked: string[] = [];
		const fetch: Fetch = async (url, init) => {
			asked.push(`${init?.method ?? "GET"} ${url}`);
			return refuse("ENOTFOUND", "getaddrinfo ENOTFOUND gitlab.moldplan.app")(url, init);
		};
		assert.equal(await hostProbe(fetch, 1000)("gitlab.moldplan.app", signal), "unreachable");
		assert.deepEqual(asked, ["HEAD https://gitlab.moldplan.app/"]);
	});

	it("calls a host that never answers unreachable, within the limit", async () => {
		const blackhole: Fetch = (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
		const started = Date.now();
		assert.equal(await hostProbe(blackhole, 150)("10.255.255.1.example", signal), "unreachable");
		assert.ok(Date.now() - started < 3000);
	});

	it("passes a host that answers, whatever its status, and leaves a certificate problem to Git", async () => {
		const answers = (status: number): Fetch => async () => new Response(null, { status });
		assert.equal(await hostProbe(answers(200), 1000)("github.com", signal), "ok");
		assert.equal(await hostProbe(answers(403), 1000)("github.com", signal), "ok");
		assert.equal(await hostProbe(refuse("UNABLE_TO_VERIFY_LEAF_SIGNATURE", "unable to verify the first certificate"), 1000)("git.example.com", signal), "tls");
	});
});
