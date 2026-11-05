import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { parseStack, platformKey, type Stack } from "../src/main/bootstrap/stack.ts";
import { checkCandidate, changeList, MAX_STACK_BYTES, StackUpdater, stackFiles, type EngineRunResult, type StackUpdaterDeps } from "../src/main/update/stack.ts";
import type { StackUpdateState } from "../src/shared/updates.ts";
import { loadActiveStack } from "../src/main/wizard/stack-source.ts";
import { compareVersions } from "../src/main/update/verify.ts";
import { ALT_NODE_VERSION, altStack } from "./harness/alt-pins.ts";
import { scratchRoot, testLayout } from "./harness/engine-fixture.ts";

// The stack channel (task 13): the decision about a candidate, in the order the spec gives it, and the apply and rollback around the engine. The keys exist for the run only.

// The channel tests count generations from a fixed 5 (the active stack), whatever generation the repo's pin has reached.
const real: Record<string, any> = { ...JSON.parse(readFileSync(new URL("../../stack.json", import.meta.url), "utf8")), generation: 5 };
const realText = `${JSON.stringify(real, null, "\t")}\n`;
const key = platformKey(process.platform, process.arch);
const ACTIVE = parseStack(real);
const SHELL = "0.0.1";

const pair = (): { privateKey: KeyObject; publicKey: string } => {
	const made = generateKeyPairSync("ed25519");
	return { privateKey: made.privateKey, publicKey: made.publicKey.export({ type: "spki", format: "der" }).toString("base64") };
};
const A = pair();
const B = pair();
const OUTSIDER = pair();

