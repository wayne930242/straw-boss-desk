// A scratch HOME with its own login keychain (macOS design 1b, ~/.local/share/sbd-review/mac-account/design.md §2 and §5): `security` takes the user's
// keychain domain from $HOME, so a child run with HOME=<scratch> has a separate default keychain and search list, and the real ones are never opened.
// Test code only. Nothing is written until the guard has shown that the default keychain and the search list hold nothing from outside the scratch HOME.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FixtureIO } from "./hosted.ts";
import { processIO } from "./process-io.ts";

export const SECURITY = "/usr/bin/security";
const LIMIT = { timeoutMs: 10_000 };

/** The quoted paths in `security default-keychain` / `list-keychains` output (`    "/Users/x/Library/Keychains/login.keychain-db"`). */
export function keychainPaths(output: string): string[] {
	return [...output.matchAll(/"([^"\n]+)"/g)].map((m) => m[1]).filter((p): p is string => p !== undefined);
}

/** `/private/var/...` and `/var/...` name one folder on macOS; compare them as one. */
const canonical = (p: string): string => p.replace(/^\/private(?=\/)/, "");
export const underHome = (home: string, p: string): boolean => canonical(p) === canonical(home) || canonical(p).startsWith(`${canonical(home)}/`);

export interface ScratchKeychain {
	/** Runs commands with HOME set to the scratch folder; nothing else of the caller's environment reaches them. */
	io: FixtureIO;
	home: string;
	keychain: string;
	dispose(): Promise<void>;
}

export interface ScratchOptions {
	parent?: string;
	makeIO?: (env: Record<string, string>) => FixtureIO;
	/**
	 * An existing folder to use as the scratch HOME instead of a new one (the e2e world's own home, which the app is launched with). The folder is the caller's: `dispose` deletes the
	 * keychain and leaves the folder.
	 */
	home?: string;
}

export async function createScratchKeychain({ parent = tmpdir(), makeIO = processIO, home: given }: ScratchOptions = {}): Promise<ScratchKeychain> {
	const home = given !== undefined ? realpathSync(given) : realpathSync(mkdtempSync(join(parent, "sbd-kc-")));
	const owned = given === undefined;
	mkdirSync(join(home, "Library", "Keychains"), { recursive: true, mode: 0o700 });
	mkdirSync(join(home, "tmp"), { recursive: true, mode: 0o700 });
	const keychain = join(home, "Library", "Keychains", "login.keychain-db");
	const io = makeIO({ HOME: home, TMPDIR: join(home, "tmp"), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" });
	const secrets: string[] = [];

	/** The default keychain and the user search list: nothing outside the scratch HOME, and with `expectOnly`, exactly the scratch keychain. */
	async function guard(expectOnly: boolean): Promise<void> {
		const seen: Record<string, string[]> = {};
		for (const args of [["default-keychain", "-d", "user"], ["list-keychains", "-d", "user"]]) {
			const r = await io.run(SECURITY, args, LIMIT);
			// An empty answer proves nothing unless the query really ran: a timeout or any other failure stops before a write. The one failure that is an answer is a
			// fresh HOME's "A default keychain could not be found" (exit 1), measured 2026-11-01.
			const noDefault = args[0] === "default-keychain" && r.code === 1 && /default keychain could not be found/i.test(r.stderr);
			if (r.timedOut || (r.code !== 0 && !noDefault)) {
				throw new Error(`scratch keychain guard: \`security ${args[0]}\` did not answer (exit ${r.code}${r.timedOut ? ", timed out" : ""}); nothing was written`);
			}
			const paths = keychainPaths(`${r.stdout}\n${r.stderr}`);
			const outside = paths.filter((p) => !underHome(home, p));
			if (outside.length > 0) throw new Error(`scratch keychain guard: \`security ${args[0]}\` names ${outside.join(", ")}, outside ${home}; HOME is not honored, nothing was written`);
			seen[args[0] ?? ""] = paths;
		}
		if (expectOnly) {
			for (const [command, paths] of Object.entries(seen)) {
				if (paths.length !== 1 || !paths.every((p) => canonical(p) === canonical(keychain))) {
					throw new Error(`scratch keychain guard: \`security ${command}\` is ${JSON.stringify(paths)}, not only ${keychain}`);
				}
			}
		}
	}

	try {
		await guard(false);
		const password = randomBytes(18).toString("hex");
		secrets.push(password);
		// The password goes to `security -i` on standard input, never onto a command line.
		const script = [
			`create-keychain -p ${password} "${keychain}"`,
			`default-keychain -d user -s "${keychain}"`,
			`list-keychains -d user -s "${keychain}"`,
			// No -l, -u, or -t: the keychain neither locks on sleep nor times out, so no unlock dialog opens on a developer's screen.
			`set-keychain-settings "${keychain}"`,
		].join("\n");
		const made = await io.run(SECURITY, ["-i"], { ...LIMIT, stdin: `${script}\n` });
		if (made.code !== 0) throw new Error(`scratch keychain: security -i exited ${made.code}: ${made.stderr.trim().slice(0, 200)}`);
		await guard(true);
	} catch (error) {
		if (owned) rmSync(home, { recursive: true, force: true });
		throw error;
	}

	return {
		io,
		home,
		keychain,
		async dispose() {
			try {
				// The same guard first: delete-keychain runs only against the scratch keychain.
				await guard(true);
				const gone = await io.run(SECURITY, ["delete-keychain", keychain], LIMIT);
				if (gone.code !== 0) throw new Error(`scratch keychain: delete-keychain exited ${gone.code}: ${gone.stderr.trim().slice(0, 200)}`);
			} finally {
				if (owned) rmSync(home, { recursive: true, force: true });
			}
		},
	};
}
