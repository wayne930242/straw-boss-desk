import { lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, basename, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import type { CommandRunner, Locate } from "../platform/index.ts";
import { StageError } from "./errors.ts";
import { removeTree } from "./fsutil.ts";
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
	/** Leading path components dropped from every entry (the `node-v24.22.1-win-x64/` folder of the Node zip). */
	stripComponents?: number;
}

export interface Extracted {
	entries: number;
	/** The program that ran, for the log. */
	tar: string;
}

async function tar(request: ExtractRequest, tarPath: string, args: string[], cwd: string): Promise<string> {
	const result = await request.run(tarPath, args, { timeoutMs: TAR_LIMIT_MS, cwd });
	if (result.code !== 0) {
		const why = result.timedOut ? "timed out" : `exit ${result.code}`;
		throw new StageError("other", { stage: "extract" }, `tar ${args[0]} ${request.archive} failed (${why}): ${result.stderr.trim().split(/\r?\n/)[0] ?? ""}`);
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
	const names = (await tar(request, tarPath, ["-tf", basename(archive)], dirname(archive))).split(/\r?\n/).filter((n) => n !== "");
	for (const name of names) {
		const problem = unsafeEntryName(name);
		if (problem !== null) throw new ExtractRefused(archive, `the entry ${JSON.stringify(name)} ${problem}`);
	}

	const strip = request.stripComponents ? ["--strip-components", String(request.stripComponents)] : [];
	try {
		await tar(request, tarPath, ["-xf", relative(dest, archive), ...strip], dest);
		checkLinks(archive, dest);
	} catch (error) {
		removeTree(dest);
		mkdirSync(dest, { recursive: true });
		throw error;
	}
	return { entries: names.length, tar: tarPath };
}

/** Every link of the extracted tree must stay inside it, lexically and after resolving the links already there. */
function checkLinks(archive: string, dest: string): void {
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
			}
		}
	};
	walk(dest);
}