const bytesOf = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, "\t")}\n`);
const signWith = (bytes: Uint8Array, k: KeyObject): string => `${cryptoSign(null, bytes, k).toString("base64")}\n`;
/** `stack.json` with the given fields changed. */
const stackWith = (change: (stack: Record<string, any>) => void): Record<string, any> => {
	const copy = structuredClone(real);
	change(copy);
	return copy;
};
const next = (generation = ACTIVE.generation + 1): Record<string, any> => stackWith((s) => (s.generation = generation));

type Input = Parameters<typeof checkCandidate>[0];
const input = (bytes: Buffer, signature: string | null, extra: Partial<Input> = {}): Input => ({
	bytes,
	signature,
	keys: [A.publicKey, B.publicKey],
	shellVersion: SHELL,
	active: ACTIVE,
	recipeTools: [],
	...extra,
});
const signedBy = (value: unknown, k: KeyObject = A.privateKey): { bytes: Buffer; signature: string } => {
	const bytes = bytesOf(value);
	return { bytes, signature: signWith(bytes, k) };
};
const verdict = (value: unknown, k: KeyObject = A.privateKey, extra: Partial<Input> = {}) => {
	const s = signedBy(value, k);
	return checkCandidate(input(s.bytes, s.signature, extra));
};

describe("checkCandidate: the decision about a candidate (spec: Updater, stack.json)", () => {
	it("accepts a newer stack signed by the first key", () => {
		const v = verdict(next());
		assert.equal(v.kind, "newer");
		if (v.kind === "newer") {
			assert.equal(v.stack.generation, ACTIVE.generation + 1);
			assert.equal(v.keyIndex, 0);
		}
	});

	it("refuses a wrong signature: signed with a key of no list, one byte changed after signing, another file's signature", () => {
		const forged = verdict(next(), OUTSIDER.privateKey);
		assert.deepEqual(forged, { kind: "refused", refusal: "bad-signature" });
		const s = signedBy(next());
		const flipped = Buffer.from(s.bytes);
		flipped[flipped.length - 2] = (flipped[flipped.length - 2] as number) ^ 1;
		assert.deepEqual(checkCandidate(input(flipped, s.signature)), { kind: "refused", refusal: "bad-signature" });
		const other = signedBy(next(ACTIVE.generation + 2));
		assert.deepEqual(checkCandidate(input(s.bytes, other.signature)), { kind: "refused", refusal: "bad-signature" });
	});

	it("verifies bytes before it parses them: a file with a bad signature that is not even JSON is a bad signature, not invalid", () => {
		const bytes = Buffer.from("this is not json");
		assert.deepEqual(checkCandidate(input(bytes, signWith(bytes, OUTSIDER.privateKey))), { kind: "refused", refusal: "bad-signature" });
		assert.deepEqual(checkCandidate(input(bytes, signWith(bytes, A.privateKey))), { kind: "refused", refusal: "invalid" }, "signed, but not a stack");
	});

	it("refuses a candidate with no signature and one whose signature is not 64 bytes of base64", () => {
		const bytes = bytesOf(next());
		assert.deepEqual(checkCandidate(input(bytes, null)), { kind: "refused", refusal: "no-signature" });
		for (const junk of ["", "not base64!!", Buffer.alloc(63).toString("base64"), `${signWith(bytes, A.privateKey).trim()}AA`]) {
			assert.deepEqual(checkCandidate(input(bytes, junk)), { kind: "refused", refusal: "malformed-signature" }, JSON.stringify(junk));
		}
	});

	it("refuses a lower generation, signed correctly, and takes the equal one as nothing to apply", () => {
		assert.deepEqual(verdict(next(ACTIVE.generation - 1)), { kind: "refused", refusal: "older", generation: ACTIVE.generation - 1 });
		assert.deepEqual(verdict(next(ACTIVE.generation)), { kind: "same", generation: ACTIVE.generation });
	});

	it("refuses a minShell above the app's version, and accepts one equal to it", () => {
		const withMin = (minShell: string) => stackWith((s) => ((s.generation = ACTIVE.generation + 1), (s.minShell = minShell)));
		assert.deepEqual(verdict(withMin("0.0.2")), { kind: "refused", refusal: "min-shell", generation: ACTIVE.generation + 1, minShell: "0.0.2" });
		assert.equal(verdict(withMin(SHELL)).kind, "newer");
		assert.equal(verdict(withMin("0.0.2"), A.privateKey, { shellVersion: "0.0.2" }).kind, "newer");
		assert.equal(verdict(withMin("1.0.0-beta.1"), A.privateKey, { shellVersion: "1.0.0" }).kind, "newer", "a pre-release is lower than its release");
	});

	it("verifies a candidate signed by the second key of the list, and not one signed by a key that is not in it", () => {
		const second = verdict(next(), B.privateKey);
		assert.equal(second.kind, "newer");
		if (second.kind === "newer") assert.equal(second.keyIndex, 1);
		assert.deepEqual(verdict(next(), OUTSIDER.privateKey), { kind: "refused", refusal: "bad-signature" });
		// A list that holds the outsider's key is a different list: it verifies there.
		assert.equal(verdict(next(), OUTSIDER.privateKey, { keys: [OUTSIDER.publicKey] }).kind, "newer");
	});

	it("fails closed on an empty key list, a list of three, and a list with an entry that is not an Ed25519 key", () => {
		assert.deepEqual(verdict(next(), A.privateKey, { keys: [] }), { kind: "refused", refusal: "no-keys" });
		assert.deepEqual(verdict(next(), A.privateKey, { keys: [A.publicKey, B.publicKey, OUTSIDER.publicKey] }), { kind: "refused", refusal: "bad-key-list" });
		assert.deepEqual(verdict(next(), A.privateKey, { keys: [A.publicKey, "AAAA"] }), { kind: "refused", refusal: "bad-key-list" });
		const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
		assert.deepEqual(verdict(next(), A.privateKey, { keys: [rsa] }), { kind: "refused", refusal: "bad-key-list" });
	});

	it("refuses a candidate that drops an optional tool the active recipe names, and names the tool", () => {
		const dropped = stackWith((s) => ((s.generation = ACTIVE.generation + 1), delete s.optionalTools));
		assert.deepEqual(verdict(dropped, A.privateKey, { recipeTools: ["bun"] }), { kind: "refused", refusal: "recipe-tool", generation: ACTIVE.generation + 1, tools: ["bun"] });
		assert.equal(verdict(dropped, A.privateKey, { recipeTools: [] }).kind, "newer", "a recipe that names no tool does not mind");
	});

	it("refuses a file that is too large or is not a stack, signed or not", () => {
		const big = Buffer.alloc(MAX_STACK_BYTES + 1, 0x20);
		assert.deepEqual(checkCandidate(input(big, signWith(big, A.privateKey))), { kind: "refused", refusal: "too-large" });
		assert.equal(verdict({ schema: 1 }).kind, "refused");
		assert.deepEqual(verdict(stackWith((s) => ((s.generation = ACTIVE.generation + 1), (s.minShell = "soon")))), { kind: "refused", refusal: "invalid" });
	});
});

describe("changeList", () => {
	const to = (change: (s: Record<string, any>) => void): Stack => parseStack(stackWith(change));
	it("lists a tool, an optional tool, an npm package, a pi package and the profile that change, and nothing that stays", () => {
		const candidate = to((s) => {
			s.tools.node.assets[key] = { ...s.tools.node.assets[key], version: "24.99.0" };
			s.tools.rg.assets[key] = { ...s.tools.rg.assets[key], version: "15.9.0" };
			s.optionalTools.bun.assets[key] = { ...s.optionalTools.bun.assets[key], version: "1.9.0" };
			s.npmGlobal[0].version = "1.5.0";
			s.piPackages = [...s.piPackages.slice(1), { name: "pi-new", version: "0.1.0", integrity: "sha512-x" }];
			s.profile.version = "0.2.0";
		});
		const lines = changeList(ACTIVE, candidate, key);
		const by = (stage: string) => lines.filter((l) => l.stage === stage);
		assert.deepEqual(by("node"), [{ kind: "tool", name: "node", stage: "node", from: "24.22.1", to: "24.99.0" }]);
		assert.deepEqual(by("fd-rg").map((l) => [l.name, l.to]), [["rg", "15.9.0"]]);
		assert.deepEqual(by("opt:bun").map((l) => l.to), ["1.9.0"]);
		assert.deepEqual(by("pi").map((l) => [l.from, l.to]), [["1.4.0", "1.5.0"]]);
		assert.deepEqual(by("pkg:pi-new").map((l) => [l.from, l.to]), [[null, "0.1.0"]]);
		assert.equal(lines.find((l) => l.from !== null && l.to === null)?.stage.startsWith("pkg:"), true, "the dropped package shows as removed");
		assert.deepEqual(by("profile").map((l) => l.to), ["0.2.0"]);
		assert.equal(by("git").length + by("gh").length + by("herdr").length, 0, "what stays is not listed");
	});

	it("shows the update fixture's Node as a rising version, not a downgrade (SA-T13-1)", () => {
		const node = changeList(ACTIVE, parseStack(altStack(real as { tools: Record<string, any>; optionalTools: Record<string, any> }, { node: true })), key).find((l) => l.stage === "node");
		assert.equal(node?.to, ALT_NODE_VERSION);
		assert.ok(node?.from !== undefined && node.from !== null && node.to !== null && compareVersions(node.to, node.from) > 0, `${node?.from} to ${node?.to}`);
	});

	it("is empty for the same stack", () => {
		assert.deepEqual(changeList(ACTIVE, ACTIVE, key), []);
	});
});

// ---- the updater around the engine ----------------------------------------------------------------------------------------

const scratch: string[] = [];
after(() => {
	for (const d of scratch) removeTree(d);
});

interface Rig {
	updater: StackUpdater;
	root: string;
	files: ReturnType<typeof stackFiles>;
	events: string[];
	runs: Array<{ generation: number }>;
	/** What `runEngine` answers, by the generation it is run against. */
	script: Map<number, EngineRunResult>;
	serve: (stack: string, bytes: Buffer | null, signature: Buffer | string | null) => void;
	fetched: string[];
	reloads: number;
	logs: Array<Record<string, unknown>>;
	states: StackUpdateState[];
	record(): Record<string, any>;
}

function makeRig(options: { onRun?: () => void; onReload?: () => void; onRecipeTools?: (stack: Stack) => void; recipeTools?: string[]; keys?: string[]; base?: string | null; withStackStopped?: StackUpdaterDeps["withStackStopped"]; activeBytes?: Buffer | null } = {}): Rig {
	const { base, root } = scratchRoot("sbd-upd-");
	scratch.push(base);
	const layout = testLayout(root);
	mkdirSync(layout.stack, { recursive: true });
	mkdirSync(layout.state, { recursive: true });
	const files = stackFiles(layout);
	if (options.activeBytes !== null) writeFileSync(files.active, options.activeBytes ?? Buffer.from(realText));
	const served = new Map<string, { status: number; body: Buffer }>();
	const events: string[] = [];
	const runs: Array<{ generation: number }> = [];
	const script = new Map<number, EngineRunResult>();
	const fetched: string[] = [];
	const logs: Array<Record<string, unknown>> = [];
	const states: StackUpdateState[] = [];
	const rig = { events, runs, script, fetched, logs, states, reloads: 0, files, root } as unknown as Rig;
	rig.serve = (stack, bytes, signature) => {
		served.set(`https://feed.test/${stack}/stack.json`, bytes === null ? { status: 404, body: Buffer.alloc(0) } : { status: 200, body: bytes });
		served.set(`https://feed.test/${stack}/stack.json.sig`, signature === null ? { status: 404, body: Buffer.alloc(0) } : { status: 200, body: Buffer.from(signature) });
	};
	rig.updater = new StackUpdater({
		layout,
		shellVersion: SHELL,
		key,
		keys: options.keys ?? [A.publicKey, B.publicKey],
		base: options.base === undefined ? "https://feed.test/s/" : options.base,
		fetchBytes: async (url) => {
			fetched.push(url);
			const hit = served.get(url);
			if (hit === undefined) throw new Error(`no route ${url}`);
			return hit;
		},
		runEngine: async (raw, onStage) => {
			const generation = (raw as { generation: number }).generation;
			options.onRun?.();
			runs.push({ generation });
			events.push(`engine ${generation}`);
			onStage({ type: "start", stage: "node" });
			onStage({ type: "end", stage: "node" });
			return script.get(generation) ?? { ok: true };
		},
		withStackStopped:
			options.withStackStopped ??
			(async (work) => {
				events.push("stop");
				try {
					return await work();
				} finally {
					events.push("start");
				}
			}),
		recipeTools: (stack) => {
			options.onRecipeTools?.(stack);
			return options.recipeTools ?? [];
		},
		reloadStack: () => {
			rig.reloads++;
			options.onReload?.();
		},
		log: (fields) => void logs.push(fields as Record<string, unknown>),
		now: () => new Date("2026-11-04T10:00:00Z"),
	});
	rig.updater.onChange(() => void states.push(rig.updater.state));
	rig.record = () => JSON.parse(readFileSync(join(layout.state, "update.json"), "utf8")) as Record<string, any>;
	return rig;
}

