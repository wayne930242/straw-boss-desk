import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppPlatform, Layout } from "../../paths.ts";
import { StageError } from "../errors.ts";
import { installGlobal, assertRegistryIntegrity, nodeBinaryPath, npmCliPath, packageDir, type NpmRun } from "../npm.ts";
import { StackError, type NpmPin, type Stack } from "../stack.ts";
import { detectFromRecord, fileKey, type Evidence, type Stage, type StageContext } from "../stage.ts";
import { expectVersion } from "./support.ts";

// The npm stages of the private prefix (spec: Stages `pi`, `ttt`). `pi` installs `@earendil-works/pi-coding-agent` at the pin of `stack.json`'s
// `npmGlobal` (the entry whose `bin` is `pi`), registry integrity first, then runs it. npm installs straight into the shared prefix (`tools/npm`, which
// `ttt` uses too), so there is no staging folder to rename: a failed install leaves what npm itself rolled back, and a stack rollback installs the
// previous pin again from the npm cache.

export interface NpmStageSpec {
	/** The stage's name, which is also the `bin` the pin names in `stack.json` (`pi`, `ttt`). */
	name: string;
	needs: readonly string[];
	/**
	 * Wait for the programs of the data root to end before the install (the stack is stopped for this stage). `ttt` is installed beside a stack that runs, so it does not wait; it still marks its
	 * prefix, so a cancel or a time limit leaves the record `running` and its own next run installs it again. The start gate does not read it (`isPackageStage` covers `pi`, the profile and the
	 * packages, not `ttt`): a start does not need `ttt`.
	 */
	waitForQuiet?: boolean;
	/** Extra environment for npm, for tests (a local registry). The product passes none. */
	npm?: NpmRun;
}

/** The pin of `stack.json`'s `npmGlobal` whose `bin` is `bin`. Throws `StackError` when there is none, so a stage never guesses. */
export function npmGlobalPin(stack: Stack, bin: string): NpmPin {
	const pin = stack.npmGlobal.find((p) => p.bin === bin);
	if (pin === undefined) throw new StackError(`the stack's npmGlobal has no package with the bin ${bin}`);
	return pin;
}

/** The two fields of an installed package's `package.json` this stage reads. */
export interface PackageManifest {
	version?: string;
	bin?: string | Record<string, string>;
}

/** The manifest at `file`, or null when it is missing or not an object. Only the fields of `PackageManifest` that have the right type are kept. */
export function readManifest(file: string): PackageManifest | null {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") return null;
	const manifest: PackageManifest = {};
	if (typeof parsed.version === "string") manifest.version = parsed.version;
	const { bin } = parsed;
	if (typeof bin === "string") manifest.bin = bin;
	else if (bin !== null && typeof bin === "object" && !Array.isArray(bin)) {
		manifest.bin = Object.fromEntries(Object.entries(bin).filter((e): e is [string, string] => typeof e[1] === "string"));
	}
	return manifest;
}

/** The bin entry of the installed package, from its own `package.json`: `{ "bin": { "pi": "dist/bundle/cli.js" } }` or the string form. */
export function binEntry(manifest: PackageManifest | null, bin: string, packageName: string): string | null {
	const field = manifest?.bin;
	if (field === undefined) return null;
	if (typeof field === "string") return packageName.split("/").pop() === bin ? field : null;
	return field[bin] ?? null;
}

/** The files `detect` hashes: the package's `package.json`, its bin script, and on Windows the `.cmd` wrapper npm wrote. Empty when the package is not installed. */
export function installedFiles(layout: Layout, pin: NpmPin, bin: string): string[] {
	const dir = packageDir(layout, pin.name);
	const manifest = join(dir, "package.json");
	if (!existsSync(manifest)) return [];
	const entry = binEntry(readManifest(manifest), bin, pin.name);
	const files = [manifest];
	if (entry !== null) files.push(join(dir, ...entry.split("/")));
	if (layout.platform === "win32") files.push(join(layout.tools.npm, `${bin}.cmd`));
	return files.filter((f) => existsSync(f));
}

/** `<prefix>/bin/<bin>` (a symlink to the script) on macOS, `<prefix>/<bin>.cmd` on Windows. */
export const binShim = (layout: Layout, bin: string): string => (layout.platform === "win32" ? join(layout.tools.npm, `${bin}.cmd`) : join(layout.tools.npm, "bin", bin));

/**
 * The bin script of the installed package: the absolute path, and its place under the root with backslashes (what the Windows `pi.cmd` shim writes
 * between quotes, T6-F001). Null when the package or its bin entry is missing or the entry climbs out of the package folder.
 */
