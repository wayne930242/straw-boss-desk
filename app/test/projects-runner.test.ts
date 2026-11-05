import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { execRunner } from "../src/main/platform/exec.ts";
import { ProjectGit } from "../src/main/projects/git.ts";
import { ProjectRecordStore } from "../src/main/projects/record.ts";
import { ProjectsRunner, type ProjectsDeps, type RepoSpec } from "../src/main/projects/runner.ts";
import type { OpenOutcome } from "../src/main/projects/open-base.ts";
import { HOME_BASE_LABEL } from "../src/main/runtime/config.ts";
import { HOME_BASE_FOLDER } from "../../recipe/validate.mjs";
import type { ProjectRow } from "../src/shared/projects.ts";

// The projects step against real Git and local repositories (task 12's anchor, the unit half): the clone, the reuse of a folder with the same `origin`, the refusal of another, `set-head` and the
// default branch, the Windows symlink check, the recipe update's partial runs, and the open as a base. Git is the machine's own, with a scratch `HOME` and global configuration, no system
// configuration and no terminal prompt; the repositories are bare folders that `url.<folder>.insteadOf` serves for `https://git.fixture.test/`, so the recipe's addresses are the https ones the
// validator accepts and `origin` holds the address the recipe wrote. The wizard e2e runs the same step against the packaged app's own Git.

const scratch: string[] = [];
let base = "";
let git: (cwd: string, ...args: string[]) => string;
let env: Record<string, string>;

const pick = (names: string[]): Record<string, string> => Object.fromEntries(names.flatMap((n) => (process.env[n] !== undefined ? [[n, process.env[n] as string]] : [])));

before(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "sbd-projects-")));
	scratch.push(base);
	const home = join(base, "home");
	mkdirSync(home, { recursive: true });
	writeFileSync(join(base, "gitconfig"), `[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n[url "${pathToFileURL(join(base, "remote")).href}/"]\n\tinsteadOf = https://git.fixture.test/\n`);
	env = {
		...(process.platform === "win32" ? pick(["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "PATH", "Path", "TEMP", "TMP"]) : pick(["PATH"])),
		HOME: home,
		USERPROFILE: home,
		GIT_CONFIG_GLOBAL: join(base, "gitconfig"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
	};
	git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", windowsHide: true });
	mkdirSync(join(base, "remote"), { recursive: true });
});
after(() => {
	for (const d of scratch) removeTree(d);
});

let n = 0;
/** A bare repository `remote/<name>.git` with the given branches (`main` is the server's HEAD) and files on `main`. */
function bare(name: string, options: { branches?: string[]; files?: Record<string, string>; links?: string[]; realFiles?: Record<string, string> } = {}): void {
	const work = join(base, `seed-${name}-${++n}`);
	mkdirSync(work, { recursive: true });
	git(work, "init", "-q", "-b", "main");
	for (const [file, text] of Object.entries(options.files ?? { "README.md": "hello\n" })) {
		mkdirSync(join(work, file, ".."), { recursive: true });
		writeFileSync(join(work, file), text);
	}
	git(work, "add", "-A");
	// A link entry is put in the index by hand (mode 120000, a blob holding the target), so it builds on Windows without symlink rights.
	for (const link of options.links ?? []) {
		const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: work, env, input: "target", encoding: "utf8" }).trim();
		git(work, "update-index", "--add", "--cacheinfo", `120000,${blob},${link}`);
	}
	git(work, "commit", "-q", "-m", "seed");
	for (const branch of options.branches ?? []) git(work, "branch", branch);
	removeTree(join(base, "remote", `${name}.git`));
	git(base, "clone", "-q", "--bare", work, join(base, "remote", `${name}.git`));
}

const spec = (name: string, extra: Partial<RepoSpec> = {}): RepoSpec => ({ url: `https://git.fixture.test/${name}.git`, folder: name, label: name, ...extra });

interface Rig {
	work: string;
	calls: string[][];
	opens: Array<{ dir: string; label: string }>;
	runner: ProjectsRunner;
	rows: () => Record<string, ProjectRow>;
	record: ProjectRecordStore;
	open: { outcome: OpenOutcome; hold?: () => Promise<void>; trust?: boolean };
	deps: ProjectsDeps;
}

