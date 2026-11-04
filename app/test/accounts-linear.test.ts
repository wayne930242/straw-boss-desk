import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { failureLine, LinearAccounts, linearFile, LINEAR_KEY_URL, tttConfigFile, type SecretBox, type TttInstall } from "../src/main/accounts/linear.ts";
import type { CommandRunner, RunOptions, RunResult } from "../src/main/platform/types.ts";
import { scratchRoot, testLayout } from "./harness/engine-fixture.ts";

// The Linear key (task 11): where it is written, that nothing but `safeStorage` ever holds it, that it reaches the setup only through a child's environment, the refusal when the box is unavailable, and the
// restart offer. A box that reverses the text stands in for `safeStorage`; no real encryption, key, or Linear call.

const scratch: string[] = [];
after(() => {
	for (const d of scratch) removeTree(d);
});

const CURRENT = { node: "1", git: "1", herdr: "1", gh: "2.103.3", glab: "1.124.0" };
const KEY = "lin_api_TESTDUMMYKEY0123456789abcdef";

class FakeBox implements SecretBox {
	isAvailable = true;
	failDecrypt = false;
	/** What the OS was asked, in order: "available", "encrypt", "decrypt". */
	asked: string[] = [];
	async available(): Promise<boolean> {
		this.asked.push("available");
		return this.isAvailable;
	}
	async encrypt(text: string): Promise<Buffer> {
		this.asked.push("encrypt");
		if (!this.isAvailable) throw new Error("not available");
		return Buffer.from(`ENC:${[...text].reverse().join("")}`);
	}
	async decrypt(blob: Buffer): Promise<string> {
		this.asked.push("decrypt");
		if (this.failDecrypt) throw new Error("cannot decrypt this blob");
		return [...blob.toString().slice(4)].reverse().join("");
	}
}

function rig(options: { install?: TttInstall; initWrites?: boolean; initCode?: number; running?: boolean; restartFails?: boolean; tttMissing?: boolean } = {}) {
	const made = scratchRoot("sbd-linear-");
	scratch.push(made.base);
	const layout = testLayout(made.root);
	const work = join(made.base, "work folder");
	const box = new FakeBox();
	const calls: Array<{ file: string; args: string[]; options?: RunOptions }> = [];
	const log: Array<Record<string, unknown>> = [];
	const installs: number[] = [];
	const restarts: number[] = [];
	const held: string[] = [];
	const released: string[] = [];
	const opened: string[] = [];
	let running = options.running ?? true;
	const run: CommandRunner = async (file, args, o): Promise<RunResult> => {
		calls.push({ file, args: [...args], ...(o !== undefined ? { options: o } : {}) });
		if (options.initWrites !== false) {
			mkdirSync(join(o?.cwd ?? work, ".ttt"), { recursive: true });
			writeFileSync(tttConfigFile(o?.cwd ?? work), "team: x\n");
		}
		return { code: options.initCode ?? 0, stdout: options.initCode ? `error with ${KEY}` : "", stderr: "" };
	};
	const linear = new LinearAccounts({
		layout,
		box,
		run,
		appEnv: {},
		current: () => CURRENT,
		ttt: () => (options.tttMissing ? null : { file: "/fake/ttt", args: ["--lead"] }),
		installTtt: async () => {
			installs.push(1);
			return options.install ?? { ok: true, detail: "" };
		},
		workFolder: () => work,
		stackRunning: () => running,
		restartStack: async () => {
			restarts.push(1);
			if (options.restartFails) throw new Error("herdr did not come back");
		},
		log: (f) => log.push(f as Record<string, unknown>),
		openExternal: (u) => opened.push(u),
		hold: (v) => held.push(v),
		release: (v) => released.push(v),
	});
	return { layout, work, box, linear, calls, log, installs, restarts, held, released, opened, setRunning: (v: boolean) => (running = v) };
}
const filesUnder = (dir: string): string[] => {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
};

