import { lookup } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { isPublicAddress } from "./public-address.ts";

// The one fetch the app makes for an address a colleague wrote and the PM did not pick by hand: a recipe's `updateUrl` (spec: team-profile section 5, Delivery and updates). It is an SSRF
// guard first, so every rule is a refusal with a reason the page can word, and every rule is checked before a byte of a body is read:
//   - https only, at the first address and at every redirect;
//   - no credentials: the address carries no user name or password, the request carries no cookie and no authorization header, and a `Set-Cookie` is dropped, never stored or sent back;
//   - at most 3 redirects;
//   - at most 256 KB of body, counted as it arrives (a `Content-Length` over it is refused before the body starts);
//   - the host is public: its name passes the recipe validator's lexical rule, and every address it resolves to is public (`isPublicAddress`), at the first address and at every redirect. The
//     connection goes to the address that was checked, not to the name, so the answer cannot change between the check and the connect (DNS rebinding).
// The fetch does not use the OS proxy: through a proxy the address that is dialled is the proxy's, and the check above would say nothing about where the request goes.

export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 20_000;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export type FetchRefusalReason =
	/** The address, or a redirect's target, is not https. */
	| "scheme"
	/** The address, or a redirect's target, carries a user name or password. */
	| "credentials"
	/** The host is local or private by its name, or a name resolves to an address that is not public. */
	| "host"
	/** More than 3 redirects. */
	| "redirects"
	/** The body is over 256 KB. */
	| "too-large"
	/** The final answer is not 200, or a redirect has no usable `Location`, or the body is encoded. */
	| "status"
	/** The host did not resolve, the connection failed, the certificate is not trusted, or the answer did not end in time. */
	| "network";

export class FetchRefused extends Error {
	readonly reason: FetchRefusalReason;
	/** The address the refusal is about (the first one, or the redirect's target), without user info, query or fragment: safe to show. */
	readonly url: string;
	/** The HTTP status, for `status`. */
	readonly status: number | undefined;
	/** The raw cause, for the log; never shown as a sentence. */
	readonly detail: string | undefined;

	constructor(reason: FetchRefusalReason, url: string, status?: number, detail?: string) {
		super(`fetch refused (${reason})${status === undefined ? "" : ` status ${status}`}`);
		this.name = "FetchRefused";
		this.reason = reason;
		this.url = url;
		this.status = status;
		this.detail = detail;
	}
}

/** Where a request to `address:port` really goes. Production dials the address; a test sends it to a local server. */
export type Dial = (address: string, port: number) => { host: string; port: number };

export interface FetchDeps {
	/** Every address `host` resolves to. Default: the system resolver (`dns.lookup`, all addresses, in the order the system gives them). */
	resolve?: (host: string) => Promise<string[]>;
	/** The recipe validator's lexical test for a host name (`privateOrLocalHost`). Required: main loads the validator from the app's assets and hands the function in. */
	privateOrLocalHost: (hostname: string) => boolean;
	/** A test points a checked address at a local server; production dials the address itself. */
	dial?: Dial;
	/** Extra certificate authorities (PEM) for a test server's certificate. Production uses the system's. */
	ca?: string;
	timeoutMs?: number;
}

export interface Fetched {
	text: string;
	/** The address that answered, without user info (there is none), query or fragment. */
	finalUrl: string;
	redirects: number;
}

const plainUrl = (url: URL): string => `${url.protocol}//${url.host}${url.pathname}`;

const systemResolve = async (host: string): Promise<string[]> => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** The checks that need no network: scheme, credentials and the host's name. Throws `FetchRefused`. */
function checkAddress(url: URL, deps: FetchDeps): void {
	if (url.protocol !== "https:") throw new FetchRefused("scheme", plainUrl(url));
	if (url.username !== "" || url.password !== "") throw new FetchRefused("credentials", plainUrl(url));
	if (url.hostname === "" || deps.privateOrLocalHost(url.hostname)) throw new FetchRefused("host", plainUrl(url));
}

/** The address to dial for `url`: every address the name resolves to must be public, and the first one is dialled. */
async function checkedAddress(url: URL, deps: FetchDeps): Promise<string> {
	const host = url.hostname;
	let addresses: string[];
	try {
		// An address typed as the host is its own answer; a name is asked.
		addresses = isIP(host) !== 0 ? [host] : await (deps.resolve ?? systemResolve)(host);
	} catch (error) {
		throw new FetchRefused("network", plainUrl(url), undefined, `could not resolve ${host}: ${(error as Error).message}`);
	}
	if (addresses.length === 0) throw new FetchRefused("network", plainUrl(url), undefined, `${host} has no address`);
	// A name with one public and one private address is refused as a whole: which one the connection used must not matter.
	if (!addresses.every(isPublicAddress)) throw new FetchRefused("host", plainUrl(url));
	return addresses[0] as string;
}

