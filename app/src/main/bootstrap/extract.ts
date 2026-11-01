import { lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import path, { dirname, basename, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import type { CommandRunner, Locate, Processes } from "../platform/index.ts";
import { StageError } from "./errors.ts";
import { removeTree, sha256File } from "./fsutil.ts";
import { isInside } from "../paths.ts";

// Archive extraction (spec: Decisions, Archive extraction). The system `tar` (bsdtar, which reads tar, gzip, and zip) is called by absolute path:
// `%SystemRoot%\System32\tar.exe` on Windows, `/usr/bin/tar` on macOS. A Git-for-Windows GNU `tar` earlier on the PATH cannot read zip and takes
// `C:` for a remote host, so no name is ever looked up on the PATH. The archive is untrusted: the entry names are checked before anything is
// written, and the extracted tree is checked for links that leave it afterwards.

const TAR_LIMIT_MS = 10 * 60 * 1000;

/** Why an archive entry name may not be extracted, or null. Absolute names, drive letters, and any `..` segment are refused, with either slash. */
export function unsafeEntryName(name: string): string | null {
	if (name.includes("\0")) return "contains a NUL byte";
	if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name)) return "is an absolute path";
	if (name.split(/[\\/]/).includes("..")) return "has a `..` segment";
	return null;
}

/**
 * Two names in one archive that differ only in case (or in Unicode normalization) are one file on Windows and macOS, so which one wins depends on the
 * machine. Returns a description of the first such pair, or null. A name repeated exactly is not a collision, and every folder of a path counts.
 */
export function nameCollision(names: readonly string[]): string | null {
	const seen = new Map<string, string>();
	for (const name of names) {
		const parts = name.split(/[\\/]/).filter((part) => part !== "");
		for (let i = 1; i <= parts.length; i++) {
			const spelled = parts.slice(0, i).join("/");
			const folded = spelled.normalize("NFC").toLowerCase();
			const first = seen.get(folded);
			if (first === undefined) seen.set(folded, spelled);
			else if (first !== spelled) return `${JSON.stringify(first)} and ${JSON.stringify(spelled)} differ only in case`;
		}
	}
	return null;
}

/**
 * The archive's path as `tar` is given it: relative to `dest`, which is its working directory, so that the program (`tar.exe` reads its arguments in the
 * ANSI code page) only ever sees names the app chose. Throws `ExtractRefused` when there is no such path (another drive: `relative()` answers with an
 * absolute path), or, for Windows, when it would carry a character outside ASCII.
 */
export function archiveArgument(archive: string, dest: string, P: typeof posix = path): string {
	const rel = P.relative(dest, archive);
	if (P.isAbsolute(rel) || rel === "") throw new ExtractRefused(archive, `there is no relative path from ${dest} to the archive (another drive?)`);
	if (P === win32 && /[^\x20-\x7e]/.test(rel)) throw new ExtractRefused(archive, `the relative path ${JSON.stringify(rel)} has characters tar.exe cannot read in its arguments`);
	return rel;
}

export class ExtractRefused extends StageError {
	constructor(archive: string, reason: string) {
		super("other", { stage: "extract" }, `refused to extract ${archive}: ${reason}`);
		this.name = "ExtractRefused";
	}
}

export interface ExtractRequest {
	archive: string;
	/** A new or empty folder. Everything extracted lands under it. */
	dest: string;
	locate: Locate;
	run: CommandRunner;
	/** The whole environment `tar` gets (T5-F005): with it the program starts from nothing else, without it from the runner's base. */
	env?: Readonly<Record<string, string>>;
	/** Leading path components dropped from every entry (the `node-v24.22.1-win-x64/` folder of the Node zip). */
	stripComponents?: number;
}

export interface Extracted {
	entries: number;
	/** The program that ran, for the log. */
	tar: string;
}

/** What bsdtar says when the disk is full: libarchive's strerror on macOS ("No space left on device") and the Windows message on `tar.exe` (T4-F013). */
const DISK_FULL = /No space left on device|not enough space on the disk|There is not enough space|disk is full|ENOSPC/i;

