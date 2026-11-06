import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { stopSequence, type StopParts } from "../src/main/stop-sequence.ts";

// The stop of a quit and the stop before an update's installer are one sequence, and it ends every account work (task 11 R11-F007): a running `ttt init` or Claude sign-in
// cannot survive the stop. Fakes record the calls; nothing real starts.

function parts(calls: string[], over: { settledFails?: boolean; stopFails?: boolean; log?: (f: unknown) => void } = {}): StopParts {
	const account = (name: string) => ({
		dispose: () => void calls.push(`${name}.dispose`),
		settled: async () => {
			calls.push(`${name}.settled`);
			if (over.settledFails) throw new Error("settled failed");
		},
	});
	return {
		supervisor: {
			beginQuit: () => void calls.push("beginQuit"),
			stop: async () => {
				calls.push("stop");
				if (over.stopFails) throw new Error("stop failed");
				return { ok: true, leftovers: [] };
			},
		},
		updates: { dispose: () => void calls.push("updates.dispose") },
		accounts: account("accounts"),
		claude: account("claude"),
		linear: account("linear"),
		engineHost: { dispose: async () => void calls.push("engine.dispose") },
		log: (f) => over.log?.(f),
	};
}

/** The source with comments dropped; string and template literals are walked so a `//` inside one stays. */
function code(file: string): string {
	const source = readFileSync(new URL(file, import.meta.url), "utf8");
	let out = "";
	let i = 0;
	while (i < source.length) {
		const c = source[i] as string;
		const next = source[i + 1];
		if (c === "/" && next === "/") {
			while (i < source.length && source[i] !== "\n") i++;
		} else if (c === "/" && next === "*") {
			const end = source.indexOf("*/", i + 2);
			i = end < 0 ? source.length : end + 2;
		} else if (c === '"' || c === "'" || c === "`") {
			let j = i + 1;
			while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
			out += source.slice(i, j + 1);
			i = j + 1;
		} else {
			out += c;
			i++;
		}
	}
	return out;
}

function body(source: string, name: string): string {
	const start = source.search(new RegExp(`(async )?function ${name}\\(`));
	assert.ok(start >= 0, `${name} exists`);
	const open = source.indexOf("{", source.indexOf(")", start));
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === "{") depth++;
		if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
	}
	throw new Error(`${name} has no end`);
}

describe("stop sequence", () => {
	it("runs the whole order: beginQuit, updates.dispose, the sign-ins disposed then settled, the engine disposed, then the stack stops", async () => {
		const calls: string[] = [];
		assert.equal(await stopSequence(parts(calls)), true);
		const at = (name: string) => {
			assert.ok(calls.includes(name), `${name} ran`);
			return calls.indexOf(name);
		};
		assert.equal(calls[0], "beginQuit");
		assert.equal(at("updates.dispose"), 1);
		const names = ["accounts", "claude", "linear"];
		for (const name of names) {
			assert.ok(at("updates.dispose") < at(`${name}.dispose`), name);
			assert.ok(at(`${name}.dispose`) < at(`${name}.settled`), `${name} disposed before it settled`);
			assert.ok(at(`${name}.settled`) < at("stop"), name);
		}
		for (const settled of names.map((n) => at(`${n}.settled`))) {
			for (const dispose of names.map((n) => at(`${n}.dispose`))) assert.ok(dispose < settled, "every dispose before any settled");
		}
		assert.ok(at("engine.dispose") < at("stop"));
		assert.equal(calls.at(-1), "stop");
		assert.equal(calls.length, 10);
	});

	it("a settled that rejects does not hold the stop back; a stop that rejects logs quit-stop-failed and resolves false", async () => {
		const calls: string[] = [];
		assert.equal(await stopSequence(parts(calls, { settledFails: true })), true);
		assert.equal(calls.at(-1), "stop");
		const logged: unknown[] = [];
		assert.equal(await stopSequence(parts([], { stopFails: true, log: (f) => logged.push(f) })), false);
		assert.equal((logged[0] as { event: string }).event, "quit-stop-failed");
	});

	it("both the update stop and the quit go through stopAll, which hands over the real sign-ins (comments ignored)", () => {
		const source = code("../src/main/index.ts");
		assert.match(source, /prepareQuit: \(\) => stopForUpdate\(\)/);
		assert.match(source, /new QuitGate\(\{\s*stopAll: \(\) => stopAll\(\)/, "the gate stops through stopAll");
		assert.match(source, /const stopForUpdate = \(\): Promise<void> => quitGate\.stopForUpdate\(\)/);
		assert.match(source, /const stopThenExit = [^;]*quitGate\.quit\(code\)/);
		const gate = code("../src/main/quit-gate.ts");
		assert.match(gate, /async stopForUpdate\(\)[^]*await this\.#d\.stopAll\(\)/);
		assert.match(gate, /quit\(code[^]*this\.#d\.stopAll\(\)/);
		assert.match(body(source, "stopAll"), /stopSequence\(stopParts\(\)\)/);
		assert.match(body(source, "stopParts"), /\bupdates\b[^]*\baccounts\b[^]*\bclaude\b[^]*\blinear\b[^]*\bengineHost\b/);
	});

	it("Remove all data stops through the gate, with the same parts, so it ends the same sign-ins and the same engine, and never beside another stop (comments ignored)", () => {
		const source = code("../src/main/index.ts");
		// Inside the gate, around keep awake, and with the same parts: the route itself (the gate, keep awake, `resume`) is `removal/wiring.ts`, which removal-wiring.test.ts runs against a real gate.
		assert.match(source, /removalStop\(\{ gate: quitGate, keepAwake, stopSequence: \(\) => stopForRemoval\(stopParts\(\)\) \}\)/, "the removal's stop is the removal's stop sequence on the same parts, run by removalStop");
		// The cleanup armed by the removal starts before the gate's exit.
		assert.match(source, /exit: \(code\) => \{\s*exitCleanup\.run\(\);\s*app\.exit\(code\);/);
		const gate = code("../src/main/quit-gate.ts");
		assert.match(gate, /async stopForRemoval[^]*if \(this\.#stopping\) return \{ ok: false, busy: true/, "another stop under way answers busy and starts nothing");
	});

	it("resuming after a failed installer or a refused removal resumes every sign-in, and finishes an interrupted apply before the stack starts (comments ignored)", () => {
		const source = code("../src/main/index.ts");
		assert.match(source, /resume: \(event\) => resumeStack\(event\)/);
		const resume = body(source, "resumeStack");
		for (const name of ["accounts", "claude", "linear"]) assert.match(resume, new RegExp(`\\b${name}\\.resume\\(\\)`));
		assert.match(resume, /stackUpdater\.healInterrupted\(\)[^]*supervisor\s*\.start\(\)/, "the heal comes before the start");
	});
});
