import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { execRunner } from "./exec.ts";
import { CREDENTIAL_LIST_SCRIPT, CREDENTIAL_PROBE_SCRIPT, PROCESS_SCRIPT, USER_PATH_SCRIPT } from "./win-scripts.ts";
import { CredentialStoreError, type CommandRunner, type CredentialStore, type Locate, type Platform, type ProbeResult, type ProcessInfo, type Processes, type StoreEntry, type SystemTool, type UserPath, type UserPathValue } from "./types.ts";

/** One PowerShell start costs 2 to 5 s (spec: Start times); a slow machine under antivirus may take much longer. */
const POWERSHELL_LIMIT_MS = 60_000;

const firstLine = (text: string): string => text.trim().split("\n")[0]?.slice(0, 200) ?? "";

// ---- Locate ----------------------------------------------------------------------------------------------------------

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

export interface WinLocateOptions {
	/** `%SystemRoot%`; defaults to the app's own. */
	systemRoot?: string;
	pathExt?: string;
	exists?: (path: string) => boolean;
}

export function createWinLocate(options: WinLocateOptions = {}): Locate {
	const systemRoot = options.systemRoot ?? process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
	const exts = (options.pathExt ?? process.env.PATHEXT ?? DEFAULT_PATHEXT).split(";").filter((e) => e !== "").map((e) => e.toLowerCase());
	const exists = options.exists ?? existsSync;
	const system32 = (...parts: string[]) => win32.join(systemRoot, "System32", ...parts);
	const tools: Partial<Record<SystemTool, string>> = {
		tar: system32("tar.exe"),
		powershell: system32("WindowsPowerShell", "v1.0", "powershell.exe"),
		reg: system32("reg.exe"),
		cmd: system32("cmd.exe"),
	};
	return {
		system(tool) {
			const path = tools[tool];
			if (path === undefined) throw new Error(`${tool} is not a Windows system tool`);
			return path;
		},
		onPath(name, pathValue) {
			const hasExt = exts.includes(win32.extname(name).toLowerCase());
			const names = hasExt ? [name] : exts.map((e) => name + e);
			for (const raw of pathValue.split(";")) {
				const dir = raw.trim().replace(/^"(.*)"$/, "$1");
				if (dir === "") continue;
				for (const candidate of names) {
					const full = win32.join(dir, candidate);
					if (exists(full)) return full;
				}
			}
			return null;
		},
	};
}

// ---- PowerShell ------------------------------------------------------------------------------------------------------

/** Runs a script by `-EncodedCommand`, so no argument needs quoting; input goes in `env`. Returns its standard output; throws with the first line of its error. */
async function powershell(run: CommandRunner, locate: Locate, script: string, env: Record<string, string>, timeoutMs = POWERSHELL_LIMIT_MS): Promise<string> {
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	const r = await run(locate.system("powershell"), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { env, timeoutMs });
	if (r.timedOut) throw new Error(`PowerShell did not finish within ${timeoutMs / 1000} s`);
	if (r.code !== 0) throw new Error(`PowerShell exited ${r.code}: ${firstLine(r.stderr || r.stdout)}`);
	return r.stdout.trim();
}

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const unb64 = (text: string): string => Buffer.from(text, "base64").toString("utf8");

// ---- Processes -------------------------------------------------------------------------------------------------------

/** Lines of `pid base64(executable) started`; the executable and the time are empty when Windows would not say. */
export function parseProcessLines(text: string): ProcessInfo[] {
	const out: ProcessInfo[] = [];
	for (const line of text.split("\n")) {
		const [pid, exe = "", started = ""] = line.replace(/\r$/, "").split(" ");
		if (pid === undefined || !/^\d+$/.test(pid)) continue;
		out.push({ pid: Number(pid), startTime: started === "" ? null : started, executable: exe === "" ? null : unb64(exe) });
	}
	return out;
}

export const isUnderWinDir = (dir: string, file: string): boolean => {
	// win32.relative compares without regard to case, as NTFS does.
	const rel = win32.relative(dir, file);
	return rel !== "" && rel !== ".." && !rel.startsWith("..\\") && !win32.isAbsolute(rel);
};