function rig(platform: "win32" | "darwin" = "darwin", existing?: { work: string; stateDir: string }): Rig {
	const root = mkdtempSync(join(base, "case-"));
	const work = existing?.work ?? join(root, "work");
	const stateDir = existing?.stateDir ?? join(root, "state");
	mkdirSync(stateDir, { recursive: true });
	const calls: string[][] = [];
	const opens: Array<{ dir: string; label: string }> = [];
	const run = execRunner();
	const open: Rig["open"] = { outcome: { ok: true } };
	const record = new ProjectRecordStore({ state: stateDir });
	const deps: ProjectsDeps = {
		platform,
		workFolder: () => work,
		git: new ProjectGit(
			(args, options) => (calls.push([...args]), run("git", args, { env, replaceEnv: true, timeoutMs: options.timeoutMs, ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) })),
			() => undefined,
		),
		openBase: async (input, hooks) => {
			opens.push({ dir: input.dir, label: input.label });
			if (open.trust === true) hooks.onTrust(true);
			await open.hold?.();
			if (open.trust === true) hooks.onTrust(false);
			return open.outcome;
		},
		record,
		redact: (t) => t,
		log: () => undefined,
	};
	const runner = new ProjectsRunner(deps);
	return { work, calls, opens, runner, rows: () => Object.fromEntries(runner.view().rows.map((r) => [r.folder, r])), record, open, deps };
}

const head = (dir: string): string => git(dir, "symbolic-ref", "refs/remotes/origin/HEAD").trim();

describe("the clone and the default branch (task 12 anchor)", () => {
	beforeEach(() => {
		bare("web", { branches: ["develop"] });
		bare("plain", { branches: ["develop"] });
	});

	it("clones into <work>/<folder>, makes origin/HEAD point at the recipe's defaultBranch although the server's HEAD is main, and opens the base with its label", async () => {
		const r = rig();
		await r.runner.begin([spec("web", { defaultBranch: "develop", label: "官網" })]);
		assert.equal(r.rows().web?.phase, "done", JSON.stringify(r.rows().web));
		assert.equal(r.rows().web?.reused, false);
		assert.equal(head(join(r.work, "web")), "refs/remotes/origin/develop");
		assert.deepEqual(r.opens, [{ dir: join(r.work, "web"), label: "官網" }]);
		assert.equal(r.rows().web?.opened, true);
	});

	it("keeps the code host's own default for a repository without defaultBranch, and runs no set-head for it", async () => {
		const r = rig();
		await r.runner.begin([spec("plain")]);
		assert.equal(r.rows().plain?.phase, "done");
		assert.equal(head(join(r.work, "plain")), "refs/remotes/origin/main");
		assert.equal(r.calls.some((c) => c[0] === "remote"), false, "no set-head call");
	});

	it("fails a defaultBranch that origin lacks for that repository alone, naming the repository and the branch, and goes on to the next", async () => {
		const r = rig();
		await r.runner.begin([spec("web", { defaultBranch: "no-such-branch" }), spec("plain")]);
		const web = r.rows().web;
		assert.equal(web?.phase, "failed");
		assert.deepEqual(web?.failure, { kind: "branch-missing", branch: "no-such-branch" });
		assert.equal(web?.folder, "web");
		assert.equal(r.rows().plain?.phase, "done", "the other repository is not held up");
		assert.deepEqual(r.opens.map((o) => o.label), ["plain"], "a repository that failed is not opened");
	});

	it("a recipe update that changes defaultBranch runs set-head again for that repository and touches nothing else; an unchanged one is not touched", async () => {
		const r = rig();
		const v1 = [spec("web", { defaultBranch: "develop" }), spec("plain")];
		await r.runner.begin(v1);
		assert.equal(head(join(r.work, "web")), "refs/remotes/origin/develop");
		r.calls.length = 0;
		r.opens.length = 0;
		// The same recipe again: nothing runs.
		await r.runner.update(v1, v1);
		assert.deepEqual(r.calls, [], "an update that changes nothing runs no Git");
		assert.deepEqual(r.opens, []);
		// defaultBranch moves from develop to main for web: set-head only.
		const v2 = [spec("web", { defaultBranch: "main" }), spec("plain")];
		await r.runner.update(v1, v2);
		assert.equal(head(join(r.work, "web")), "refs/remotes/origin/main");
		assert.deepEqual(r.calls, [["remote", "set-head", "origin", "main"]], "set-head for web alone: no clone, no fetch, no listing");
		assert.deepEqual(r.opens, [], "and the base stays as it was");
		assert.equal(r.rows().web?.opened, true);
		assert.equal(r.rows().web?.phase, "done");
		// A branch the update names that origin lacks fails that repository alone.
		await r.runner.update(v2, [spec("web", { defaultBranch: "nope" }), spec("plain")]);
		assert.deepEqual(r.rows().web?.failure, { kind: "branch-missing", branch: "nope" });
		assert.equal(r.rows().plain?.phase, "done");
	});

	it("a repository the update adds is cloned and opened; one it drops leaves the list and stays on disk", async () => {
		const r = rig();
		await r.runner.begin([spec("web", { defaultBranch: "develop" })]);
		await r.runner.update([spec("web", { defaultBranch: "develop" })], [spec("plain")]);
		assert.deepEqual(Object.keys(r.rows()), ["plain"]);
		assert.ok(existsSync(join(r.work, "web", ".git")), "the dropped repository's folder stays");
		assert.equal(r.rows().plain?.phase, "done");
		assert.deepEqual(r.opens.map((o) => o.label), ["web", "plain"]);
	});
});

