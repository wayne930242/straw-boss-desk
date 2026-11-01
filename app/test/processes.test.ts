import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, constants, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, it } from "node:test";
import { createPlatform } from "../src/main/platform/index.ts";

// Real processes: a copy of this Node placed in a folder with a space and CJK characters runs a long sleep, and the platform's Processes finds it by
// its full executable path and reads a stable start token, as the stop sequence and the leftover listing do.
const processes = createPlatform().processes;
const waitForExit = (child: ChildProcess): Promise<void> => new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", () => resolve()); });
const scratch: string[] = [];
const children: ChildProcess[] = [];
after(async () => {
	for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
	// Windows refuses to delete a program that is still running: wait for each child to be gone first.
	await Promise.all(children.map(waitForExit));
	for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

function startChild(): { child: ChildProcess; dir: string; exe: string } {
	const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "sbd-proc-")));
	scratch.push(dir);
	const bin = join(dir, "sbd 測試", "tools", "node");
	mkdirSync(bin, { recursive: true });
	const exe = join(bin, process.platform === "win32" ? "node.exe" : "node");
	copyFileSync(process.execPath, exe, constants.COPYFILE_FICLONE);
	chmodSync(exe, 0o755);
	const child = spawn(exe, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore", windowsHide: true });
	children.push(child);
	assert.ok(child.pid !== undefined);
	return { child, dir, exe };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("Processes", () => {
	it("reads the executable and a stable start token of a running process, and lists it under its folder", { timeout: 120_000 }, async () => {
		const { child, dir, exe } = startChild();
		const pid = child.pid ?? 0;
		// The process may not have mapped its executable the instant spawn returns.
		let info = (await processes.inspect([pid]))[0];
		for (let i = 0; i < 20 && info?.executable == null; i++) { await sleep(250); info = (await processes.inspect([pid]))[0]; }
		assert.ok(info?.executable, "the executable was read");
		assert.equal(basename(info.executable).toLowerCase(), basename(exe).toLowerCase());
		assert.ok(info.executable.toLowerCase().includes("sbd 測試"), `the executable path keeps its folder: ${info.executable}`);
		assert.ok(info.startTime && info.startTime.length > 0, "a start token");
		const again = (await processes.inspect([pid]))[0];
		assert.equal(again?.startTime, info.startTime, "the token is the same on a second read");

		const listed = await processes.listUnder(join(dir, "sbd 測試", "tools"));
		assert.ok(listed.some((p) => p.pid === pid), "the leftover listing finds it by its full path");
		assert.equal((await processes.listUnder(join(dir, "elsewhere"))).some((p) => p.pid === pid), false, "and not under another folder");

		assert.equal(processes.kill(pid), true);
		await waitForExit(child);
		const gone = (await processes.inspect([pid]))[0];
		assert.deepEqual(gone, { pid, startTime: null, executable: null }, "a process that is gone comes back with nulls");
		assert.equal(processes.kill(pid), false, "killing it again reports it is already gone");
	});

	it("answers for no pids without starting anything", async () => {
		assert.deepEqual(await processes.inspect([]), []);
	});

	it("gives this process a start token that differs from another process's", { timeout: 60_000 }, async () => {
		const { child } = startChild();
		const [mine, other] = await processes.inspect([process.pid, child.pid ?? 0]);
		assert.ok(mine?.startTime);
		assert.notEqual(mine.startTime, other?.startTime);
	});
});
