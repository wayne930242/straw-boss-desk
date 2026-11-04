import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { stopSequence, type StopParts } from "../src/main/stop-sequence.ts";

// The stop of a quit and the stop before an update's installer are one sequence, and it ends every account work (task 11 R11-F007): a running `ttt init` or Claude sign-in
// cannot survive the stop. Fakes record the calls; nothing real starts.

function parts(calls: string[]): StopParts {
	const account = (name: string) => ({ dispose: () => void calls.push(`${name}.dispose`), settled: async () => void calls.push(`${name}.settled`) });
	return {
		supervisor: { beginQuit: () => void calls.push("beginQuit"), stop: async () => (calls.push("stop"), { ok: true, leftovers: [] }) },
		updates: { dispose: () => void calls.push("updates.dispose") },
		accounts: account("accounts"),
		claude: account("claude"),
		linear: account("linear"),
		engineHost: { dispose: async () => void calls.push("engine.dispose") },
		log: () => undefined,
	};
}

describe("stop sequence", () => {
	it("disposes and waits for Claude and Linear before the stack stops", async () => {
		const calls: string[] = [];
		assert.equal(await stopSequence(parts(calls)), true);
		for (const name of ["accounts", "claude", "linear"]) {
			assert.ok(calls.includes(`${name}.dispose`) && calls.includes(`${name}.settled`), name);
			assert.ok(calls.indexOf(`${name}.settled`) < calls.indexOf("stop"), name);
		}
	});

	it("is the sequence the update stop path runs", () => {
		const source = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
		assert.match(source, /prepareQuit: \(\) => stopForUpdate\(\)/);
		assert.match(source, /async function stopForUpdate\(\)[^}]*await stopAll\(\)/s);
		assert.match(source, /function stopAll\(\)[^}]*stopSequence\(/s);
	});
});