/** The channel serves `value` under `s`, signed by `k`; returns the bytes served. */
const serveSigned = (rig: Rig, value: unknown, k: KeyObject = A.privateKey): Buffer => {
	const bytes = bytesOf(value);
	rig.serve("s", bytes, signWith(bytes, k));
	return bytes;
};

describe("StackUpdater.check", () => {
	it("offers a newer, verified candidate with its change list, and keeps it with its signature on disk", async () => {
		const rig = makeRig();
		const bytes = serveSigned(rig, stackWith((s) => ((s.generation = 6), (s.tools.node.assets[key].version = "24.99.0"))));
		await rig.updater.check();
		const state = rig.updater.state;
		assert.equal(state.phase, "available");
		if (state.phase === "available") {
			assert.equal(state.generation, 6);
			assert.deepEqual(state.changes.map((c) => [c.stage, c.to]), [["node", "24.99.0"]]);
		}
		assert.deepEqual(readFileSync(rig.files.candidate), bytes);
		assert.ok(existsSync(rig.files.candidateSig));
		assert.deepEqual(rig.fetched, ["https://feed.test/s/stack.json", "https://feed.test/s/stack.json.sig"]);
		assert.equal(rig.runs.length, 0, "a check runs no engine");
	});

	for (const [name, setup, reason] of [
		["a wrong signature", (rig: Rig) => serveSigned(rig, next(6), OUTSIDER.privateKey), "bad-signature"],
		["a lower generation", (rig: Rig) => serveSigned(rig, next(4)), "older"],
		["a minShell above the app", (rig: Rig) => serveSigned(rig, stackWith((s) => ((s.generation = 6), (s.minShell = "9.0.0")))), "min-shell"],
		["a missing signature", (rig: Rig) => rig.serve("s", bytesOf(next(6)), null), "no-signature"],
	] as const) {
		it(`refuses ${name}, shows why, and keeps no candidate on disk`, async () => {
			const rig = makeRig();
			// A candidate left by an earlier check must not survive a refusal.
			writeFileSync(rig.files.candidate, "stale");
			writeFileSync(rig.files.candidateSig, "stale");
			setup(rig);
			await rig.updater.check();
			assert.equal(rig.updater.state.phase, "refused");
			assert.equal((rig.updater.state as { reason: string }).reason, reason);
			assert.equal(existsSync(rig.files.candidate), false);
			assert.equal(existsSync(rig.files.candidateSig), false);
			await rig.updater.apply();
			assert.equal(rig.runs.length, 0, "nothing refused is ever applied");
		});
	}

	it("names the tool a recipe still needs and the version the app must reach", async () => {
		const tools = makeRig({ recipeTools: ["bun"] });
		serveSigned(tools, stackWith((s) => ((s.generation = 6), delete s.optionalTools)));
		await tools.updater.check();
		assert.deepEqual(tools.updater.state, { phase: "refused", reason: "recipe-tool", generation: 6, tools: ["bun"] });
		const shell = makeRig();
		serveSigned(shell, stackWith((s) => ((s.generation = 6), (s.minShell = "2.0.0"))));
		await shell.updater.check();
		assert.deepEqual(shell.updater.state, { phase: "refused", reason: "min-shell", generation: 6, minShell: "2.0.0" });
	});

	it("takes nothing published, an equal generation and a channel that is not configured as up to date, and a network failure as an error", async () => {
		const none = makeRig();
		none.serve("s", null, null);
		await none.updater.check();
		assert.equal(none.updater.state.phase, "idle");
		const same = makeRig();
		serveSigned(same, next(5));
		await same.updater.check();
		assert.equal(same.updater.state.phase, "idle");
		assert.equal(existsSync(same.files.candidate), false);
		const off = makeRig({ base: null });
		await off.updater.check();
		assert.equal(off.updater.state.phase, "idle");
		assert.equal(off.fetched.length, 0);
		const down = makeRig();
		await down.updater.check();
		assert.equal(down.updater.state.phase, "error");
		assert.equal((down.updater.state as { kind: string }).kind, "network");
	});

	it("reports every state change and runs one check at a time", async () => {
		const rig = makeRig();
		serveSigned(rig, next(6));
		await Promise.all([rig.updater.check(), rig.updater.check()]);
		assert.deepEqual(rig.states.map((s) => s.phase), ["checking", "available"]);
		assert.equal(rig.fetched.length, 2, "the second call did not fetch");
	});
});

