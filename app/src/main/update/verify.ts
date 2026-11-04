import { createPublicKey, verify } from "node:crypto";

// What both update channels share (spec: Updater, The key): the one Ed25519 check against the built-in key list, and the version comparison `minShell` needs. The shell's installers and
// dmgs, and `stack.json`, are signed with the same key as a detached signature over the exact bytes of the file (`<file>.sig`, the signature in base64 text).

/** The most keys the list may hold: the current one and, during a rotation, the next (spec: Updater, The key). A longer list is refused whole, never trimmed. */
export const MAX_KEYS = 2;

/**
 * The built-in public keys of a release build, each the base64 of an Ed25519 key's SPKI DER. It is empty until the boss's release key exists (spec: Open for the boss, item 5: the
 * key is generated for the protected `release` environment and approved by the boss); with no key nothing verifies, so a release build applies no update and offers no installer
 * (fail closed). A development build may take a list from `SBD_UPDATE_KEYS` instead (`updateConfig`), which is how the tests sign with keys made during the run.
 */
export const RELEASE_KEYS: readonly string[] = [];

export type SignatureFailure =
	/** The list is empty: nothing can verify. */
	| "no-keys"
	/** More keys than `MAX_KEYS`, or one that is not an Ed25519 SPKI key. */
	| "bad-key-list"
	/** The signature text is not 64 bytes of base64. */
	| "malformed-signature"
	/** No key of the list verifies the bytes. */
	| "bad-signature";

export type SignatureVerdict = { ok: true; keyIndex: number } | { ok: false; reason: SignatureFailure };

const SIGNATURE_BYTES = 64;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The raw signature bytes of a `.sig` file's text, or null when it is not exactly one Ed25519 signature in base64 (surrounding white space is ignored). */
export function decodeSignature(text: string | Uint8Array): Buffer | null {
	const raw = (typeof text === "string" ? text : Buffer.from(text).toString("utf8")).trim();
	if (raw === "" || !BASE64.test(raw)) return null;
	const bytes = Buffer.from(raw, "base64");
	return bytes.length === SIGNATURE_BYTES ? bytes : null;
}

/**
 * Checks `signature` over `bytes` against the list. Every key is tried, so a rotation window accepts a file signed by either; a list that is empty, too long or holds one bad entry
 * refuses everything. The verdict names the failure, never the bytes.
 */
export function verifyDetached(bytes: Uint8Array, signature: string | Uint8Array, keys: readonly string[]): SignatureVerdict {
	if (keys.length === 0) return { ok: false, reason: "no-keys" };
	if (keys.length > MAX_KEYS) return { ok: false, reason: "bad-key-list" };
	const parsed: ReturnType<typeof createPublicKey>[] = [];
	for (const key of keys) {
		try {
			const object = createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" });
			if (object.asymmetricKeyType !== "ed25519") return { ok: false, reason: "bad-key-list" };
			parsed.push(object);
		} catch {
			return { ok: false, reason: "bad-key-list" };
		}
	}
	const sig = decodeSignature(signature);
	if (sig === null) return { ok: false, reason: "malformed-signature" };
	for (const [keyIndex, key] of parsed.entries()) {
		if (verify(null, bytes, key, sig)) return { ok: true, keyIndex };
	}
	return { ok: false, reason: "bad-signature" };
}

// ---- versions ----------------------------------------------------------------------------------------------------------

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export const isVersion = (text: unknown): text is string => typeof text === "string" && VERSION.test(text);

/** Negative, zero or positive as `a` is lower than, equal to or higher than `b` (semantic versions; a pre-release is lower than its release). Throws on text that is not a version. */
export function compareVersions(a: string, b: string): number {
	const x = VERSION.exec(a);
	const y = VERSION.exec(b);
	if (x === null) throw new Error(`${JSON.stringify(a.slice(0, 40))} is not a version`);
	if (y === null) throw new Error(`${JSON.stringify(b.slice(0, 40))} is not a version`);
	for (let i = 1; i <= 3; i++) {
		const d = Number(x[i]) - Number(y[i]);
		if (d !== 0) return d;
	}
	const pa = x[4];
	const pb = y[4];
	if (pa === undefined && pb === undefined) return 0;
	if (pa === undefined) return 1;
	if (pb === undefined) return -1;
	const ia = pa.split(".");
	const ib = pb.split(".");
	for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
		const l = ia[i];
		const r = ib[i];
		if (l === undefined) return -1;
		if (r === undefined) return 1;
		const ln = /^\d+$/.test(l);
		const rn = /^\d+$/.test(r);
		if (ln && rn) {
			const d = Number(l) - Number(r);
			if (d !== 0) return d;
		} else if (ln !== rn) return ln ? -1 : 1;
		else if (l !== r) return l < r ? -1 : 1;
	}
	return 0;
}

