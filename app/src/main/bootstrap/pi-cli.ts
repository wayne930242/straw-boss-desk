import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../paths.ts";
import type { RunResult } from "../platform/index.ts";
import { StageError } from "./errors.ts";
import { nodeBinaryPath, npmFailure, packageDir, type NpmRun } from "./npm.ts";
import { StackError, type NpmPin } from "./stack.ts";
import type { StageContext } from "./stage.ts";
import { binEntry, npmGlobalPin, readManifest } from "./stages/pi.ts";

// The pi CLI as the package stages use it (spec: Stages `profile`, `pkg:<name>`, `team-pkg:<name>`): `pi install npm:<name>@<version>` and `pi remove`,
// which keep `settings.json`'s `packages` list and install under `<agent>/npm/node_modules`. pi runs by `node <its bin script>` under the private Node,
// with the constructed environment, so no `.cmd` wrapper and no shell are involved (the kit's `Invoke-Native -File $t.PiCmd` had both).

/** An npm package name as the registry allows it, which is also all a folder under `node_modules` may be called here. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

/** `<agent>/npm/node_modules/<name>`: where `pi install` puts a package. A name that is not a plain npm name is refused, so it can never name a path outside the folder. */
export function agentPackageDir(layout: Layout, name: string): string {
	if (!PACKAGE_NAME.test(name) || name.length > 214) throw new StackError(`${JSON.stringify(name.slice(0, 80))} is not an npm package name`);
	return join(layout.agent, "npm", "node_modules", ...name.split("/"));
}

/** The version of the package `pi install` put under the agent folder, or null when it is not there. */
export const installedVersion = (layout: Layout, name: string): string | null => readManifest(join(agentPackageDir(layout, name), "package.json"))?.version ?? null;

/** `npm:<name>@<version>`, the source string pi takes and writes into `settings.json`. */
export const piSource = (pin: Pick<NpmPin, "name" | "version">): string => `npm:${pin.name}@${pin.version}`;

/** The private Node and the pinned pi's bin script: what runs `pi <subcommand>`. */
export function piInvocation(ctx: StageContext): { file: string; script: string } {
	const pin = npmGlobalPin(ctx.stack, "pi");
	const dir = packageDir(ctx.layout, pin.name);
	const entry = binEntry(readManifest(join(dir, "package.json")), "pi", pin.name);
	if (entry === null) throw new StageError("other", { stage: ctx.stage }, `${pin.name} is not installed under ${ctx.layout.tools.npm}, so ${ctx.stage} cannot run pi`);
	const node = ctx.versionsOf(["node"]).node as string;
	return { file: nodeBinaryPath(ctx.layout, node), script: join(dir, ...entry.split("/")) };
}

/** Runs `pi <args>` with the constructed environment (the OS proxy among it). The command and its output go to the stage log. */
export function runPi(ctx: StageContext, args: readonly string[], timeoutMs: number, extraEnv?: Readonly<Record<string, string>>): Promise<RunResult> {
	const { file, script } = piInvocation(ctx);
	// The cwd is the data root's tools folder, where no project file (`.pi/`) can be: `pi install` without `-l` writes the user scope, the agent folder.
	return ctx.exec(file, [script, ...args], { env: ctx.childEnv(extraEnv), cwd: ctx.layout.tools.root, timeoutMs });
}

const LOCKED_LINE = /\b(EBUSY|EPERM|EACCES|EMFILE|ENOTEMPTY)\b/;

/** `pi install npm:<name>@<version>`: a failure is classified from npm's own lines (pi prints them), the way the `pi` stage's npm steps are. */
export async function piInstall(ctx: StageContext, pin: NpmPin, options: NpmRun = {}): Promise<void> {
	const what = `${pin.name}@${pin.version}`;
	const result = await runPi(ctx, ["install", piSource(pin)], options.timeoutMs ?? 1_800_000, options.env);
	if (result.timedOut || result.code !== 0) throw npmFailure(ctx.stage, what, result, `pi install ${piSource(pin)}`);
	for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) if (LOCKED_LINE.test(line)) ctx.fsErrors.push(line.trim().slice(0, 300));
}

/** `pi remove npm:<name>@<version>`: the result is the caller's to judge (a failed removal is reported, not thrown). */
export const piRemove = (ctx: StageContext, pin: Pick<NpmPin, "name" | "version">, options: NpmRun = {}): Promise<RunResult> => runPi(ctx, ["remove", piSource(pin)], options.timeoutMs ?? 300_000, options.env);

export type LockCheck = { kind: "match" } | { kind: "mismatch"; recorded: string } | { kind: "absent" };

/**
 * What npm recorded for `pin` in `<agent>/npm/package-lock.json` when pi installed it: the integrity of the tarball it fetched. The registry's answer was
 * compared with the pin before the install (`assertRegistryIntegrity`); this closes the window between that question and the download, since a tarball
 * that changed in between would be recorded here with another integrity. The lock's key for the package can carry a path prefix (a linked data root), so
 * entries are matched by the `node_modules/<name>` they end with.
 */
export function checkLockedIntegrity(layout: Layout, pin: NpmPin): LockCheck {
	let lock: unknown;
	try {
		lock = JSON.parse(readFileSync(join(layout.agent, "npm", "package-lock.json"), "utf8"));
	} catch {
		return { kind: "absent" };
	}
	const packages = typeof lock === "object" && lock !== null ? (lock as { packages?: unknown }).packages : undefined;
	if (typeof packages !== "object" || packages === null) return { kind: "absent" };
	const tail = `node_modules/${pin.name}`;
	for (const [key, entry] of Object.entries(packages as Record<string, unknown>)) {
		if (key !== tail && !key.endsWith(`/${tail}`)) continue;
		if (typeof entry !== "object" || entry === null) continue;
		const { version, integrity } = entry as { version?: unknown; integrity?: unknown };
		if (version !== pin.version) continue;
		if (typeof integrity !== "string") return { kind: "absent" };
		return integrity === pin.integrity ? { kind: "match" } : { kind: "mismatch", recorded: integrity };
	}
	return { kind: "absent" };
}

/** Throws an `integrity` failure when npm recorded another tarball than the pin, and `other` when it recorded none (the app cannot confirm what was installed). */
export function assertLockedIntegrity(ctx: StageContext, pin: NpmPin): void {
	const check = checkLockedIntegrity(ctx.layout, pin);
	if (check.kind === "match") return;
	if (check.kind === "mismatch") {
		throw new StageError("integrity", { tool: pin.name }, `npm installed ${pin.name}@${pin.version} with another integrity than the pin\n  pinned   ${pin.integrity}\n  recorded ${check.recorded}`);
	}
	throw new StageError("other", { stage: ctx.stage }, `npm recorded no integrity for ${pin.name}@${pin.version} in ${join(ctx.layout.agent, "npm", "package-lock.json")}, so the app cannot confirm which tarball was installed`);
}
