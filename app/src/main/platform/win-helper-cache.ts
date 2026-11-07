import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { HELPER_LOAD_EXIT, NATIVE_PRELUDE_BUILD, NATIVE_PRELUDE_LOAD, NATIVE_PRELUDE_MEMORY, NATIVE_PRELUDE_NONE, NATIVE_SOURCE } from "./win-scripts.ts";

// The compiled native helper of the Windows implementations (spec: Windows native helper). `Add-Type -TypeDefinition` costs seconds on every call
// (52 s under x64 emulation on a hosted ARM runner), so the C# is compiled once into a DLL in the app's own data root and loaded from there afterwards.
// The file's name carries a hash of the C# it was built from, so a new app version never loads an old helper. The DLL lies under the data root, the
// same trust as the tools folder the app already runs programs from, and nothing is ever loaded from a path outside it.

/** `<root>/helpers`: the one folder the helper DLL lives in. Removed with the root by **Remove all data**. */
export const helpersDir = (root: string): string => join(root, "helpers");

const HELPER_FILE = /^sbd-native-[0-9a-f]{16}\.dll$/;

/** `sbd-native-<first 16 hex digits of the SHA-256 of the C# source>.dll`. */
export const helperFileName = (source: string = NATIVE_SOURCE): string => `sbd-native-${createHash("sha256").update(source, "utf8").digest("hex").slice(0, 16)}.dll`;

/** True when `file` is a path directly inside `<root>/helpers` with a name `helperFileName` could have made. */
export function isHelperFile(root: string, file: string): boolean {
	return HELPER_FILE.test(basename(file)) && dirname(file) === helpersDir(root);
}

/** The helper's path under `root`; throws for a root that is not absolute, so a relative path can never be resolved against the process's working directory. */
export function helperPath(root: string, source: string = NATIVE_SOURCE): string {
	if (!isAbsolute(root)) throw new Error(`the data root must be an absolute path: ${root}`);
	const file = join(helpersDir(root), helperFileName(source));
	if (!isHelperFile(root, file)) throw new Error(`not a helper file under ${root}: ${file}`);
	return file;
}

export interface HelperFs {
	exists(file: string): boolean;
	/** Deletes a file; false when it could not be deleted (locked, already gone). Never throws. */
	remove(file: string): boolean;
}

export const realHelperFs: HelperFs = {
	exists: (file) => existsSync(file),
	remove(file) {
		try {
			unlinkSync(file);
			return true;
		} catch {
			return false;
		}
	},
};

/** A PowerShell run that ended with a non-zero exit code. */
export class PowerShellExit extends Error {
	readonly code: number;
	constructor(code: number, detail: string) {
		super(`PowerShell exited ${code}: ${detail}`);
		this.name = "PowerShellExit";
		this.code = code;
	}
}

/** `none`: the script never touches the native helper (no prelude). `native`: it needs `[SbdNative]`. */
export type NativeUse = "none" | "native";

export type RunNative = (use: NativeUse, body: string, env: Record<string, string>) => Promise<string>;

export interface NativeHelperOptions {
	/** The data root; with none, the C# is compiled in memory on every call (what the app did before the cache: a unit test, or a tool that has no data root). */
	root?: string | undefined;
	/** Runs one script text with this environment and returns its standard output. */
	call: (script: string, env: Record<string, string>) => Promise<string>;
	fs?: HelperFs;
	log?: (line: string) => void;
}

/**
 * Runs a script body with the native helper in the session. With a root: a cached file is loaded; one that will not load (the load prelude exits `HELPER_LOAD_EXIT`)
 * is deleted (this file only, by its name and place) and the script is run again with the building prelude, which also writes the file for the next call; a missing
 * file goes straight to the building prelude. A body that fails for its own reasons is not retried.
 */
export function createNativeHelper({ root, call, fs = realHelperFs, log = () => {} }: NativeHelperOptions): RunNative {
	return async (use, body, env) => {
		if (use === "none") return call(NATIVE_PRELUDE_NONE + body, env);
		if (root === undefined) return call(NATIVE_PRELUDE_MEMORY + body, env);
		const dll = helperPath(root);
		const withDll = { ...env, SBD_HELPER_DLL: dll };
		if (fs.exists(dll)) {
			try {
				return await call(NATIVE_PRELUDE_LOAD + body, withDll);
			} catch (error) {
				if (!(error instanceof PowerShellExit) || error.code !== HELPER_LOAD_EXIT) throw error;
				const removed = isHelperFile(root, dll) && fs.remove(dll);
				log(`native helper ${basename(dll)} would not load; ${removed ? "deleted it" : "could not delete it"}, building again`);
			}
		} else {
			log(`native helper ${basename(dll)} is not built yet, building it`);
		}
		return call(NATIVE_PRELUDE_BUILD + body, withDll);
	};
}