// ---- configuration -----------------------------------------------------------------------------------------------------

/** Where the update assets are: a generic feed (the tests' local server; a development build's `SBD_UPDATE_FEED`) or a GitHub repository's releases. */
export type UpdateFeed = { kind: "generic"; url: string } | { kind: "github"; owner: string; repo: string };

export interface UpdateConfig {
	keys: readonly string[];
	/** The shell channel's feed; null when none is configured (a development build without `SBD_UPDATE_FEED` checks nothing). A release build reads its own from the package (`app-update.yml`), so it carries `github` here too. */
	shell: UpdateFeed | null;
	/** Where `stack.json` and `stack.json.sig` are, a folder URL ending in `/`; null when none. */
	stackBase: string | null;
}

/** The rolling release that phase 4 publishes `stack.json` to (spec: Updater, `stack.json`). Nothing exists there yet, so a release build's check finds nothing until phase 4. */
export const RELEASE_FEED: UpdateFeed = { kind: "github", owner: "wayne930242", repo: "straw-boss-desk" };
export const RELEASE_STACK_BASE = "https://github.com/wayne930242/straw-boss-desk/releases/download/stack/";

const isLoopback = (host: string): boolean => host === "127.0.0.1" || host === "localhost" || host === "[::1]";

/** Why `url` may not be a feed address, or null. The feed is HTTPS; plain HTTP is allowed only on a loopback name, for the fixture server of a test. */
export function feedUrlProblem(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return "is not a URL";
	}
	if (parsed.username !== "" || parsed.password !== "") return "must carry no user name or password";
	if (parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopback(parsed.hostname))) return null;
	return "must be https";
}

/** The folder URL of a feed: the address with a trailing slash, so file names resolve under it. */
export const folderUrl = (url: string): string => (url.endsWith("/") ? url : `${url}/`);

/**
 * The build's update settings. A release build uses the built-in keys and the release feeds and reads nothing from its environment. A development build reads `SBD_UPDATE_KEYS` (a JSON list
 * of base64 SPKI keys) and `SBD_UPDATE_FEED` (one folder URL serving the shell's `latest*.yml` and installers and the stack's `stack.json`), and fails closed on a value it cannot use: the
 * keys fall back to the (empty) built-in list and the feed to none.
 */
export function updateConfig(kind: "dev" | "release", env: Readonly<Record<string, string | undefined>>): UpdateConfig {
	if (kind === "release") return { keys: RELEASE_KEYS, shell: RELEASE_FEED, stackBase: RELEASE_STACK_BASE };
	let keys: readonly string[] = RELEASE_KEYS;
	const rawKeys = env.SBD_UPDATE_KEYS;
	if (rawKeys !== undefined && rawKeys !== "") {
		try {
			const list: unknown = JSON.parse(rawKeys);
			if (Array.isArray(list) && list.every((k) => typeof k === "string")) keys = list as string[];
		} catch {
			// an unusable list leaves the built-in one
		}
	}
	const feed = env.SBD_UPDATE_FEED;
	if (feed === undefined || feed === "" || feedUrlProblem(feed) !== null) return { keys, shell: null, stackBase: null };
	return { keys, shell: { kind: "generic", url: folderUrl(feed) }, stackBase: folderUrl(feed) };
}

/** The address of a file of the shell channel's release `version`: under the generic feed, or a GitHub release asset. */
export function assetUrl(feed: UpdateFeed, version: string, name: string): string {
	if (feed.kind === "generic") return new URL(name, folderUrl(feed.url)).href;
	return `https://github.com/${feed.owner}/${feed.repo}/releases/download/v${version}/${encodeURIComponent(name)}`;
}
