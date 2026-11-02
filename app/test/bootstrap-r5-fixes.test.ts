import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { StageError } from "../src/main/bootstrap/errors.ts";
import { extractSelfExtractor } from "../src/main/bootstrap/extract.ts";
import { asideName, asideNumber, freeAside, removeAside, removeTree, sha256File, type FsOps } from "../src/main/bootstrap/fsutil.ts";
import { sweepLeftovers } from "../src/main/bootstrap/graph.ts";
import type { CommandRunner } from "../src/main/platform/index.ts";
import { scratchRoot, testLayout } from "./harness/engine-fixture.ts";

// Task 8a closes the task 5b recheck's R5-F001 (the sweep restores the newest aside by recorded order, and a failed restore is caught), R5-F002 (a held
// leftover is tried once, not with 11 s of retries) and R5-F003 (the self-extractor keeps the `locked` failure when its staging folder cannot be deleted).
// Each case fails when its fix is reverted.

const scratch: string[] = [];
after(() => {
	for (const d of scratch) {
		try {
			chmodTree(d);
		} catch {
			// best effort
		}
		removeTree(d);
	}
});
const fresh = (): { base: string; root: string } => {
	const made = scratchRoot("sbd-r5-");
	scratch.push(made.base);
	return made;
};
const isWindows = process.platform === "win32";
const posixOnly = isWindows ? "POSIX file modes" : false;

function chmodTree(dir: string): void {
	if (isWindows || !existsSync(dir)) return;
	chmodSync(dir, 0o755);
	for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) chmodTree(join(dir, entry.name));
}

/** A stand-in for the file system of Windows: the asides matching `held` cannot be deleted (a running program holds them); everything else is deleted for real. */
const holding = (held: RegExp, calls: { tree: string[]; aside: string[] } = { tree: [], aside: [] }): FsOps & { calls: typeof calls } => {
	const refuse = (path: string): void => {
		throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${path}'`), { code: "EPERM" });
	};
	return {
		calls,
		removeTree(path) {
			calls.tree.push(path);
			if (held.test(path)) refuse(path);
			removeTree(path);
		},
		removeAside(path) {
			calls.aside.push(path);
			if (held.test(path)) refuse(path);
			removeAside(path);
		},
		renameRetry() {
			throw new Error("not used");
		},
	};
};

describe("asideNumber", () => {
	it("reads .replaced as 1 and .replaced-<n> as n, and nothing else", () => {
		const target = join("x", "bun.exe");
		assert.equal(asideNumber(target, "bun.exe.replaced"), 1);
		assert.equal(asideNumber(target, "bun.exe.replaced-2"), 2);
		assert.equal(asideNumber(target, "bun.exe.replaced-17"), 17);
		for (const name of ["bun.exe", "bun.exe.replaced-1", "bun.exe.replaced-0", "bun.exe.replaced-", "bun.exe.replaced-2x", "bun.exe.replaced.old", "gh.replaced", "bun.exe.staging"]) {
			assert.equal(asideNumber(target, name), null, name);
		}
	});
});

describe("R5-F001: the newest aside has the highest number", () => {
	it("a replace after the sweep deleted .replaced but .replaced-2 is still held uses .replaced-3, not .replaced", () => {
		const { base } = fresh();
		const dir = join(base, "bin");
		mkdirSync(dir);
		const target = join(dir, "bun.exe");
		writeFileSync(target, "current");
		writeFileSync(`${target}.replaced-2`, "old, held by a running process");
		const ops = holding(/\.replaced-2$/);
		const held: string[] = [];
		const aside = freeAside(target, ops, (path) => held.push(path));
		assert.equal(aside, asideName(target, 3));
		assert.deepEqual(held, [`${target}.replaced-2`]);
		assert.equal(existsSync(`${target}.replaced-2`), true, "the held copy stays");
	});

	it("with nothing held the first name is used again, and every leftover is deleted", () => {
		const { base } = fresh();
		const target = join(base, "gh");
		writeFileSync(target, "current");
		writeFileSync(`${target}.replaced`, "old");
		writeFileSync(`${target}.replaced-2`, "older");
		assert.equal(freeAside(target), asideName(target, 1));
		assert.deepEqual(readdirSync(base).filter((n) => n.startsWith("gh")), ["gh"]);
	});

	it("two held copies: the next name is above both", () => {
		const { base } = fresh();
		const target = join(base, "bun.exe");
		writeFileSync(`${target}.replaced`, "held");
		writeFileSync(`${target}.replaced-2`, "held");
		assert.equal(freeAside(target, holding(/\.replaced(-\d+)?$/)), asideName(target, 3));
	});

	it("the sweep puts the highest aside back when the original is missing and the lowest was deleted earlier", () => {
		const { root } = fresh();
		const layout = testLayout(root);
		mkdirSync(layout.tools.bin, { recursive: true });
		// What the sequence of the recheck leaves: n2 is the older held copy, n3 the copy the record names, and n1 was reused and deleted.
		writeFileSync(join(layout.tools.bin, "bun.exe.replaced-2"), "older, held");
		writeFileSync(join(layout.tools.bin, "bun.exe.replaced-3"), "the current file, moved aside by the replace that was killed");
		const swept = sweepLeftovers(layout);
		assert.deepEqual(swept.restored, [join(layout.tools.bin, "bun.exe.replaced-3")]);
		assert.equal(readFileSync(join(layout.tools.bin, "bun.exe"), "utf8"), "the current file, moved aside by the replace that was killed");
		assert.deepEqual(readdirSync(layout.tools.bin), ["bun.exe"]);
	});

	it("a restore that cannot be done is reported as kept, and the sweep goes on without throwing", () => {
		const { root } = fresh();
		const layout = testLayout(root);
		mkdirSync(join(layout.tools.root, "node", "24.0.0.replaced"), { recursive: true });
		mkdirSync(join(layout.tools.root, "node", "23.0.0.replaced"), { recursive: true });
		mkdirSync(join(layout.tools.root, "node", "22.0.0.staging"), { recursive: true });
		const moves: string[] = [];
		const swept = sweepLeftovers(layout, {
			rename: (from) => {
				moves.push(from);
				throw Object.assign(new Error("EBUSY: resource busy or locked, rename"), { code: "EBUSY" });
			},
		});
		assert.deepEqual(moves.sort(), [join(layout.tools.root, "node", "23.0.0.replaced"), join(layout.tools.root, "node", "24.0.0.replaced")]);
		assert.deepEqual(swept.restored, []);
		assert.deepEqual(swept.kept.map((k) => k.path).sort(), moves.sort());
		assert.match(swept.kept[0]?.error ?? "", /EBUSY/);
		assert.equal(existsSync(join(layout.tools.root, "node", "22.0.0.staging")), false, "the sweep went on past the failed restore");
	});
});

