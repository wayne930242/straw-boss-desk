import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { createNativeHelper, helperFileName, helperPath, helpersDir, isHelperFile, PowerShellExit, type HelperFs } from "../src/main/platform/win-helper-cache.ts";
import type { CommandRunner } from "../src/main/platform/types.ts";
import { createWinCredentialStore, createWinLocate, createWinUserPath } from "../src/main/platform/win.ts";
import {
	CREDENTIAL_LIST_BODY, CREDENTIAL_PROBE_BODY, HELPER_LOAD_EXIT, NATIVE_PRELUDE_BUILD, NATIVE_PRELUDE_LOAD, NATIVE_PRELUDE_MEMORY, NATIVE_PRELUDE_NONE, NATIVE_SOURCE, PROCESS_SCRIPT, USER_PATH_BODY,
} from "../src/main/platform/win-scripts.ts";
import { scratchRoot } from "./harness/engine-fixture.ts";

// The compiled native helper (spec: Windows native helper): the file's name and place, which prelude a call gets, what a helper that will not load costs, and that the
// scripts' outputs stay the same. PowerShell itself runs only on the Windows runners; here a fake runner records the script text and the environment it was given.

const scratch: string[] = [];
after(() => {
	for (const d of scratch) removeTree(d);
});
const scratchDir = () => {
	const made = scratchRoot("sbd-helper-");
	scratch.push(made.base);
	return made.root;
};

const decode = (args: readonly string[]): string => Buffer.from(args[args.indexOf("-EncodedCommand") + 1] ?? "", "base64").toString("utf16le");

interface Call {
	script: string;
	env: Record<string, string>;
	encodedLength: number;
}