export function binScript(layout: Layout, pin: NpmPin, bin: string): { absolute: string; relative: string } | null {
	const dir = packageDir(layout, pin.name);
	const entry = binEntry(readManifest(join(dir, "package.json")), bin, pin.name);
	if (entry === null) return null;
	const parts = entry.split("/").filter((part) => part !== "" && part !== ".");
	if (parts.length === 0 || parts.includes("..")) return null;
	const absolute = join(dir, ...parts);
	return { absolute, relative: ["tools", "npm", "node_modules", ...pin.name.split("/"), ...parts].join("\\") };
}

/**
 * A stage that installs one pinned npm package into the private prefix and runs its bin. `verify` runs the bin the way a shell would find it
 * (the private Node with the bin script on Windows, the prefix's `bin/pi` on macOS) and compares its `--version` with the pin.
 */
export function npmGlobalStage(spec: NpmStageSpec): Stage {
	const pinOf = (ctx: StageContext): NpmPin => npmGlobalPin(ctx.stack, spec.name);
	return {
		name: spec.name,
		needs: spec.needs,
		lane: "npm",
		plannedVersion: (ctx) => pinOf(ctx).version,
		async detect(ctx) {
			const pin = pinOf(ctx);
			const found = await detectFromRecord(ctx, { version: pin.version });
			if (found === null) return null;
			const installed = readManifest(join(packageDir(ctx.layout, pin.name), "package.json"))?.version;
			if (installed !== pin.version || !existsSync(binShim(ctx.layout, spec.name))) {
				ctx.log.event({ event: "detect-failed", reason: `${pin.name} on disk is ${installed ?? "unreadable"}, or its ${spec.name} wrapper is missing` });
				return null;
			}
			return found;
		},
		async install(ctx) {
			const pin = pinOf(ctx);
			await assertRegistryIntegrity(ctx, pin, spec.npm);
			// No npm of an earlier run may still be writing the prefix (R9-F001), and from here on the prefix changes in place: a failure cannot promise the old install is intact, and a
			// cancel or a time limit leaves the record `running`, which the start gate reads (R13-F009, R9B-F002).
			if (spec.waitForQuiet === true) await ctx.waitForQuietTools();
			ctx.markInPlace();
			await installGlobal(ctx, pin, spec.npm);
		},
		async verify(ctx) {
			const pin = pinOf(ctx);
			const files = installedFiles(ctx.layout, pin, spec.name);
			if (files.length < 2) throw new StageError("other", { stage: spec.name }, `${pin.name}@${pin.version} is not installed under ${ctx.layout.tools.npm} after npm install`);
			const installed = readManifest(join(packageDir(ctx.layout, pin.name), "package.json"))?.version;
			if (installed !== pin.version) throw new StageError("other", { stage: spec.name }, `${pin.name} on disk is ${installed ?? "unreadable"}, the pin is ${pin.version}`);
			const line = await versionThroughBin(ctx, pin, spec.name);
			expectVersion(ctx, spec.name, line, pin.version);
			return { text: `${pin.name}@${pin.version}; ${spec.name} --version -> ${line}`, version: pin.version, files: files.map((f) => fileKey(ctx.layout, f)) };
		},
		async activate() {
			// npm wrote into the prefix already; the engine records the hashes of `files` after this.
		},
	};
}

/**
 * `<bin> --version` the way the app runs it. macOS: `bin/<bin>` (a script with a `node` shebang, so `node` must be on the constructed `PATH`).
 * Windows: the private Node with the package's bin script, which is what the `pi.cmd` shim runs, never npm's `<bin>.cmd` wrapper (it breaks under a
 * root with `&` or `^`, T6-F001).
 */
export async function versionThroughBin(ctx: StageContext, pin: NpmPin, bin: string): Promise<string> {
	const env = ctx.childEnv();
	let result;
	if (ctx.layout.platform === "win32") {
		const script = binScript(ctx.layout, pin, bin);
		if (script === null) throw new StageError("other", { stage: ctx.stage }, `${pin.name} has no bin script for ${bin} under ${ctx.layout.tools.npm}`);
		const node = nodeBinaryPath(ctx.layout, ctx.versionsOf(["node"]).node as string);
		result = await ctx.exec(node, [script.absolute, "--version"], { cwd: ctx.layout.tools.npm, env, timeoutMs: 120_000 });
	} else {
		result = await ctx.exec(binShim(ctx.layout, bin), ["--version"], { env, timeoutMs: 120_000 });
	}
	const line = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/)[0] ?? "";
	if (result.code !== 0) throw new StageError("other", { stage: ctx.stage }, `${bin} --version failed (exit ${result.code}): ${line}`);
	return result.stdout.trim().split(/\r?\n/)[0] ?? line;
}

/** The `pi` stage. It needs Node (npm runs under it) and the other two tools of the constructed environment, which names all three. */
export const piStage = (_platform: AppPlatform, npm?: NpmRun): Stage => npmGlobalStage({ name: "pi", needs: ["node", "git", "herdr"], waitForQuiet: true, ...(npm ? { npm } : {}) });

/** Exposed for the tests that run npm by hand under the same private Node. */
export { nodeBinaryPath, npmCliPath };
