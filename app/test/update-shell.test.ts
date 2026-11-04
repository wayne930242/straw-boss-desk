import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AppUpdater } from "electron-updater";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { CHECK_EVERY_MS, FIRST_CHECK_AFTER_MS, electronUpdaterDriver, ShellUpdater, type FoundUpdate, type ShellUpdaterDeps, type UpdaterDriver } from "../src/main/update/shell.ts";
import { UpdatesService } from "../src/main/update/service.ts";
import { StackUpdater } from "../src/main/update/stack.ts";
import { assetUrl, compareVersions, feedUrlProblem, MAX_KEYS, RELEASE_KEYS, updateConfig, verifyDetached } from "../src/main/update/verify.ts";
import type { ShellUpdateState } from "../src/shared/updates.ts";

// The shell channel (task 13): the installer or dmg is checked against the built-in key list before it is offered, a file that fails is deleted, and nothing unverified is installed or opened.

const pair = (): { privateKey: KeyObject; publicKey: string } => {
	const made = generateKeyPairSync("ed25519");
	return { privateKey: made.privateKey, publicKey: made.publicKey.export({ type: "spki", format: "der" }).toString("base64") };
};
const A = pair();
const B = pair();
const OUTSIDER = pair();
const sign = (bytes: Uint8Array, k: KeyObject = A.privateKey): Buffer => Buffer.from(`${cryptoSign(null, bytes, k).toString("base64")}\n`);

const scratch: string[] = [];
after(() => {
	for (const d of scratch) removeTree(d);
});
const tmp = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "sbd-shell-"));
	scratch.push(dir);
	return dir;
};

const FEED = { kind: "generic", url: "http://127.0.0.1:1/feed/" } as const;
const INSTALLER = Buffer.from("the installer of 0.0.2");
const INSTALLER_NAME = "straw-boss-desk-Setup-0.0.2.exe";
const DMG = Buffer.from("the disk image of 0.0.2");
const DMG_NAME = "Straw Boss Desk-0.0.2-arm64.dmg";

interface Rig {
	shell: ShellUpdater;
	dir: string;
	/** The signature the feed serves for a file name (status 404 when absent). */
	sigs: Map<string, Buffer>;
	calls: string[];
	revealed: string[];
	states: ShellUpdateState[];
	found: { value: FoundUpdate | null };
	/** The bytes the "download" leaves on disk. */
	payload: { bytes: Buffer };
	driverMade: { n: number };
	fetched: string[];
	logs: Array<Record<string, unknown>>;
}

function makeRig(options: { platform?: "win32" | "darwin"; feed?: ShellUpdaterDeps["feed"]; keys?: string[]; check?: () => Promise<FoundUpdate | null>; fail?: (what: string) => Error | null } = {}): Rig {
	const platform = options.platform ?? "win32";
	const dir = tmp();
	const downloads = join(dir, "Downloads");
	mkdirSync(downloads, { recursive: true });
	const sigs = new Map<string, Buffer>();
	const calls: string[] = [];
	const revealed: string[] = [];
	const states: ShellUpdateState[] = [];
	const fetched: string[] = [];
	const logs: Array<Record<string, unknown>> = [];
	const found: Rig["found"] = { value: { version: "0.0.2", files: [{ url: platform === "win32" ? INSTALLER_NAME : DMG_NAME }] } };
	const payload = { bytes: platform === "win32" ? INSTALLER : DMG };
	const driverMade = { n: 0 };
	const rig = { dir, sigs, calls, revealed, states, found, payload, driverMade, fetched, logs } as unknown as Rig;
	const driver: UpdaterDriver = {
		check: options.check ?? (async () => found.value),
		async download(onProgress) {
			calls.push("download");
			onProgress(50);
			const file = join(dir, "pending", INSTALLER_NAME);
			mkdirSync(join(dir, "pending"), { recursive: true });
			writeFileSync(file, payload.bytes);
			return { file };
		},
		quitAndInstall() {
			calls.push("quitAndInstall");
		},
	};
	rig.shell = new ShellUpdater({
		platform,
		version: "0.0.1",
		feed: options.feed === undefined ? FEED : options.feed,
		keys: options.keys ?? [A.publicKey, B.publicKey],
		driver: () => {
			driverMade.n++;
			return driver;
		},
		fetchBytes: async (url) => {
			fetched.push(url);
			const name = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1, -".sig".length));
			const sig = sigs.get(name);
			return sig === undefined ? { status: 404, body: Buffer.alloc(0) } : { status: 200, body: sig };
		},
		downloadFile: async (url, file, onProgress) => {
			calls.push(`downloadFile ${url.slice(url.lastIndexOf("/") + 1)}`);
			const err = options.fail?.("downloadFile");
			if (err) throw err;
			writeFileSync(file, payload.bytes);
			onProgress(100);
		},
		downloadDir: () => downloads,
		reveal: (file) => void revealed.push(file),
		prepareQuit: async () => void calls.push("prepareQuit"),
		log: (fields) => void logs.push(fields as Record<string, unknown>),
		now: () => new Date("2026-11-04T10:00:00Z"),
	});
	rig.shell.onChange(() => void states.push(rig.shell.state));
	return rig;
}

