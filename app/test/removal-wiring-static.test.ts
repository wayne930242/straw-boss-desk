import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// `index.ts` runs Electron at import, so the two lines that connect the quit gate and the launch check to the app are pinned by their text (T14R-F001). The cases themselves are in quit-gate.test.ts and
// removal-small.test.ts.
const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "main", "index.ts"), "utf8");

describe("index.ts wiring of the removal's quit and launch handling (T14R-F001)", () => {
	it("a removal that ends with a quit asked shows its result in a window, opened if the PM had closed theirs", () => {
		const block = /removal\.onChange\(\(\) => \{([^]*?)\n\t\t\}\);/.exec(index)?.[1] ?? "";
		assert.match(block, /removal\.state\.phase === "done" && quitGate\.removalDone\(\)/);
		assert.match(block, /openWindow\(\);/);
		assert.match(block, /desk\?\.openSettings\("computer"\);/);
		assert.ok(block.indexOf("removalDone()") < block.indexOf("openWindow()"));
	});

	it("a launch that finds the removal's owner alive hands over before anything is created, and never exits silently ahead of the lock", () => {
		const block = /if \(early\.action === "handover"\) \{([^]*?)\n\}/.exec(index)?.[1] ?? "";
		assert.match(block, /handOver\(\{/);
		assert.match(block, /requestSingleInstanceLock\(\)/);
		assert.match(block, /process\.exit\(0\)/);
		assert.ok(index.indexOf('early.action === "handover"') < index.indexOf("mkdirSync(electronDir(root)"), "before the root's folders are made");
		assert.match(index, /if \(early\.action === "stop" \|\| early\.action === "exit"\) process\.exit\(early\.code\);/);
	});

	it("the cleanup is armed with whether the marker was written, and passes it on", () => {
		assert.match(index, /pendingCleanup: \{ root: string; fallbackDir: string \| null; marked: boolean \}/);
		assert.match(index, /fallbackDir: spec\.fallbackDir, marked: spec\.marked/);
	});
});