interface Hop {
	status: number;
	location: string | null;
	text: string;
}

function oneRequest(url: URL, address: string, deps: FetchDeps): Promise<Hop> {
	return new Promise((resolve, reject) => {
		const port = url.port === "" ? 443 : Number(url.port);
		const target = deps.dial === undefined ? { host: address, port } : deps.dial(address, port);
		const options: RequestOptions = {
			host: target.host,
			port: target.port,
			method: "GET",
			path: `${url.pathname}${url.search}`,
			// The name still decides the certificate (SNI and identity check) and the `Host` header; only the connection goes to the checked address.
			servername: url.hostname,
			headers: { host: url.host, accept: "application/json, text/plain;q=0.5", "accept-encoding": "identity", "user-agent": "straw-boss-desk", connection: "close" },
			agent: false,
			...(deps.ca === undefined ? {} : { ca: deps.ca }),
		};
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (): boolean => {
			if (settled) return false;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			return true;
		};
		const fail = (error: unknown): void => {
			if (finish()) reject(error instanceof FetchRefused ? error : new FetchRefused("network", plainUrl(url), undefined, (error as Error).message));
		};
		const done = (hop: Hop): void => {
			if (finish()) resolve(hop);
		};
		const req = request(options, (res) => {
			const status = res.statusCode ?? 0;
			const location = typeof res.headers.location === "string" ? res.headers.location : null;
			if (REDIRECT_STATUS.has(status)) {
				// The body of a redirect is not read; the answer is the `Location`.
				res.destroy();
				done({ status, location, text: "" });
				return;
			}
			const encoding = res.headers["content-encoding"];
			if (status === 200 && encoding !== undefined && encoding !== "identity") {
				fail(new FetchRefused("status", plainUrl(url), status, `content-encoding ${String(encoding).slice(0, 40)}`));
				res.destroy();
				return;
			}
			const length = Number(res.headers["content-length"]);
			if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
				fail(new FetchRefused("too-large", plainUrl(url), status));
				res.destroy();
				return;
			}
			const chunks: Buffer[] = [];
			let size = 0;
			res.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_BODY_BYTES) {
					// Refused first: destroying the answer raises its own `aborted`, which must not be the reason given.
					fail(new FetchRefused("too-large", plainUrl(url), status));
					res.destroy();
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			res.on("end", () => done({ status, location: null, text: Buffer.concat(chunks).toString("utf8") }));
			res.on("error", fail);
			res.on("aborted", () => fail(new Error("the answer was cut off")));
		});
		// One limit for the whole hop, so a server that trickles bytes under 256 KB cannot hold the fetch.
		timer = setTimeout(() => {
			req.destroy();
			fail(new Error("no complete answer in time"));
		}, deps.timeoutMs ?? TIMEOUT_MS);
		timer.unref?.();
		req.on("error", fail);
		req.end();
	});
}

/** Fetches `address` as text under the rules above. Throws `FetchRefused`; any other error is a bug. */
export async function fetchPublicText(address: string, deps: FetchDeps): Promise<Fetched> {
	let url: URL;
	try {
		url = new URL(address);
	} catch {
		throw new FetchRefused("scheme", "(address)");
	}
	for (let hop = 0; ; hop++) {
		checkAddress(url, deps);
		const dial = await checkedAddress(url, deps);
		const answer = await oneRequest(url, dial, deps);
		if (REDIRECT_STATUS.has(answer.status)) {
			if (hop >= MAX_REDIRECTS) throw new FetchRefused("redirects", plainUrl(url), answer.status);
			if (answer.location === null || answer.location === "") throw new FetchRefused("status", plainUrl(url), answer.status, "a redirect with no Location");
			try {
				url = new URL(answer.location, url);
			} catch {
				throw new FetchRefused("status", plainUrl(url), answer.status, "a redirect to an address that is not one");
			}
			continue;
		}
		if (answer.status !== 200) throw new FetchRefused("status", plainUrl(url), answer.status);
		return { text: answer.text, finalUrl: plainUrl(url), redirects: hop };
	}
}