describe("the Windows installer", () => {
	it("downloads it, checks its signature against the key list, and only then offers Restart to update", async () => {
		const rig = makeRig();
		rig.sigs.set(INSTALLER_NAME, sign(INSTALLER));
		await rig.shell.check();
		assert.deepEqual(rig.shell.state, { phase: "ready", version: "0.0.2" });
		assert.deepEqual(rig.states.map((s) => s.phase), ["checking", "downloading", "downloading", "downloading", "ready"]);
		assert.deepEqual(rig.fetched, [`${FEED.url}${INSTALLER_NAME}.sig`]);
		assert.equal(rig.calls.includes("quitAndInstall"), false, "nothing installs by itself");
	});

	it("accepts a file signed by the second key of the list", async () => {
		const rig = makeRig();
		rig.sigs.set(INSTALLER_NAME, sign(INSTALLER, B.privateKey));
		await rig.shell.check();
		assert.equal(rig.shell.state.phase, "ready");
	});

	for (const [name, sigFor, reason] of [
		["a file with one byte changed after it was signed", () => sign(Buffer.from("the installer of 0.0.3")), "bad-signature"],
		["a file signed by a key that is not in the list", () => sign(INSTALLER, OUTSIDER.privateKey), "bad-signature"],
		["a file with no signature on the feed", () => undefined, "no-signature"],
		["a file with an unreadable signature", () => Buffer.from("not a signature"), "malformed-signature"],
	] as const) {
		it(`deletes ${name}, never offers it, and says why`, async () => {
			const rig = makeRig();
			const sig = sigFor();
			if (sig !== undefined) rig.sigs.set(INSTALLER_NAME, sig);
			await rig.shell.check();
			assert.deepEqual(rig.shell.state, { phase: "refused", version: "0.0.2", reason });
			assert.equal(existsSync(join(rig.dir, "pending", INSTALLER_NAME)), false, "the downloaded file is deleted");
			assert.equal(rig.states.some((s) => s.phase === "ready"), false, "never offered");
			await rig.shell.restart();
			assert.equal(rig.calls.includes("quitAndInstall"), false);
			assert.equal(rig.calls.includes("prepareQuit"), false);
		});
	}

	it("does not download a refused version again before the app restarts", async () => {
		const rig = makeRig();
		rig.sigs.set(INSTALLER_NAME, sign(INSTALLER, OUTSIDER.privateKey));
		await rig.shell.check();
		await rig.shell.check();
		assert.equal(rig.calls.filter((c) => c === "download").length, 1);
		assert.equal(rig.shell.state.phase, "refused");
	});

	it("refuses every file when this build has no key, or a list it cannot use", async () => {
		for (const [keys, reason] of [[[], "no-keys"], [[A.publicKey, B.publicKey, OUTSIDER.publicKey], "bad-key-list"]] as const) {
			const rig = makeRig({ keys: [...keys] });
			rig.sigs.set(INSTALLER_NAME, sign(INSTALLER));
			await rig.shell.check();
			assert.deepEqual(rig.shell.state, { phase: "refused", version: "0.0.2", reason });
		}
	});

	it("Restart to update stops the stack first, then hands the file to the installer silently", async () => {
		const rig = makeRig();
		rig.sigs.set(INSTALLER_NAME, sign(INSTALLER));
		await rig.shell.check();
		rig.calls.length = 0;
		await rig.shell.restart();
		assert.deepEqual(rig.calls, ["prepareQuit", "quitAndInstall"]);
	});

	it("checks the file again right before the install: one swapped after the first check is refused, deleted, and never handed to the installer", async () => {
		const rig = makeRig();
		rig.sigs.set(INSTALLER_NAME, sign(INSTALLER));
		await rig.shell.check();
		writeFileSync(join(rig.dir, "pending", INSTALLER_NAME), "a different installer");
		rig.calls.length = 0;
		await rig.shell.restart();
		assert.deepEqual(rig.calls, []);
		assert.deepEqual(rig.shell.state, { phase: "refused", version: "0.0.2", reason: "bad-signature" });
		assert.equal(existsSync(join(rig.dir, "pending", INSTALLER_NAME)), false);
	});

	it("ignores Restart to update when nothing is ready, and Download on Windows", async () => {
		const rig = makeRig();
		await rig.shell.restart();
		await rig.shell.download();
		assert.deepEqual(rig.calls, []);
	});

	it("has no newer version: up to date, nothing downloaded; the same or an older version counts as none", async () => {
		const none = makeRig({ check: async () => null });
		await none.shell.check();
		assert.equal(none.shell.state.phase, "idle");
		const same = makeRig();
		same.found.value = { version: "0.0.1", files: [{ url: INSTALLER_NAME }] };
		await same.shell.check();
		assert.equal(same.shell.state.phase, "idle");
		assert.equal(same.calls.includes("download"), false);
	});

	it("shows a feed that cannot be read as a network error, and a failure of its own as another", async () => {
		const net = makeRig({ check: async () => Promise.reject(new Error("net::ERR_CONNECTION_REFUSED")) });
		await net.shell.check();
		assert.equal(net.shell.state.phase, "error");
		assert.equal((net.shell.state as { kind: string }).kind, "network");
		const other = makeRig({ check: async () => Promise.reject(new Error("the latest.yml is not YAML")) });
		await other.shell.check();
		assert.equal((other.shell.state as { kind: string }).kind, "other");
		const noInstaller = makeRig();
		noInstaller.found.value = { version: "0.0.2", files: [{ url: "readme.txt" }] };
		await noInstaller.shell.check();
		assert.equal(noInstaller.shell.state.phase, "error");
	});

	it("is off, and builds no updater, when no feed is configured", async () => {
		const rig = makeRig({ feed: null });
		assert.deepEqual(rig.shell.state, { phase: "off" });
		await rig.shell.check();
		assert.equal(rig.driverMade.n, 0);
		assert.deepEqual(rig.shell.state, { phase: "off" });
	});
});