describe("an existing folder", () => {
	beforeEach(() => bare("web", { branches: ["develop"] }));

	it("with the same origin is fetched and reused, and with a trailing .git or slash it is still the same address", async () => {
		const r = rig();
		await r.runner.begin([spec("web")]);
		const again = rig("darwin", { work: r.work, stateDir: join(r.work, "..", "state-2") });
		await again.runner.begin([spec("web", { url: "https://git.fixture.test/web" })]);
		assert.equal(again.rows().web?.phase, "done", JSON.stringify(again.rows().web));
		assert.equal(again.rows().web?.reused, true);
		assert.ok(again.calls.some((c) => c[0] === "fetch"), "it was fetched");
		assert.equal(again.calls.some((c) => c[0] === "clone"), false);
	});

	it("with another origin is reported and untouched: nothing is fetched, cloned or changed", async () => {
		const r = rig();
		const folder = join(r.work, "web");
		mkdirSync(folder, { recursive: true });
		git(folder, "init", "-q", "-b", "main");
		git(folder, "remote", "add", "origin", "https://git.fixture.test/something-else.git");
		writeFileSync(join(folder, "mine.txt"), "mine\n");
		const configBefore = readFileSync(join(folder, ".git", "config"), "utf8");
		await r.runner.begin([spec("web", { defaultBranch: "develop" })]);
		const row = r.rows().web;
		assert.equal(row?.phase, "failed");
		assert.deepEqual(row?.failure, { kind: "other-origin" });
		assert.equal(readFileSync(join(folder, "mine.txt"), "utf8"), "mine\n");
		assert.equal(readFileSync(join(folder, ".git", "config"), "utf8"), configBefore, "the repository's configuration is as it was");
		assert.deepEqual(r.calls.map((c) => c[0]), ["config"], "Git was asked for the origin and nothing else");
		assert.deepEqual(r.opens, []);
	});

	it("that is a repository without an origin, one that is not empty and not a repository, and a file are refused the same way", async () => {
		const r = rig();
		mkdirSync(join(r.work, "web"), { recursive: true });
		git(join(r.work, "web"), "init", "-q");
		await r.runner.begin([spec("web")]);
		assert.deepEqual(r.rows().web?.failure, { kind: "other-origin" });
		const s = rig();
		mkdirSync(join(s.work, "web"), { recursive: true });
		writeFileSync(join(s.work, "web", "notes.txt"), "x");
		await s.runner.begin([spec("web")]);
		assert.deepEqual(s.rows().web?.failure, { kind: "not-empty" });
		assert.deepEqual(s.calls, []);
		const t = rig();
		mkdirSync(t.work, { recursive: true });
		writeFileSync(join(t.work, "web"), "a file");
		await t.runner.begin([spec("web")]);
		assert.deepEqual(t.rows().web?.failure, { kind: "not-empty" });
	});

	it("that is empty is cloned into", async () => {
		const r = rig();
		mkdirSync(join(r.work, "web"), { recursive: true });
		await r.runner.begin([spec("web")]);
		assert.equal(r.rows().web?.phase, "done");
		assert.equal(r.rows().web?.reused, false);
	});

	it("shows an address with user info only without it, and never in the failure", async () => {
		const r = rig();
		const folder = join(r.work, "web");
		mkdirSync(folder, { recursive: true });
		git(folder, "init", "-q");
		git(folder, "remote", "add", "origin", "https://user:hunter2@git.fixture.test/other.git");
		await r.runner.begin([spec("web")]);
		assert.equal(JSON.stringify(r.rows().web).includes("hunter2"), false);
	});
});