export function createWinProcesses(run: CommandRunner, locate: Locate): Processes {
	return {
		async inspect(pids) {
			if (pids.length === 0) return [];
			const found = parseProcessLines(await powershell(run, locate, PROCESS_SCRIPT, { SBD_PIDS: pids.join(",") }));
			return pids.map((pid) => found.find((p) => p.pid === pid) ?? { pid, startTime: null, executable: null });
		},
		async listUnder(dir) {
			const all = parseProcessLines(await powershell(run, locate, PROCESS_SCRIPT, { SBD_PIDS: "" }));
			return all.filter((p) => p.executable !== null && isUnderWinDir(dir, p.executable));
		},
		kill(pid) {
			try {
				process.kill(pid);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
				throw error;
			}
		},
	};
}

// ---- UserPath --------------------------------------------------------------------------------------------------------

/** Entries compare case-insensitively with a trailing backslash ignored; nothing is expanded, so `%USERPROFILE%\bin` is its own text. */
const sameEntry = (a: string, b: string): boolean => a.replace(/\\+$/, "").toLowerCase() === b.replace(/\\+$/, "").toLowerCase();

function checkEntry(entry: string): void {
	if (entry === "" || entry.includes(";") || /[\u0000-\u001f]/.test(entry)) throw new Error(`not a PATH entry: ${JSON.stringify(entry)}`);
}

const partsOf = (current: UserPathValue | null): string[] => (current === null || current.value === "" ? [] : current.value.split(";"));

/** The value after putting `entry` first, with the type and every other entry as they were. */
export function planEnsureFirst(current: UserPathValue | null, entry: string): { next: UserPathValue; changed: boolean } {
	checkEntry(entry);
	const parts = partsOf(current);
	const others = parts.filter((p) => !sameEntry(p, entry));
	const first = parts[0];
	if (current !== null && first !== undefined && sameEntry(first, entry) && others.length === parts.length - 1) return { next: current, changed: false };
	return { next: { kind: current?.kind ?? "ExpandString", value: [entry, ...others].join(";") }, changed: true };
}

/** The value after removing only `entry`; null means delete the value (nothing else was in it). */
export function planRemove(current: UserPathValue | null, entry: string): { next: UserPathValue | null; changed: boolean } {
	checkEntry(entry);
	const parts = partsOf(current);
	const rest = parts.filter((p) => !sameEntry(p, entry));
	if (current === null || rest.length === parts.length) return { next: current, changed: false };
	if (rest.every((p) => p === "")) return { next: null, changed: true };
	return { next: { kind: current.kind, value: rest.join(";") }, changed: true };
}

export interface WinUserPathOptions {
	run: CommandRunner;
	locate: Locate;
	/** The HKCU subkey that holds `Path`. Default `Environment`; a test points it at a scratch key. */
	key?: string;
	/** Broadcast `WM_SETTINGCHANGE` after a write, so new terminals and Herdr panes see it. Default true. */
	broadcast?: boolean;
}

export function createWinUserPath({ run, locate, key = "Environment", broadcast = true }: WinUserPathOptions): UserPath {
	const call = (env: Record<string, string>) => powershell(run, locate, USER_PATH_SCRIPT, { SBD_KEY: key, ...env });

	async function read(): Promise<UserPathValue | null> {
		const answer = await call({ SBD_OP: "read" });
		if (answer === "none") return null;
		const [kind, encoded = ""] = answer.split(" ");
		if (kind !== "ExpandString" && kind !== "String") throw new Error(`the user Path has an unsupported registry type: ${kind}`);
		return { kind, value: unb64(encoded) };
	}

	async function write(next: UserPathValue | null): Promise<void> {
		const flag = broadcast ? "1" : "0";
		if (next === null) await call({ SBD_OP: "delete", SBD_BROADCAST: flag });
		else await call({ SBD_OP: "write", SBD_VALUE: b64(next.value), SBD_KIND: next.kind, SBD_BROADCAST: flag });
	}

	return {
		supported: true,
		read,
		async ensureFirst(entry) {
			const plan = planEnsureFirst(await read(), entry);
			if (plan.changed) await write(plan.next);
			return { changed: plan.changed };
		},
		async remove(entry) {
			const plan = planRemove(await read(), entry);
			if (plan.changed) await write(plan.next);
			return { changed: plan.changed };
		},
	};
}

