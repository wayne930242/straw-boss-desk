// Fixtures that seed and rewrite entries in the OS credential store (macOS keychain, Windows Credential Manager) to test the CredentialStore against
// real stores. Registered through the guard: they run on a GitHub-hosted runner, and locally on macOS only in a scratch HOME keychain.
// Seeded names look like gh's (`gh:<host>`, accounts "" and a user) but use a host under .example.test, so they can never be anyone's real sign-in.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { removeTree } from "../../src/main/bootstrap/fsutil.ts";
import { createMacCredentialStore, createMacLocate } from "../../src/main/platform/mac.ts";
import { helperPath, helpersDir } from "../../src/main/platform/win-helper-cache.ts";
import { createWinCredentialStore, createWinLocate, createWinUserPath } from "../../src/main/platform/win.ts";
import type { CommandRunner, CredentialStore } from "../../src/main/platform/types.ts";
import { defineFixture, type FixtureIO } from "./hosted.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

/** Writes and removes entries the way gh and go-keyring name them: macOS service and account, Windows target `<service>:<account>`. */
export interface Seeder {
	write(name: string, account: string, secret: string): Promise<void>;
	remove(name: string, account: string): Promise<void>;
	/** The secret of an entry, for a test that seeded it with a known dummy and wants to see it unchanged. Null when there is no such entry. Never use it on a real login. */
	read(name: string, account: string): Promise<string | null>;
}