describe("the macOS dmg", () => {
	const mac = (options: Parameters<typeof makeRig>[0] = {}) => makeRig({ platform: "darwin", ...options });

	it("only offers the newer version at a check, and downloads, verifies and reveals the dmg when asked", async () => {
		const rig = mac();
		rig.sigs.set(DMG_NAME, sign(DMG));
		await rig.shell.check();
		assert.deepEqual(rig.shell.state, { phase: "available", version: "0.0.2" });
		assert.deepEqual(rig.calls, [], "nothing was downloaded");
		await rig.shell.download();
		const file = join(rig.dir, "Downloads", DMG_NAME);
		assert.deepEqual(rig.shell.state, { phase: "downloaded", version: "0.0.2", file });
		assert.deepEqual(readFileSync(file), DMG);
		assert.deepEqual(rig.revealed, [file], "revealed once, and never opened");
		assert.deepEqual(readdirSync(join(rig.dir, "Downloads")), [DMG_NAME], "no partial file is left");
		rig.shell.reveal();
		assert.equal(rig.revealed.length, 2, "Show in folder shows it again");
	});

	it("deletes a dmg that fails the check and reveals nothing", async () => {
		for (const sig of [sign(DMG, OUTSIDER.privateKey), undefined]) {
			const rig = mac();
			if (sig !== undefined) rig.sigs.set(DMG_NAME, sig);
			await rig.shell.check();
			await rig.shell.download();
			assert.equal(rig.shell.state.phase, "refused");
			assert.deepEqual(rig.revealed, []);
			assert.deepEqual(readdirSync(join(rig.dir, "Downloads")), [], "neither the dmg nor its partial file stays");
		}
	});

	it("also checks the SHA512 the feed lists, before the signature", async () => {
		const rig = mac();
		rig.found.value = { version: "0.0.2", files: [{ url: DMG_NAME, sha512: createHash("sha512").update("other bytes").digest("base64") }] };
		rig.sigs.set(DMG_NAME, sign(DMG));
		await rig.shell.check();
		await rig.shell.download();
		assert.equal(rig.shell.state.phase, "error");
		assert.deepEqual(rig.revealed, []);
		assert.deepEqual(readdirSync(join(rig.dir, "Downloads")), []);
		const good = mac();
		good.found.value = { version: "0.0.2", files: [{ url: DMG_NAME, sha512: createHash("sha512").update(DMG).digest("base64") }] };
		good.sigs.set(DMG_NAME, sign(DMG));
		await good.shell.check();
		await good.shell.download();
		assert.equal(good.shell.state.phase, "downloaded");
	});

	it("shows a download that fails as an error and leaves no partial file", async () => {
		const rig = mac({ fail: (what) => (what === "downloadFile" ? new Error("ECONNRESET") : null) });
		rig.sigs.set(DMG_NAME, sign(DMG));
		await rig.shell.check();
		await rig.shell.download();
		assert.equal(rig.shell.state.phase, "error");
		assert.equal((rig.shell.state as { kind: string }).kind, "network");
		assert.deepEqual(readdirSync(join(rig.dir, "Downloads")), []);
	});

	it("never restarts into an installer (that is Windows)", async () => {
		const rig = mac();
		rig.sigs.set(DMG_NAME, sign(DMG));
		await rig.shell.check();
		await rig.shell.restart();
		assert.deepEqual(rig.calls, []);
	});
});