describe("StackUpdater.apply: the stack stops, the engine runs against the candidate, the stack starts", () => {
	it("applies a signed candidate: stop, engine on the candidate, active.json is the candidate, previous.json the old stack, start", async () => {
		const rig = makeRig();
		const bytes = serveSigned(rig, next(6));
		await rig.updater.check();
		await rig.updater.apply();
		assert.deepEqual(rig.events, ["stop", "engine 6", "start"]);
		assert.deepEqual(readFileSync(rig.files.active), bytes);
		assert.equal(readFileSync(rig.files.previous, "utf8"), realText);
		assert.equal(existsSync(rig.files.candidate), false);
		assert.deepEqual(rig.updater.state, { phase: "applied", generation: 6, at: "2026-11-04T10:00:00.000Z" });
		assert.equal(rig.updater.generation, 6);
		assert.ok(rig.reloads >= 1, "the wizard reads the new file");
		assert.equal(rig.record().inFlight, undefined, "the marker is cleared");
		assert.equal(rig.record().last.phase, "applied");
		assert.ok(rig.states.some((s) => s.phase === "applying"));
	});

	it("rolls a candidate whose stage fails back to the old stack: the engine runs the old stack, active.json stays, and the report names the stage", async () => {
		const rig = makeRig();
		serveSigned(rig, next(6));
		rig.script.set(6, { ok: false, failed: { stage: "pi", category: "registry" } });
		await rig.updater.check();
		await rig.updater.apply();
		assert.deepEqual(rig.events, ["stop", "engine 6", "engine 5", "start"], "the stack starts on the old generation, after the old stack's engine run");
		assert.equal(readFileSync(rig.files.active, "utf8"), realText);
		assert.deepEqual(rig.updater.state, { phase: "rolled-back", generation: 6, stage: "pi", category: "registry", restored: true, at: "2026-11-04T10:00:00.000Z" });
		assert.equal(rig.updater.generation, 5);
		assert.equal(rig.record().inFlight, undefined);
		assert.equal(rig.record().last.stage, "pi");
	});

	it("says so when the old stack could not be put back either, and keeps the old file in force", async () => {
		const rig = makeRig();
		serveSigned(rig, next(6));
		rig.script.set(6, { ok: false, failed: { stage: "node", category: "network" } });
		rig.script.set(5, { ok: false, failed: { stage: "node", category: "network" } });
		await rig.updater.check();
		await rig.updater.apply();
		const state = rig.updater.state;
		assert.equal(state.phase, "rolled-back");
		assert.equal((state as { restored: boolean }).restored, false);
		assert.equal(readFileSync(rig.files.active, "utf8"), realText);
	});

	it("stops the stack through withStackStopped, waiting for programs under the tools folder, so no engine run ever happens beside a live pi", async () => {
		const seen: unknown[] = [];
		const rig = makeRig({
			withStackStopped: async (work, options) => {
				seen.push(options);
				return work();
			},
		});
		serveSigned(rig, next(6));
		await rig.updater.check();
		await rig.updater.apply();
		assert.deepEqual(seen, [{ waitForTools: true }]);
	});

	it("reports a stack that cannot be stopped as an error and changes nothing: no engine run, the old file in force", async () => {
		const rig = makeRig({
			withStackStopped: async () => {
				throw new Error("a program from the tools folder still runs (pid 42)");
			},
		});
		serveSigned(rig, next(6));
		await rig.updater.check();
		await rig.updater.apply();
		assert.equal(rig.runs.length, 0);
		assert.equal(rig.updater.state.phase, "error");
		assert.equal(readFileSync(rig.files.active, "utf8"), realText);
		assert.equal(rig.record().inFlight, undefined);
	});

	it("decides again from the files on disk: a candidate swapped after the check is refused and never run", async () => {
		const rig = makeRig();
		serveSigned(rig, next(6));
		await rig.updater.check();
		writeFileSync(rig.files.candidate, bytesOf(stackWith((s) => ((s.generation = 6), (s.tools.node.assets[key].sha256 = "0".repeat(64))))));
		await rig.updater.apply();
		assert.equal(rig.runs.length, 0);
		assert.deepEqual(rig.updater.state, { phase: "refused", reason: "bad-signature" });
		assert.equal(readFileSync(rig.files.active, "utf8"), realText);
	});

	it("applies only what a check offered, once", async () => {
		const rig = makeRig();
		await rig.updater.apply();
		assert.equal(rig.runs.length, 0, "nothing offered");
		serveSigned(rig, next(6));
		await rig.updater.check();
		await Promise.all([rig.updater.apply(), rig.updater.apply()]);
		assert.equal(rig.runs.filter((r) => r.generation === 6).length, 1);
	});

	it("leaves the in-flight marker when the app quits during the run, and runs no rollback then", async () => {
		const rig = makeRig();
		serveSigned(rig, next(6));
		rig.script.set(6, { ok: false, interrupted: true });
		await rig.updater.check();
		await rig.updater.apply();
		assert.deepEqual(rig.events, ["stop", "engine 6", "start"]);
		assert.equal(rig.record().inFlight.generation, 6);
	});
});

