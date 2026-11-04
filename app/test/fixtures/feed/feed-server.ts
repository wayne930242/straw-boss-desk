// A local update feed for the updater tests (task 13), test code only: one folder URL on the loopback interface that serves what the app asks for (`latest.yml` or `latest-mac.yml`, the installer
// or dmg with its signed manifest, `stack.json`, and the `.sig` next to it). Files are held in memory and replaced between cases, so one server serves a whole run. Nothing here is a release key: the tests make
// their own Ed25519 pair with `makeTestKey()` and never write it anywhere.
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { manifestText, sha512Of } from "../../../src/main/update/verify.ts";

export interface TestKey {
	privateKey: KeyObject;
	/** The base64 SPKI DER form the app's key list holds. */
	publicKey: string;
}

export function makeTestKey(): TestKey {
	const pair = generateKeyPairSync("ed25519");
	return { privateKey: pair.privateKey, publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64") };
}

/** A detached signature as `sign-stack.mjs` writes it: the 64 bytes as base64 text and a newline. */
export const signature = (bytes: Uint8Array, key: KeyObject): Buffer => Buffer.from(`${cryptoSign(null, bytes, key).toString("base64")}\n`);

export class FeedServer {
	readonly #files: Map<string, Buffer>;
	readonly #server: Server;
	/** Every path asked for, in order. */
	readonly requests: string[];
	url = "";

	private constructor(server: Server, files: Map<string, Buffer>, requests: string[]) {
		this.#server = server;
		this.#files = files;
		this.requests = requests;
	}

	static async start(): Promise<FeedServer> {
		const files = new Map<string, Buffer>();
		const requests: string[] = [];
		const server = createServer((req, res) => {
			const path = decodeURIComponent((req.url ?? "/").split("?")[0] as string).replace(/^\//, "");
			requests.push(path);
			const body = files.get(path);
			if (body === undefined) {
				res.writeHead(404).end();
				return;
			}
			res.writeHead(200, { "content-length": body.length, "content-type": "application/octet-stream" }).end(req.method === "HEAD" ? undefined : body);
		});
		const feed = new FeedServer(server, files, requests);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		feed.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
		return feed;
	}

	put(name: string, body: Uint8Array | string): void {
		this.#files.set(name, Buffer.from(body));
	}

	/** Puts `name` and its detached signature (`name.sig`) made with `key`. */
	putSigned(name: string, body: Uint8Array | string, key: KeyObject): void {
		const bytes = Buffer.from(body);
		this.#files.set(name, bytes);
		this.#files.set(`${name}.sig`, signature(bytes, key));
	}

	/**
	 * Puts an installer or a dmg `name` and its signed manifest, the files `sign-stack.mjs --shell-version` writes: `name.manifest` (kind, `version`, `name`, SHA512 of `signed`) and
	 * `name.manifest.sig`. `signed` is the file the manifest describes; it differs from `body` for a case that serves a file other than the one that was signed.
	 */
	putShellSigned(name: string, body: Uint8Array | string, version: string, key: KeyObject, signed: Uint8Array | string = body): void {
		this.#files.set(name, Buffer.from(body));
		const manifest = Buffer.from(manifestText({ kind: "shell", version, file: name, sha512: sha512Of(Buffer.from(signed)) }));
		this.#files.set(`${name}.manifest`, manifest);
		this.#files.set(`${name}.manifest.sig`, signature(manifest, key));
	}

	remove(name: string): void {
		this.#files.delete(name);
	}

	clear(): void {
		this.#files.clear();
		this.requests.length = 0;
	}

	async close(): Promise<void> {
		await new Promise<void>((resolve) => this.#server.close(() => resolve()));
	}
}

/** The `latest.yml` (Windows) or `latest-mac.yml` electron-updater reads for one installer or dmg. `sha512` is the base64 of the file's SHA512, as electron-builder writes it. */
export function latestYml(options: { version: string; file: string; bytes: Uint8Array; releaseDate?: string }): string {
	const sha512 = createHash("sha512").update(options.bytes).digest("base64");
	return [
		`version: ${options.version}`,
		"files:",
		`  - url: ${options.file}`,
		`    sha512: ${sha512}`,
		`    size: ${options.bytes.length}`,
		`path: ${options.file}`,
		`sha512: ${sha512}`,
		`releaseDate: '${options.releaseDate ?? "2026-11-04T00:00:00.000Z"}'`,
		"",
	].join("\n");
}
