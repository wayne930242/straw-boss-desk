import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { binEntry, binScript, binShim, installedFiles, npmGlobalPin, npmGlobalStage, piStage, readManifest } from "../src/main/bootstrap/stages/pi.ts";
import { npmFailure, npmFailureKind } from "../src/main/bootstrap/npm.ts";
import { StateStore } from "../src/main/bootstrap/state.ts";
import { execRunner } from "../src/main/platform/exec.ts";
import type { CommandRunner } from "../src/main/platform/types.ts";
import { readStartGate } from "../src/main/runtime/readiness.ts";
import type { Stack } from "../src/main/bootstrap/stack.ts";
import { connectProxy } from "./harness/connect-proxy.ts";
import { makeStack, scratchRoot, testEngine, testLayout } from "./harness/engine-fixture.ts";
import { installFakeNode } from "./harness/fake-node.ts";
import { NpmRegistryFixture } from "./harness/npm-registry.ts";
import { resolveOsProxy } from "../src/main/env.ts";

// The `pi` stage against a local registry, with the real npm of the node running the test: success, a second run, a changed file, a wrong pin, a
// missing version, a registry that is down or answers 500, and the OS proxy reaching npm through a test-local CONNECT proxy. Each failure checks the
// category the engine reports (the kit's sentences for the registry's, none for an integrity mismatch) and how often it was tried.

const registry = new NpmRegistryFixture();
const scratch: string[] = [];
before(async () => {
	await registry.listen();
});
after(async () => {
	await registry.close();
	for (const d of scratch) removeTree(d);
});

const PI = "@earendil-works/pi-coding-agent";
const isWindows = process.platform === "win32";

interface Fixture {
	base: string;
	root: string;
	layout: ReturnType<typeof testLayout>;
	appEnv: Record<string, string>;
}

/** A root whose `node`, `git`, and `herdr` are active (as the stages before `pi` leave them), and an app environment that is the scratch folder's own. */
async function fixture(rootName?: string): Promise<Fixture> {
	const made = scratchRoot("sbd-pi-", rootName);
	scratch.push(made.base);
	const layout = testLayout(made.root);
	installFakeNode(layout, "24.0.0");
	const store = new StateStore(layout);
	await store.setVersion("node", "24.0.0");
	await store.setVersion("git", "2.56.0");
	await store.setVersion("herdr", "0.9.5");
	const tmp = join(made.base, "tmp");
	mkdirSync(tmp, { recursive: true });
	const essentials = Object.fromEntries(
		["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "LANG"].flatMap((name) => {
			const key = Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase());
			return key !== undefined && process.env[key] !== undefined ? [[name, process.env[key] as string]] : [];
		}),
	);
	const appEnv: Record<string, string> = isWindows
		? { ...essentials, USERPROFILE: made.base, HOME: made.base, APPDATA: join(made.base, "AppData"), LOCALAPPDATA: join(made.base, "AppData", "Local"), TEMP: tmp, TMP: tmp, USERNAME: "runner" }
		: { ...essentials, HOME: made.base, USER: "runner", TMPDIR: tmp };
	return { base: made.base, root: made.root, layout, appEnv };
}

const stackFor = (pin: { name: string; version: string; integrity: string }): Stack => ({ ...makeStack({}), npmGlobal: [{ ...pin, bin: "pi" }] });

/** The `pi` stage with its `needs` removed (the stages before it are stood in for by the active versions above) and npm pointed at the fixture registry. */
const stageOf = (extraEnv: Record<string, string> = {}) => ({ ...piStage(isWindows ? "win32" : "darwin", { env: { NPM_CONFIG_REGISTRY: registry.url, ...extraEnv } }), needs: [] as string[] });

const runPi = async (f: Fixture, pin: { name: string; version: string; integrity: string }, extraEnv: Record<string, string> = {}, proxyEnv?: Record<string, string>) => {
	const engine = testEngine(f.root, () => [stageOf(extraEnv)], { appEnv: f.appEnv, layout: f.layout });
	await engine.engine.handle({
		type: "run",
		config: { root: f.root, stack: stackFor(pin), secretPatterns: (await import("./harness/engine-fixture.ts")).secretPatterns, ...(proxyEnv ? { proxyEnv } : {}) },
	});
	const done = engine.events.find((e) => e.type === "done");
	assert.ok(done?.type === "done", JSON.stringify(engine.events.find((e) => e.type === "error")));
	return { outcome: done.outcomes.find((o) => o.stage === "pi"), events: engine.events };
};

