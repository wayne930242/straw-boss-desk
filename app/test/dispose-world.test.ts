import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, it } from "node:test";
import { createPlatform } from "../src/main/platform/index.ts";
import { stopProcessesUnder } from "./harness/e2e-light.ts";

// T7-F001: what `disposeWorld` stops. Real processes: a copy of this Node run from inside a scratch folder (a leftover of the world's pi), and this Node run
// from outside it with a command line that names the scratch folder (somebody else's process). Only the first one may be stopped.
const processes = createPlatform().processes;
const isWindows = process.platform === "win32";
const children: ChildProcess[] = [];
const scratch: string[] = [];
const waitForExit = (child: ChildProcess): Promise<void> => new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", () => resolve())));
const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

after(async () => {
	for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
	await Promise.all(children.map(waitForExit));
	for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

/** Waits until the platform layer reads the process's executable (a process may not have mapped it the instant spawn returns). */
async function visible(pid: number): Promise<void> {
	for (let i = 0; i < 40; i++) {
		if ((await processes.inspect([pid]))[0]?.executable != null) return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	assert.fail(`the platform layer never read the executable of ${pid}`);
}

describe("disposeWorld's process sweep (T7-F001)", () => {
	it("stops a process whose executable lies under the scratch folder, leaves one whose command line only names the folder, and prints no command line", { timeout: 180_000 }, async () => {
		const base = realpathSync.native(mkdtempSync(join(tmpdir(), "sbd-dispose-")));
		scratch.push(base);
		const bin = join(base, "agent", "npm", "node_modules", "sbd 測試");
		mkdirSync(bin, { recursive: true });
		const exe = join(bin, isWindows ? "node.exe" : "node");
		copyFileSync(process.execPath, exe, constants.COPYFILE_FICLONE);
		chmodSync(exe, 0o755);
		const marker = `command-line-marker-${process.pid}`;
		// The leftover: its executable is under `base`. Its command line carries a marker that must never be printed.
		const leftover = spawn(exe, ["-e", "setTimeout(() => {}, 120000)", marker], { stdio: "ignore", windowsHide: true });
		// The bystander: this machine's Node, whose command line names the scratch folder (as an editor or a shell would).
		const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)", join(base, "named-in-a-command-line")], { stdio: "ignore", windowsHide: true });
		children.push(leftover, bystander);
		assert.ok(leftover.pid !== undefined && bystander.pid !== undefined);
		await visible(leftover.pid);
		await visible(bystander.pid);

		const lines: string[] = [];
		const stopped = await stopProcessesUnder(base, { log: (line) => lines.push(line) });

		await Promise.race([waitForExit(leftover), new Promise((resolve) => setTimeout(resolve, 15_000))]);
		assert.ok(leftover.exitCode !== null || leftover.signalCode !== null, "the leftover is gone");
		assert.ok(alive(bystander.pid), "the process whose command line names the folder is still running");
		assert.deepEqual(stopped.map((p) => p.pid), [leftover.pid], "exactly the leftover was stopped");
		assert.equal(stopped[0]?.executable, basename(exe));
		assert.equal(lines.length, 1);
		assert.match(lines[0] ?? "", new RegExp(`stopping pid ${leftover.pid} \\(${basename(exe).replace(".", "\\.")}\\)`));
		assert.ok(!lines.join("\n").includes(marker), "no command line is printed");
		assert.ok(!lines.join("\n").includes("setTimeout"), "nor any part of one");
		// Nothing is left to stop, and the folder can be deleted once the leftover is gone.
		assert.deepEqual(await stopProcessesUnder(base, { log: (line) => lines.push(line) }), []);
		bystander.kill("SIGKILL");
		await waitForExit(bystander);
		rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		assert.ok(!existsSync(base));
	});

	it("never stops the process that runs it, even when a listing names it", async () => {
		const killed: number[] = [];
		const fake = {
			inspect: async () => [],
			listUnder: async () => [
				{ pid: process.pid, startTime: "t", executable: join(tmpdir(), "x", "node") },
				{ pid: 2_000_000_001, startTime: "t", executable: join(tmpdir(), "x", "esbuild") },
			],
			kill: (pid: number) => (killed.push(pid), true),
		};
		const stopped = await stopProcessesUnder(tmpdir(), { processes: fake, log: () => {} });
		assert.deepEqual(killed.filter((pid, i) => killed.indexOf(pid) === i), [2_000_000_001]);
		assert.ok(!stopped.some((p) => p.pid === process.pid));
	});
});