describe("R5-F002: a leftover is deleted with one attempt", () => {
	it("freeAside deletes its asides through removeAside and never through the retrying removeTree", () => {
		const { base } = fresh();
		const target = join(base, "bun.exe");
		writeFileSync(`${target}.replaced`, "old");
		const ops = holding(/^$/);
		freeAside(target, ops);
		assert.deepEqual(ops.calls.aside, [`${target}.replaced`]);
		assert.deepEqual(ops.calls.tree, []);
	});

	it("the sweep deletes a staging folder with remove and an aside with removeAside", () => {
		const { root } = fresh();
		const layout = testLayout(root);
		mkdirSync(layout.tools.bin, { recursive: true });
		writeFileSync(join(layout.tools.bin, "gh"), "new");
		writeFileSync(join(layout.tools.bin, "gh.replaced"), "old");
		mkdirSync(join(layout.tools.root, "git", "2.0.0.staging"), { recursive: true });
		const trees: string[] = [];
		const asides: string[] = [];
		sweepLeftovers(layout, { remove: (p) => (trees.push(p), removeTree(p)), removeAside: (p) => (asides.push(p), removeAside(p)) });
		assert.deepEqual(trees, [join(layout.tools.root, "git", "2.0.0.staging")]);
		assert.deepEqual(asides, [join(layout.tools.bin, "gh.replaced")]);
	});

	it("the real single attempt gives up at once on a copy it cannot delete", { skip: posixOnly }, () => {
		const { base } = fresh();
		const held = join(base, "held.replaced");
		mkdirSync(join(held, "inner"), { recursive: true });
		writeFileSync(join(held, "inner", "bun.exe"), "x");
		chmodSync(join(held, "inner"), 0o555);
		const began = Date.now();
		assert.throws(() => removeAside(held), /EACCES|EPERM|ENOTEMPTY/);
		assert.ok(Date.now() - began < 1500, `one attempt, took ${Date.now() - began} ms`);
	});
});

describe("R5-F003: the self-extractor keeps its locked failure when the staging folder cannot be deleted", () => {
	it("rethrows the locked StageError, not the file system's error, and leaves the folder for the next sweep", { skip: posixOnly }, async () => {
		const { base } = fresh();
		mkdirSync(join(base, "downloads"), { recursive: true });
		const installer = join(base, "downloads", "fake.7z.exe");
		writeFileSync(installer, "installer bytes");
		const sha = await sha256File(installer);
		const dest = join(base, "git", "2.0.0.staging");
		const run: CommandRunner = async (_file, args, options) => {
			const out = join(options?.cwd ?? ".", String(args[0]).slice(2));
			// A read-only folder holding a file: the stand-in for a tree a running program holds.
			mkdirSync(join(out, "usr"), { recursive: true });
			writeFileSync(join(out, "usr", "bash.exe"), "x");
			chmodSync(join(out, "usr"), 0o555);
			return { code: 0, stdout: "", stderr: "" };
		};
		await assert.rejects(
			extractSelfExtractor({ installer, sha256: sha, dest, run, processes: { listUnder: async () => [{ pid: 4242, startTime: "t", executable: join(dest, "usr", "bash.exe") }] } }),
			(e: unknown) => e instanceof StageError && e.category === "locked" && /bash\.exe \(pid 4242\) still runs/.test(e.message),
		);
		assert.equal(existsSync(join(dest, "usr", "bash.exe")), true, "the folder is still there");
		chmodTree(dest);
		const swept = sweepLeftovers(testLayout(join(base, "root")), {});
		assert.deepEqual(swept.kept, []);
	});
});