describe("the pi stage against a local registry", () => {
	const published = registry.publish(PI, "1.4.0");

	it("installs the pinned package, prints its version through the wrapper, and hashes what it installed", async () => {
		const f = await fixture();
		const { outcome } = await runPi(f, published);
		assert.equal(outcome?.status, "installed", JSON.stringify(outcome));
		assert.match(outcome?.evidence ?? "", /pi --version -> 1\.4\.0/);
		assert.ok(existsSync(binShim(f.layout, "pi")), "the wrapper npm wrote");
		const record = new StateStore(f.layout).record("pi");
		assert.equal(record?.status, "ok");
		assert.equal(record?.version, "1.4.0");
		assert.ok(Object.keys(record?.hashes ?? {}).some((k) => k.endsWith("package.json")), "package.json is hashed");
		assert.ok(Object.keys(record?.hashes ?? {}).some((k) => k.endsWith("dist/cli.js")), "the bin script is hashed");
		assert.ok(registry.requests.some((r) => r.startsWith("GET /@earendil-works/pi-coding-agent") || r.includes("pi-coding-agent")), "npm asked the registry");
	});

	it("is skipped-verified the second time, and installed again when a hashed file changes", async () => {
		const f = await fixture();
		assert.equal((await runPi(f, published)).outcome?.status, "installed");
		assert.equal((await runPi(f, published)).outcome?.status, "skipped-verified");
		const cli = installedFiles(f.layout, published, "pi").find((p) => p.endsWith("cli.js")) as string;
		writeFileSync(cli, `${readFileSync(cli, "utf8")}// tampered\n`);
		const again = await runPi(f, published);
		assert.equal(again.outcome?.status, "installed", "a changed bin script fails detect");
		assert.ok(!readFileSync(cli, "utf8").includes("tampered"));
	});

	it("refuses a pin whose integrity differs from the registry's: category integrity, tried once, nothing installed", async () => {
		const f = await fixture();
		const wrong = { ...published, integrity: `sha512-${Buffer.alloc(64, 7).toString("base64")}` };
		const { outcome } = await runPi(f, wrong);
		assert.equal(outcome?.status, "failed");
		assert.equal(outcome?.failure?.category, "integrity");
		assert.equal(outcome?.attempts, 1, "an integrity mismatch is never retried");
		assert.match(outcome?.failure?.detail ?? "", /registry integrity mismatch/);
		assert.equal(existsSync(binShim(f.layout, "pi")), false);
	});

	it("says registry, with the kit's sentence, for a version the registry does not have, and tries twice", async () => {
		const f = await fixture();
		const { outcome } = await runPi(f, { name: PI, version: "9.9.9", integrity: published.integrity });
		assert.equal(outcome?.failure?.category, "registry");
		assert.equal(outcome?.attempts, 2);
		assert.match(outcome?.failure?.sentence ?? "", /^The npm registry could not be reached or is out of date, so @earendil-works\/pi-coding-agent@9\.9\.9 was not installed\./);
		assert.match(outcome?.failure?.detail ?? "", /not an integrity mismatch/);
	});

	it("says registry for a server error and for a registry that is not there at all", async () => {
		const f = await fixture();
		registry.mode = { kind: "status", code: 500 };
		try {
			assert.equal((await runPi(f, published, { NPM_CONFIG_FETCH_RETRIES: "0" })).outcome?.failure?.category, "registry");
		} finally {
			registry.mode = { kind: "ok" };
		}
		const down = await runPi(await fixture(), published, { NPM_CONFIG_REGISTRY: "http://127.0.0.1:9/", NPM_CONFIG_FETCH_RETRIES: "0" });
		assert.equal(down.outcome?.failure?.category, "registry");
		assert.equal(down.outcome?.attempts, 2);
	});

	it("goes through the proxy the OS setting names on a first install, with no proxy variable in the app's environment", async () => {
		const f = await fixture();
		// A forward proxy that knows one name, which is not on the loopback list NO_PROXY keeps off the proxy.
		const proxy = await connectProxy({ hostMap: { "registry.sbd.test": "127.0.0.1" } });
		registry.publicHost = "registry.sbd.test";
		try {
			// The stub answers as `session.resolveProxy` would; main turns the answer into the variables the engine hands to every child it starts.
			const os = await resolveOsProxy({ resolve: async () => `PROXY 127.0.0.1:${proxy.port}`, forgeHosts: [], appEnv: f.appEnv });
			assert.equal(os.env.HTTP_PROXY, `http://127.0.0.1:${proxy.port}`);
			assert.equal(os.env.NO_PROXY, "127.0.0.1,localhost,::1");
			const { outcome } = await runPi(f, published, { NPM_CONFIG_REGISTRY: `http://registry.sbd.test:${registry.port}/` }, os.env);
			assert.equal(outcome?.status, "installed", JSON.stringify(outcome));
			assert.ok(proxy.requests.some((r) => r.startsWith(`http://registry.sbd.test:${registry.port}/`)), `the proxy saw ${JSON.stringify(proxy.requests)}`);
			assert.ok(proxy.requests.some((r) => r.includes("/tarballs/")), "the tarball came through the proxy too");
		} finally {
			registry.publicHost = "127.0.0.1";
			await proxy.close();
		}
	});
});

