import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BRANCH_OF, DEFAULT_BRANCH, hasBranch, headRef, parseListing, runPushCheck, sweepTargets, type GitResult, type GitRun } from "./harness/ci-push-check.ts";

// The CI push check's rules on a stand-in remote (task 10, T10R-F004): the default branch is never named in a command, old `sbd-ci-*` branches go before the push, one fixed branch per OS is pushed and
// deleted in a `finally`, and nothing else on the project is touched.

const PROJECT = "https://gitlab.example/test/project.git";
const SHA = "0123456789abcdef0123456789abcdef01234567";

interface Remote {
	heads: string[];
	head: string;
	commands: string[][];
	/** The push of the run's own branch reports this exit code, whatever the server did. */
	pushExit?: number;
	/** The server takes the pushed branch even when the push reports a failure (a timeout after the ref was written). */
	acceptsOnFailure?: boolean;
	/** Deleting these branches fails. */
	undeletable?: string[];
	/** Every `ls-remote` fails. */
	listFails?: boolean;
	/** Tags of the remote. A delete that names a bare short name takes the tag of that name first, as git resolves an ambiguous name; a qualified `refs/heads/` name never does. */
	tags?: string[];
	/** Longer paths whose tail is a branch name (`x/<name>`): an `ls-remote` pattern matches them too. */
	tailPaths?: string[];
	/** The look of the `finally` (the second `ls-remote` after the push) fails once (a flaky network), so it cannot see whether the branch is there and deletes it by name. */
	lookFailsOnce?: boolean;
	looks?: number;
}