describe("electronUpdaterDriver", () => {
	function fakeUpdater() {
		const state = { feed: undefined as unknown, listeners: [] as Array<(info: { percent: number }) => void>, quit: [] as unknown[][], downloads: 0 };
		const updater = {
			autoDownload: true,
			autoInstallOnAppQuit: true,
			autoRunAppAfterInstall: false,
			allowDowngrade: true,
			allowPrerelease: true,
			disableDifferentialDownload: false,
			disableWebInstaller: false,
			setFeedURL: (feed: unknown) => void (state.feed = feed),
			checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: "0.0.2", files: [{ url: "a.exe", sha512: "xx", size: 3 }] } }),
			downloadUpdate: async () => {
				state.downloads++;
				for (const l of state.listeners) l({ percent: 41.6 });
				return ["C:\\pending\\a.exe"];
			},
			on: (_event: string, l: (info: { percent: number }) => void) => void state.listeners.push(l),
			off: (_event: string, l: (info: { percent: number }) => void) => void state.listeners.splice(state.listeners.indexOf(l), 1),
			quitAndInstall: (...args: unknown[]) => void state.quit.push(args),
		};
		return { state, updater };
	}

	it("switches off everything electron-updater would do by itself, points a generic feed at its folder, and installs silently with a restart", async () => {
		const { state, updater } = fakeUpdater();
		const driver = electronUpdaterDriver(updater as unknown as AppUpdater, FEED);
		assert.deepEqual([updater.autoDownload, updater.autoInstallOnAppQuit, updater.allowDowngrade, updater.allowPrerelease, updater.disableDifferentialDownload, updater.disableWebInstaller, updater.autoRunAppAfterInstall], [false, false, false, false, true, true, true]);
		assert.deepEqual(state.feed, { provider: "generic", url: FEED.url });
		assert.deepEqual(await driver.check(), { version: "0.0.2", files: [{ url: "a.exe", sha512: "xx", size: 3 }] });
		const seen: Array<number | null> = [];
		assert.deepEqual(await driver.download((p) => seen.push(p)), { file: "C:\\pending\\a.exe" });
		assert.deepEqual(seen, [42]);
		assert.equal(state.listeners.length, 0, "the progress listener is removed");
		driver.quitAndInstall();
		assert.deepEqual(state.quit, [[true, true]]);
	});

	it("leaves a GitHub feed to the package's own update file, and reads no update as null", async () => {
		const { state, updater } = fakeUpdater();
		updater.checkForUpdates = async () => ({ isUpdateAvailable: false, updateInfo: { version: "0.0.1", files: [] } });
		const driver = electronUpdaterDriver(updater as unknown as AppUpdater, { kind: "github", owner: "o", repo: "r" });
		assert.equal(state.feed, undefined);
		assert.equal(await driver.check(), null);
	});
});