describe("StackUpdater at launch: Precedence and an update that was cut short", () => {
	const bundledFile = (rig: Rig, value: unknown): string => {
		const file = join(rig.root, "bundled-stack.json");
		writeFileSync(file, bytesOf(value));
		return file;
	};

	it("keeps the downloaded stack when the new app's bundled one has a lower generation", () => {
		const rig = makeRig({ activeBytes: bytesOf(next(7)) });
		assert.equal(rig.updater.prepare(bundledFile(rig, next(6))), null);
		assert.equal(rig.updater.prepare(bundledFile(rig, next(7))), null, "an equal one changes nothing either");
		assert.equal(parseStack(JSON.parse(readFileSync(rig.files.active, "utf8"))).generation, 7);
	});

	it("does nothing on a root with no active stack yet (the wizard seeds it)", () => {
		const rig = makeRig({ activeBytes: null });
		assert.equal(rig.updater.prepare(bundledFile(rig, next(9))), null);
	});

	it("runs the engine against a higher bundled stack through the same stop and start, with a rollback to the stack it replaced", async () => {
		const rig = makeRig();
		const file = bundledFile(rig, next(8));
		const plan = rig.updater.prepare(file);
		assert.equal(plan?.kind, "bundled");
		// The wizard seeds active.json from the bundled file as soon as it reads the stack.
		writeFileSync(rig.files.active, readFileSync(file));
		rig.script.set(8, { ok: false, failed: { stage: "pkg:pi-lens", category: "integrity" } });
		await rig.updater.finish(plan);
		assert.deepEqual(rig.events, ["stop", "engine 8", "engine 5", "start"]);
		assert.equal(readFileSync(rig.files.active, "utf8"), realText, "the old stack is back in force");
		assert.equal(rig.updater.state.phase, "rolled-back");
		assert.equal((rig.updater.state as { stage: string }).stage, "pkg:pi-lens");
		assert.equal(rig.record().inFlight, undefined);
	});

	it("keeps a higher bundled stack in force when its run succeeds", async () => {
		const rig = makeRig();
		const file = bundledFile(rig, next(8));
		const plan = rig.updater.prepare(file);
		writeFileSync(rig.files.active, readFileSync(file));
		await rig.updater.finish(plan);
		assert.deepEqual(rig.events, ["stop", "engine 8", "start"]);
		assert.equal(parseStack(JSON.parse(readFileSync(rig.files.active, "utf8"))).generation, 8);
		assert.equal(rig.updater.state.phase, "applied");
	});

	it("heals an apply that was cut short: the engine runs against the stack in force, and the card says it was undone", async () => {
		const rig = makeRig();
		writeFileSync(join(rig.root, "state", "update.json"), JSON.stringify({ schema: 1, inFlight: { generation: 6, source: "channel", at: "2026-11-04T09:00:00Z" } }));
		const plan = rig.updater.prepare(bundledFile(rig, next(5)));
		assert.equal(plan?.kind, "heal");
		await rig.updater.finish(plan);
		assert.deepEqual(rig.events, ["stop", "engine 5", "start"]);
		assert.equal(rig.record().inFlight, undefined);
		assert.deepEqual(rig.updater.state, { phase: "rolled-back", generation: 6, stage: "interrupted", category: "other", restored: true, at: "2026-11-04T10:00:00.000Z" });
	});
});

