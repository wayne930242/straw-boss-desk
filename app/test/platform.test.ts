import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMacCredentialStore, createMacLocate, isUnderDir, parseDumpKeychain, parseLsofExecutables, parsePsStart } from "../src/main/platform/mac.ts";
import {
	createWinCredentialStore, createWinLocate, filetimeToIso, isUnderWinDir, parseCredentialList, parseProcessLines, planEnsureFirst, planRemove, splitTarget,
} from "../src/main/platform/win.ts";
import { createPlatform } from "../src/main/platform/index.ts";
import { CredentialStoreError, type CommandRunner } from "../src/main/platform/types.ts";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("macOS: dump-keychain parsing", () => {
	// Shaped like `security dump-keychain` output (without -d) on macOS 27: attributes only, in the order the tool prints them.
	const item = (cls: string, svce: string, acct: string, mdat: string) => [
		'keychain: "/Users/pm/Library/Keychains/login.keychain-db"', "version: 512", `class: ${cls}`, "attributes:",
		'    0x00000007 <blob>="x"', '    0x00000008 <blob>=<NULL>', `    "acct"<blob>=${acct}`,
		'    "cdat"<timedate>=0x32303236313130313133333632325A00  "20261101133622Z\\000"',
		`    "mdat"<timedate>=${mdat}`, `    "svce"<blob>=${svce}`, '    "type"<uint32>=<NULL>',
	].join("\n");
	const time = (t: string) => `0x00  "${t}\\000"`;
	const dump = [
		item('"genp"', '"gh:github.com"', "<NULL>", time("20261101133632Z")),
		item('"genp"', '"gh:github.com"', '"wayne930242"', time("20261101133700Z")),
		item('"genp"', '"glab:gitlab.example:token"', "0xE6B8ACE8A9A6 ", time("20261102010203Z")),
		item('"inet"', '"gh:github.com"', '"internet-password"', time("20261101133632Z")),
		item("0x0000000F ", '"com.apple.systemdefault"', "<NULL>", time("20261101133632Z")),
		item('"genp"', "<NULL>", '"tailscale-current-profile"', time("20261001042013Z")),
		item('"genp"', '"gh:_refreshable:github.com"', "<NULL>", "<NULL>"),
	].join("\n");

	it("lists generic-password items with service, account, and modification time", () => {
		assert.deepEqual(parseDumpKeychain(dump).filter((e) => e.name !== ""), [
			{ name: "gh:github.com", account: "", modified: "2026-11-01T13:36:32Z" },
			{ name: "gh:github.com", account: "wayne930242", modified: "2026-11-01T13:37:00Z" },
			{ name: "glab:gitlab.example:token", account: "測試", modified: "2026-11-02T01:02:03Z" },
			{ name: "gh:_refreshable:github.com", account: "", modified: "" },
		]);
	});

	it("maps an empty account to the empty string and a missing time to the empty string (unreadable, so foreign)", () => {
		const entries = parseDumpKeychain(dump);
		assert.equal(entries.find((e) => e.name === "gh:_refreshable:github.com")?.modified, "");
		assert.equal(entries.find((e) => e.name === "gh:github.com")?.account, "");
	});

	it("skips internet passwords and non-generic classes", () => {
		assert.equal(parseDumpKeychain(dump).some((e) => e.name === "com.apple.systemdefault"), false);
		assert.equal(parseDumpKeychain(dump).filter((e) => e.name === "gh:github.com").length, 2);
	});

	it("returns nothing for an empty dump", () => {
		assert.deepEqual(parseDumpKeychain(""), []);
		assert.deepEqual(parseDumpKeychain('keychain: "/x"\nversion: 512\n'), []);
	});
});

