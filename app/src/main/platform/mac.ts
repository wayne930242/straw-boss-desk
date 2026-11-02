import { randomBytes } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { posix } from "node:path";
import { execRunner } from "./exec.ts";
import { CredentialStoreError, type CommandRunner, type CredentialStore, type Locate, type Platform, type ProbeResult, type ProcessInfo, type Processes, type StoreEntry, type SystemTool, type UserPath } from "./types.ts";

const SYSTEM_TOOLS: Partial<Record<SystemTool, string>> = {
	tar: "/usr/bin/tar",
	security: "/usr/bin/security",
	ps: "/bin/ps",
	lsof: "/usr/sbin/lsof",
	sh: "/bin/sh",
};

/** Each call into `security`, `ps`, and `lsof` has this long; a locked keychain's unlock dialog on a PM's Mac ends in a timeout (spec: store probe). */
const LIMIT_MS = 10_000;
/** `lsof -d txt` walks every process on the machine, which takes longer on a loaded Mac. */
const LISTING_LIMIT_MS = 30_000;

const firstLine = (text: string): string => text.trim().split("\n")[0]?.slice(0, 200) ?? "";

// ---- Locate ----------------------------------------------------------------------------------------------------------

const isExecutableFile = (path: string): boolean => {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
};

export function createMacLocate(isExecutable: (path: string) => boolean = isExecutableFile): Locate {
	return {
		system(tool) {
			const path = SYSTEM_TOOLS[tool];
			if (path === undefined) throw new Error(`${tool} is not a macOS system tool`);
			return path;
		},
		onPath(name, pathValue) {
			for (const dir of pathValue.split(":")) {
				if (dir === "") continue;
				const candidate = posix.join(dir, name);
				if (isExecutable(candidate)) return candidate;
			}
			return null;
		},
	};
}

// ---- Processes -------------------------------------------------------------------------------------------------------

/** `ps -o pid=,lstart=` lines: the pid, then the start time as ps prints it (spaces collapsed, since the day is padded). */
export function parsePsStart(text: string): Map<number, string> {
	const out = new Map<number, string>();
	for (const line of text.split("\n")) {
		const m = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(line);
		if (m?.[1] !== undefined && m[2] !== undefined) out.set(Number(m[1]), m[2].replace(/\s+/g, " "));
	}
	return out;
}

/** `lsof -Fpn` output: a `p<pid>` line, then the `n<path>` lines of that process. The first path is the program itself (its `txt` entry); the rest are mapped libraries. */
export function parseLsofExecutables(text: string): Map<number, string> {
	const out = new Map<number, string>();
	let pid: number | null = null;
	for (const line of text.split("\n")) {
		if (line.startsWith("p")) {
			pid = Number(line.slice(1));
			continue;
		}
		if (line.startsWith("n") && pid !== null && !out.has(pid)) {
			const path = line.slice(1);
			if (path.startsWith("/")) out.set(pid, path);
		}
	}
	return out;
}

export const isUnderDir = (dir: string, file: string): boolean => {
	const rel = posix.relative(dir, file);
	return rel !== "" && rel !== ".." && !rel.startsWith("../") && !posix.isAbsolute(rel);
};

/** lsof escapes the bytes of a non-ASCII path (`\xNN`) unless the locale is UTF-8, as in a Finder-launched app with no `LANG`; a root with such characters would never be listed (R7 recheck). */
const LSOF_ENV = { LC_ALL: "en_US.UTF-8" } as const;

