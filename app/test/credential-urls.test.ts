import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { credUrl } from "./harness/cred-url.ts";

// GitGuardian incident 39413346 and T8C-F003: no line of the repository is a URL with a user name and a password in front of the host, not even a placeholder in a comment or a
// document, since a generic secret scanner reports those too. Tests that need one build it at run time (`credUrl`). The pattern is the one the review used with `git grep`.
const PATTERN = String.raw`://[^/ :@]+:[^/ @]+@`;
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The tracked lines that match, or an empty list; `git grep` exits 1 when nothing matches. */
function trackedHits(): string[] {
	try {
		return execFileSync("git", ["grep", "-nE", PATTERN], { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).split("\n").filter(Boolean);
	} catch (error) {
		const failed = error as { status?: number | null };
		if (failed.status === 1) return [];
		throw error;
	}
}

describe("no literal URL with a user name and a password in the repository (T8C-F003)", () => {
	it("has the pattern match a built URL and leave plain ones alone", () => {
		const re = new RegExp(PATTERN);
		assert.equal(re.test(credUrl("http://alice<c>s3cret@proxy.example:8080")), true);
		assert.equal(re.test(credUrl("https://u<c>p%40ss@10.0.0.1:3128/path")), true);
		for (const clean of ["ssh://git@host/repo.git", "http://127.0.0.1:8080/", "see https://example.test/a:b@c"]) assert.equal(re.test(clean), false, clean);
	});

	it("finds no tracked line that matches", () => {
		assert.deepEqual(trackedHits(), []);
	});
});
