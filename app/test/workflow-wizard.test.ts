import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// The shape of `wizard-from-zero.yml` that the spec's CI anchor fixes (Runners, Workflows; task 15), read as text: the two required runners on every push, the two nightly-only ones only on the
// schedule and on a dispatch that asks for them, and a dispatched run that no other run cancels.
const text = readFileSync(new URL("../../.github/workflows/wizard-from-zero.yml", import.meta.url), "utf8");
const matrix = /os: \$\{\{ fromJSON\(\((.*?)\) && '(\[.*?\])' \|\| '(\[.*?\])'\) \}\}/.exec(text);

describe("wizard-from-zero.yml runners", () => {
	it("runs windows-2025 and macos-15 by default", () => {
		assert.ok(matrix, "the matrix is one fromJSON choice between two lists");
		assert.deepEqual(JSON.parse(matrix[3] as string), ["windows-2025", "macos-15"]);
	});

	it("adds windows-11-arm and macos-15-intel on the schedule and on a dispatch with `runners: all`, and on nothing else", () => {
		assert.ok(matrix);
		assert.deepEqual(JSON.parse(matrix[2] as string), ["windows-2025", "macos-15", "windows-11-arm", "macos-15-intel"]);
		assert.equal(matrix[1], "github.event_name == 'schedule' || inputs.runners == 'all'");
	});

	it("has a nightly schedule and a dispatch input that offers `all`", () => {
		assert.match(text, /^  schedule:\n    - cron: "\d+ \d+ \* \* \*"$/m);
		assert.match(text, /^  workflow_dispatch:\n    inputs:\n      runners:\n(?:.*\n)*?        options: \[required, all\]\n        default: required$/m);
	});

	it("gives a dispatched run and the nightly a concurrency group of their own, so runs started one after another do not cancel each other and a push to main does not cancel the nightly (T15R-F004)", () => {
		assert.match(text, /group: wizard-from-zero-\$\{\{ \(github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'schedule'\) && github\.run_id \|\| github\.ref \}\}/);
	});

	it("builds the nightly-only runners as x64 and reads the update fixture at the ref under test", () => {
		assert.match(text, /PACK_ARCH: \$\{\{ \(matrix\.os == 'windows-11-arm' \|\| matrix\.os == 'macos-15-intel'\) && '--x64' \|\| '' \}\}/);
		assert.match(text, /SBD_RECIPE_FIXTURE_REF: \$\{\{ github\.head_ref \|\| github\.ref_name \}\}/);
	});

	it("relaxes the developer-tools check on macos-15-intel and nowhere else", () => {
		assert.deepEqual([...text.matchAll(/SBD_ASIDE_GIT_MAY_RUN: (.*)$/gm)].map((m) => m[1]), ["${{ matrix.os == 'macos-15-intel' && '1' || '' }}"]);
	});
});