describe("the folder named Straw Boss", () => {
	it("is the home base's folder in the app and in the validator", () => {
		assert.equal(HOME_BASE_FOLDER, HOME_BASE_LABEL);
	});

	it("is refused for a repository before anything is created, whatever its case", async () => {
		bare("sb");
		for (const folder of ["Straw Boss", "straw boss", "STRAW BOSS"]) {
			const r = rig();
			await r.runner.begin([spec("sb", { folder })]);
			assert.deepEqual(r.rows()[folder]?.failure, { kind: "reserved-folder" });
			assert.deepEqual(r.calls, []);
			assert.equal(existsSync(r.work), false, "not even the work folder was made");
		}
	});

	it("refuses a folder that is not a single name", async () => {
		bare("sb");
		const r = rig();
		await r.runner.begin([spec("sb", { folder: "../outside" })]);
		assert.equal(r.rows()["../outside"]?.phase, "failed");
		assert.deepEqual(r.calls, []);
	});
});

describe("the Windows symlink check", () => {
	beforeEach(() => {
		bare("links", { links: [".agents/skills", ".claude/commands", "docs/link"], realFiles: {}, files: { ".pi/settings.json": "{}\n", "README.md": "x\n" } });
		bare("clean", { files: { ".pi/settings.json": "{}\n", ".agents/real/SKILL.md": "x\n" } });
	});

	it("names the repository's links under .agents, .pi and .claude, not a link outside them, and the repository is still opened", async () => {
		const r = rig("win32");
		await r.runner.begin([spec("links")]);
		const row = r.rows().links;
		assert.equal(row?.phase, "done", JSON.stringify(row));
		assert.deepEqual(row?.links, { paths: [".agents/skills", ".claude/commands"], more: 0 });
		assert.equal(row?.opened, true);
		assert.ok(r.calls.some((c) => c[0] === "ls-files" && c.join(" ") === "ls-files -s -z -- .agents .pi .claude"));
	});

	it("shows the sentence again when the same folder is reused", async () => {
		const first = rig("win32");
		await first.runner.begin([spec("links")]);
		const second = rig("win32", { work: first.work, stateDir: join(first.work, "..", "state-b") });
		await second.runner.begin([spec("links")]);
		assert.equal(second.rows().links?.reused, true);
		assert.deepEqual(second.rows().links?.links?.paths, [".agents/skills", ".claude/commands"]);
	});

	it("shows no sentence for a repository without such entries", async () => {
		const r = rig("win32");
		await r.runner.begin([spec("clean")]);
		assert.equal(r.rows().clean?.phase, "done");
		assert.equal(r.rows().clean?.links, null);
		assert.ok(r.calls.some((c) => c[0] === "ls-files"), "the check ran");
	});

	it("runs no Git process for the check on macOS, and shows no sentence for the same fixture", async () => {
		const r = rig("darwin");
		await r.runner.begin([spec("links")]);
		assert.equal(r.rows().links?.phase, "done");
		assert.equal(r.rows().links?.links, null);
		assert.equal(r.calls.some((c) => c[0] === "ls-files"), false);
	});

	it("names ten paths and counts the rest", async () => {
		bare("many", { links: Array.from({ length: 13 }, (_, i) => `.agents/link-${String(i).padStart(2, "0")}`) });
		const r = rig("win32");
		await r.runner.begin([spec("many")]);
		assert.equal(r.rows().many?.links?.paths.length, 10);
		assert.equal(r.rows().many?.links?.more, 3);
	});

	it("never writes core.symlinks: the app's code has no such setting", () => {
		const roots = [join(import.meta.dirname, "..", "src", "main")];
		const hits: string[] = [];
		const walk = (dir: string): void => {
			for (const name of require_readdir(dir)) {
				const file = join(dir, name);
				if (statSync(file).isDirectory()) walk(file);
				else if (file.endsWith(".ts")) {
					readFileSync(file, "utf8")
						.split("\n")
						.forEach((line, i) => {
							// A comment may explain the rule; code may not set it.
							const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
							if (/symlinks/i.test(code) && !/^\s*\*/.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
						});
				}
			}
		};
		for (const root of roots) walk(root);
		assert.deepEqual(hits, []);
	});
});

import { readdirSync } from "node:fs";
const require_readdir = (dir: string): string[] => readdirSync(dir);

describe("opening the base", () => {
	beforeEach(() => bare("web"));

	it("a refusal fails that repository with its cause and keeps the clone; Retry opens it, without cloning again", async () => {
		const r = rig();
		r.open.outcome = { ok: false, cause: "settings-unsafe", reason: "The folder's settings ask for something not allowed" };
		await r.runner.begin([spec("web")]);
		assert.deepEqual(r.rows().web?.failure, { kind: "open", cause: "settings-unsafe" });
		assert.equal(r.rows().web?.detail, "The folder's settings ask for something not allowed");
		assert.ok(existsSync(join(r.work, "web", ".git")));
		r.open.outcome = { ok: true };
		r.calls.length = 0;
		await r.runner.retry(spec("web"));
		assert.equal(r.rows().web?.phase, "done");
		assert.equal(r.rows().web?.reused, true, "the second pass found the clone and fetched it");
		assert.equal(r.calls.some((c) => c[0] === "clone"), false);
	});

	it("holds on a trust question without blocking the step, and the row says so until the answer", async () => {
		const r = rig();
		r.open.trust = true;
		let release: () => void = () => undefined;
		r.open.hold = () => new Promise<void>((resolve) => (release = resolve));
		const done = r.runner.begin([spec("web")]);
		for (let i = 0; i < 200 && r.rows().web?.phase !== "trust"; i++) await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(r.rows().web?.phase, "trust");
		assert.equal(r.runner.view().held, true);
		assert.equal(r.runner.view().running, false, "waiting for the PM is not running work");
		release();
		await done;
		assert.equal(r.rows().web?.phase, "done");
		assert.equal(r.runner.view().held, false);
	});

	it("does not open a base a second time: an earlier run that opened it is remembered", async () => {
		const r = rig();
		await r.runner.begin([spec("web")]);
		assert.equal(r.opens.length, 1);
		const again = rig("darwin", { work: r.work, stateDir: join(r.work, "..", "state") });
		await again.runner.begin([spec("web")]);
		assert.equal(again.opens.length, 0, "the finished row is left alone");
		assert.deepEqual(again.calls, []);
	});

	it("goes on from the repositories that are left after a quit: a row that was working reads as interrupted and runs again", async () => {
		bare("plain");
		const r = rig();
		await r.runner.begin([spec("web")]);
		// A record that says the second row was working when the app stopped.
		const saved = r.record.read();
		assert.ok(saved !== null);
		r.record.write({ ...saved, rows: [...saved.rows, { ...saved.rows[0]!, folder: "plain", label: "plain", url: "https://git.fixture.test/plain.git", phase: "working", step: "cloning", opened: false }] });
		const next = rig("darwin", { work: r.work, stateDir: join(r.work, "..", "state") });
		assert.deepEqual(next.rows().plain?.failure, { kind: "interrupted" });
		await next.runner.begin([spec("web"), spec("plain")]);
		assert.equal(next.rows().plain?.phase, "done");
		assert.deepEqual(next.opens.map((o) => o.label), ["plain"], "web was done and is left alone");
	});

	it("reports a clone that fails as a cause the page words: a repository that does not exist", async () => {
		const r = rig();
		await r.runner.begin([spec("missing")]);
		assert.equal(r.rows().missing?.phase, "failed");
		assert.equal(r.rows().missing?.failure?.kind, "clone");
		assert.equal(r.opens.length, 0);
		cpSync(join(base, "remote", "web.git"), join(base, "remote", "missing.git"), { recursive: true });
		await r.runner.retry(spec("missing"));
		assert.equal(r.rows().missing?.phase, "done", "each row is retryable alone");
	});
});