function remote(over: Partial<Remote> = {}): { git: GitRun; state: Remote } {
	const state: Remote = { heads: [DEFAULT_BRANCH], head: DEFAULT_BRANCH, commands: [], ...over };
	const git: GitRun = async (args): Promise<GitResult> => {
		state.commands.push([...args]);
		if (args[0] === "ls-remote") {
			if (state.listFails) return { code: 128, stdout: "" };
			const pattern = args.at(-1) as string;
			if (state.lookFailsOnce && !args.includes("--symref") && state.commands.some((c) => c[0] === "push" && !c.includes("--delete") && c.includes("--force"))) {
				state.looks = (state.looks ?? 0) + 1;
				if (state.looks === 2) return { code: 128, stdout: "" };
			}
			const names = args.includes("--symref") ? state.heads : state.heads.filter((h) => pattern === "refs/heads/*" || `refs/heads/${h}` === pattern);
			const tails = args.includes("--symref") ? [] : (state.tailPaths ?? []).filter((p) => pattern === `refs/heads/${p.split("/").at(-1)}`).map((p) => `${SHA}\trefs/heads/${p}`);
			const symref = args.includes("--symref") && state.heads.length > 0 ? [`ref: refs/heads/${state.head}\tHEAD`, `${SHA}\tHEAD`] : [];
			return { code: 0, stdout: [...symref, ...names.map((h) => `${SHA}\trefs/heads/${h}`), ...tails].join("\n") };
		}
		if (args[0] === "push" && args.includes("--delete")) {
			const target = args.at(-1) as string;
			// A bare short name resolves to a tag of that name first; `refs/heads/<name>` is only ever the branch.
			if (!target.startsWith("refs/") && state.tags?.includes(target)) {
				state.tags = state.tags.filter((t) => t !== target);
				return { code: 0, stdout: "" };
			}
			const name = target.replace(/^refs\/heads\//, "");
			if (name === state.head || state.undeletable?.includes(name)) return { code: 1, stdout: "", stderr: "remote: error: cannot delete" };
			state.heads = state.heads.filter((h) => h !== name);
			return { code: 0, stdout: "" };
		}
		if (args[0] === "push") {
			const name = (args.at(-1) as string).replace("HEAD:refs/heads/", "");
			const exit = state.pushExit ?? 0;
			if (exit === 0 || state.acceptsOnFailure) if (!state.heads.includes(name)) state.heads.push(name);
			return { code: exit, stdout: "" };
		}
		return { code: 1, stdout: "" };
	};
	return { git, state };
}

const own = BRANCH_OF.darwin;
const deletes = (s: Remote): string[] => s.commands.filter((c) => c.includes("--delete")).map((c) => (c.at(-1) as string).replace(/^refs\/heads\//, ""));
const mentionsDefault = (s: Remote): string[][] => s.commands.filter((c) => c.some((a) => a.includes(DEFAULT_BRANCH) && !a.startsWith("refs/heads/*")));

describe("the CI push check", () => {
	it("sweeps old sbd-ci branches, never names the default branch, pushes the fixed branch and deletes it", async () => {
		const r = remote({ heads: [DEFAULT_BRANCH, "sbd-ci-mw1nriff-20474", "sbd-ci-mw1nufw4-7780", own, BRANCH_OF.win32, "main", "feature/x"] });
		const lines: string[] = [];
		const result = await runPushCheck({ git: r.git, project: PROJECT, branch: own, log: (l) => lines.push(l) });
		assert.deepEqual([...result.swept].sort(), ["sbd-ci-macos", "sbd-ci-mw1nriff-20474", "sbd-ci-mw1nufw4-7780"], "this run's own name left from a killed run goes with the old ones");
		assert.equal(result.pushed, true);
		assert.deepEqual(mentionsDefault(r.state), [], "no command names the default branch");
		assert.deepEqual(r.state.heads.sort(), [DEFAULT_BRANCH, BRANCH_OF.win32, "feature/x", "main"].sort(), "what is left is the default branch, the other OS's branch, and branches that are not ours");
		assert.ok(!deletes(r.state).includes("main") && !deletes(r.state).includes("feature/x"), "only sbd-ci-* branches are deleted");
		assert.ok(lines.some((l) => /swept 3 old/.test(l)));
		// The order: the listing, the sweep, the push, the check, the delete.
		const kinds = r.state.commands.map((c) => (c[0] === "ls-remote" ? "ls" : c.includes("--delete") ? `del:${c.at(-1)}` : "push"));
		const firstPush = kinds.indexOf("push");
		assert.ok(kinds.slice(0, firstPush).filter((k) => k.startsWith("del:")).length === 3, "every sweep delete comes before the push");
		assert.equal(kinds.at(-1), `del:${headRef(own)}`, "the last command deletes this run's own branch");
	});

	it("never sweeps the other OS's branch, and sweeps its own leftover", async () => {
		const r = remote({ heads: [DEFAULT_BRANCH, BRANCH_OF.win32, BRANCH_OF.darwin] });
		await runPushCheck({ git: r.git, project: PROJECT, branch: BRANCH_OF.darwin });
		assert.ok(!deletes(r.state).slice(0, -1).includes(BRANCH_OF.win32), "the Windows job may be using its branch");
		assert.ok(r.state.heads.includes(BRANCH_OF.win32));
		assert.ok(!r.state.heads.includes(BRANCH_OF.darwin));
	});

	it("deletes the pushed branch when the push reports a failure after the server took it", async () => {
		const r = remote({ pushExit: 1, acceptsOnFailure: true });
		await assert.rejects(runPushCheck({ git: r.git, project: PROJECT, branch: own }), /push exited 1/);
		assert.ok(!r.state.heads.includes(own), "nothing of this run is left on the project");
		assert.ok(deletes(r.state).includes(own), "the finally block deleted it");
	});

	it("a push that failed and left nothing deletes nothing", async () => {
		const r = remote({ pushExit: 1 });
		await assert.rejects(runPushCheck({ git: r.git, project: PROJECT, branch: own }), /push exited 1/);
		assert.deepEqual(deletes(r.state), []);
	});

	it("a delete that fails and leaves the branch on the project is an error that says so; the next run sweeps it", async () => {
		const r = remote({ undeletable: [own] });
		await assert.rejects(runPushCheck({ git: r.git, project: PROJECT, branch: own }), /still on the project/);
		const next = remote({ heads: [DEFAULT_BRANCH, own] });
		await runPushCheck({ git: next.git, project: PROJECT, branch: own });
		assert.deepEqual(next.state.heads, [DEFAULT_BRANCH]);
	});

	it("an old branch that cannot be deleted does not stop the check, and is reported", async () => {
		const r = remote({ heads: [DEFAULT_BRANCH, "sbd-ci-old-1"], undeletable: ["sbd-ci-old-1"] });
		const lines: string[] = [];
		const result = await runPushCheck({ git: r.git, project: PROJECT, branch: own, log: (l) => lines.push(l) });
		assert.deepEqual(result.sweepFailed, ["sbd-ci-old-1"]);
		assert.equal(result.pushed, true);
		assert.ok(lines.some((l) => /could not delete sbd-ci-old-1/.test(l)));
	});

	it("a project with no branch is only read", async () => {
		const r = remote({ heads: [] });
		const result = await runPushCheck({ git: r.git, project: PROJECT, branch: own });
		assert.equal(result.skipped, true);
		assert.deepEqual(r.state.commands.map((c) => c[0]), ["ls-remote"], "no push, no delete");
	});

	it("a listing that fails fails the check before anything is changed", async () => {
		const r = remote({ listFails: true });
		await assert.rejects(runPushCheck({ git: r.git, project: PROJECT, branch: own }), /ls-remote of the private test project exited 128/);
		assert.deepEqual(r.state.commands.map((c) => c[0]), ["ls-remote"]);
	});

	it("refuses to push or delete the default branch or a branch that is not an sbd-ci one, whatever it is called", async () => {
		for (const name of [DEFAULT_BRANCH, "main", "sbd-ci-*", "sbd-ci-a b"]) {
			const r = remote();
			await assert.rejects(runPushCheck({ git: r.git, project: PROJECT, branch: name }), /refusing to touch/, name);
			assert.deepEqual(r.state.commands, [], `${name}: no command ran`);
		}
		// A project whose HEAD is another sbd-ci branch is protected too.
		const r = remote({ heads: ["sbd-ci-new-default", "sbd-ci-stale"], head: "sbd-ci-new-default" });
		await runPushCheck({ git: r.git, project: PROJECT, branch: own });
		assert.ok(r.state.heads.includes("sbd-ci-new-default"), "the branch HEAD points at stays");
		assert.ok(!deletes(r.state).includes("sbd-ci-new-default"));
	});

	it("names every branch by its full ref: a push, a delete and a look never reach a tag of the same short name (T10RR-F004)", async () => {
		const r = remote({ heads: [DEFAULT_BRANCH, "sbd-ci-old-1"], tags: [own, "sbd-ci-old-1"], lookFailsOnce: true });
		await runPushCheck({ git: r.git, project: PROJECT, branch: own });
		const mutating = r.state.commands.filter((c) => c[0] === "push");
		assert.ok(mutating.length >= 3, "the sweep, the push and the delete ran");
		for (const c of mutating) assert.ok((c.at(-1) as string).includes("refs/heads/"), `${c.join(" ")} names the full ref`);
		assert.deepEqual(r.state.tags.sort(), [own, "sbd-ci-old-1"].sort(), "no tag was deleted");
		assert.ok(!r.state.heads.includes(own) && !r.state.heads.includes("sbd-ci-old-1"), "the branches were");
		for (const c of r.state.commands.filter((x) => x[0] === "ls-remote" && !x.includes("--symref"))) assert.equal(c.at(-1)?.startsWith("refs/heads/"), true, `${c.join(" ")} looks for the full ref`);
	});

	it("takes an ls-remote line for the branch only when its ref is exactly refs/heads/<name> (T10RR-F004)", async () => {
		assert.equal(hasBranch(`${SHA}\trefs/heads/${own}`, own), true);
		assert.equal(hasBranch(`${SHA}\trefs/heads/x/${own}`, own), false, "a longer path that ends in the name is another ref");
		assert.equal(hasBranch(`${SHA}\trefs/tags/${own}`, own), false);
		assert.equal(hasBranch("", own), false);
		assert.equal(headRef(own), `refs/heads/${own}`);
		// A pushed branch is "there" only by its exact ref; a tail path with the same last part is not.
		const r = remote({ tailPaths: [`x/${own}`], pushExit: 0 });
		await runPushCheck({ git: r.git, project: PROJECT, branch: own });
		assert.ok(!r.state.heads.includes(own));
	});

	it("reads a listing, and picks the sweep's targets from it", () => {
		const listing = parseListing(`ref: refs/heads/sbd-ci-mw1lovby-21505\tHEAD\n${SHA}\tHEAD\n${SHA}\trefs/heads/sbd-ci-mw1lovby-21505\n${SHA}\trefs/heads/sbd-ci-x\n${SHA}\trefs/heads/main\n`);
		assert.deepEqual(listing, { heads: ["sbd-ci-mw1lovby-21505", "sbd-ci-x", "main"], head: "sbd-ci-mw1lovby-21505" });
		assert.deepEqual(sweepTargets(listing, { own }), ["sbd-ci-x"]);
	});
});