// T6-F001: the default root holds the profile folder's name, which can carry `&`, `^`, `!`, or `%`. The stage runs the package's bin script with the
// private Node (what the `pi.cmd` shim runs), never npm's `pi.cmd` wrapper, whose `SET dp0=%~dp0` breaks under `&` and `^`.
const HOSTILE_ROOTS = ["a^b!c%d&e 測試", "R&D", "a^b", "100%", "x!y!", "(1) b"];

const INSTALL_LIMIT_MS = 3_500;
/**
 * The stage hands its `timeoutMs` to both npm programs it runs: the integrity lookup (`npm view`) and the install. Here it is meant for the install, which the registry never lets finish. A loaded machine can
 * need more than 3.5 s just to start npm and read the packument; then the lookup is what the limit cuts off, the stage fails as `registry` before it marks the prefix, and the record is `failed` (or the old
 * `ok`), a path these tests do not mean to take. So the lookup runs under the limit the stage gives it when none is set, and only the install keeps the short one.
 */
const limitInstallOnly: CommandRunner = (() => {
	const run = execRunner(process.env);
	return (file, args, options) => (args[1] === "view" ? run(file, args, { ...options, timeoutMs: 120_000 }) : run(file, args, options));
})();

/** The engine of a `pi` stage whose npm install hangs on the tarball and is cut off after `INSTALL_LIMIT_MS`. */
const cutOffEngine = (f: Fixture) =>
	testEngine(f.root, () => [{ ...piStage(isWindows ? "win32" : "darwin", { env: { NPM_CONFIG_REGISTRY: registry.url, NPM_CONFIG_FETCH_RETRIES: "0" }, timeoutMs: INSTALL_LIMIT_MS }), needs: [] as string[] }], { appEnv: f.appEnv, layout: f.layout, run: limitInstallOnly });