describe("macOS: processes", () => {
	it("reads ps start times, collapsing the padded day", () => {
		assert.deepEqual([...parsePsStart("  123 Sat Nov  1 21:49:12 2026\n 4567 Sun Nov 12 01:02:03 2026\n")], [[123, "Sat Nov 1 21:49:12 2026"], [4567, "Sun Nov 12 01:02:03 2026"]]);
		assert.deepEqual([...parsePsStart("")], []);
	});

	it("takes the first path of each process from lsof -Fpn as its executable", () => {
		const text = "p100\nn/r/tools/node/bin/node\nn/usr/lib/dyld\np200\nn/usr/bin/zsh\nn/usr/lib/libc.dylib\np300\nn(no file)\n";
		assert.deepEqual([...parseLsofExecutables(text)], [[100, "/r/tools/node/bin/node"], [200, "/usr/bin/zsh"]]);
	});

	it("tells a program under a folder from one beside it", () => {
		assert.equal(isUnderDir("/r/tools", "/r/tools/node/bin/node"), true);
		assert.equal(isUnderDir("/r/tools", "/r/tools-other/bin/node"), false);
		assert.equal(isUnderDir("/r/tools", "/r/tools"), false);
		assert.equal(isUnderDir("/r/tools", "/usr/bin/zsh"), false);
	});
});

