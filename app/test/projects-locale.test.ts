import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { callEnv, cloneCause, GIT_PARSED_LOCALE, ProjectGit, type GitExec } from "../src/main/projects/git.ts";
import { ProjectRecordStore } from "../src/main/projects/record.ts";
import { ProjectsRunner, type RepoSpec } from "../src/main/projects/runner.ts";
import type { RunResult } from "../src/main/platform/types.ts";

// R12-F005: the projects step reads Git's English words (a missing branch, the cause of a failed clone), so its Git calls run in the C locale. `localizedGit` answers in Traditional Chinese whenever the call
// does not ask for the C locale, as Git for Windows does on a zh-TW Windows and as Git does for a PM whose LANG is zh_TW.UTF-8 on macOS; the test environment sets such a locale.

const scratch: string[] = [];
after(() => {
	for (const d of scratch) removeTree(d);
});

const saved = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LANGUAGE: process.env.LANGUAGE };
beforeEach(() => {
	process.env.LANG = "zh_TW.UTF-8";
	process.env.LC_ALL = "zh_TW.UTF-8";
	process.env.LANGUAGE = "zh_TW";
});
afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

/** What Git would say, in the language the call's environment names (the environment is the process's, then the call's own: `callEnv`, as `gitExec` builds it). */
function localizedGit(calls: Array<{ args: string[]; env: Record<string, string> }>): GitExec {
	return async (args, options): Promise<RunResult> => {
		const env = callEnv(Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), options.env);
		calls.push({ args: [...args], env });
		const english = env.LC_ALL === "C";
		if (args[0] === "clone") {
			const staging = String(args[args.length - 1]);
			if (args[2]?.includes("denied")) return { code: 128, stdout: "", stderr: english ? "fatal: Authentication failed for 'https://git.fixture.test/denied.git/'" : "fatal: 'https://git.fixture.test/denied.git/' 驗證失敗" };
			mkdirSync(staging, { recursive: true });
			return { code: 0, stdout: "", stderr: "" };
		}
		if (args[0] === "remote") return { code: 1, stdout: "", stderr: english ? "error: Not a valid ref: refs/remotes/origin/nope" : "錯誤：不是有效的引用：refs/remotes/origin/nope" };
		return { code: 0, stdout: "", stderr: "" };
	};
}

function rig(calls: Array<{ args: string[]; env: Record<string, string> }>) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sbd-locale-")));
	scratch.push(root);
	mkdirSync(join(root, "state"), { recursive: true });
	return new ProjectsRunner({
		platform: "darwin",
		workFolder: () => join(root, "work"),
		git: new ProjectGit(localizedGit(calls), () => undefined),
		openBase: async () => ({ ok: true }),
		record: new ProjectRecordStore({ state: join(root, "state") }),
		redact: (t) => t,
		log: () => undefined,
	});
}

const spec = (name: string, extra: Partial<RepoSpec> = {}): RepoSpec => ({ url: `https://git.fixture.test/${name}.git`, folder: name, label: name, ...extra });

describe("Git's words in a non-English locale (R12-F005)", () => {
	it("asks for the C locale on every project call, over a zh-TW locale that passed through", () => {
		assert.deepEqual(GIT_PARSED_LOCALE, { LC_ALL: "C", LANGUAGE: "C" });
		const merged = callEnv({ LANG: "zh_TW.UTF-8", LC_ALL: "zh_TW.UTF-8", LANGUAGE: "zh_TW", PATH: "/bin" }, GIT_PARSED_LOCALE);
		assert.equal(merged.LC_ALL, "C");
		assert.equal(merged.LANGUAGE, "C");
		assert.equal(merged.PATH, "/bin", "the rest of the Git environment stays");
		assert.deepEqual(callEnv({ A: "1" }, undefined), { A: "1" }, "a call that asks for nothing changes nothing");
	});

	it("the app's Git wrapper builds each call's environment with callEnv, so the ask reaches the process", () => {
		const text = readFileSync(join(import.meta.dirname, "..", "src", "main", "index.ts"), "utf8");
		assert.match(text, /callEnv\(\{ \.\.\.proxyEnv, \.\.\.buildEnv\(\{ layout, current, appEnv: process\.env \}\), GIT_TERMINAL_PROMPT: "0" \}, options\.env\)/);
	});

	it("a missing branch is still named, not reported as a head step that failed", async () => {
		const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
		const runner = rig(calls);
		await runner.begin([spec("web", { defaultBranch: "nope" })]);
		const row = runner.view().rows[0];
		assert.deepEqual(row?.failure, { kind: "branch-missing", branch: "nope" });
		assert.ok(calls.length >= 2);
		for (const call of calls) assert.equal(call.env.LC_ALL, "C", `${call.args.join(" ")} runs in the C locale`);
		assert.equal(process.env.LANG, "zh_TW.UTF-8", "the app's own locale is untouched: only the calls ask for C");
	});

	it("a refused sign-in is still read as one", async () => {
		const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
		const runner = rig(calls);
		await runner.begin([spec("denied")]);
		assert.deepEqual(runner.view().rows[0]?.failure, { kind: "clone", cause: "auth" });
	});

	it("without the C locale the same localized Git is not understood (the premise of the fix)", () => {
		assert.equal(cloneCause({ code: 128, stdout: "", stderr: "fatal: 驗證失敗" }), "other");
		assert.equal(cloneCause({ code: 128, stdout: "", stderr: "fatal: Authentication failed" }), "auth");
	});
});
