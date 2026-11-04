import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AppUpdater } from "electron-updater";
import type { ShellRefusal, ShellUpdateState } from "../../shared/updates.ts";
import { firstLineOf } from "../runtime/failure.ts";
import type { RuntimeEvent } from "../runtime/log.ts";
import type { FetchedBytes } from "./stack.ts";
import { assetUrl, compareVersions, isVersion, verifyDetached, type SignatureFailure, type UpdateFeed } from "./verify.ts";

// The shell channel (spec: Updater, The shell, Windows and macOS). electron-updater finds the newer version and, on Windows, downloads the installer; the app then fetches `<installer>.sig`
// from the same feed and checks the downloaded file against the built-in key list. Only a verified file enables **Restart to update**, which runs the stop sequence and then
// `quitAndInstall(true, true)`. On macOS the newer version is only offered: the app downloads the dmg itself, checks its `.sig` the same way, and shows the verified file; it never opens
// one it has not verified. A file that fails the check is deleted and never offered.

/** The most an installer or dmg may be: the real ones are about 100 MB. Bigger is refused before it is read into memory for the signature. */
export const MAX_INSTALLER_BYTES = 600 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 4096;
/** The checks run at start and then every six hours. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** The first check waits, so the start of the stack is not slowed by it. */
export const FIRST_CHECK_AFTER_MS = 20 * 1000;

export interface FoundUpdate {
	version: string;
	/** The files `latest*.yml` lists; `url` is a name relative to the feed, or an address. */
	files: ReadonlyArray<{ url: string; sha512?: string; size?: number }>;
}

/** What the shell updater needs of electron-updater; the real one is `electronUpdaterDriver`, a test passes its own. */
export interface UpdaterDriver {
	/** The newer version the feed lists, or null when this app is current. Rejects when the feed cannot be read. */
	check(): Promise<FoundUpdate | null>;
	/** Windows: downloads the installer (electron-updater checks its SHA512 from `latest.yml`) and returns its path. */
	download(onProgress: (percent: number | null) => void): Promise<{ file: string }>;
	quitAndInstall(): void;
}

/**
 * Wraps electron-updater's `autoUpdater`: nothing downloads or installs unless the app asks, and no file is downloaded as a patch of the old installer (the whole file is what is signed).
 * `configDir` is a folder the app may write: a development build has no `app-update.yml` of its own, and electron-updater reads one from disk to name its download cache (a missing file
 * fails the download with ENOENT), so a generic feed gets a small one there.
 */
export function electronUpdaterDriver(updater: AppUpdater, feed: UpdateFeed | null, configDir?: string): UpdaterDriver {
	updater.autoDownload = false;
	updater.autoInstallOnAppQuit = false;
	updater.autoRunAppAfterInstall = true;
	updater.allowDowngrade = false;
	updater.allowPrerelease = false;
	updater.disableDifferentialDownload = true;
	updater.disableWebInstaller = true;
	// A generic feed is set here; a GitHub feed is what the package's `app-update.yml` says.
	if (feed !== null && feed.kind === "generic") {
		if (configDir !== undefined) {
			mkdirSync(configDir, { recursive: true });
			const file = join(configDir, "app-update.yml");
			writeFileSync(file, `provider: generic\nurl: ${JSON.stringify(feed.url)}\nupdaterCacheDirName: straw-boss-desk-updater\n`);
			updater.updateConfigPath = file;
		}
		updater.setFeedURL({ provider: "generic", url: feed.url });
	}
	return {
		async check() {
			const result = await updater.checkForUpdates();
			if (result === null || !result.isUpdateAvailable) return null;
			return { version: result.updateInfo.version, files: result.updateInfo.files.map((f) => ({ url: f.url, ...(f.sha512 ? { sha512: f.sha512 } : {}), ...(typeof f.size === "number" ? { size: f.size } : {}) })) };
		},
		async download(onProgress) {
			const listener = (info: { percent: number }): void => onProgress(Number.isFinite(info.percent) ? Math.round(info.percent) : null);
			updater.on("download-progress", listener);
			try {
				const files = await updater.downloadUpdate();
				const file = files[0];
				if (file === undefined) throw new Error("electron-updater downloaded no file");
				return { file };
			} finally {
				updater.off("download-progress", listener);
			}
		},
		quitAndInstall() {
			updater.quitAndInstall(true, true);
		},
	};
}

const REFUSAL_OF: Record<SignatureFailure, ShellRefusal> = { "no-keys": "no-keys", "bad-key-list": "bad-key-list", "malformed-signature": "malformed-signature", "bad-signature": "bad-signature" };