describe("saving the key", () => {
	it("writes the encrypted blob under secrets/ and nowhere else, never the key itself; then installs ttt and runs `ttt init -y` in the work folder with the key in the child's environment only", async () => {
		const r = rig();
		await r.linear.save(` ${KEY} `);
		const file = linearFile(r.layout);
		assert.ok(existsSync(file));
		assert.equal(readFileSync(file, "latin1").includes(KEY), false, "the blob is encrypted");
		assert.equal(r.installs.length, 1);
		const call = r.calls[0] as (typeof r.calls)[number];
		assert.deepEqual(call.args, ["--lead", "init", "-y"]);
		assert.equal(call.options?.cwd, r.work);
		assert.equal(call.options?.env?.LINEAR_API_KEY, KEY);
		assert.equal(call.options?.replaceEnv, true);
		assert.equal(JSON.stringify(call.args).includes(KEY), false, "no key on a command line");
		assert.deepEqual(r.linear.flow, { phase: "done", initialized: "ran" });
		assert.equal(r.linear.state, "saved");
		assert.equal(JSON.stringify(r.log).includes(KEY), false);
		assert.equal(JSON.stringify(r.linear.view()).includes(KEY), false);
		// No file under the root holds the key in the clear.
		for (const f of filesUnder(r.layout.root)) assert.equal(readFileSync(f).includes(KEY), false, f);
		assert.ok(r.held.includes(KEY), "the redactor hides it in every log");
	});

	it("refuses a key that is not the shape of one, before anything is written", async () => {
		const r = rig();
		for (const bad of ["", "short", "has space in it 12345", "ключ-не-ascii-1234"]) {
			await r.linear.save(bad);
			assert.equal(r.linear.flow.phase, "invalid", bad);
		}
		assert.equal(existsSync(linearFile(r.layout)), false);
		assert.equal(r.installs.length + r.calls.length, 0);
	});

	it("with encryption unavailable it refuses to save: no file, no plain-text fallback, no setup", async () => {
		const r = rig();
		r.box.isAvailable = false;
		await r.linear.save(KEY);
		assert.equal(r.linear.flow.phase, "refused");
		assert.equal(r.linear.view().encryption, false);
		assert.ok(!r.box.asked.includes("encrypt"), "the box was not asked to encrypt");
		assert.equal(existsSync(linearFile(r.layout)), false);
		assert.deepEqual(filesUnder(r.layout.secrets), []);
		assert.equal(r.installs.length + r.calls.length, 0);
		assert.ok(r.log.some((l) => l.event === "linear-save-refused"));
	});

	it("a failed `ttt` install or `ttt init` keeps the key saved and offers the setup again", async () => {
		const noInstall = rig({ install: { ok: false, detail: `npm failed for ${KEY}` } });
		await noInstall.linear.save(KEY);
		const f = noInstall.linear.flow;
		assert.equal(f.phase === "setup-failed" && f.step, "install");
		assert.equal(JSON.stringify(f).includes(KEY), false);
		assert.equal(noInstall.linear.state, "saved");

		const badInit = rig({ initWrites: false, initCode: 1 });
		await badInit.linear.save(KEY);
		const g = badInit.linear.flow;
		assert.equal(g.phase === "setup-failed" && g.step, "init");
		assert.equal(JSON.stringify([g, badInit.log]).includes(KEY), false, "the error text is redacted");
		assert.equal(badInit.linear.state, "saved");
	});

	it("an exit 0 that wrote no setup is a failure, and a folder that holds a setup already is kept as it is", async () => {
		const silent = rig({ initWrites: false });
		await silent.linear.save(KEY);
		assert.equal(silent.linear.flow.phase, "setup-failed");

		const kept = rig();
		mkdirSync(join(kept.work, ".ttt"), { recursive: true });
		writeFileSync(tttConfigFile(kept.work), "mine: 1\n");
		await kept.linear.save(KEY);
		assert.deepEqual(kept.linear.flow, { phase: "done", initialized: "kept" });
		assert.equal(kept.calls.length, 0, "ttt init would refuse without --force, and --force would overwrite the PM's choices");
		assert.equal(readFileSync(tttConfigFile(kept.work), "utf8"), "mine: 1\n");
	});
});

describe("asking the OS whether it can encrypt (task 11)", () => {
	it("is not asked at construction, at a view, or at a read with no key saved: nothing reaches the OS for a PM who does not use Linear", async () => {
		const r = rig();
		assert.deepEqual(r.box.asked, []);
		assert.equal(r.linear.view().encryption, null, "not asked yet");
		assert.equal(await r.linear.read(), undefined);
		r.linear.view();
		assert.deepEqual(r.box.asked, [], "a read with no key file asks nothing");
	});

	it("is asked by probe(), once per call, and the screen is told when the answer changes", async () => {
		const r = rig();
		let changes = 0;
		r.linear.onChange(() => changes++);
		await r.linear.probe();
		assert.equal(r.linear.view().encryption, true);
		assert.equal(changes, 1);
		await r.linear.probe();
		assert.equal(changes, 1, "the same answer is not a change");
		r.box.isAvailable = false;
		await r.linear.probe();
		assert.equal(r.linear.view().encryption, false);
		assert.equal(changes, 2);
	});

	it("a box that throws counts as unable, and is logged", async () => {
		const r = rig();
		r.box.available = async () => {
			throw new Error("keychain did not answer");
		};
		await r.linear.probe();
		assert.equal(r.linear.view().encryption, false);
		assert.ok(r.log.some((l) => l.event === "linear-probe-failed"));
	});
});