describe("R9B-F002 and R13-F009: an install of pi that is cut off keeps the start refused", () => {
	const published = registry.publish(PI, "1.5.0");

	it("leaves the record `running` and the start gate reading it when npm install -g hits its time limit", async () => {
		const f = await fixture();
		registry.mode = { kind: "hang-tarball" };
		try {
			const engine = cutOffEngine(f);
			await engine.engine.handle({ type: "run", config: { root: f.root, stack: stackFor(published), secretPatterns: (await import("./harness/engine-fixture.ts")).secretPatterns } });
			const done = engine.events.find((e) => e.type === "done");
			assert.ok(done?.type === "done", JSON.stringify(engine.events.find((e) => e.type === "error")));
			assert.equal(done.outcomes.find((o) => o.stage === "pi")?.failure?.category, "registry", "the time limit is a registry failure");
		} finally {
			registry.mode = { kind: "ok" };
		}
		assert.equal(new StateStore(f.layout).record("pi")?.status, "running", "a cut-off npm may still be writing the prefix");
		assert.deepEqual(readStartGate(f.layout).interrupted, ["pi"], "a start is refused until a run of the stage finishes");
	});

	it("records `failed`, not the old `ok`, when a pin change fails after npm began (the prefix has no staging copy)", async () => {
		const f = await fixture();
		const old = registry.publish(PI, "1.6.0");
		assert.equal((await runPi(f, old)).outcome?.status, "installed");
		const next = { ...registry.publish(PI, "1.7.0"), integrity: `sha512-${Buffer.alloc(64, 9).toString("base64")}` };
		// The registry integrity check stops this one before npm installs anything: the old record stays.
		assert.equal((await runPi(f, next)).outcome?.failure?.category, "integrity");
		assert.equal(new StateStore(f.layout).record("pi")?.status, "ok");
		registry.mode = { kind: "hang-tarball" };
		try {
			const engine = cutOffEngine(f);
			await engine.engine.handle({ type: "run", config: { root: f.root, stack: stackFor(registry.publish(PI, "1.7.1")), secretPatterns: (await import("./harness/engine-fixture.ts")).secretPatterns } });
		} finally {
			registry.mode = { kind: "ok" };
		}
		assert.notEqual(new StateStore(f.layout).record("pi")?.status, "ok", "the old install may be gone or altered");
	});
});

describe("the pi stage under a root with cmd's special characters (T6-F001), Windows only", { skip: isWindows ? false : "Windows only: cmd.exe's parsing of the wrapper npm writes" }, () => {
	const hostile = registry.publish(PI, "1.5.0");
	for (const name of HOSTILE_ROOTS) {
		it(`installs and prints the pin under ${JSON.stringify(name)}`, async () => {
			const f = await fixture(name);
			const { outcome } = await runPi(f, hostile);
			assert.equal(outcome?.status, "installed", JSON.stringify(outcome));
			assert.match(outcome?.evidence ?? "", /pi --version -> 1\.5\.0/);
			// The script that ran is the package's own, which the shim names too.
			const script = binScript(f.layout, hostile, "pi");
			assert.ok(script !== null && existsSync(script.absolute), "the bin script is where the manifest says");
		});
	}
});

describe("where the bin script is", () => {
	const published = registry.publish(PI, "1.6.0");

	it("is the manifest's bin entry under the package folder, as an absolute path and as the place under the root the Windows shim writes", async () => {
		const f = await fixture();
		assert.equal(binScript(f.layout, published, "pi"), null, "nothing installed yet");
		const { outcome } = await runPi(f, published);
		assert.equal(outcome?.status, "installed", JSON.stringify(outcome));
		const script = binScript(f.layout, published, "pi");
		assert.ok(script !== null && existsSync(script.absolute));
		assert.equal(script?.relative, "tools\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js");
	});

	it("is null for an entry that climbs out of the package, or a manifest without the bin", () => {
		const f = testLayout(join(scratchRoot("sbd-pi-b-").root));
		const dir = join(f.tools.npm, ...(isWindows ? ["node_modules"] : ["lib", "node_modules"]), "@earendil-works", "pi-coding-agent");
		mkdirSync(dir, { recursive: true });
		const pin = { name: PI, version: "1.0.0", integrity: "sha512-x" };
		writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.0.0", bin: { pi: "../../escape.js" } }));
		assert.equal(binScript(f, pin, "pi"), null);
		writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }));
		assert.equal(binScript(f, pin, "pi"), null);
	});
});