describe("Locate", () => {
	it("macOS: absolute paths for OS tools, an executable file along a PATH value", () => {
		const locate = createMacLocate((p) => p === "/b/pi" || p === "/c/pi");
		assert.equal(locate.system("tar"), "/usr/bin/tar");
		assert.equal(locate.system("security"), "/usr/bin/security");
		assert.throws(() => locate.system("powershell"), /not a macOS system tool/);
		assert.equal(locate.onPath("pi", "/a::/b:/c"), "/b/pi");
		assert.equal(locate.onPath("gh", "/a:/b"), null);
	});

	it("Windows: System32 paths, and PATHEXT along a PATH value", () => {
		const present = new Set(["C:\\b\\bash.cmd", "C:\\Windows\\System32\\bash.exe", "C:\\c\\pi.cmd", "C:\\c\\pi"]);
		const locate = createWinLocate({ systemRoot: "C:\\Windows", pathExt: ".COM;.EXE;.BAT;.CMD", exists: (p) => present.has(p) });
		assert.equal(locate.system("tar"), "C:\\Windows\\System32\\tar.exe");
		assert.equal(locate.system("powershell"), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
		assert.equal(locate.system("reg"), "C:\\Windows\\System32\\reg.exe");
		assert.throws(() => locate.system("security"), /not a Windows system tool/);
		assert.equal(locate.onPath("bash", "C:\\a;C:\\Windows\\System32;C:\\b"), "C:\\Windows\\System32\\bash.exe", "the machine PATH is walked in order, extensions in PATHEXT order");
		assert.equal(locate.onPath("bash", "C:\\a;\"C:\\b\""), "C:\\b\\bash.cmd");
		assert.equal(locate.onPath("bash.cmd", "C:\\b;C:\\Windows\\System32"), "C:\\b\\bash.cmd", "a name with a PATHEXT extension is tried as it is");
		assert.equal(locate.onPath("pi", "C:\\c"), "C:\\c\\pi.cmd", "an extensionless file is not what the OS runs; pi.cmd is");
		assert.equal(locate.onPath("nothing", "C:\\a;C:\\b"), null);
	});

	it("is chosen per platform, and an unsupported one fails at once", () => {
		assert.equal(createPlatform({ platform: "darwin" }).userPath.supported, false);
		assert.equal(createPlatform({ platform: "win32" }).userPath.supported, true);
		assert.throws(() => createPlatform({ platform: "linux" }), /unsupported platform linux/);
	});
});

describe("macOS: UserPath is not applicable", () => {
	it("reads nothing and changes nothing", async () => {
		const { userPath } = createPlatform({ platform: "darwin" });
		assert.equal(await userPath.read(), null);
		assert.deepEqual(await userPath.ensureFirst("/x"), { changed: false });
		assert.deepEqual(await userPath.remove("/x"), { changed: false });
	});
});

describe("Windows: UserPath planning", () => {
	const expand = (value: string) => ({ kind: "ExpandString" as const, value });

	it("puts the entry first and keeps the type and every other entry as written", () => {
		const current = expand("%USERPROFILE%\\bin;C:\\Tools\\;%SystemRoot%\\system32");
		const plan = planEnsureFirst(current, "C:\\r\\tools\\shims");
		assert.deepEqual(plan, { next: expand("C:\\r\\tools\\shims;%USERPROFILE%\\bin;C:\\Tools\\;%SystemRoot%\\system32"), changed: true });
	});

	it("changes nothing when the entry is already first, whatever its case or trailing backslash", () => {
		const current = expand("C:\\R\\Tools\\Shims\\;C:\\x");
		assert.deepEqual(planEnsureFirst(current, "c:\\r\\tools\\shims"), { next: current, changed: false });
	});

	it("moves an entry that is present but not first", () => {
		assert.deepEqual(planEnsureFirst(expand("C:\\x;C:\\shims;C:\\y"), "C:\\shims"), { next: expand("C:\\shims;C:\\x;C:\\y"), changed: true });
	});

	it("keeps REG_SZ as REG_SZ, and makes REG_EXPAND_SZ for a missing value", () => {
		assert.equal(planEnsureFirst({ kind: "String", value: "C:\\x" }, "C:\\s").next.kind, "String");
		assert.deepEqual(planEnsureFirst(null, "C:\\s"), { next: expand("C:\\s"), changed: true });
		assert.deepEqual(planEnsureFirst(expand(""), "C:\\s"), { next: expand("C:\\s"), changed: true });
	});

	it("keeps an empty entry (a trailing semicolon) where it was", () => {
		assert.deepEqual(planEnsureFirst(expand("C:\\x;"), "C:\\s").next, expand("C:\\s;C:\\x;"));
		assert.deepEqual(planRemove(expand("C:\\s;C:\\x;"), "C:\\s").next, expand("C:\\x;"));
	});

	it("removes only the exact entry and nothing else, expanding nothing", () => {
		const current = expand("%USERPROFILE%\\bin;C:\\Tools\\;C:\\Toolsmith;%USERPROFILE%\\bin2");
		assert.deepEqual(planRemove(current, "c:\\tools"), { next: expand("%USERPROFILE%\\bin;C:\\Toolsmith;%USERPROFILE%\\bin2"), changed: true });
		assert.deepEqual(planRemove(current, "%USERPROFILE%\\bin"), { next: expand("C:\\Tools\\;C:\\Toolsmith;%USERPROFILE%\\bin2"), changed: true });
		assert.deepEqual(planRemove(current, "C:\\Windows"), { next: current, changed: false });
		assert.deepEqual(planRemove(null, "C:\\Tools"), { next: null, changed: false });
	});

	it("deletes the value when the entry was the only one", () => {
		assert.deepEqual(planRemove(expand("C:\\s"), "C:\\s"), { next: null, changed: true });
		assert.deepEqual(planRemove(expand("C:\\s;"), "C:\\s"), { next: null, changed: true });
	});

	it("refuses an entry that is not a PATH entry", () => {
		for (const bad of ["", "a;b", "C:\\x\ny"]) assert.throws(() => planEnsureFirst(null, bad), /not a PATH entry/);
		assert.throws(() => planRemove(null, ""), /not a PATH entry/);
	});
});

describe("Windows: credential listing (no localized text)", () => {
	// What the PowerShell helper prints on a zh-TW Windows: base64 of UTF-8 for the names, a FILETIME for the time. Nothing in it is a label.
	const filetime = (iso: string) => (BigInt(Date.parse(iso)) + 11_644_473_600_000n) * 10_000n;

	it("turns a FILETIME into ISO 8601 with 100 ns precision", () => {
		assert.equal(filetimeToIso(filetime("2026-11-01T12:00:00.000Z")), "2026-11-01T12:00:00.0000000Z");
		assert.equal(filetimeToIso(filetime("2026-11-01T12:00:00.123Z") + 4567n), "2026-11-01T12:00:00.1234567Z");
		assert.ok(filetimeToIso(filetime("2026-11-01T12:00:01Z")) > filetimeToIso(filetime("2026-11-01T12:00:00Z")));
	});

	it("parses a zh-TW result with CJK names and an empty user", () => {
		const output = [
			`${b64("gh:github.com:")} ${b64("")} ${filetime("2026-11-01T12:00:00Z")}`,
			`${b64("gh:github.com:測試使用者")} ${b64("測試使用者")} ${filetime("2026-11-01T12:00:01Z")}`,
			`${b64("glab:gitlab.moldplan.app:token:")} ${b64("")} ${filetime("2026-11-01T12:00:02Z")}`,
		].join("\r\n");
		const parsed = parseCredentialList(output);
		assert.deepEqual(parsed.map((c) => [c.target, c.user]), [["gh:github.com:", ""], ["gh:github.com:測試使用者", "測試使用者"], ["glab:gitlab.moldplan.app:token:", ""]]);
		assert.deepEqual(parsed.map((c) => splitTarget(c.target, c.user)), [
			{ name: "gh:github.com", account: "" },
			{ name: "gh:github.com", account: "測試使用者" },
			{ name: "glab:gitlab.moldplan.app:token", account: "" },
		]);
	});

	it("keeps a target that does not end in :<user> whole", () => {
		assert.deepEqual(splitTarget("gh:github.com", ""), { name: "gh:github.com", account: "" });
	});

	it("returns nothing for an empty listing and refuses a line it cannot read", () => {
		assert.deepEqual(parseCredentialList(""), []);
		assert.throws(() => parseCredentialList("garbage"), CredentialStoreError);
	});

	it("lists only exact service names, even though the Windows filter is a prefix match", async () => {
		const out = [
			`${b64("gh:github.com:")} ${b64("")} ${filetime("2026-11-01T12:00:00Z")}`,
			`${b64("gh:github.com:wayne")} ${b64("wayne")} ${filetime("2026-11-01T12:00:01Z")}`,
			`${b64("gh:github.company.example:")} ${b64("")} ${filetime("2026-11-01T12:00:02Z")}`,
		].join("\n");
		const seen: Array<{ file: string; env: Record<string, string> | undefined }> = [];
		const run: CommandRunner = async (file, _args, options) => { seen.push({ file, env: options?.env as Record<string, string> | undefined }); return { code: 0, stdout: out, stderr: "" }; };
		const store = createWinCredentialStore({ run, locate: createWinLocate({ systemRoot: "C:\\Windows" }) });
		const entries = await store.list(["gh:github.com"]);
		assert.deepEqual(entries.map((e) => e.account).sort(), ["", "wayne"]);
		assert.equal(seen[0]?.env?.SBD_FILTERS, "gh:github.com*");
		assert.equal(seen[0]?.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
	});

	it("fails the listing, not silently, when PowerShell does", async () => {
		const run: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "Add-Type : denied" });
		const store = createWinCredentialStore({ run, locate: createWinLocate({ systemRoot: "C:\\Windows" }) });
		await assert.rejects(store.list(["gh:github.com"]), (e: unknown) => e instanceof CredentialStoreError && /listing failed/.test(e.message));
		const timeout: CommandRunner = async () => ({ code: null, stdout: "", stderr: "", timedOut: true });
		await assert.rejects(createWinCredentialStore({ run: timeout, locate: createWinLocate() }).list(["gh:github.com"]), CredentialStoreError);
	});

	it("reports a probe that fails or times out as ok: false, never a throw", async () => {
		const fail: CommandRunner = async () => ({ code: 0, stdout: "fail write 1312", stderr: "" });
		assert.deepEqual(await createWinCredentialStore({ run: fail, locate: createWinLocate() }).probe(), { ok: false, reason: "Credential Manager refused a step (fail write 1312)" });
		const timeout: CommandRunner = async () => ({ code: null, stdout: "", stderr: "", timedOut: true });
		const result = await createWinCredentialStore({ run: timeout, locate: createWinLocate() }).probe();
		assert.equal(result.ok, false);
	});

	it("refuses a service name that would widen the filter", async () => {
		const store = createWinCredentialStore({ run: async () => ({ code: 0, stdout: "", stderr: "" }), locate: createWinLocate() });
		for (const bad of ["", "gh:*", "a|b", "x?"]) await assert.rejects(store.list([bad]), CredentialStoreError);
	});
});