describe("the key for the Herdr server", () => {
	it("is decrypted at each read; a blob that cannot be decrypted is 'unreadable', never a throw, and a new save clears it", async () => {
		const r = rig();
		assert.equal(await r.linear.read(), undefined);
		await r.linear.save(KEY);
		assert.equal(await r.linear.read(), KEY);
		r.box.failDecrypt = true;
		assert.equal(await r.linear.read(), undefined);
		assert.equal(r.linear.state, "unreadable");
		r.box.failDecrypt = false;
		assert.equal(await r.linear.read(), KEY);
		assert.equal(r.linear.state, "saved");
	});

	it("is not read when encryption has become unavailable", async () => {
		const r = rig();
		await r.linear.save(KEY);
		r.box.isAvailable = false;
		assert.equal(await r.linear.read(), undefined);
		assert.equal(r.linear.state, "unreadable");
	});
});

describe("the restart offer", () => {
	it("is made when the stack runs; Restart now restarts it once, Later keeps the key for the next start", async () => {
		const r = rig();
		await r.linear.save(KEY);
		assert.deepEqual(r.linear.view().restart, { phase: "offer", change: "saved" });
		await r.linear.restart();
		assert.equal(r.restarts.length, 1);
		assert.deepEqual(r.linear.view().restart, { phase: "restarted" });
		await r.linear.restart();
		assert.equal(r.restarts.length, 1, "no offer, no second restart");

		const later = rig();
		await later.linear.save(KEY);
		later.linear.restartLater();
		assert.deepEqual(later.linear.view().restart, { phase: "later" });
		assert.equal(later.restarts.length, 0);
	});

	it("is not made when the stack does not run, and is made even after a failed setup (the key is saved)", async () => {
		const idle = rig({ running: false });
		await idle.linear.save(KEY);
		assert.deepEqual(idle.linear.view().restart, { phase: "none" });

		const failed = rig({ install: { ok: false, detail: "x" } });
		await failed.linear.save(KEY);
		assert.equal(failed.linear.view().restart.phase, "offer");
	});

	it("a restart that fails says so", async () => {
		const r = rig({ restartFails: true });
		await r.linear.save(KEY);
		await r.linear.restart();
		const v = r.linear.view().restart;
		assert.equal(v.phase, "failed");
		assert.match(v.phase === "failed" ? v.detail : "", /did not come back/);
	});
});

describe("removing the key", () => {
	it("deletes secrets/linear.bin, keeps the ttt setup, forgets the key in the redactor and offers a restart", async () => {
		const r = rig();
		await r.linear.save(KEY);
		await r.linear.signOut();
		assert.equal(existsSync(linearFile(r.layout)), false);
		assert.ok(existsSync(tttConfigFile(r.work)), "the setup holds no key");
		assert.deepEqual(r.released, [KEY]);
		assert.equal(r.linear.state, "not-saved");
		assert.deepEqual(r.linear.view().restart, { phase: "offer", change: "removed" });
	});
});

describe("small things", () => {
	it("the key page is Linear's API settings; edit and cancel move the field; a quit stops new work", async () => {
		const r = rig();
		r.linear.open();
		assert.deepEqual(r.opened, [LINEAR_KEY_URL]);
		r.linear.edit();
		assert.equal(r.linear.flow.phase, "entering");
		r.linear.reset();
		assert.equal(r.linear.flow.phase, "idle");
		r.linear.dispose();
		await r.linear.save(KEY);
		assert.equal(existsSync(linearFile(r.layout)), false);
	});

	it("failureLine hides the key and anything shaped like a Linear token", () => {
		assert.equal(failureLine(`bad ${KEY} and lin_oauth_ABCDEF123`, KEY).includes("lin_"), false);
	});

	it("the file is not world-readable on macOS", async () => {
		if (process.platform === "win32") return;
		const r = rig();
		await r.linear.save(KEY);
		assert.equal(statSync(linearFile(r.layout)).mode & 0o077, 0);
	});
});
