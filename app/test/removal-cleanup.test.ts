import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
		const c = cleanupCommand({ platform: "darwin", pid: 4242, root: "/Users/pm/Library/Application Support/straw-boss-desk", fallbackDir: "/Users/pm/.straw-boss-desk/ab12cd34", marked: true }, mac, { PATH: "/opt/homebrew/bin", SSH_AUTH_SOCK: "x" });
		assert.equal(c.file, "/bin/sh");
		assert.deepEqual(c.args.slice(0, 1), ["-c"]);
		assert.deepEqual(c.args.slice(2), ["sh", "/Users/pm/Library/Application Support/straw-boss-desk", "/Users/pm/.straw-boss-desk/ab12cd34", "4242", "1"]);
		assert.ok(!c.args[1]?.includes("Application Support"));
		assert.deepEqual(c.env, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
	});

	it("passes them in the environment on Windows, UTF-16 and unquoted, whatever & ^ % or CJK the root holds, and the encoded script holds none of them", () => {
		const root = "C:\\Users\\PM\\AppData\\Local\\sbd 測試 & ^ %TEMP% !x!";
		const c = cleanupCommand({ platform: "win32", pid: 77, root, fallbackDir: null, marked: true }, win, { SystemRoot: "C:\\Windows" });
		assert.match(c.file, /cmd\.exe$/i);
		assert.equal(c.verbatim, true);
		assert.deepEqual(c.args.slice(0, 3), ["/d", "/s", "/c"]);
		assert.match(c.args[3] as string, /^"start "" \/b "C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+"$/);
		assert.equal(c.env.SBD_RM_ROOT, root);
		assert.equal(c.env.SBD_RM_FALLBACK, "");
		assert.equal(c.env.SBD_RM_PID, "77");
		const decoded = Buffer.from(/-EncodedCommand ([A-Za-z0-9+/=]+)"$/.exec(c.args[3] as string)?.[1] ?? "", "base64").toString("utf16le");
		assert.equal(decoded, POWERSHELL_SCRIPT);
		assert.ok(!c.args.join(" ").includes("測試"));
	});

	it("counts a process as gone once it has exited, even while another program still holds a handle to it", () => {
		assert.match(POWERSHELL_SCRIPT, /\$null -ne \$p -and -not \$p\.HasExited/);
	});

	it("T14-F006: the Windows script does not recurse through Remove-Item, which Windows PowerShell 5.1 lets follow junctions and symlinks; it deletes a reparse point as the link it is and the marker last", () => {
		assert.doesNotMatch(POWERSHELL_SCRIPT, /Remove-Item[^\n]*-Recurse/);
		assert.match(POWERSHELL_SCRIPT, /\[IO\.FileAttributes\]::ReparsePoint/);
		// A link is removed without `recursive`: `Directory.Delete(path)` takes the link and leaves its target; `Directory.Delete(path, $true)` is never used.
		assert.match(POWERSHELL_SCRIPT, /if \(\$isLink\) \{ \[IO\.Directory\]::Delete\(\$path\); return \}/);
		assert.doesNotMatch(POWERSHELL_SCRIPT, /Directory\]::Delete\([^)]*\$true/);
		// A link is decided before any child is listed.
		assert.ok(POWERSHELL_SCRIPT.indexOf("$isLink) {") < POWERSHELL_SCRIPT.indexOf("GetFileSystemEntries"));
		// The root's marker is passed as the name that goes last, and is deleted only after the children (`$rest` counts what stayed).
		assert.match(POWERSHELL_SCRIPT, /SBD_RM_ROOT\) \{ 'remove-pending' \}/);
		const skipsMarker = POWERSHELL_SCRIPT.indexOf("-ieq $keepLast) }) { continue }") >= 0 || POWERSHELL_SCRIPT.indexOf("-ieq $keepLast)) { continue }") >= 0;
		assert.ok(skipsMarker, "the walk skips the marker while it empties the root");
		assert.ok(POWERSHELL_SCRIPT.indexOf("-ieq $keepLast") < POWERSHELL_SCRIPT.indexOf("if ($rest -gt 0) { return }"));
		assert.ok(POWERSHELL_SCRIPT.indexOf("if ($rest -gt 0) { return }") < POWERSHELL_SCRIPT.indexOf("Remove-Tree (Join-Path $path $keepLast)"));
		// The command the app starts carries that script, whatever the root holds.
		const c = cleanupCommand({ platform: "win32", pid: 5, root: "C:\\r", fallbackDir: null, marked: true }, createWinLocate({ systemRoot: "C:\\Windows" }), {});
		assert.equal(Buffer.from(/-EncodedCommand ([A-Za-z0-9+/=]+)"$/.exec(c.args[3] as string)?.[1] ?? "", "base64").toString("utf16le"), POWERSHELL_SCRIPT);
	});

	it("T14-F006: the POSIX script deletes the marker last, and only when nothing else is left", () => {
		const text = posixScript();
		assert.match(text, /find "\$target" -mindepth 1 -maxdepth 1 ! -name 'remove-pending' -exec rm -rf -- \{\} \+/);
		assert.ok(text.indexOf("-exec rm -rf") < text.indexOf('rm -f -- "$target/remove-pending"'));
		assert.match(text, /if \[ -z "\$\(find "\$target" -mindepth 1 -maxdepth 1 ! -name 'remove-pending'[^)]*\)" \]; then rm -f -- "\$target\/remove-pending"/);
	});

	it("T14R-F002: both scripts retry the root only while the marker is in it, when one was written, so a relaunch's new root is never deleted", () => {
		const text = posixScript();
		// The retry loop asks `more`, which reads the marker for the root and the folder itself for the fallback; the plain existence loop is gone.
		assert.match(text, /more\(\) \{ if \[ "\$1" = "\$root" \] && \[ -n "\$marked" \]; then \[ -e "\$1\/remove-pending" \]; else \[ -e "\$1" \]; fi; \}/);
		assert.match(text, /while more "\$target" && \[ "\$n" -lt 20 \]; do/);
		assert.doesNotMatch(text, /while \[ -e "\$target" \]/);
		assert.match(POWERSHELL_SCRIPT, /function Test-Work\(\[string\]\$target\) \{\s+if \(\(\$target -eq \$env:SBD_RM_ROOT\) -and \$env:SBD_RM_MARKED\) \{ return \(Test-Path -LiteralPath \(Join-Path \$target 'remove-pending'\)\) \}/);
		assert.match(POWERSHELL_SCRIPT, /if \(-not \(Test-Work \$target\)\) \{ break \}/);
		assert.match(POWERSHELL_SCRIPT, /if \(Test-Work \$target\) \{ Start-Sleep -Seconds 1 \}/);
		assert.doesNotMatch(POWERSHELL_SCRIPT, /if \(-not \(Test-Path -LiteralPath \$target\)\) \{ break \}/);
		// The flag travels as the fourth positional parameter on macOS and as `SBD_RM_MARKED` on Windows, and is empty when no marker was written.
		const mac = createMacLocate();
		const win = createWinLocate({ systemRoot: "C:\\Windows" });
		assert.equal(cleanupCommand({ platform: "darwin", pid: 9, root: "/r", fallbackDir: null, marked: true }, mac).args[6], "1");
		assert.equal(cleanupCommand({ platform: "darwin", pid: 9, root: "/r", fallbackDir: null, marked: false }, mac).args[6], "");
		assert.equal(cleanupCommand({ platform: "win32", pid: 9, root: "C:\\r", fallbackDir: null, marked: true }, win, {}).env.SBD_RM_MARKED, "1");
		assert.equal(cleanupCommand({ platform: "win32", pid: 9, root: "C:\\r", fallbackDir: null, marked: false }, win, {}).env.SBD_RM_MARKED, "");
	});

	it("refuses a relative root and a pid that is not one", () => {
		assert.throws(() => cleanupCommand({ platform: "darwin", pid: 1, root: "data", fallbackDir: null, marked: true }, mac), /absolute/);
		assert.throws(() => cleanupCommand({ platform: "darwin", pid: 0, root: "/data", fallbackDir: null, marked: true }, mac), /pid/);
		assert.throws(() => cleanupCommand({ platform: "darwin", pid: 1.5, root: "/data", fallbackDir: null, marked: true }, mac), /pid/);
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
		spawnCleanup({ file: "x", args: [], env: {}, verbatim: true }, (_file, _args, options) => {
			calls.push(options as Record<string, unknown>);
			return { unref: () => undefined, on: () => undefined };
		}, "win32");
		assert.equal(calls[0]?.detached, false);
		assert.equal(calls[0]?.windowsVerbatimArguments, true);
		assert.equal(calls[0]?.stdio, "ignore");
		assert.equal(calls[0]?.windowsHide, true);
	});
});

describe("the POSIX cleanup, run for real", { skip: process.platform === "win32" ? "sh runs on macOS" : false }, () => {
	const run = (root: string, fallback: string, pid: string, wait = 2, marked = "") => spawnSync("/bin/sh", ["-c", posixScript(wait), "sh", root, fallback, pid, marked], { encoding: "utf8", timeout: 30_000 });

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

	it("T14-F006: a symlink inside the root is removed as a link: the folder it points to, outside the root, keeps its files", () => {
		const base = scratch();
		const root = join(base, "root");
		const outside = join(base, "outside");
		mkdirSync(join(root, "electron"), { recursive: true });
		mkdirSync(join(outside, "deep"), { recursive: true });
		writeFileSync(join(outside, "deep", "precious.txt"), "mine");
		symlinkSync(outside, join(root, "link"), "dir");
		symlinkSync(join(outside, "deep", "precious.txt"), join(root, "file-link"));
		writeFileSync(join(root, "remove-pending"), "{}");
		assert.equal(run(root, "", "999999").status, 0);
		assert.ok(!existsSync(root), "the root is gone");
		assert.equal(readFileSync(join(outside, "deep", "precious.txt"), "utf8"), "mine", "the target of the link was not entered");
	});

	it("T14-F006: when a file in the root cannot be deleted, the marker stays, so the next launch finishes the deletion", { skip: process.getuid?.() === 0 ? "root can delete anything" : false }, () => {
		const base = scratch();
		const root = join(base, "root");
		const locked = join(root, "locked");
		mkdirSync(join(root, "electron"), { recursive: true });
		mkdirSync(locked, { recursive: true });
		writeFileSync(join(locked, "held.txt"), "x");
		writeFileSync(join(root, "remove-pending"), "{}");
		chmodSync(locked, 0o555);
		try {
			assert.equal(spawnSync("/bin/sh", ["-c", posixScript(1, 1), "sh", root, "", "999999"], { encoding: "utf8", timeout: 30_000 }).status, 0);
			assert.ok(existsSync(join(root, "remove-pending")), "the marker is the last thing to go");
			assert.ok(!existsSync(join(root, "electron")), "what could be deleted was");
			assert.ok(existsSync(join(locked, "held.txt")));
		} finally {
			chmodSync(locked, 0o755);
		}
	});

	it("T14R-F002: a marked cleanup leaves a root that has no marker alone (a relaunch's new data folder), and deletes one that has it", () => {
		const base = scratch();
		const fresh = join(base, "fresh");
		mkdirSync(join(fresh, "electron"), { recursive: true });
		writeFileSync(join(fresh, "state.json"), "{}");
		assert.equal(run(fresh, "", "999999", 1, "1").status, 0);
		assert.ok(existsSync(join(fresh, "electron")) && existsSync(join(fresh, "state.json")), "the new root keeps everything");
		const pending = join(base, "pending");
		mkdirSync(join(pending, "electron"), { recursive: true });
		writeFileSync(join(pending, "remove-pending"), "{}");
		assert.equal(run(pending, "", "999999", 1, "1").status, 0);
		assert.ok(!existsSync(pending), "the root that holds the marker is deleted");
	});

	it("T14R-F002: a relaunch that replaces the root while the cleanup retries is not deleted by the next round", { skip: process.getuid?.() === 0 ? "root can delete anything" : false }, async () => {
		const base = scratch();
		const root = join(base, "root");
		const locked = join(root, "locked");
		mkdirSync(locked, { recursive: true });
		writeFileSync(join(locked, "held.txt"), "x");
		writeFileSync(join(root, "remove-pending"), "{}");
		chmodSync(locked, 0o555);
		const cleaner = spawn("/bin/sh", ["-c", posixScript(1, 20), "sh", root, "", "999999", "1"], { stdio: "ignore" });
		const ended = new Promise<void>((resolve) => cleaner.on("exit", () => resolve()));
		try {
			// The first round fails on the locked folder and the marker stays; then the relaunch finishes the removal itself and starts afresh in the same place.
			await new Promise<void>((resolve) => setTimeout(resolve, 600));
			assert.ok(existsSync(join(root, "remove-pending")), "the cleanup is still retrying");
			chmodSync(locked, 0o755);
			rmSync(root, { recursive: true, force: true });
			mkdirSync(join(root, "electron"), { recursive: true });
			writeFileSync(join(root, "state.json"), "new");
			await ended;
			assert.equal(readFileSync(join(root, "state.json"), "utf8"), "new", "the next round left the new root alone");
			assert.ok(existsSync(join(root, "electron")));
		} finally {
			if (existsSync(locked)) chmodSync(locked, 0o755);
			cleaner.kill();
		}
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
	const waitFor = (gone: () => boolean): void => {
		const deadline = Date.now() + 90_000;
		while (!gone() && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
	};

	it("T14-F006: a junction, a directory symlink and a file symlink inside the root are each removed as links; what they point to, outside the root, keeps its files", () => {
		const base = scratch();
		const root = join(base, "root");
		const outside = join(base, "outside");
		mkdirSync(join(root, "electron"), { recursive: true });
		mkdirSync(join(outside, "deep"), { recursive: true });
		writeFileSync(join(outside, "deep", "precious.txt"), "mine");
		writeFileSync(join(outside, "single.txt"), "mine too");
		writeFileSync(join(root, "electron", "Local State"), "x");
		// The runner is an administrator, so a symlink can be made; a failure to make one fails the test rather than skipping the case.
		symlinkSync(outside, join(root, "junction"), "junction");
		symlinkSync(outside, join(root, "dir-symlink"), "dir");
		symlinkSync(join(outside, "single.txt"), join(root, "file-symlink"), "file");
		writeFileSync(join(root, "remove-pending"), "{}");
		const c = cleanupCommand({ platform: "win32", pid: 99999999, root, fallbackDir: null, marked: true }, createWinLocate());
		assert.equal(spawnSync(c.file, c.args, { env: c.env, encoding: "utf8", timeout: 120_000, windowsHide: true, windowsVerbatimArguments: c.verbatim === true }).status, 0);
		waitFor(() => !existsSync(root));
		assert.ok(!existsSync(root), "the root is gone");
		assert.equal(readFileSync(join(outside, "deep", "precious.txt"), "utf8"), "mine", "the junction's and the symlink's target was not entered");
		assert.equal(readFileSync(join(outside, "single.txt"), "utf8"), "mine too", "the file symlink's target was not deleted");
	});

	it("T14R-F002: a marked cleanup leaves a root that has no marker alone, and deletes one that has it", () => {
		const base = scratch();
		const fresh = join(base, "fresh");
		mkdirSync(join(fresh, "electron"), { recursive: true });
		writeFileSync(join(fresh, "state.json"), "{}");
		const pending = join(base, "pending");
		mkdirSync(join(pending, "electron"), { recursive: true });
		writeFileSync(join(pending, "remove-pending"), "{}");
		// PowerShell is run directly here, and waited for: through `cmd /c start` the test could only look for what did not happen.
		const direct = (root: string): number | null => {
			const c = cleanupCommand({ platform: "win32", pid: 99999999, root, fallbackDir: null, marked: true }, createWinLocate());
			const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)"$/.exec(c.args[3] as string)?.[1] ?? "";
			return spawnSync(createWinLocate().system("powershell"), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { env: c.env, encoding: "utf8", timeout: 120_000, windowsHide: true }).status;
		};
		assert.equal(direct(fresh), 0);
		assert.ok(existsSync(join(fresh, "electron")) && existsSync(join(fresh, "state.json")), "the new root keeps everything");
		assert.equal(direct(pending), 0);
		assert.ok(!existsSync(pending), "the root that holds the marker is deleted");
	});

	it("deletes a root with CJK, space, ampersand and percent characters, and a fallback folder, once the pid has gone", () => {
		const base = scratch();
		const root = join(base, "sbd 測試 & %TEMP% ^x");
		const fallback = join(base, ".straw-boss-desk", "ab12cd34");
		mkdirSync(join(root, "electron"), { recursive: true });
		mkdirSync(fallback, { recursive: true });
		const c = cleanupCommand({ platform: "win32", pid: 99999999, root, fallbackDir: fallback, marked: false }, createWinLocate());
		// `cmd /c start` returns at once; the PowerShell it started does the deletion, so the test looks for it.
		const r = spawnSync(c.file, c.args, { env: c.env, encoding: "utf8", timeout: 120_000, windowsHide: true, windowsVerbatimArguments: c.verbatim === true });
		assert.equal(r.status, 0, r.stderr);
		const deadline = Date.now() + 90_000;
		while ((existsSync(root) || existsSync(fallback)) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
		assert.ok(!existsSync(root) && !existsSync(fallback), "the root and the fallback folder are gone");
	});
});