export interface ShellUpdaterDeps {
	platform: "win32" | "darwin";
	/** The running app's version. */
	version: string;
	feed: UpdateFeed | null;
	keys: readonly string[];
	/** Made when the first check needs it (electron-updater's updater exists only once the app is ready). */
	driver(): UpdaterDriver;
	/** One GET of a small file (the signature). Throws on a network failure; any HTTP status is a result. */
	fetchBytes(url: string, maxBytes: number): Promise<FetchedBytes>;
	/** macOS: downloads `url` into `file`, calling `onProgress` with a percent when the size is known. Throws on a network failure or a status other than 200. */
	downloadFile(url: string, file: string, onProgress: (percent: number | null) => void): Promise<void>;
	/** macOS: the folder the verified dmg goes to (the PM's Downloads folder). */
	downloadDir(): string;
	/** macOS: shows the file in its folder (never opens it). */
	reveal(file: string): void;
	/** Windows: the stop sequence that runs before the installer takes over. Resolves when the stack is stopped; whether it stopped everything is logged by the caller. */
	prepareQuit(): Promise<void>;
	log: RuntimeEvent;
	now?: () => Date;
}

const nameOf = (url: string): string => decodeURIComponent(basename(new URL(url, "http://feed.invalid/").pathname));

export class ShellUpdater {
	readonly #d: ShellUpdaterDeps;
	readonly #listeners = new Set<() => void>();
	#state: ShellUpdateState;
	#driver: UpdaterDriver | null = null;
	#busy = false;
	/** The newer version the last check found, kept for the macOS download. */
	#found: FoundUpdate | null = null;
	/** The signature and the path of the installer that is `ready`, kept for the check right before the install. */
	#signature: Buffer | null = null;
	#installer: string | null = null;
	/** Versions this run refused: the same version is not downloaded again before the app restarts. */
	readonly #refused = new Map<string, ShellRefusal>();

	constructor(deps: ShellUpdaterDeps) {
		this.#d = deps;
		this.#state = deps.feed === null ? { phase: "off" } : { phase: "idle", checkedAt: null };
	}

	get state(): ShellUpdateState {
		return this.#state;
	}

	get busy(): boolean {
		return this.#busy;
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#set(state: ShellUpdateState): void {
		this.#state = state;
		for (const l of this.#listeners) l();
	}

	#now(): string {
		return (this.#d.now ?? (() => new Date()))().toISOString();
	}

	#driverNow(): UpdaterDriver {
		this.#driver ??= this.#d.driver();
		return this.#driver;
	}

	// ---- checking --------------------------------------------------------------------------------------------------