describe("Windows: processes", () => {
	it("parses pid, executable, and start time, with empty fields for what Windows would not say", () => {
		const text = `100 ${b64("C:\\Users\\測試\\r\\tools\\node\\node.exe")} 2026-11-01T12:00:00.1234567Z\r\n200  \n300 ${b64("C:\\Windows\\System32\\cmd.exe")} 2026-11-01T12:00:01.0000000Z`;
		assert.deepEqual(parseProcessLines(text), [
			{ pid: 100, startTime: "2026-11-01T12:00:00.1234567Z", executable: "C:\\Users\\測試\\r\\tools\\node\\node.exe" },
			{ pid: 200, startTime: null, executable: null },
			{ pid: 300, startTime: "2026-11-01T12:00:01.0000000Z", executable: "C:\\Windows\\System32\\cmd.exe" },
		]);
		assert.deepEqual(parseProcessLines(""), []);
	});

	it("tells a program under a folder from one beside it, without regard to case", () => {
		assert.equal(isUnderWinDir("C:\\Users\\a\\R\\tools", "c:\\users\\a\\r\\TOOLS\\node\\node.exe"), true);
		assert.equal(isUnderWinDir("C:\\r\\tools", "C:\\r\\tools-other\\node.exe"), false);
		assert.equal(isUnderWinDir("C:\\r\\tools", "D:\\r\\tools\\node.exe"), false);
	});
});