/** A runner that records each call and answers from `answer` (called with the call's index). */
function recorder(answer: (index: number, script: string, env: Record<string, string>) => { code: number; stdout?: string; stderr?: string }): { run: CommandRunner; calls: Call[] } {
	const calls: Call[] = [];
	const run: CommandRunner = async (_file, args, options) => {
		const script = decode(args);
		calls.push({ script, env: { ...(options?.env ?? {}) }, encodedLength: (args[args.indexOf("-EncodedCommand") + 1] ?? "").length });
		const a = answer(calls.length - 1, script, calls[calls.length - 1]?.env ?? {});
		return { code: a.code, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
	};
	return { run, calls };
}

const ok = (stdout = "ok") => ({ code: 0, stdout });
const loadFailure = { code: HELPER_LOAD_EXIT, stderr: "sbd-helper-load-failed" };
const usesBuild = (script: string) => script.includes("-OutputAssembly");
const usesLoad = (script: string) => script.includes("exit 99") && !usesBuild(script);

describe("helper file name and place", () => {
	it("names the file by the first 16 hex digits of the SHA-256 of the C# source", () => {
		const name = helperFileName("class A {}");
		assert.match(name, /^sbd-native-[0-9a-f]{16}\.dll$/);
		assert.equal(name, helperFileName("class A {}"));
		assert.equal(name, `sbd-native-${createHash("sha256").update("class A {}", "utf8").digest("hex").slice(0, 16)}.dll`);
	});

	it("gives another name to another source, so a new app version never loads an old helper", () => {
		assert.notEqual(helperFileName("class A {}"), helperFileName("class A { }"));
		assert.notEqual(helperFileName(NATIVE_SOURCE), helperFileName(NATIVE_SOURCE + "\n"));
		assert.equal(helperFileName(), helperFileName(NATIVE_SOURCE));
	});

	it("puts the file in <root>/helpers, and nowhere else", () => {
		const root = join(scratchDir(), "data");
		const file = helperPath(root);
		assert.equal(file, join(helpersDir(root), helperFileName()));
		assert.equal(helpersDir(root), join(root, "helpers"));
		assert.ok(isHelperFile(root, file));
	});

	it("refuses a relative root, so the working directory is never a place to load from", () => {
		assert.throws(() => helperPath("data"), /absolute/);
		assert.throws(() => helperPath(""), /absolute/);
	});

	it("knows its own files only: by name, by folder, not by a path that climbs out", () => {
		const root = join(scratchDir(), "data");
		const name = helperFileName();
		assert.ok(isHelperFile(root, join(helpersDir(root), name)));
		assert.equal(isHelperFile(root, join(root, name)), false, "right name, wrong folder");
		assert.equal(isHelperFile(root, join(helpersDir(root), "sub", name)), false, "a subfolder");
		assert.equal(isHelperFile(root, join(helpersDir(root), "..", "tools", name)), false, "climbing out");
		assert.equal(isHelperFile(root, join(helpersDir(root), "sbd-native-XYZ.dll")), false, "a name no hash made");
		assert.equal(isHelperFile(root, join(helpersDir(root), `${name}.tmp`)), false);
		assert.equal(isHelperFile(root, join(helpersDir(root), "sbd-tmp-0123456789abcdef.dll")), false, "a temp file is not the cache file");
		assert.equal(isHelperFile(join(root, "other"), join(helpersDir(root), name)), false, "another root's file");
	});
});

describe("which prelude a call gets", () => {
	function helperWith(fs: HelperFs, root: string | undefined, answer: Parameters<typeof recorder>[0]) {
		const { run, calls } = recorder(answer);
		const logs: string[] = [];
		const native = createNativeHelper({ root, fs, log: (l) => logs.push(l), call: async (script, env) => {
			const r = await run("powershell.exe", ["-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env });
			if (r.code !== 0) throw new PowerShellExit(r.code ?? -1, r.stderr);
			return r.stdout;
		} });
		return { native, calls, logs };
	}
	const memoryFs = (present: Set<string>, canRemove = true): HelperFs & { removed: string[] } => {
		const removed: string[] = [];
		return {
			removed,
			exists: (f) => present.has(f),
			remove(f) {
				if (!canRemove) return false;
				removed.push(f);
				return present.delete(f);
			},
		};
	};

	it("compiles in memory, and sets no helper path, when there is no data root (the app before the cache)", async () => {
		const fs = memoryFs(new Set());
		const { native, calls } = helperWith(fs, undefined, () => ok());
		assert.equal(await native("native", CREDENTIAL_PROBE_BODY, { SBD_TARGET: "t" }), "ok");
		assert.equal(calls.length, 1);
		assert.ok(calls[0]?.script.startsWith(NATIVE_PRELUDE_MEMORY));
		assert.equal(calls[0]?.env.SBD_HELPER_DLL, undefined);
		assert.equal(calls[0]?.env.SBD_TARGET, "t");
	});

	it("builds the file on first use: one run, with the DLL's path under the data root in the environment", async () => {
		const root = join(scratchDir(), "data");
		const fs = memoryFs(new Set());
		const { native, calls, logs } = helperWith(fs, root, () => ok("lines"));
		assert.equal(await native("native", CREDENTIAL_LIST_BODY, { SBD_OP: "list" }), "lines");
		assert.equal(calls.length, 1);
		assert.ok(calls[0]?.script.startsWith(NATIVE_PRELUDE_BUILD));
		assert.equal(calls[0]?.env.SBD_HELPER_DLL, helperPath(root));
		assert.equal(logs.length, 1);
	});

	it("loads the file when it exists: one run, no C# in the script, a much shorter command line", async () => {
		const root = join(scratchDir(), "data");
		const fs = memoryFs(new Set([helperPath(root)]));
		const { native, calls } = helperWith(fs, root, () => ok());
		await native("native", CREDENTIAL_PROBE_BODY, { SBD_TARGET: "t" });
		assert.equal(calls.length, 1);
		const script = calls[0]?.script ?? "";
		assert.ok(script.startsWith(NATIVE_PRELUDE_LOAD));
		assert.ok(usesLoad(script));
		assert.equal(script.includes("DllImport"), false);
		assert.equal(calls[0]?.env.SBD_HELPER_DLL, helperPath(root));
		assert.deepEqual(fs.removed, []);
	});

	it("deletes only the cache file that will not load, and runs the script again with the building prelude", async () => {
		const root = join(scratchDir(), "data");
		const dll = helperPath(root);
		const bystander = join(helpersDir(root), "sbd-native-0000000000000000.dll");
		const fs = memoryFs(new Set([dll, bystander]));
		const { native, calls, logs } = helperWith(fs, root, (i) => (i === 0 ? loadFailure : ok("answer")));
		assert.equal(await native("native", CREDENTIAL_LIST_BODY, { SBD_OP: "list" }), "answer");
		assert.equal(calls.length, 2);
		assert.ok(usesLoad(calls[0]?.script ?? ""));
		assert.ok(usesBuild(calls[1]?.script ?? ""));
		assert.deepEqual(fs.removed, [dll], "the other helper file is not ours to delete");
		assert.equal(calls[1]?.env.SBD_HELPER_DLL, dll);
		assert.match(logs.join("\n"), /would not load; deleted it/);
	});

	it("still builds when the bad file cannot be deleted (locked)", async () => {
		const root = join(scratchDir(), "data");
		const fs = memoryFs(new Set([helperPath(root)]), false);
		const { native, calls, logs } = helperWith(fs, root, (i) => (i === 0 ? loadFailure : ok("answer")));
		assert.equal(await native("native", CREDENTIAL_LIST_BODY, {}), "answer");
		assert.equal(calls.length, 2);
		assert.match(logs.join("\n"), /could not delete it/);
	});

	it("does not delete the cache for a script that failed for its own reasons, nor run it twice", async () => {
		const root = join(scratchDir(), "data");
		const fs = memoryFs(new Set([helperPath(root)]));
		const { native, calls } = helperWith(fs, root, () => ({ code: 1, stderr: "Exception calling List" }));
		await assert.rejects(native("native", CREDENTIAL_LIST_BODY, {}), /PowerShell exited 1: Exception calling List/);
		assert.equal(calls.length, 1);
		assert.deepEqual(fs.removed, []);
	});

	it("fails when the build itself fails, with one rerun at most", async () => {
		const root = join(scratchDir(), "data");
		const fs = memoryFs(new Set([helperPath(root)]));
		const { native, calls } = helperWith(fs, root, (i) => (i === 0 ? loadFailure : { code: 1, stderr: "Add-Type : error CS1002" }));
		await assert.rejects(native("native", CREDENTIAL_LIST_BODY, {}), /CS1002/);
		assert.equal(calls.length, 2);
	});

	it("gives a script that never calls the helper no prelude work at all, whatever the root", async () => {
		const root = join(scratchDir(), "data");
		const fs = memoryFs(new Set());
		const { native, calls } = helperWith(fs, root, () => ok("none 0"));
		await native("none", USER_PATH_BODY, { SBD_OP: "read" });
		assert.equal(calls.length, 1);
		assert.ok(calls[0]?.script.startsWith(NATIVE_PRELUDE_NONE));
		assert.equal(calls[0]?.script.includes("Add-Type"), false);
		assert.equal(calls[0]?.env.SBD_HELPER_DLL, undefined);
	});

	it("keeps the command line far below the 32767 characters Windows allows, in the build form too", () => {
		const encoded = (text: string) => Buffer.from(text, "utf16le").toString("base64").length;
		for (const body of [CREDENTIAL_LIST_BODY, CREDENTIAL_PROBE_BODY, USER_PATH_BODY]) {
			assert.ok(encoded(NATIVE_PRELUDE_BUILD + body) < 26_000, `build form is ${encoded(NATIVE_PRELUDE_BUILD + body)}`);
			assert.ok(encoded(NATIVE_PRELUDE_MEMORY + body) < 26_000);
			assert.ok(encoded(NATIVE_PRELUDE_LOAD + body) < 8_000);
		}
	});
});

describe("the scripts themselves", () => {
	it("compile the C# in one place: the three bodies hold none, and only the helper's types are called", () => {
		for (const body of [CREDENTIAL_LIST_BODY, CREDENTIAL_PROBE_BODY, USER_PATH_BODY]) {
			assert.equal(body.includes("Add-Type"), false);
			assert.equal(body.includes("DllImport"), false);
		}
		assert.equal(PROCESS_SCRIPT.includes("Add-Type"), false, "the process listing reads CIM and compiles nothing");
		assert.equal(CREDENTIAL_PROBE_BODY.includes("[SbdNative]::Probe($env:SBD_TARGET)"), true);
	});

	it("keep the Win32 surface the cache replaced: list, delete, probe, and the settings-change broadcast", () => {
		for (const member of ["public static string List(string[] filters)", "public static int Delete(string target)", "public static string Probe(string target)", "public static void Broadcast()"]) {
			assert.ok(NATIVE_SOURCE.includes(member), member);
		}
		assert.ok(NATIVE_SOURCE.includes("SendMessageTimeout(new IntPtr(0xffff), 0x001A, UIntPtr.Zero, \"Environment\", 2, 5000, out result)"));
		assert.ok(NATIVE_PRELUDE_BUILD.includes(NATIVE_SOURCE), "the building prelude carries the source the name was hashed from");
		assert.ok(NATIVE_PRELUDE_MEMORY.includes(NATIVE_SOURCE));
	});

	it("only ever load the file named by the app, and clean only temp files of their own kind", () => {
		assert.ok(NATIVE_PRELUDE_LOAD.includes("Add-Type -LiteralPath $env:SBD_HELPER_DLL"));
		assert.ok(NATIVE_PRELUDE_BUILD.includes("GetFiles($dir, 'sbd-tmp-*.dll')"));
		assert.ok(NATIVE_PRELUDE_BUILD.includes("[IO.File]::Move($tmp, $dll)"), "a temp name, then a rename");
	});
});

describe("through the Windows stores", () => {
	const locate = createWinLocate({ systemRoot: "C:\\Windows" });
	const filetime = (iso: string) => (BigInt(Date.parse(iso)) + 11_644_473_600_000n) * 10_000n;
	const line = `${Buffer.from("gh:github.com:u").toString("base64")} ${Buffer.from("u").toString("base64")} ${filetime("2026-11-01T12:00:00Z")}`;

	it("a credential check costs one build, then loads: the probe and the listing share one helper file", async () => {
		const root = join(scratchDir(), "data");
		const { run, calls } = recorder((_i, script) => (script.includes("Probe") ? ok("ok") : ok(line)));
		const store = createWinCredentialStore({ run, locate, root });
		assert.deepEqual(await store.probe(), { ok: true });
		assert.ok(usesBuild(calls[0]?.script ?? ""));
		assert.equal(calls[0]?.env.SBD_HELPER_DLL, helperPath(root));
		// The first run is what would write the file; do what it does.
		mkdirSync(helpersDir(root), { recursive: true });
		writeFileSync(helperPath(root), "stand-in");
		const entries = await store.list(["gh:github.com"]);
		assert.equal(entries.length, 1);
		assert.ok(usesLoad(calls[1]?.script ?? ""), "the listing loads what the probe built");
		assert.equal(calls[1]?.env.SBD_HELPER_DLL, helperPath(root));
		await store.delete({ name: "gh:github.com", account: "u" }).catch(() => {});
		assert.ok(usesLoad(calls[2]?.script ?? ""));
	});

	it("deletes a cache file that will not load, through the real file system, and answers as before", async () => {
		const root = join(scratchDir(), "data");
		mkdirSync(helpersDir(root), { recursive: true });
		writeFileSync(helperPath(root), "not a dll");
		const { run, calls } = recorder((i) => (i === 0 ? loadFailure : ok("ok")));
		const result = await createWinCredentialStore({ run, locate, root }).probe();
		assert.deepEqual(result, { ok: true });
		assert.equal(calls.length, 2);
		assert.equal(existsSync(helperPath(root)), false);
	});

	it("without a root keeps the old behavior: compile in memory, every call", async () => {
		const { run, calls } = recorder(() => ok("ok"));
		await createWinCredentialStore({ run, locate }).probe();
		assert.ok(calls[0]?.script.includes("Add-Type -TypeDefinition $source"));
		assert.equal(usesBuild(calls[0]?.script ?? ""), false);
	});

	it("the user PATH compiles nothing to read, or to write without the broadcast; it uses the helper only to broadcast", async () => {
		const root = join(scratchDir(), "data");
		const { run, calls } = recorder((_i, _script, env) => ok(env.SBD_OP === "read" ? "none" : "ok"));
		const quiet = createWinUserPath({ run, locate, root, broadcast: false, key: "Software\\sbd-test" });
		await quiet.read();
		await quiet.ensureFirst("C:\\x");
		for (const c of calls) assert.equal(c.script.includes("Add-Type"), false, "no helper without the broadcast");
		const before = calls.length;
		const loud = createWinUserPath({ run, locate, root, key: "Software\\sbd-test" });
		await loud.ensureFirst("C:\\x");
		const last = calls[calls.length - 1];
		assert.ok(calls.length > before);
		assert.ok(usesBuild(last?.script ?? ""));
		assert.equal(last?.env.SBD_BROADCAST, "1");
		assert.equal(last?.env.SBD_HELPER_DLL, helperPath(root));
	});

	it("types a failed run as a PowerShell exit with its code, so another failure is never taken for a failed load", () => {
		const e = new PowerShellExit(99, "x");
		assert.equal(e.code, 99);
		assert.match(e.message, /^PowerShell exited 99: x$/);
	});
});
