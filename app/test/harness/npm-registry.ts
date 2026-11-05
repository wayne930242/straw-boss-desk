import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tarGz } from "./archives.ts";

// Test code: a local npm registry for one scoped or plain package at a time. It serves the packument and the tarball npm asks for, so the `pi` stage's
// `npm view` and `npm install -g` run for real (the real npm, under a node of the test) without the network. It binds 127.0.0.1 on port 0.

export interface PublishedPackage {
	name: string;
	version: string;
	/** `sha512-...` as npm writes `dist.integrity`. */
	integrity: string;
	tarball: Buffer;
}

/** `hang-tarball`: the packument answers, the tarball never does (an install that a time limit must cut off). */
export type RegistryMode = { kind: "ok" } | { kind: "status"; code: number } | { kind: "hang-tarball" };

export class NpmRegistryFixture {
	readonly #server: Server;
	readonly #packages = new Map<string, PublishedPackage[]>();
	readonly #requests: string[] = [];
	mode: RegistryMode = { kind: "ok" };
	port = 0;
	/** The host name the packuments put in tarball URLs; a test that sends npm through a proxy sets a name the proxy knows. */
	publicHost = "127.0.0.1";

	constructor() {
		this.#server = createServer((request, response) => {
			const url = decodeURIComponent((request.url ?? "").split("?")[0] ?? "");
			this.#requests.push(`${request.method} ${url}`);
			if (this.mode.kind === "status") {
				response.writeHead(this.mode.code).end();
				return;
			}
			const tarball = /^\/tarballs\/(.+)$/.exec(url);
			if (tarball !== null && this.mode.kind === "hang-tarball") return;
			if (tarball !== null) {
				const file = tarball[1] as string;
				for (const list of this.#packages.values()) {
					const found = list.find((p) => fileOf(p) === file);
					if (found !== undefined) {
						response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(found.tarball.length) }).end(found.tarball);
						return;
					}
				}
				response.writeHead(404).end();
				return;
			}
			const name = url.replace(/^\//, "");
			const list = this.#packages.get(name);
			if (list === undefined) {
				response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
				return;
			}
			const versions = Object.fromEntries(
				list.map((p) => [
					p.version,
					{ name: p.name, version: p.version, bin: { pi: "dist/cli.js" }, dist: { tarball: `http://${this.publicHost}:${this.port}/tarballs/${fileOf(p)}`, integrity: p.integrity, shasum: createHash("sha1").update(p.tarball).digest("hex") } },
				]),
			);
			response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name, "dist-tags": { latest: list.at(-1)?.version }, versions }));
		});
	}

	async listen(): Promise<this> {
		await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
		this.port = (this.#server.address() as AddressInfo).port;
		return this;
	}

	get url(): string {
		return `http://127.0.0.1:${this.port}/`;
	}

	get requests(): readonly string[] {
		return this.#requests;
	}

	/**
	 * Publishes `name@version` as a package whose bin `pi` (a script with a node shebang) prints `printed` for `--version`. `printed` defaults to the version.
	 */
	publish(name: string, version: string, printed: string = version): PublishedPackage {
		const cli = `#!/usr/bin/env node\nconsole.log(${JSON.stringify(printed)});\n`;
		const manifest = JSON.stringify({ name, version, bin: { pi: "dist/cli.js" } });
		const tarball = tarGz([
			{ name: "package/package.json", data: manifest },
			{ name: "package/dist/cli.js", data: cli, mode: 0o755 },
		]);
		const published: PublishedPackage = { name, version, integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`, tarball };
		this.#packages.set(name, [...(this.#packages.get(name) ?? []), published]);
		return published;
	}

	async close(): Promise<void> {
		this.#server.closeAllConnections();
		await new Promise<void>((resolve) => this.#server.close(() => resolve()));
	}
}

const fileOf = (p: PublishedPackage): string => `${p.name.replace(/^@/, "").replace("/", "-")}-${p.version}.tgz`;