async function tar(request: ExtractRequest, tarPath: string, args: string[], cwd: string): Promise<string> {
	const result = await request.run(tarPath, args, { timeoutMs: TAR_LIMIT_MS, cwd, ...(request.env ? { env: request.env, replaceEnv: true } : {}) });
	if (result.code !== 0) {
		const why = result.timedOut ? "timed out" : `exit ${result.code}`;
		const detail = `tar ${args[0]} ${request.archive} failed (${why}): ${result.stderr.trim().split(/\r?\n/)[0] ?? ""}`;
		// The category decides whether the engine tries again and what the PM reads: a full disk is not "tar failed".
		if (DISK_FULL.test(result.stderr)) throw new StageError("disk", {}, detail);
		throw new StageError("other", { stage: "extract" }, detail);
	}
	return result.stdout;
}

/** Extracts `archive` into `dest`, or throws and leaves `dest` empty of the archive's files. */
export async function extractArchive(request: ExtractRequest): Promise<Extracted> {
	const { archive, dest } = request;
	const tarPath = request.locate.system("tar");
	if (!isAbsolute(tarPath)) throw new Error(`the tar program must be an absolute path: ${tarPath}`);

	mkdirSync(dest, { recursive: true });
	if (readdirSync(dest).length > 0) throw new ExtractRefused(archive, `the destination ${dest} is not empty`);

	// `tar.exe` on Windows reads its arguments in the ANSI code page, so a user name outside it (CJK on a machine whose code page is not CJK, or a character
	// outside Big5 on zh-TW) turns into `?` and the archive "cannot be opened". The working directory is passed as UTF-16, so the program runs in the
	// folder it works on and gets only names the app chose: the archive's file name, and the relative path between two folders of the data root.
	// A file name `-` is stdin to tar, and one that starts with `-` reads as an option in some tars: the stack parser refuses both, and so does this.
	if (basename(archive).startsWith("-")) throw new ExtractRefused(archive, "the archive's file name starts with `-`");
	const names = (await tar(request, tarPath, ["-tf", basename(archive)], dirname(archive))).split(/\r?\n/).filter((n) => n !== "");
	for (const name of names) {
		const problem = unsafeEntryName(name);
		if (problem !== null) throw new ExtractRefused(archive, `the entry ${JSON.stringify(name)} ${problem}`);
	}
	const collision = nameCollision(names);
	if (collision !== null) throw new ExtractRefused(archive, `${collision}, which one file system keeps apart and another does not`);

	const strip = request.stripComponents ? ["--strip-components", String(request.stripComponents)] : [];
	try {
		await tar(request, tarPath, ["-xf", archiveArgument(archive, dest), ...strip], dest);
		checkExtractedTree(archive, dest);
	} catch (error) {
		removeTree(dest);
		mkdirSync(dest, { recursive: true });
		throw error;
	}
	return { entries: names.length, tar: tarPath };
}

// ---- self-extracting installers --------------------------------------------------------------------------------------

/** A self-extractor (PortableGit's `.7z.exe`) gets this long; it unpacks about 400 MB. */
const SFX_LIMIT_MS = 15 * 60 * 1000;

export interface SelfExtractRequest {
	/** The downloaded installer, `tools/downloads/<file>`. */
	installer: string;
	/** Its pinned SHA-256: the bytes are hashed again right before they run, so nothing but the verified download is ever executed. */
	sha256: string;
	/** A new or empty folder; the self-extractor's output lands under it. */
	dest: string;
	run: CommandRunner;
	/** The whole environment the installer gets (T5-F005): it runs code from the archive, so it must not inherit the app's own. */
	env?: Readonly<Record<string, string>>;
	/** Looked at after the installer exits: a program still running from `dest` fails the extraction, since the staging folder is about to be renamed. */
	processes?: Pick<Processes, "listUnder">;
}

/**
 * Runs a 7-Zip self-extracting executable (`<installer> -o<dest> -y`) and checks what it wrote. Three rules, each from the tar findings of task 4:
 * the program runs only on bytes whose SHA-256 equals the pin at this moment (it is code, not data); it gets only ASCII arguments, since a Windows
 * program may read its command line in the ANSI code page (`-o` names `dest` relative to the working directory, which Windows passes as UTF-16); and
 * what it extracted passes the same link and special-file walk as a tar extraction.
 */