// ---- CredentialStore -------------------------------------------------------------------------------------------------

const FILETIME_EPOCH_MS = 11_644_473_600_000n;

/** A FILETIME (100 ns since 1601) as ISO 8601 UTC with seven fraction digits. */
export function filetimeToIso(ticks: bigint): string {
	const ms = ticks / 10_000n - FILETIME_EPOCH_MS;
	const sub = (ticks % 10_000n).toString().padStart(4, "0");
	return new Date(Number(ms)).toISOString().replace("Z", `${sub}Z`);
}

export interface RawCredential {
	target: string;
	user: string;
	modified: string;
}

/**
 * The helper's output: one line per credential, `base64(target) base64(user) filetime`. Names travel as base64 of UTF-8, so a localized or CJK name
 * survives any console code page, and nothing here reads translated text.
 */
export function parseCredentialList(text: string): RawCredential[] {
	const out: RawCredential[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.replace(/\r$/, "");
		if (trimmed === "") continue;
		const [target, user, ticks] = trimmed.split(" ");
		if (target === undefined || user === undefined || ticks === undefined || !/^\d+$/.test(ticks)) throw new CredentialStoreError("the credential listing has a line this app cannot read");
		out.push({ target: unb64(target), user: unb64(user), modified: filetimeToIso(BigInt(ticks)) });
	}
	return out;
}

/** go-keyring names a Credential Manager target `<service>:<account>`, with the account also in the user name. */
export function splitTarget(target: string, user: string): { name: string; account: string } {
	const suffix = `:${user}`;
	return target.endsWith(suffix) ? { name: target.slice(0, target.length - suffix.length), account: user } : { name: target, account: user };
}

export function createWinCredentialStore({ run, locate, log = () => {} }: { run: CommandRunner; locate: Locate; log?: (line: string) => void }): CredentialStore {
	return {
		async probe(): Promise<ProbeResult> {
			const target = `straw-boss-desk-probe-${randomBytes(6).toString("hex")}`;
			try {
				const answer = await powershell(run, locate, CREDENTIAL_PROBE_SCRIPT, { SBD_TARGET: target });
				log(`credential probe: ${answer}`);
				return answer === "ok" ? { ok: true } : { ok: false, reason: `Credential Manager refused a step (${answer})` };
			} catch (error) {
				log(`credential probe: ${(error as Error).message}`);
				return { ok: false, reason: (error as Error).message };
			}
		},

		async list(names) {
			if (names.length === 0) return [];
			for (const name of names) if (name === "" || /[|*?]/.test(name)) throw new CredentialStoreError(`not a credential service name: ${JSON.stringify(name)}`);
			let stdout: string;
			try {
				stdout = await powershell(run, locate, CREDENTIAL_LIST_SCRIPT, { SBD_OP: "list", SBD_FILTERS: names.map((n) => `${n}*`).join("|") });
			} catch (error) {
				throw new CredentialStoreError(`the credential listing failed: ${(error as Error).message}`);
			}
			const wanted = new Set(names);
			const entries = parseCredentialList(stdout).map((c): StoreEntry => ({ ...splitTarget(c.target, c.user), modified: c.modified }));
			log(`credential listing: ${entries.length} matching of the filter`);
			return entries.filter((e) => wanted.has(e.name));
		},

		async delete({ name, account }) {
			let answer: string;
			try {
				answer = await powershell(run, locate, CREDENTIAL_LIST_SCRIPT, { SBD_OP: "delete", SBD_TARGET: b64(`${name}:${account}`) });
			} catch (error) {
				throw new CredentialStoreError(`deleting ${name} failed: ${(error as Error).message}`);
			}
			log(`credential delete ${name}: Win32 ${answer}`);
			if (answer !== "0") throw new CredentialStoreError(`deleting ${name} failed (Win32 error ${answer})`);
		},
	};
}

export function createWin(options: { run?: CommandRunner; log?: (line: string) => void } = {}): Platform {
	const run = options.run ?? execRunner();
	const locate = createWinLocate();
	return {
		locate,
		processes: createWinProcesses(run, locate),
		userPath: createWinUserPath({ run, locate }),
		credentials: createWinCredentialStore({ run, locate, ...(options.log ? { log: options.log } : {}) }),
	};
}