export function createMacProcesses(run: CommandRunner, locate: Locate): Processes {
	const ps = locate.system("ps");
	const lsof = locate.system("lsof");

	async function startTimes(pids: readonly number[]): Promise<Map<number, string>> {
		if (pids.length === 0) return new Map();
		// LC_ALL=C keeps the date format the same whatever the PM's language, and TZ=UTC0 keeps `lstart` the same whatever the system time zone: it prints local time, so a PM
		// who travels, or whose zone changes with daylight saving, would otherwise see every recorded start time differ from the process's own (T8A-F010).
		const r = await run(ps, ["-o", "pid=,lstart=", "-p", pids.join(",")], { timeoutMs: LIMIT_MS, env: { LC_ALL: "C", TZ: "UTC0" } });
		return parsePsStart(r.stdout);
	}

	return {
		async inspect(pids) {
			if (pids.length === 0) return [];
			const [starts, exes] = await Promise.all([
				startTimes(pids),
				run(lsof, ["-a", "-p", pids.join(","), "-d", "txt", "-Fpn"], { timeoutMs: LIMIT_MS, env: LSOF_ENV }).then((r) => parseLsofExecutables(r.stdout)),
			]);
			return pids.map((pid): ProcessInfo => ({ pid, startTime: starts.get(pid) ?? null, executable: exes.get(pid) ?? null }));
		},
		async listUnder(dir) {
			const r = await run(lsof, ["-d", "txt", "-Fpn"], { timeoutMs: LISTING_LIMIT_MS, env: LSOF_ENV });
			// lsof exits 1 when it could not read some process (another user's, a protected one); what it did read is still listed.
			if (r.code === null) throw new Error(`lsof did not finish${r.timedOut ? " within 30 s" : ""}: ${r.stderr.trim().slice(0, 200)}`);
			const hits = [...parseLsofExecutables(r.stdout)].filter(([, exe]) => isUnderDir(dir, exe));
			const starts = await startTimes(hits.map(([pid]) => pid));
			return hits.map(([pid, executable]): ProcessInfo => ({ pid, startTime: starts.get(pid) ?? null, executable }));
		},
		kill(pid) {
			try {
				process.kill(pid, "SIGKILL");
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
				throw error;
			}
		},
	};
}

// ---- UserPath --------------------------------------------------------------------------------------------------------

/** macOS has no user PATH entry to write: panes get their PATH from the ZDOTDIR files. */
export function createMacUserPath(): UserPath {
	return {
		supported: false,
		read: async () => null,
		ensureFirst: async () => ({ changed: false }),
		remove: async () => ({ changed: false }),
	};
}

// ---- CredentialStore -------------------------------------------------------------------------------------------------

/** The text of an attribute `security` prints: `"abc"`, `<NULL>`, or `0x<hex>  "abc"` (the hex carries the exact UTF-8 when the value has other characters). */
function attributeText(raw: string): string {
	const text = raw.trim();
	if (text.startsWith("<NULL>")) return "";
	const hex = /^0x([0-9A-Fa-f]*)(?:\s|$)/.exec(text);
	if (hex?.[1] !== undefined) return Buffer.from(hex[1], "hex").toString("utf8");
	const quoted = /^"(.*)"$/.exec(text);
	return quoted?.[1] ?? "";
}

/** `"20261101120000Z\000"` (generalized time, UTC) to ISO 8601; empty when the item has no time. */
function modificationTime(raw: string): string {
	const m = /"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z/.exec(raw);
	return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : "";
}

/**
 * Generic-password items of `security dump-keychain` (without `-d`, so attributes only: the secret is never printed) as service, account, and `mdat`.
 * The dump walks every keychain in the search list, each item opening with a `class:` line.
 */
export function parseDumpKeychain(text: string): StoreEntry[] {
	const out: StoreEntry[] = [];
	let item: { generic: boolean; svce: string | null; acct: string; mdat: string } | null = null;
	const flush = () => {
		if (item?.generic && item.svce !== null) out.push({ name: item.svce, account: item.acct, modified: item.mdat });
	};
	for (const line of text.split("\n")) {
		if (line.startsWith("class:")) {
			flush();
			item = { generic: /^class:\s*"genp"/.test(line), svce: null, acct: "", mdat: "" };
			continue;
		}
		if (line.startsWith("keychain:")) {
			flush();
			item = null;
			continue;
		}
		if (item === null) continue;
		const attribute = /^\s+"(svce|acct|mdat)"<(?:blob|timedate)>=(.*)$/.exec(line);
		const [, key, value] = attribute ?? [];
		if (value === undefined) continue;
		if (key === "svce") item.svce = attributeText(value);
		else if (key === "acct") item.acct = attributeText(value);
		else item.mdat = modificationTime(value);
	}
	flush();
	return out;
}