describe("npm's own words", () => {
	it("tells registry-side failures from the rest", () => {
		assert.equal(npmFailureKind("npm error code ETIMEDOUT"), "network failure");
		assert.match(npmFailureKind("npm error code E404"), /no such version/);
		assert.match(npmFailureKind("npm error code ETARGET\nnpm error notarget No matching version found for x@1"), /no such version/);
		assert.match(npmFailureKind("npm error code E403"), /refused/);
		assert.match(npmFailureKind("npm error code E503"), /server error/);
		assert.equal(npmFailureKind("npm error code UNABLE_TO_VERIFY_LEAF_SIGNATURE"), "certificate failure");
		assert.equal(npmFailureKind("npm error something else entirely"), "npm failed");
	});

	it("maps them to the engine's categories", () => {
		const fail = (stderr: string, extra: object = {}) => npmFailure("pi", "x@1.0.0", { code: 1, stdout: "", stderr, ...extra }, "npm install -g x@1.0.0");
		assert.equal(fail("npm error code ECONNRESET").category, "registry");
		assert.equal(fail("npm error code E404").category, "registry");
		assert.equal(fail("", { timedOut: true, code: null }).category, "registry");
		assert.equal(fail("npm error code ENOSPC").category, "disk");
		assert.equal(fail("npm error code EBUSY: resource busy or locked, rename").category, "locked");
		assert.equal(fail("npm error SELF_SIGNED_CERT_IN_CHAIN").category, "network");
		assert.equal(fail("npm error SELF_SIGNED_CERT_IN_CHAIN").params.cause, "tls");
		assert.equal(fail("npm error code EJSONPARSE").category, "other");
	});
});

describe("reading an installed package", () => {
	it("takes the bin entry from the object and the string forms, and nothing from a manifest without one", () => {
		assert.equal(binEntry({ bin: { pi: "dist/bundle/cli.js" } }, "pi", PI), "dist/bundle/cli.js");
		assert.equal(binEntry({ bin: "cli.js" }, "pi", "pi"), "cli.js");
		assert.equal(binEntry({ bin: "cli.js" }, "pi", PI), null, "a string bin is named after the package, which is not pi");
		assert.equal(binEntry({ version: "1.0.0" }, "pi", PI), null);
		assert.equal(binEntry(null, "pi", PI), null);
	});

	it("keeps only the fields of the right type and reads a missing file as null", () => {
		const { base } = scratchRoot("sbd-pi-m-");
		scratch.push(base);
		writeFileSync(join(base, "a.json"), JSON.stringify({ version: 5, bin: { pi: 1, x: "y.js" } }));
		assert.deepEqual(readManifest(join(base, "a.json")), { bin: { x: "y.js" } });
		writeFileSync(join(base, "b.json"), "[1]");
		assert.equal(readManifest(join(base, "b.json")), null);
		assert.equal(readManifest(join(base, "missing.json")), null);
	});

	it("finds the pin of a bin in the stack, and fails by name when there is none", () => {
		const stack = stackFor({ name: PI, version: "1.4.0", integrity: "sha512-x" });
		assert.equal(npmGlobalPin(stack, "pi").version, "1.4.0");
		assert.throws(() => npmGlobalPin(stack, "ttt"), /no package with the bin ttt/);
	});
});

describe("the ttt stage is installed beside a running stack (task 12 carry-in review)", () => {
	/** A context that records what the install asked of it; every program it runs answers with the pinned integrity or succeeds. */
	const install = async (name: "pi" | "ttt", waitForQuiet?: boolean): Promise<string[]> => {
		const asked: string[] = [];
		const pin = { name: "@x/pkg", version: "1.0.0", integrity: "sha512-abc", bin: name };
		const stage = npmGlobalStage({ name, needs: [], ...(waitForQuiet === true ? { waitForQuiet } : {}) });
		const ctx = {
			stage: name,
			stack: { npmGlobal: [pin] },
			layout: { tools: { root: "/t", npm: "/t/npm" } },
			fsErrors: [] as string[],
			versionsOf: () => ({ node: "24.0.0" }),
			childEnv: () => ({}),
			exec: async (_file: string, args: readonly string[]) => (args.includes("view") ? { code: 0, stdout: "sha512-abc\n", stderr: "" } : (asked.push("npm-install"), { code: 0, stdout: "", stderr: "" })),
			waitForQuietTools: async () => void asked.push("wait-quiet"),
			markInPlace: () => void asked.push("mark-in-place"),
		};
		await stage.install(ctx as never);
		return asked;
	};

	it("marks its prefix but does not wait for the programs of the data root, which are the running stack", async () => {
		assert.deepEqual(await install("ttt"), ["mark-in-place", "npm-install"]);
	});

	it("the pi stage waits first and then marks, as it runs with the stack stopped", async () => {
		assert.deepEqual(await install("pi", true), ["wait-quiet", "mark-in-place", "npm-install"]);
		assert.equal(piStage("darwin").name, "pi");
	});
});