const WIN_SEED_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class SbdSeed {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL {
        public uint Flags; public uint Type; public string TargetName; public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
        public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWriteW(ref CREDENTIAL credential, uint flags);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDeleteW(string target, uint type, uint flags);
    public static int Write(string target, string user, string secret) {
        byte[] bytes = Encoding.Unicode.GetBytes(secret);
        IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
        try {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            CREDENTIAL c = new CREDENTIAL();
            c.Type = 1; c.TargetName = target; c.UserName = user;
            c.CredentialBlobSize = (uint)bytes.Length; c.CredentialBlob = blob; c.Persist = 2;
            return CredWriteW(ref c, 0) ? 0 : Marshal.GetLastWin32Error();
        } finally { Marshal.FreeHGlobal(blob); }
    }
    public static int Delete(string target) { return CredDeleteW(target, 1, 0) ? 0 : Marshal.GetLastWin32Error(); }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr buffer);
    public static string Read(string target) {
        IntPtr p;
        if (!CredReadW(target, 1, 0, out p)) return "";
        try {
            CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
            byte[] bytes = new byte[c.CredentialBlobSize];
            Marshal.Copy(c.CredentialBlob, bytes, 0, bytes.Length);
            return "=" + Convert.ToBase64String(Encoding.UTF8.GetBytes(Encoding.Unicode.GetString(bytes)));
        } finally { CredFree(p); }
    }
}
'@
function Decode([string]$v) { return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($v)) }
$target = Decode $env:SBD_TARGET
if ($env:SBD_OP -eq 'write') { [Console]::Out.Write([string][SbdSeed]::Write($target, (Decode $env:SBD_USER), (Decode $env:SBD_SECRET))) }
elseif ($env:SBD_OP -eq 'read') { [Console]::Out.Write([SbdSeed]::Read($target)) }
else { [Console]::Out.Write([string][SbdSeed]::Delete($target)) }
`;

function winPowerShell(io: FixtureIO, env: Record<string, string>): Promise<string> {
	const exe = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
	const encoded = Buffer.from(WIN_SEED_SCRIPT, "utf16le").toString("base64");
	return io
		.run(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { env, timeoutMs: 60_000 })
		.then((r) => {
			if (r.code !== 0) throw new Error(`seeding exited ${r.code}: ${r.stderr.trim().slice(0, 300)}`);
			return r.stdout.trim();
		});
}

export function seederFor(platform: NodeJS.Platform, io: FixtureIO): Seeder {
	if (platform === "darwin") {
		return {
			async write(name, account, secret) {
				const r = await io.run("security", ["add-generic-password", "-U", "-a", account, "-s", name, "-w", secret], { timeoutMs: 10_000 });
				if (r.code !== 0) throw new Error(`seeding ${name} exited ${r.code}: ${r.stderr.trim()}`);
			},
			async remove(name, account) {
				await io.run("security", ["delete-generic-password", "-a", account, "-s", name], { timeoutMs: 10_000 });
			},
			async read(name, account) {
				const r = await io.run("security", ["find-generic-password", "-a", account, "-s", name, "-w"], { timeoutMs: 10_000 });
				return r.code === 0 ? r.stdout.replace(/\r?\n$/, "") : null;
			},
		};
	}
	if (platform === "win32") {
		return {
			async write(name, account, secret) {
				const code = await winPowerShell(io, { SBD_OP: "write", SBD_TARGET: b64(`${name}:${account}`), SBD_USER: b64(account), SBD_SECRET: b64(secret) });
				if (code !== "0") throw new Error(`seeding ${name} failed (Win32 error ${code})`);
			},
			async remove(name, account) {
				await winPowerShell(io, { SBD_OP: "delete", SBD_TARGET: b64(`${name}:${account}`) });
			},
			async read(name, account) {
				const answer = await winPowerShell(io, { SBD_OP: "read", SBD_TARGET: b64(`${name}:${account}`) });
				return answer.startsWith("=") ? Buffer.from(answer.slice(1), "base64").toString("utf8") : null;
			},
		};
	}
	throw new Error(`no credential store seeder for ${platform}`);
}

/** The credential store of `platform`, run through `io` (a scratch HOME's, or the hosted runner's own). */
export function storeFor(io: FixtureIO, platform: NodeJS.Platform, captured: string[] = []): CredentialStore {
	const run: CommandRunner = async (file, args, options) => {
		const r = await io.run(file, args, options);
		captured.push(r.stdout, r.stderr);
		return r;
	};
	const log = (line: string) => { captured.push(line); };
	return platform === "darwin" ? createMacCredentialStore({ run, locate: createMacLocate(), log }) : createWinCredentialStore({ run, locate: createWinLocate(), log });
}

interface Rig {
	store: CredentialStore;
	seeder: Seeder;
	/** Everything the store's commands printed, and every line it logged. */
	captured: string[];
}

function rigFor(io: FixtureIO, platform: NodeJS.Platform): Rig {
	const captured: string[] = [];
	const run: CommandRunner = async (file, args, options) => {
		const r = await io.run(file, args, options);
		captured.push(r.stdout, r.stderr);
		return r;
	};
	const log = (line: string) => { captured.push(line); };
	const store = platform === "darwin"
		? createMacCredentialStore({ run, locate: createMacLocate(), log })
		: createWinCredentialStore({ run, locate: createWinLocate(), log });
	return { store, seeder: seederFor(platform, io), captured };
}

const byAccount = <T extends { account: string }>(entries: T[]): T[] => [...entries].sort((a, b) => a.account.localeCompare(b.account));

export const credentialListing = defineFixture({
	name: "credential store: list two seeded items under one service with their times, and see a second write change only its own time",
	platforms: ["darwin", "win32"],
	scratch: "keychain",
	async body(io: FixtureIO): Promise<void> {
		const platform = process.platform;
		const { store, seeder, captured } = rigFor(io, platform);
		const nonce = randomBytes(5).toString("hex");
		const name = `gh:sbd-${nonce}.example.test`;
		const secret = `sbd-known-secret-${nonce}`;
		try {
			await seeder.write(name, "", secret);
			await seeder.write(name, "someone", secret);

			const first = byAccount(await store.list([name]));
			assert.deepEqual(first.map((e) => [e.name, e.account]), [[name, ""], [name, "someone"]]);
			for (const e of first) assert.match(e.modified, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/, `modification time of ${e.account || "(empty account)"}`);

			// A service that merely starts with the name, or is a prefix of it, is not the service (the Windows filter is a prefix match).
			assert.deepEqual(await store.list([`${name}x`]), []);
			assert.deepEqual(await store.list([name.slice(0, -2)]), []);
			assert.deepEqual(await store.list([]), []);

			// A second write at least 2 s later (macOS keeps mdat to the second) changes the time of that entry only.
			await sleep(2100);
			await seeder.write(name, "someone", secret);
			const second = byAccount(await store.list([name]));
			assert.equal(second.length, 2);
			assert.equal(second[0]?.modified, first[0]?.modified, "the untouched entry keeps its time");
			assert.notEqual(second[1]?.modified, first[1]?.modified, "the rewritten entry has a new time");
			assert.ok((second[1]?.modified ?? "") > (first[1]?.modified ?? ""), "and it is later");

			// The secret never reached anything the store printed, logged, or returned (plain, base64 of UTF-8, base64 of UTF-16LE).
			const everything = [...captured, JSON.stringify(first), JSON.stringify(second)].join("\n");
			for (const form of [secret, Buffer.from(secret, "utf8").toString("base64"), Buffer.from(secret, "utf16le").toString("base64")]) {
				assert.ok(!everything.includes(form), `a form of the secret is in the store's output: ${form.slice(0, 8)}...`);
			}

			await store.delete({ name, account: "" });
			assert.deepEqual((await store.list([name])).map((e) => e.account), ["someone"]);
			await store.delete({ name, account: "someone" });
			assert.deepEqual(await store.list([name]), []);
			await assert.rejects(store.delete({ name, account: "someone" }), /delet/i, "deleting what is gone is an error, not silence");
		} finally {
			await seeder.remove(name, "").catch(() => undefined);
			await seeder.remove(name, "someone").catch(() => undefined);
		}
	},
});