// ---- R13-F001, F005, F006, F007 ---------------------------------------------------------------------------------------------

describe("a bundled stack that did not finish stays out of force (R13-F001)", () => {
	const setup = (options: Parameters<typeof makeRig>[0] = {}) => {
		let layoutRoot = "";
		// As index.ts: the run reads the wizard's stack (engineRecipe -> wizard.recipe -> loadActiveStack) before the engine runs.
		const rig = makeRig({ ...options, onRun: () => void loadActiveStack(testLayout(layoutRoot), bundled) });
		layoutRoot = rig.root;
		const bundled = join(rig.root, "bundled.json");
		return { rig, bundled, layout: testLayout(rig.root) };
	};

	it("does not seed the failed bundled file again at the wizard's next read, and does not retry it at the next launch", async () => {
		const { rig, bundled, layout } = setup();
		writeFileSync(bundled, bytesOf(next(8)));
		const plan = rig.updater.prepare(bundled);
		assert.equal(plan?.kind, "bundled");
		rig.script.set(8, { ok: false, failed: { stage: "pi", category: "network" } });
		await rig.updater.finish(plan);
		assert.equal(rig.updater.state.phase, "rolled-back");
		assert.equal(rig.record().bundledRolledBack, 8);
		assert.equal(readFileSync(rig.files.active, "utf8"), realText, "right after the rollback the old stack is in force");
		const reread = loadActiveStack(layout, bundled);
		assert.equal(reread.seeded, false);
		assert.equal(reread.stack.generation, 5);
		assert.equal(readFileSync(rig.files.active, "utf8"), realText, "the wizard's next read did not take the failed file");
		assert.equal(rig.updater.prepare(bundled), null, "the next launch does not run it again: it applies at the shell's first start only");
		assert.equal(JSON.parse(rig.record().last ? JSON.stringify(rig.record().last) : "{}").phase, "rolled-back");
	});

	it("lets a channel candidate of the refused generation be offered, and a newer shell's higher bundled generation be tried", async () => {
		const { rig, bundled, layout } = setup();
		writeFileSync(bundled, bytesOf(next(8)));
		rig.script.set(8, { ok: false, failed: { stage: "pi", category: "network" } });
		await rig.updater.finish(rig.updater.prepare(bundled));
		serveSigned(rig, next(8));
		await rig.updater.check();
		assert.equal(rig.updater.state.phase, "available", "the old stack is in force, so generation 8 reads as newer, not as the same");
		writeFileSync(bundled, bytesOf(next(9)));
		assert.equal(rig.updater.prepare(bundled)?.kind, "bundled", "a higher generation is a new try");
		assert.equal(loadActiveStack(layout, bundled).seeded, true);
	});

	it("keeps the failed file out when the stack could not be stopped, too", async () => {
		const { rig, bundled, layout } = setup({
			withStackStopped: async () => {
				throw Object.assign(new Error("the stack could not be stopped: pid 42"), { name: "StackBusyError" });
			},
		});
		writeFileSync(bundled, bytesOf(next(8)));
		await rig.updater.finish(rig.updater.prepare(bundled));
		assert.deepEqual(rig.updater.state, { phase: "error", kind: "busy", detail: "the stack could not be stopped: pid 42" });
		assert.equal(loadActiveStack(layout, bundled).seeded, false);
		assert.equal(readFileSync(rig.files.active, "utf8"), realText);
	});

	it("still seeds a bundled file the updater has not refused, and one over a damaged active file", () => {
		const { rig, bundled, layout } = setup();
		writeFileSync(bundled, bytesOf(next(8)));
		assert.equal(loadActiveStack(layout, bundled).seeded, true);
		writeFileSync(rig.files.active, "damaged");
		writeFileSync(join(rig.root, "state", "update.json"), JSON.stringify({ schema: 1, bundledRolledBack: 8 }));
		assert.equal(loadActiveStack(layout, bundled).seeded, true, "with no active stack there is nothing else to run");
	});
});