	/** Asks the feed for a newer version. On Windows a newer version is downloaded and verified in the same call; on macOS it is only offered. */
	async check(): Promise<void> {
		if (this.#busy || this.#d.feed === null) return;
		// A file that is ready or already on disk stays what the card shows until the PM acts.
		if (this.#state.phase === "ready" || this.#state.phase === "downloaded" || this.#state.phase === "downloading") return;
		this.#busy = true;
		this.#set({ phase: "checking" });
		try {
			const found = await this.#driverNow().check();
			if (found === null || !isVersion(found.version) || compareVersions(found.version, this.#d.version) <= 0) {
				this.#found = null;
				this.#set({ phase: "idle", checkedAt: this.#now() });
				return;
			}
			this.#found = found;
			const refused = this.#refused.get(found.version);
			if (refused !== undefined) {
				this.#set({ phase: "refused", version: found.version, reason: refused });
				return;
			}
			if (this.#d.platform === "win32") await this.#downloadInstaller(found);
			else this.#set({ phase: "available", version: found.version });
		} catch (error) {
			this.#fail(error, "check");
		} finally {
			this.#busy = false;
		}
	}

	#fail(error: unknown, what: string): void {
		const detail = firstLineOf((error as Error).message ?? String(error));
		this.#d.log({ event: "shell-update-failed", what, detail });
		this.#set({ phase: "error", kind: /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_INTERNET|ERR_NETWORK|ERR_CONNECTION|ERR_NAME|timeout|net::|HttpError|404|50\d|fetch failed/i.test(detail) ? "network" : "other", detail });
	}

	// ---- Windows: the installer ------------------------------------------------------------------------------------

	async #downloadInstaller(found: FoundUpdate): Promise<void> {
		const entry = found.files.find((f) => /\.exe$/i.test(nameOf(f.url)));
		if (entry === undefined || this.#d.feed === null) throw new Error("the feed lists no installer for this version");
		this.#set({ phase: "downloading", version: found.version, percent: null });
		const { file } = await this.#driverNow().download((percent) => this.#set({ phase: "downloading", version: found.version, percent }));
		this.#set({ phase: "downloading", version: found.version, percent: 100 });
		const verdict = await this.#verifyFile(file, found.version, nameOf(entry.url));
		if (!verdict.ok) {
			this.#refuse(found.version, verdict.reason, file);
			return;
		}
		this.#signature = verdict.signature;
		this.#installer = file;
		this.#d.log({ event: "shell-update-verified", version: found.version, keyIndex: verdict.keyIndex });
		this.#set({ phase: "ready", version: found.version });
	}

	/**
	 * Fetches `<name>.sig` from the feed and checks `file` against it. An unreachable feed throws (a network failure, not a refusal); a missing or wrong signature is a refusal. The file is read
	 * only when it is within the size limit.
	 */
	async #verifyFile(file: string, version: string, name: string): Promise<{ ok: true; signature: Buffer; keyIndex: number } | { ok: false; reason: ShellRefusal }> {
		if (this.#d.feed === null) return { ok: false, reason: "no-keys" };
		const sig = await this.#d.fetchBytes(`${assetUrl(this.#d.feed, version, name)}.sig`, MAX_SIGNATURE_BYTES);
		if (sig.status === 404) return { ok: false, reason: "no-signature" };
		if (sig.status !== 200) throw new Error(`the signature of ${name} answered ${sig.status}`);
		return this.#check(file, Buffer.from(sig.body));
	}

	#check(file: string, signature: Buffer): { ok: true; signature: Buffer; keyIndex: number } | { ok: false; reason: ShellRefusal } {
		if (statSync(file).size > MAX_INSTALLER_BYTES) return { ok: false, reason: "too-large" };
		const verdict = verifyDetached(readFileSync(file), signature, this.#d.keys);
		return verdict.ok ? { ok: true, signature, keyIndex: verdict.keyIndex } : { ok: false, reason: REFUSAL_OF[verdict.reason] };
	}

	/** Deletes the file, remembers the version as refused, and tells the card. Nothing is left that could be offered. */
	#refuse(version: string, reason: ShellRefusal, file: string): void {
		try {
			rmSync(file, { force: true });
		} catch (error) {
			this.#d.log({ event: "shell-update-delete-failed", detail: firstLineOf((error as Error).message) });
		}
		this.#refused.set(version, reason);
		this.#signature = null;
		this.#installer = null;
		this.#d.log({ event: "shell-update-refused", version, reason });
		this.#set({ phase: "refused", version, reason });
	}

	/**
	 * Restart to update (Windows). The file is checked again right before it is handed to the installer, then the stop sequence runs, then electron-updater starts the installer silently and the
	 * app quits. Anything but `ready` is ignored.
	 */
	async restart(): Promise<void> {
		const state = this.#state;
		if (this.#d.platform !== "win32" || state.phase !== "ready" || this.#busy) return;
		const file = this.#installer;
		if (file === null || this.#signature === null) {
			this.#set({ phase: "error", kind: "other", detail: "the downloaded installer is gone" });
			return;
		}
		this.#busy = true;
		try {
			const again = this.#check(file, this.#signature);
			if (!again.ok) {
				this.#refuse(state.version, again.reason, file);
				return;
			}
			await this.#d.prepareQuit();
			this.#d.log({ event: "shell-update-install", version: state.version });
			this.#driverNow().quitAndInstall();
		} catch (error) {
			this.#fail(error, "install");
		} finally {
			this.#busy = false;
		}
	}

	// ---- macOS: the dmg --------------------------------------------------------------------------------------------

	/** Download the new version (macOS): fetches the dmg, checks its SHA512 and signature, and shows the verified file. An unverified file is deleted and never shown. */
	async download(): Promise<void> {
		const state = this.#state;
		const found = this.#found;
		if (this.#d.platform !== "darwin" || state.phase !== "available" || found === null || this.#busy || this.#d.feed === null) return;
		this.#busy = true;
		const entry = found.files.find((f) => /\.dmg$/i.test(nameOf(f.url)));
		const version = found.version;
		try {
			if (entry === undefined) throw new Error("the feed lists no dmg for this version");
			const name = nameOf(entry.url);
			const dir = this.#d.downloadDir();
			mkdirSync(dir, { recursive: true });
			const part = join(dir, `${name}.part`);
			const final = join(dir, name);
			this.#set({ phase: "downloading", version, percent: null });
			try {
				await this.#d.downloadFile(assetUrl(this.#d.feed, version, name), part, (percent) => this.#set({ phase: "downloading", version, percent }));
			} catch (error) {
				rmSync(part, { force: true });
				throw error;
			}
			// The feed's own SHA512 first (what electron-updater checks for the files it downloads), then the signature.
			if (entry.sha512 !== undefined && createHash("sha512").update(readFileSync(part)).digest("base64") !== entry.sha512) {
				rmSync(part, { force: true });
				throw new Error(`${name} does not match the SHA512 the feed lists`);
			}
			let verdict;
			try {
				verdict = await this.#verifyFile(part, version, name);
			} catch (error) {
				rmSync(part, { force: true });
				throw error;
			}
			if (!verdict.ok) {
				this.#refuse(version, verdict.reason, part);
				return;
			}
			rmSync(final, { force: true });
			renameSync(part, final);
			this.#d.log({ event: "shell-update-verified", version, keyIndex: verdict.keyIndex });
			this.#set({ phase: "downloaded", version, file: final });
			this.#d.reveal(final);
		} catch (error) {
			this.#fail(error, "download");
		} finally {
			this.#busy = false;
		}
	}

	/** Shows the verified dmg again (macOS). */
	reveal(): void {
		const state = this.#state;
		if (state.phase === "downloaded") this.#d.reveal(state.file);
	}
}