export const credentialProbe = defineFixture({
	name: "credential store: the probe writes, reads, and deletes a throwaway entry and leaves nothing behind",
	platforms: ["darwin", "win32"],
	scratch: "keychain",
	async body(io: FixtureIO): Promise<void> {
		const platform = process.platform;
		const { store, captured } = rigFor(io, platform);
		assert.deepEqual(await store.probe(), { ok: true });
		// What a probe leaves behind shows in the store's own listing of all names; the probe names its throwaway `straw-boss-desk-probe-<nonce>`.
		const dump = platform === "darwin"
			? (await io.run("security", ["dump-keychain"], { timeoutMs: 10_000 })).stdout
			: (await io.run(`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmdkey.exe`, ["/list"], { timeoutMs: 20_000 })).stdout;
		assert.ok(!dump.includes("straw-boss-desk-probe"), "the probe left an entry in the store");
		assert.ok(captured.some((line) => line.includes("probe")), "the probe logged its steps");
	},
});

/** The native helper's cache on the real Windows PowerShell: one build, then loads, a corrupt file replaced, and the same answers each time. Timings go to the log, not to an assertion. */
export const nativeHelperCache = defineFixture({
	name: "native helper cache: the first call builds one DLL, later calls load it, a corrupt file is replaced, and the answers stay the same",
	platforms: ["win32"],
	async body(io: FixtureIO): Promise<void> {
		const root = join(realpathSync.native(mkdtempSync(join(tmpdir(), "sbd-helper-"))), "root 測試");
		const dll = helperPath(root);
		const run: CommandRunner = (file, args, options) => io.run(file, args, options);
		const lines: string[] = [];
		const store = createWinCredentialStore({ run, locate: createWinLocate(), root, log: (line) => lines.push(line) });
		const dlls = () => readdirSync(helpersDir(root)).filter((f) => f.startsWith("sbd-native-"));
		const timed = async <T>(what: string, body: () => Promise<T>): Promise<T> => {
			const t0 = Date.now();
			try {
				return await body();
			} finally {
				console.log(`native helper cache: ${what} took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
			}
		};
		const nonce = randomBytes(5).toString("hex");
		const scratchKey = `Software\\StrawBossDeskTest-${nonce}`;
		try {
			assert.deepEqual(await timed("the first probe (builds the helper)", () => store.probe()), { ok: true });
			assert.deepEqual(dlls(), [basename(dll)], "exactly one helper file, named by the hash of its source");
			assert.ok(statSync(dll).size > 2000, "a compiled assembly, not a stub");
			const built = statSync(dll).mtimeMs;

			assert.deepEqual(await timed("the second probe (loads the helper)", () => store.probe()), { ok: true });
			assert.deepEqual(await timed("a listing of a name nothing has (loads the helper)", () => store.list([`gh:sbd-${nonce}.example.test`])), []);
			await assert.rejects(store.delete({ name: `gh:sbd-${nonce}.example.test`, account: "x" }), /Win32 error 1168/, "the Win32 error comes through the loaded helper unchanged");
			assert.equal(statSync(dll).mtimeMs, built, "loading never rebuilds the file");

			// The registry broadcast lives in the same assembly: a write with the broadcast on a scratch key loads it and builds nothing.
			const userPath = createWinUserPath({ run, locate: createWinLocate(), root, key: scratchKey });
			await timed("a user PATH write with the broadcast (loads the helper)", async () => {
				assert.deepEqual(await userPath.ensureFirst("C:\\sbd-test\\shims"), { changed: true });
				assert.deepEqual(await userPath.remove("C:\\sbd-test\\shims"), { changed: true });
			});
			assert.equal(statSync(dll).mtimeMs, built);

			// A file that will not load is deleted and built again, in the same call, and the answer is the one a good file gives.
			writeFileSync(dll, "this is not an assembly");
			assert.deepEqual(await timed("a probe over a corrupt file (deletes it, builds again)", () => store.probe()), { ok: true });
			assert.equal(dlls().length, 1);
			assert.ok(statSync(dll).size > 2000, "the corrupt file was replaced by a real assembly");
			const rebuilt = statSync(dll).mtimeMs;
			assert.deepEqual(await timed("the probe after the rebuild (loads the helper)", () => store.probe()), { ok: true });
			assert.equal(statSync(dll).mtimeMs, rebuilt);
			assert.ok(lines.some((l) => l.includes("would not load")), "the replacement is logged");
			console.log(`native helper cache: files in the helpers folder: ${readdirSync(helpersDir(root)).join(", ")}`);
		} finally {
			await io.run(`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\reg.exe`, ["delete", `HKCU\\${scratchKey}`, "/f"], { timeoutMs: 20_000 }).catch(() => undefined);
			removeTree(join(root, ".."));
		}
	},
});