describe("UpdatesService", () => {
	function service(enabled = true) {
		const timers: Array<{ fn: () => void; ms: number; kind: string; unref: boolean }> = [];
		const checks: string[] = [];
		const shell = { state: { phase: "idle", checkedAt: null } as ShellUpdateState, onChange: () => () => undefined, check: async () => void checks.push("shell"), restart: async () => void checks.push("restart"), download: async () => void checks.push("download"), reveal: () => void checks.push("reveal") };
		const stack = { state: { phase: "idle", checkedAt: null }, generation: 5, busy: false, onChange: () => () => undefined, check: async () => void checks.push("stack"), apply: async () => void checks.push("apply") };
		const svc = new UpdatesService({
			shell: shell as unknown as ShellUpdater,
			stack: stack as unknown as StackUpdater,
			appVersion: "0.0.1",
			platform: "win32",
			enabled: () => enabled,
			log: () => undefined,
			now: () => new Date("2026-11-04T10:00:00Z"),
			setTimeout: (fn, ms) => {
				const t = { fn, ms, kind: "timeout", unref: false, unrefFn() {} };
				timers.push(t);
				return { unref: () => void (t.unref = true) };
			},
			setInterval: (fn, ms) => {
				const t = { fn, ms, kind: "interval", unref: false };
				timers.push(t);
				return { unref: () => void (t.unref = true) };
			},
			clear: () => undefined,
		});
		return { svc, timers, checks, shell };
	}

	it("checks both channels at a Check now, in order, and records when", async () => {
		const { svc, checks } = service();
		await svc.act({ type: "update-check" });
		assert.deepEqual(checks, ["shell", "stack"]);
		assert.equal(svc.view().checkedAt, "2026-11-04T10:00:00.000Z");
		assert.equal(svc.view().checking, false);
		assert.equal(svc.view().generation, 5);
	});

	it("checks shortly after the start and every six hours, with timers that do not keep the app alive, and not before the wizard is done", async () => {
		const done = service();
		done.svc.start();
		assert.deepEqual(done.timers.map((t) => [t.kind, t.ms, t.unref]), [["timeout", FIRST_CHECK_AFTER_MS, true], ["interval", CHECK_EVERY_MS, true]]);
		assert.equal(CHECK_EVERY_MS, 6 * 60 * 60 * 1000);
		done.timers[0]?.fn();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(done.checks, ["shell", "stack"]);
		const early = service(false);
		early.svc.start();
		early.timers[1]?.fn();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(early.checks, []);
	});

	it("sends each request to its channel, and shows a notice only for a version that is ready or available", async () => {
		const { svc, checks, shell } = service();
		for (const type of ["update-apply", "update-restart", "update-download", "update-reveal"] as const) await svc.act({ type });
		assert.deepEqual(checks, ["apply", "restart", "download", "reveal"]);
		assert.equal(svc.notice(), null);
		shell.state = { phase: "ready", version: "0.0.2" };
		assert.deepEqual(svc.notice(), { version: "0.0.2", action: "restart" });
		shell.state = { phase: "available", version: "0.0.2" };
		assert.deepEqual(svc.notice(), { version: "0.0.2", action: "open" });
	});
});