describe("a bundled stack that drops a tool the recipe names is refused like a downloaded one (R13-F007)", () => {
	it("runs nothing, shows the refusal on the card, and is not seeded by the wizard", () => {
		const rig = makeRig({ recipeTools: ["bun"] });
		const bundled = join(rig.root, "bundled.json");
		writeFileSync(bundled, bytesOf(stackWith((s) => ((s.generation = 8), delete s.optionalTools))));
		assert.equal(rig.updater.prepare(bundled), null);
		assert.deepEqual(rig.updater.state, { phase: "refused", reason: "recipe-tool", generation: 8, tools: ["bun"] });
		assert.deepEqual(rig.runs, []);
		assert.equal(rig.record().bundledRolledBack, 8);
		assert.ok(rig.logs.some((l) => l.event === "stack-bundled-refused"));
		assert.equal(loadActiveStack(testLayout(rig.root), bundled).seeded, false);
		assert.equal(readFileSync(rig.files.active, "utf8"), realText);
	});

	it("asks for the recipe's tools against the stack in force, not the bundled one or whatever the wizard seeded", () => {
		const asked: number[] = [];
		const rig = makeRig({ recipeTools: [], onRecipeTools: (stack) => void asked.push(stack.generation) });
		const bundled = join(rig.root, "bundled.json");
		writeFileSync(bundled, bytesOf(next(8)));
		assert.equal(rig.updater.prepare(bundled)?.kind, "bundled", "a bundled stack that keeps every tool is planned as before");
		assert.deepEqual(asked, [5]);
	});
});

