import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { StageError } from "./errors.ts";
import { renameRetry, sha256File } from "./fsutil.ts";
import { downloadUrlProblem, type Asset } from "./stack.ts";

// Pinned downloads (spec: Decisions, Downloads; Bootstrap engine). Every external download is pinned by version and verified by SHA256 before it
// is used: the bytes go to a `.part` file, are hashed as they arrive, and only a match is renamed to `tools/downloads/<file>`, the cache that repair
// and rollback read. A mismatch deletes the part, activates nothing, and is never retried.

/** The part of `fetch` the engine uses. In the engine process it is Electron's `net.fetch` (OS proxy and certificate store); tests pass a plain `fetch`. */
export type Fetch = (url: string, init?: { signal?: AbortSignal; method?: string }) => Promise<Response>;

/** Electron's `net.fetch`, loaded when first used so Node-only tests never import `electron`. */
export function netFetch(): Fetch {
	return async (url, init) => {
		const { net } = await import("electron");
		// SAFETY: Electron types `net.fetch` with the DOM `Response`; at run time it is the same fetch Response Node's types describe.
		return (await net.fetch(url, init)) as unknown as Response;
	};
}

/** A download that receives no bytes for this long (no response headers, or no next chunk of the body) is a network failure. */
export const DEFAULT_IDLE_MS = 60_000;

export interface DownloadRequest {
	fetch: Fetch;
	asset: Pick<Asset, "url" | "sha256" | "file">;
	/** The tool's name for the integrity sentence. */
	tool: string;
	/** `tools/downloads`. */
	dir: string;
	signal?: AbortSignal;
	/** Idle limit in milliseconds (default 60 s); tests shorten it. */
	idleTimeoutMs?: number;
	log?: (event: { event: string; [key: string]: string | number | boolean }) => void;
}

export interface Downloaded {
	/** `<dir>/<file>`, hashed and equal to the pin. */
	path: string;
	/** True when the cache already held a file with the pinned hash and nothing was fetched. */
	cached: boolean;
	bytes: number;
}

const hostOf = (url: string): string => {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
};

const idleText = (ms: number): string => (ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`);

const NETWORK_STATUS = (status: number): boolean => status >= 500 || status === 408 || status === 429;

/** Fetches `asset` into the cache and returns its path. Throws `StageError`: network, integrity, disk, locked, or other. */
export async function downloadVerified(request: DownloadRequest): Promise<Downloaded> {
	const { fetch, asset, tool, dir, signal } = request;
	const log = request.log ?? (() => {});
	const host = hostOf(asset.url);
	// Only a pinned HTTPS URL (or a test's loopback one) is fetched, whatever called this.
	const problem = downloadUrlProblem(asset.url);
	if (problem !== null) throw new StageError("other", { stage: tool }, `the pinned URL of ${asset.file} ${problem}`);
	mkdirSync(dir, { recursive: true });
	const target = join(dir, asset.file);

	let cachedHash: string | null = null;
	try {
		cachedHash = await sha256File(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (cachedHash === asset.sha256) {
		log({ event: "download-cached", file: asset.file, sha256: asset.sha256 });
		return { path: target, cached: true, bytes: 0 };
	}
	if (cachedHash !== null) {
		log({ event: "download-cache-mismatch", file: asset.file, expected: asset.sha256, got: cachedHash });
		rmSync(target, { force: true });
	}

	const part = join(dir, `${asset.file}.${randomBytes(4).toString("hex")}.part`);
	log({ event: "download-begin", file: asset.file, host });

	// One timer per download, re-armed before each wait for the network. When it fires it aborts the request and rejects `stalled`, which every wait
	// races against, so a connection that is held open without a byte (a half-open socket, a proxy that died, a captive portal) cannot freeze the stage.
	const idleMs = request.idleTimeoutMs ?? DEFAULT_IDLE_MS;
	const idle = new AbortController();
	let timer: NodeJS.Timeout | undefined;
	let timedOut = false;
	let expire: (error: Error) => void = () => {};
	const stalled = new Promise<never>((_, reject) => {
		expire = reject;
	});
	stalled.catch(() => {});
	const arm = (): void => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			timedOut = true;
			idle.abort();
			expire(new Error(`no data for ${idleText(idleMs)}`));
		}, idleMs);
	};
	const disarm = (): void => clearTimeout(timer);

	try {
		let response: Response;
		arm();
		try {
			response = await Promise.race([fetch(asset.url, { signal: signal ? AbortSignal.any([signal, idle.signal]) : idle.signal }), stalled]);
		} catch (error) {
			if (signal?.aborted) throw error;
			const why = timedOut ? `${host} sent no response for ${idleText(idleMs)} while fetching ${asset.file}` : `could not fetch ${asset.file} from ${host}: ${(error as Error).message}`;
			throw new StageError("network", { host }, why, { cause: error });
		} finally {
			disarm();
		}
		if (!response.ok || response.body === null) {
			await response.body?.cancel().catch(() => {});
			if (NETWORK_STATUS(response.status)) throw new StageError("network", { host }, `${host} answered HTTP ${response.status} for ${asset.file}`);
			throw new StageError("other", { stage: tool }, `${host} answered HTTP ${response.status} for ${asset.file}; the pinned download is gone or moved`);
		}

		const hash = createHash("sha256");
		let bytes = 0;
		const file = await open(part, "w");
		try {
			const reader = response.body.getReader();
			for (;;) {
				let step: Awaited<ReturnType<typeof reader.read>>;
				arm();
				try {
					step = await Promise.race([reader.read(), stalled]);
				} catch (error) {
					void reader.cancel().catch(() => {});
					if (signal?.aborted) throw error;
					const why = timedOut
						? `the download of ${asset.file} from ${host} stalled: no data for ${idleText(idleMs)} after ${bytes} bytes`
						: `the download of ${asset.file} from ${host} broke off after ${bytes} bytes: ${(error as Error).message}`;
					throw new StageError("network", { host }, why, { cause: error });
				} finally {
					disarm();
				}
				if (step.done) break;
				hash.update(step.value);
				bytes += step.value.byteLength;
				await file.write(step.value);
			}
		} catch (error) {
			await file.close().catch(() => {});
			rmSync(part, { force: true });
			throw error;
		}
		await file.close();

		const got = hash.digest("hex");
		if (got !== asset.sha256) {
			rmSync(part, { force: true });
			log({ event: "download-integrity-mismatch", file: asset.file, expected: asset.sha256, got });
			throw new StageError("integrity", { tool }, `${asset.file} from ${host}: SHA256 is ${got}, the pin says ${asset.sha256}`);
		}
		try {
			renameRetry(part, target);
		} catch (error) {
			rmSync(part, { force: true });
			throw error;
		}
		log({ event: "download-done", file: asset.file, sha256: got, bytes });
		return { path: target, cached: false, bytes };
	} finally {
		disarm();
		// Ends the request in every case: after success the body is already read, so this changes nothing; after a failure it frees the socket.
		idle.abort();
	}
}