describe("macOS: credential store failures", () => {
	const locate = createMacLocate();
	type Call = { args: readonly string[]; stdin: string | undefined };
	const recording = (answer: (args: readonly string[]) => { code: number | null; stdout?: string; stderr?: string; timedOut?: boolean }) => {
		const calls: Call[] = [];
		const run: CommandRunner = async (_file, args, options) => {
			calls.push({ args, stdin: options?.stdin });
			const a = answer(args);
			return { code: a.code, stdout: a.stdout ?? "", stderr: a.stderr ?? "", ...(a.timedOut ? { timedOut: true } : {}) };
		};
		return { run, calls };
	};

	it("probe: writes through `security -i` on standard input, never a password on a command line, then finds and deletes the item", async () => {
		const { run, calls } = recording(() => ({ code: 0 }));
		const result = await createMacCredentialStore({ run, locate }).probe();
		assert.deepEqual(result, { ok: true });
		assert.ok(calls.every((c) => !c.args.includes("-w")), "no -w on any command line");
		assert.deepEqual(calls.map((c) => c.args[0]?.replace(/-generic-password$/, "")), ["-i", "find", "delete"]);
		assert.match(calls[0]?.stdin ?? "", /^add-generic-\w+ -U -s straw-boss-desk-probe-[0-9a-f]+ -a straw-boss-desk-probe -w probe\n$/);
	});

	it("probe: an unanswered keychain (a locked one waiting for a password) is ok: false, and the throwaway is still removed", async () => {
		const { run, calls } = recording((args) => (args[0] === "-i" ? { code: null, timedOut: true } : { code: 0 }));
		const result = await createMacCredentialStore({ run, locate }).probe();
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.reason, /did not answer within 10 s/);
		assert.ok(calls.some((c) => c.args[0]?.startsWith("delete-")), "a cleanup delete ran");
	});

	it("probe: an item the keychain did not keep (find exits 44) is ok: false", async () => {
		const { run } = recording((args) => (args[0] === "find-generic-password" ? { code: 44, stderr: "The specified item could not be found in the keychain." } : { code: 0 }));
		const result = await createMacCredentialStore({ run, locate }).probe();
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.reason, /did not keep the throwaway item/);
	});

	it("list: a timeout and a failing dump are errors, not an empty list", async () => {
		const timed = recording(() => ({ code: null, timedOut: true }));
		await assert.rejects(createMacCredentialStore({ run: timed.run, locate }).list(["gh:github.com"]), (e: unknown) => e instanceof CredentialStoreError && /within 10 s/.test(e.message));
		const failed = recording(() => ({ code: 1, stderr: "security: SecKeychainCopyDomainDefault: no default keychain" }));
		await assert.rejects(createMacCredentialStore({ run: failed.run, locate }).list(["gh:github.com"]), (e: unknown) => e instanceof CredentialStoreError && /exited 1/.test(e.message));
	});

	it("list: makes no call for no names, and the call is `dump-keychain` without -d", async () => {
		const { run, calls } = recording(() => ({ code: 0, stdout: "" }));
		const store = createMacCredentialStore({ run, locate });
		assert.deepEqual(await store.list([]), []);
		assert.equal(calls.length, 0);
		await store.list(["gh:github.com"]);
		assert.deepEqual(calls.map((c) => c.args), [["dump-keychain"]]);
	});

	it("delete: a failure throws with the service named", async () => {
		const { run } = recording(() => ({ code: 44, stderr: "could not be found" }));
		await assert.rejects(createMacCredentialStore({ run, locate }).delete({ name: "gh:github.com", account: "" }), (e: unknown) => e instanceof CredentialStoreError && /gh:github\.com/.test(e.message));
	});
});
