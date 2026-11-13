import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { flatScreen, NOT_TRUSTED_WARNING, plantProject, screenShows, seconds, trustAnswers, trustNotes } from "./trust-open.ts";

const scratch = mkdtempSync(join(tmpdir(), "sbd-trust-open-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe("the helpers of the trust e2e", () => {
	it("reads a wrapped, padded pane screen as one line", () => {
		const screen = "  This project is not trusted. Project .pi   \n  resources and packages are ignored.\n\n";
		assert.equal(flatScreen(screen), "This project is not trusted. Project .pi resources and packages are ignored.");
		assert.equal(screenShows(screen, NOT_TRUSTED_WARNING), true);
		assert.equal(screenShows("Trust project folder?\nThe question is in the Straw Boss window.", NOT_TRUSTED_WARNING), false);
	});

	it("takes a word that wraps across lines as one, and a non-ASCII character as a question mark", () => {
		assert.equal(flatScreen("Trust project\r\nfolder? \u2728 C:\\sbd \u6e2c\u8a66"), "Trust project folder? ? C:\\sbd ??");
	});

	it("plants the one entry pi gates behind trust, and nothing that runs", () => {
		const dir = join(scratch, "project");
		plantProject(dir);
		assert.equal(readFileSync(join(dir, ".pi", "settings.json"), "utf8").trim(), "{}");
		assert.ok(existsSync(join(dir, "README.md")));
		plantProject(dir);
	});

	it("counts only the trust lines of a return list", () => {
		const body = {
			report: {
				lines: [
					{ session: "a", tool: "project_trust", kind: "trust", count: 2, first: "t", gist: "not trusted for this session: /x" },
					{ session: "b", tool: "bash", kind: "refused", count: 5, first: "t", gist: "" },
					{ session: "c", tool: "project_trust", kind: "trust", first: "t", gist: "not trusted for this session: /y" },
				],
			},
		};
		assert.deepEqual(trustNotes(body).map((n) => [n.session, n.count]), [["a", 2], ["c", 1]]);
		assert.equal(trustAnswers(body), 3);
	});

	it("reads a missing report, a null report and a malformed one as no answer", () => {
		for (const body of [undefined, null, {}, { report: null }, { report: { lines: "x" } }, "text"]) assert.equal(trustAnswers(body), 0);
	});

	it("words a duration in seconds", () => {
		assert.equal(seconds(12_345), "12.3 s");
	});
});