describe("a heal tells a finished apply from a rolled-back one (R13-F005)", () => {
	const healRig = (inFlight: Record<string, unknown>, activeGeneration: number) => {
		const rig = makeRig({ activeBytes: bytesOf(next(activeGeneration)) });
		writeFileSync(join(rig.root, "state", "update.json"), JSON.stringify({ schema: 1, inFlight: { at: "2026-11-04T09:00:00Z", ...inFlight } }));
		return rig;
	};
	const bundledFile = (rig: Rig, generation: number): string => {
		const file = join(rig.root, "bundled-stack.json");
		writeFileSync(file, bytesOf(next(generation)));
		return file;
	};

	it("records applied when the candidate was promoted and active.json is at its generation", async () => {
		const rig = healRig({ generation: 6, source: "channel", promoted: true }, 6);
		const plan = rig.updater.prepare(bundledFile(rig, 5));
		assert.equal(plan?.kind, "heal");
		await rig.updater.finish(plan);
		assert.deepEqual(rig.events, ["stop", "engine 6", "start"], "the engine converges to the new stack");
		assert.deepEqual(rig.updater.state, { phase: "applied", generation: 6, at: "2026-11-04T10:00:00.000Z" });
		assert.equal(rig.record().last.phase, "applied");
		assert.equal(rig.record().inFlight, undefined);
		assert.equal(rig.updater.generation, 6);
	});

	it("writes the promoted marker before the candidate's bytes become active.json, so a cut-off after it can be told", async () => {
		const seen: Array<{ promoted: boolean | undefined; generationOnDisk: number }> = [];
		const rig: Rig = makeRig({
			onReload: () => void seen.push({ promoted: rig.record().inFlight?.promoted, generationOnDisk: JSON.parse(readFileSync(rig.files.active, "utf8")).generation }),
		});
		serveSigned(rig, next(6));
		await rig.updater.check();
		await rig.updater.apply();
		// The reload that follows promote() sees active.json at the candidate and the marker set.
		assert.deepEqual(seen, [{ promoted: true, generationOnDisk: 6 }]);
		assert.equal(rig.record().inFlight, undefined, "and the record is cleared once the stack has started");
	});

	it("records a rollback when the apply was cut short before the candidate was promoted", async () => {
		const rig = healRig({ generation: 6, source: "channel" }, 5);
		await rig.updater.finish(rig.updater.prepare(bundledFile(rig, 5)));
		assert.equal(rig.updater.state.phase, "rolled-back");
		assert.equal((rig.updater.state as { stage: string }).stage, "interrupted");
	});

	it("does not take active.json at the failed generation for a finished apply unless the marker says it was promoted", async () => {
		const rig = healRig({ generation: 6, source: "channel" }, 6);
		await rig.updater.finish(rig.updater.prepare(bundledFile(rig, 5)));
		assert.equal(rig.updater.state.phase, "rolled-back");
	});

	it("a bundled run cut short puts the old stack back, spends the bundled try, and the wizard does not seed it", async () => {
		const rig = makeRig();
		const bundled = bundledFile(rig, 8);
		assert.equal(rig.updater.prepare(bundled)?.kind, "bundled");
		// The wizard had seeded the bundled file when the app was cut short (no `promoted` marker yet).
		writeFileSync(rig.files.active, readFileSync(bundled));
		const heal = rig.updater.prepare(bundled);
		assert.equal(heal?.kind, "heal");
		await rig.updater.finish(heal);
		assert.equal(readFileSync(rig.files.active, "utf8"), realText);
		assert.deepEqual(rig.events, ["stop", "engine 5", "start"]);
		assert.equal(rig.record().bundledRolledBack, 8);
		assert.equal(rig.updater.state.phase, "rolled-back");
		assert.equal(loadActiveStack(testLayout(rig.root), bundled).seeded, false);
	});

	it("a bundled run that was promoted and cut off at the start is an applied one", async () => {
		const rig = makeRig();
		const bundled = bundledFile(rig, 8);
		rig.updater.prepare(bundled);
		writeFileSync(rig.files.active, readFileSync(bundled));
		writeFileSync(join(rig.root, "state", "update.json"), JSON.stringify({ schema: 1, inFlight: { generation: 8, source: "bundled", at: "2026-11-04T09:00:00Z", promoted: true } }));
		await rig.updater.finish(rig.updater.prepare(bundled));
		assert.equal(rig.updater.state.phase, "applied");
		assert.equal(JSON.parse(readFileSync(rig.files.active, "utf8")).generation, 8, "the bundled stack stays in force");
		assert.equal(rig.record().bundledRolledBack, undefined);
	});
});

describe("an error names its kind and keeps the raw text for Details (R13-F006)", () => {
	it("maps a stack that cannot be stopped, and a refused engine run, to busy; anything else to other", async () => {
		for (const [error, kind] of [
			[Object.assign(new Error("the stack could not be stopped: a program still runs"), { name: "StackBusyError" }), "busy"],
			[new Error("an engine run is already active"), "busy"],
			[new Error("EPERM: operation not permitted, rename 'C:\\x'"), "other"],
		] as const) {
			const rig = makeRig({
				withStackStopped: async () => {
					throw error;
				},
			});
			serveSigned(rig, next(6));
			await rig.updater.check();
			await rig.updater.apply();
			assert.deepEqual(rig.updater.state, { phase: "error", kind, detail: error.message });
		}
	});
});
