import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Test code: a local HTTP server for pinned downloads. It binds 127.0.0.1 on port 0 and is closed by the test's `after` hook.

export type RouteMode =
	| { kind: "ok" }
	/** Sends the status line and half the body, then holds the socket open until the server closes. After `times` requests the route answers normally. */
	| { kind: "hang"; times?: number }
	/** Takes the request and sends nothing, not even the status line, until the server closes. After `times` requests the route answers normally. */
	| { kind: "silent"; times?: number }
	/** Sends the body in `chunks` pieces, `gapMs` apart: a slow link that never goes quiet for long. */
	| { kind: "trickle"; chunks: number; gapMs: number }
	| { kind: "status"; code: number; times?: number }
	/** Destroys the socket after the headers, `times` times (default always). */
	| { kind: "drop"; times?: number };

interface Route {
	body: Buffer;
	mode: RouteMode;
	hits: number;
}

export class FixtureServer {
	readonly #server: Server;
	readonly #routes = new Map<string, Route>();
	readonly #listeners = new Map<string, ((request: IncomingMessage) => void)[]>();
	readonly #sockets = new Set<ServerResponse>();
	port = 0;

	constructor() {
		this.#server = createServer((request, response) => this.#handle(request, response));
	}

	async listen(): Promise<this> {
		await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
		this.port = (this.#server.address() as AddressInfo).port;
		return this;
	}

	url(path: string): string {
		return `http://127.0.0.1:${this.port}${path}`;
	}

	serve(path: string, body: Buffer, mode: RouteMode = { kind: "ok" }): string {
		this.#routes.set(path, { body, mode, hits: 0 });
		return this.url(path);
	}

	setMode(path: string, mode: RouteMode): void {
		const route = this.#routes.get(path);
		if (route === undefined) throw new Error(`no route ${path}`);
		route.mode = mode;
	}

	hits(path: string): number {
		return this.#routes.get(path)?.hits ?? 0;
	}

	/** Resolves when `path` is next requested. */
	requested(path: string): Promise<void> {
		return new Promise((resolve) => {
			const list = this.#listeners.get(path) ?? [];
			list.push(() => resolve());
			this.#listeners.set(path, list);
		});
	}

	#handle(request: IncomingMessage, response: ServerResponse): void {
		const path = (request.url ?? "").split("?")[0] ?? "";
		const route = this.#routes.get(path);
		if (route === undefined) {
			response.writeHead(404).end();
			return;
		}
		route.hits++;
		for (const listener of this.#listeners.get(path) ?? []) listener(request);
		this.#listeners.delete(path);
		const mode = route.mode;
		if (mode.kind === "status" && (mode.times === undefined || mode.times > 0)) {
			if (mode.times !== undefined) route.mode = { ...mode, times: mode.times - 1 };
			response.writeHead(mode.code).end();
			return;
		}
		if (mode.kind === "drop" && (mode.times === undefined || mode.times > 0)) {
			if (mode.times !== undefined) route.mode = { ...mode, times: mode.times - 1 };
			response.writeHead(200, { "content-length": String(route.body.length) });
			response.flushHeaders();
			response.socket?.destroy();
			return;
		}
		if (mode.kind === "silent" && (mode.times === undefined || mode.times > 0)) {
			if (mode.times !== undefined) route.mode = { ...mode, times: mode.times - 1 };
			this.#sockets.add(response);
			return;
		}
		if (mode.kind === "hang" && (mode.times === undefined || mode.times > 0)) {
			if (mode.times !== undefined) route.mode = { ...mode, times: mode.times - 1 };
			this.#sockets.add(response);
			response.writeHead(200, { "content-length": String(route.body.length) });
			response.write(route.body.subarray(0, Math.floor(route.body.length / 2)));
			return;
		}
		if (mode.kind === "trickle") {
			this.#sockets.add(response);
			response.writeHead(200, { "content-length": String(route.body.length) });
			const size = Math.ceil(route.body.length / mode.chunks);
			let sent = 0;
			const timer = setInterval(() => {
				if (response.destroyed) return clearInterval(timer);
				response.write(route.body.subarray(sent, sent + size));
				sent += size;
				if (sent >= route.body.length) {
					clearInterval(timer);
					response.end();
				}
			}, mode.gapMs);
			return;
		}
		response.writeHead(200, { "content-length": String(route.body.length) }).end(route.body);
	}

	async close(): Promise<void> {
		for (const response of this.#sockets) response.socket?.destroy();
		this.#server.closeAllConnections();
		await new Promise<void>((resolve) => this.#server.close(() => resolve()));
	}
}
