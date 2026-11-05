import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { cleanupCommand, POWERSHELL_SCRIPT, posixScript, spawnCleanup } from "../src/main/removal/cleanup.ts";
import { createMacLocate } from "../src/main/platform/mac.ts";
import { createWinLocate } from "../src/main/platform/win.ts";

// The detached cleanup (spec: Uninstall and data). The POSIX script runs for real where `sh` exists; the PowerShell one runs on the Windows runner. Neither touches anything but its own scratch folders.
const bases: string[] = [];
after(() => {
	for (const b of bases) rmSync(b, { recursive: true, force: true });
});
const scratch = (): string => {
	const b = realpathSync.native(mkdtempSync(join(tmpdir(), "sbd-clean-")));
	bases.push(b);
	return b;
};

describe("the cleanup command", () => {
	const mac = createMacLocate();
	const win = createWinLocate({ systemRoot: "C:\\Windows" });
	it("passes the root, the fallback folder and the pid as positional parameters of sh on macOS, and the script text holds none of them", () => {
		const c = cleanupCommand({ platform: "darwin", pid: 4242, root: "/Users/pm/Library/Application Support/straw-boss-desk", fallbackDir: "/Users/pm/.straw-boss-desk/ab12cd34" }, mac, { PATH: "/opt/homebrew/bin", SSH_AUTH_SOCK: "x" });
		assert.equal(c.file, "/bin/sh");
		assert.deepEqual(c.args.slice(0, 1), ["-c"]);
		assert.deepEqual(c.args.slice(2), ["sh", "/Users/pm/Library/Application Support/straw-boss-desk", "/Users/pm/.straw-boss-desk/ab12cd34", "4242"]);
		assert.ok(!c.args[1]?.includes("Application Support"));
		assert.deepEqual(c.env, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
	});

	it("passes them in the environment on Windows, UTF-16 and unquoted, whatever & ^ % or CJK the root holds, and the encoded script holds none of them", () => {
		const root = "C:\\Users\\PM\\AppData\\Local\\sbd 測試 & ^ %TEMP% !x!";
		const c = cleanupCommand({ platform: "win32", pid: 77, root, fallbackDir: null }, win, { SystemRoot: "C:\\Windows" });
		assert.match(c.file, /powershell\.exe$/i);
		assert.equal(c.env.SBD_RM_ROOT, root);
		assert.equal(c.env.SBD_RM_FALLBACK, "");
		assert.equal(c.env.SBD_RM_PID, "77");
		const decoded = Buffer.from(c.args[c.args.length - 1] as string, "base64").toString("utf16le");
		assert.equal(decoded, POWERSHELL_SCRIPT);
		assert.ok(!c.args.join(" ").includes("測試"));
	});

	it("refuses a relative root and a pid that is not one", () => {
		assert.throws(() => cleanupCommand({ platform: "darwin", pid: 1, root: "data", fallbackDir: null }, mac), /absolute/);
		assert.throws(() => cleanupCommand({ platform: "darwin", pid: 0, root: "/data", fallbackDir: null }, mac), /pid/);
		assert.throws(() => cleanupCommand({ platform: "darwin", pid: 1.5, root: "/data", fallbackDir: null }, mac), /pid/);
	});

	it("starts the program detached, hidden, with no inherited handles and a working folder outside the root, and ignores its start error", () => {
		const calls: Array<{ file: string; options: Record<string, unknown> }> = [];
		let unref = false;
		let onError: (e: Error) => void = () => undefined;
		spawnCleanup({ file: "x", args: [], env: {} }, (file, _args, options) => {
			calls.push({ file, options: options as Record<string, unknown> });
			return { unref: () => void (unref = true), on: (_e, l) => void (onError = l) };
		}, "darwin");
		assert.equal(calls[0]?.options.detached, true);
		assert.equal(calls[0]?.options.stdio, "ignore");
		assert.equal(calls[0]?.options.windowsHide, true);
		assert.equal(calls[0]?.options.cwd, tmpdir());
		assert.ok(unref);
		onError(new Error("ENOENT"));
	});

	it("does not start the Windows program detached: with no console at all Windows PowerShell ends before its first line (seen on the hosted runner)", () => {
		const calls: Array<Record<string, unknown>> = [];
		spawnCleanup({ file: "x", args: [], env: {} }, (_file, _args, options) => {
			calls.push(options as Record<string, unknown>);
			return { unref: () => undefined, on: () => undefined };
		}, "win32");
		assert.equal(calls[0]?.detached, false);
		assert.equal(calls[0]?.stdio, "ignore");
		assert.equal(calls[0]?.windowsHide, true);
	});
});

describe("the POSIX cleanup, run for real", { skip: process.platform === "win32" ? "sh runs on macOS" : false }, () => {
	const run = (root: string, fallback: string, pid: string, wait = 2) => spawnSync("/bin/sh", ["-c", posixScript(wait), "sh", root, fallback, pid], { encoding: "utf8", timeout: 30_000 });

	it("waits for the app's pid to end, then deletes the root and the fallback folder, and the parent when it is empty", async () => {
		const base = scratch();
		const root = join(base, "root 測試 & x");
		const parent = join(base, ".straw-boss-desk");
		const fallback = join(parent, "ab12cd34");
		mkdirSync(join(root, "electron"), { recursive: true });
		mkdirSync(join(fallback, "agent"), { recursive: true });
		writeFileSync(join(root, "remove-pending"), "{}");
		const app = spawn("/bin/sleep", ["1"], { stdio: "ignore" });
		const exited = new Promise<void>((resolve) => app.on("exit", () => resolve()));
		const started = Date.now();
		const cleaner = spawn("/bin/sh", ["-c", posixScript(10), "sh", root, fallback, String(app.pid)], { stdio: "ignore" });
		await new Promise<void>((resolve) => setTimeout(resolve, 300));
		assert.ok(existsSync(root), "nothing is deleted while the app's pid lives");
		await exited;
		await new Promise<void>((resolve) => cleaner.on("exit", () => resolve()));
		assert.ok(Date.now() - started >= 900);
		assert.ok(!existsSync(root) && !existsSync(fallback) && !existsSync(parent));
	});

	it("leaves everything and exits 2 when the pid is still alive after the wait", () => {
		const base = scratch();
		const root = join(base, "root");
		mkdirSync(root);
		const app = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
		try {
			const r = run(root, "", String(app.pid), 1);
			assert.equal(r.status, 2);
			assert.ok(existsSync(root));
		} finally {
			app.kill();
		}
	});

	it("refuses a relative root and a pid that is not a number, and deletes nothing", () => {
		const base = scratch();
		mkdirSync(join(base, "rel"));
		assert.equal(spawnSync("/bin/sh", ["-c", posixScript(1), "sh", "rel", "", "999999"], { cwd: base, encoding: "utf8" }).status, 1);
		assert.ok(existsSync(join(base, "rel")));
		assert.equal(run(join(base, "rel"), "", "abc").status, 1);
		assert.ok(existsSync(join(base, "rel")));
	});

	it("deletes a root whose pid is already gone at once", () => {
		const base = scratch();
		const root = join(base, "gone");
		mkdirSync(root);
		assert.equal(run(root, "", "999999").status, 0);
		assert.ok(!existsSync(root));
	});
});

describe("the PowerShell cleanup, run for real", { skip: process.platform === "win32" ? false : "PowerShell 5.1 runs on the Windows runner" }, () => {
	it("deletes a root with CJK, space, ampersand and percent characters, and a fallback folder, once the pid has gone", () => {
		const base = scratch();
		const root = join(base, "sbd 測試 & %TEMP% ^x");
		const fallback = join(base, ".straw-boss-desk", "ab12cd34");
		mkdirSync(join(root, "electron"), { recursive: true });
		mkdirSync(fallback, { recursive: true });
		const c = cleanupCommand({ platform: "win32", pid: 99999999, root, fallbackDir: fallback }, createWinLocate());
		const r = spawnSync(c.file, c.args, { env: c.env, encoding: "utf8", timeout: 120_000, windowsHide: true });
		assert.equal(r.status, 0, r.stderr);
		assert.ok(!existsSync(root) && !existsSync(fallback));
	});
});