describe("the key list and the build's configuration", () => {
	it("ships no key until the release key exists, and never more than two", () => {
		assert.deepEqual(RELEASE_KEYS, []);
		assert.ok(RELEASE_KEYS.length <= MAX_KEYS);
		assert.equal(MAX_KEYS, 2);
	});

	it("verifies against either of two keys and nothing else", () => {
		const bytes = Buffer.from("x");
		assert.deepEqual(verifyDetached(bytes, sign(bytes, B.privateKey), [A.publicKey, B.publicKey]), { ok: true, keyIndex: 1 });
		assert.deepEqual(verifyDetached(bytes, sign(bytes, OUTSIDER.privateKey), [A.publicKey, B.publicKey]), { ok: false, reason: "bad-signature" });
	});

	it("lets only a development build take keys and a feed from its environment; a release build reads neither", () => {
		const env = { SBD_UPDATE_KEYS: JSON.stringify([A.publicKey]), SBD_UPDATE_FEED: "http://127.0.0.1:8123/feed" };
		const dev = updateConfig("dev", env);
		assert.deepEqual(dev.keys, [A.publicKey]);
		assert.deepEqual(dev.shell, { kind: "generic", url: "http://127.0.0.1:8123/feed/" });
		assert.equal(dev.stackBase, "http://127.0.0.1:8123/feed/");
		const release = updateConfig("release", env);
		assert.deepEqual(release.keys, RELEASE_KEYS);
		assert.equal(release.shell?.kind, "github");
		assert.ok(release.stackBase?.startsWith("https://"));
	});

	it("fails closed on a development environment it cannot use", () => {
		assert.deepEqual(updateConfig("dev", {}), { keys: RELEASE_KEYS, shell: null, stackBase: null });
		assert.deepEqual(updateConfig("dev", { SBD_UPDATE_KEYS: "not json", SBD_UPDATE_FEED: "ftp://example.com/" }), { keys: RELEASE_KEYS, shell: null, stackBase: null });
		assert.deepEqual(updateConfig("dev", { SBD_UPDATE_FEED: "http://example.com/feed" }).shell, null, "plain http only on a loopback name");
	});

	it("takes https and loopback http as feed addresses, and nothing with credentials", () => {
		assert.equal(feedUrlProblem("https://example.com/x"), null);
		assert.equal(feedUrlProblem("http://127.0.0.1:80/x"), null);
		assert.equal(feedUrlProblem("http://localhost/x"), null);
		assert.match(feedUrlProblem("http://example.com/x") ?? "", /https/);
		assert.match(feedUrlProblem("https://u:p@example.com/") ?? "", /user name/);
		assert.match(feedUrlProblem("nope") ?? "", /URL/);
	});

	it("names the assets of a generic feed and of a GitHub release", () => {
		assert.equal(assetUrl({ kind: "generic", url: "http://127.0.0.1:1/f" }, "0.0.2", "a b.exe"), "http://127.0.0.1:1/f/a%20b.exe");
		assert.equal(assetUrl({ kind: "github", owner: "o", repo: "r" }, "0.0.2", "a b.exe"), "https://github.com/o/r/releases/download/v0.0.2/a%20b.exe");
	});

	it("compares versions as semantic versions", () => {
		assert.ok(compareVersions("0.0.2", "0.0.1") > 0);
		assert.ok(compareVersions("0.10.0", "0.9.0") > 0);
		assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
		assert.ok(compareVersions("1.0.0-beta.2", "1.0.0-beta.10") < 0);
		assert.ok(compareVersions("1.0.0-beta", "1.0.0") < 0);
		assert.throws(() => compareVersions("soon", "1.0.0"), /not a version/);
	});
});