export interface CredentialStoreDeps {
	run: CommandRunner;
	locate: Locate;
	/** Receives one line per call: the command and its outcome. Never an argument that carries a secret, and never output. */
	log?: (line: string) => void;
}

export function createMacCredentialStore({ run, locate, log = () => {} }: CredentialStoreDeps): CredentialStore {
	const security = locate.system("security");
	const outcome = (r: { code: number | null; timedOut?: boolean }): string => `exit ${r.code}${r.timedOut ? ", timed out" : ""}`;

	return {
		async probe(): Promise<ProbeResult> {
			const service = `straw-boss-desk-probe-${randomBytes(6).toString("hex")}`;
			const account = "straw-boss-desk-probe";
			const remove = ["delete-generic-password", "-s", service, "-a", account];
			let cleaned = false;
			try {
				// As go-keyring writes: `security -i` with the command on standard input and no keychain argument, so the item goes to the default keychain.
				const added = await run(security, ["-i"], { stdin: `add-generic-password -U -s ${service} -a ${account} -w probe\n`, timeoutMs: LIMIT_MS });
				log(`security -i add-generic-password (probe): ${outcome(added)}`);
				if (added.timedOut) return { ok: false, reason: "the keychain did not answer within 10 s (it may be locked and waiting for a password)" };
				// `security -i` can exit 0 after a failed command, so the read-back decides.
				const found = await run(security, ["find-generic-password", "-s", service, "-a", account], { timeoutMs: LIMIT_MS });
				log(`security find-generic-password (probe): ${outcome(found)}`);
				if (found.timedOut) return { ok: false, reason: "the keychain did not answer within 10 s" };
				if (found.code !== 0) return { ok: false, reason: `the keychain did not keep the throwaway item: ${firstLine(added.stderr || found.stderr)}` };
				const removed = await run(security, remove, { timeoutMs: LIMIT_MS });
				log(`security delete-generic-password (probe): ${outcome(removed)}`);
				if (removed.code !== 0) return { ok: false, reason: `the throwaway item could not be deleted: ${firstLine(removed.stderr)}` };
				cleaned = true;
				return { ok: true };
			} finally {
				if (!cleaned) await run(security, remove, { timeoutMs: LIMIT_MS }).catch(() => undefined);
			}
		},

		async list(names) {
			if (names.length === 0) return [];
			const r = await run(security, ["dump-keychain"], { timeoutMs: LIMIT_MS });
			log(`security dump-keychain: ${outcome(r)}, ${r.stdout.length} bytes`);
			if (r.timedOut) throw new CredentialStoreError("the keychain listing did not finish within 10 s");
			if (r.code !== 0) throw new CredentialStoreError(`security dump-keychain exited ${r.code}: ${firstLine(r.stderr)}`);
			const wanted = new Set(names);
			return parseDumpKeychain(r.stdout).filter((entry) => wanted.has(entry.name));
		},

		async delete({ name, account }) {
			const r = await run(security, ["delete-generic-password", "-s", name, "-a", account], { timeoutMs: LIMIT_MS });
			log(`security delete-generic-password ${name}: ${outcome(r)}`);
			if (r.timedOut) throw new CredentialStoreError(`deleting ${name} did not finish within 10 s`);
			if (r.code !== 0) throw new CredentialStoreError(`security delete-generic-password ${name} exited ${r.code}: ${firstLine(r.stderr)}`);
		},
	};
}

export function createMac(options: { run?: CommandRunner; log?: (line: string) => void } = {}): Platform {
	const run = options.run ?? execRunner();
	const locate = createMacLocate();
	return {
		locate,
		processes: createMacProcesses(run, locate),
		userPath: createMacUserPath(),
		credentials: createMacCredentialStore({ run, locate, ...(options.log ? { log: options.log } : {}) }),
	};
}