export async function extractSelfExtractor(request: SelfExtractRequest): Promise<Extracted> {
	const { installer, sha256, dest } = request;
	mkdirSync(dest, { recursive: true });
	if (readdirSync(dest).length > 0) throw new ExtractRefused(installer, `the destination ${dest} is not empty`);
	const got = await sha256File(installer);
	if (got !== sha256) throw new StageError("integrity", { tool: basename(installer) }, `${installer} no longer matches its pin just before it runs: SHA256 is ${got}, the pin says ${sha256}`);
	const out = relative(dirname(dest), dest);
	if (!/^[\x21-\x7e]+$/.test(out) || out.startsWith("-")) throw new ExtractRefused(installer, `the destination name ${JSON.stringify(out)} has characters the extractor cannot read in its arguments`);
	try {
		const result = await request.run(installer, [`-o${out}`, "-y"], { timeoutMs: SFX_LIMIT_MS, cwd: dirname(dest), ...(request.env ? { env: request.env, replaceEnv: true } : {}) });
		if (result.code !== 0) {
			const why = result.timedOut ? "timed out" : `exit ${result.code}`;
			const detail = `${basename(installer)} failed (${why}): ${(result.stderr || result.stdout).trim().split(/\r?\n/)[0] ?? ""}`;
			if (DISK_FULL.test(`${result.stderr}${result.stdout}`)) throw new StageError("disk", {}, detail);
			throw new StageError("other", { stage: "extract" }, detail);
		}
		// PortableGit's self-extractor runs `RunProgram="git-bash.exe ... --command=post-install.bat"` from the extracted tree before it exits (T5-F005).
		// 7zSD waits for it; if it did not, a bash would still hold the staging folder when it is renamed, so look.
		const running = (await request.processes?.listUnder(dest)) ?? [];
		if (running.length > 0) {
			throw new StageError("locked", {}, `${basename(installer)} exited while ${running.map((p) => `${p.executable ?? "a process"} (pid ${p.pid})`).join(", ")} still runs from ${dest}`);
		}
		checkExtractedTree(installer, dest);
	} catch (error) {
		removeTree(dest);
		mkdirSync(dest, { recursive: true });
		throw error;
	}
	return { entries: countFiles(dest), tar: installer };
}

function countFiles(dir: string): number {
	let n = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) n += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
	return n;
}

/** Every link of the extracted tree must stay inside it, lexically and after resolving the links already there, and nothing but files, folders, and links may be in it. */
export function checkExtractedTree(archive: string, dest: string): void {
	const realDest = realpathSync.native(dest);
	const P = process.platform === "win32" ? win32 : posix;
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			const stat = lstatSync(full);
			if (stat.isSymbolicLink()) {
				const target = readlinkSync(full);
				if (isAbsolute(target) || posix.isAbsolute(target) || win32.isAbsolute(target)) {
					throw new ExtractRefused(archive, `the link ${full} points at the absolute path ${target}`);
				}
				if (!isInside(dest, resolve(dir, target), P) && !isInside(realDest, resolve(dir, target), P)) {
					throw new ExtractRefused(archive, `the link ${full} points outside the archive's folder (${target})`);
				}
				let real: string | null = null;
				try {
					real = realpathSync.native(full);
				} catch {
					// a link to something not extracted: a dangling link points nowhere outside
				}
				if (real !== null && !isInside(realDest, real, P)) throw new ExtractRefused(archive, `the link ${full} resolves outside the archive's folder (${real})`);
			} else if (stat.isDirectory()) {
				walk(full);
			} else if (!stat.isFile()) {
				// A FIFO would block the first program that opens it (`sha256File` in `detect`); a device node needs root, but is no more welcome.
				throw new ExtractRefused(archive, `${full} is a special file (a FIFO, socket, or device), not a file, folder, or link`);
			}
		}
	};
	walk(dest);
}
