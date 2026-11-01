import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { MACHINE_CHANGING, scanForMachineChanges, SPEC_COMMAND_WORDS } from "./harness/fixture-scan.ts";

const testRoot = import.meta.dirname;
const scratch: string[] = [];
function plant(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "sbd-scan-"));
	scratch.push(root);
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(join(root, rel, ".."), { recursive: true });
		writeFileSync(join(root, rel), text);
	}
	return root;
}
after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

describe("fixture scan", () => {
	it("finds no machine-changing command in app/test outside the harness", () => {
		assert.deepEqual(scanForMachineChanges(testRoot), []);
	});

	it("fails on a planted keychain add command in a test file outside the harness", () => {
		const sample = MACHINE_CHANGING.find((p) => p.name === "store-add")?.sample;
		assert.ok(sample);
		const root = plant({ "e2e/planted.e2e.ts": `await run("${sample}");\n` });
		assert.deepEqual(scanForMachineChanges(root), [{ file: join("e2e", "planted.e2e.ts"), line: 1, pattern: "store-add" }]);
	});

	it("leaves the harness folder alone", () => {
		const sample = MACHINE_CHANGING[0]?.sample ?? "";
		const root = plant({ "harness/hosted.ts": `${sample}\n`, "plain.test.ts": "nothing here\n" });
		assert.deepEqual(scanForMachineChanges(root), []);
	});

	it("catches each listed command, with the sample line it carries", () => {
		for (const p of MACHINE_CHANGING) {
			assert.ok(p.re.test(p.sample), `${p.name} does not match its own sample`);
			const root = plant({ "case.test.ts": `// ${p.sample}\n` });
			const found = scanForMachineChanges(root).map((f) => f.pattern);
			assert.ok(found.includes(p.name), `${p.name} was not found in a planted file`);
		}
	});

	it("lists every command family of the spec", () => {
		for (const word of SPEC_COMMAND_WORDS) assert.ok(MACHINE_CHANGING.some((p) => p.re.test(word)), `${word} is not covered`);
	});
});
