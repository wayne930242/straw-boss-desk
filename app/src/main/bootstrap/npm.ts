import { join } from "node:path";
import { toolDir, toolExecutable, type Layout } from "../paths.ts";
import { StageError } from "./errors.ts";
import type { StageContext } from "./stage.ts";
import type { NpmPin } from "./stack.ts";
import type { RunResult } from "../platform/index.ts";

// The npm steps of the pi stages (spec: Stages `pi`; Rollback: "npm and pi stages roll back by installing the previous pin again"). npm runs under the
// private Node by `node npm-cli.js`, never through `npm.cmd`, so no shell and no argument quoting is involved. A pinned package is checked against
// its registry integrity first (the kit's `Assert-NpmIntegrity`); nothing falls back to another version.

/** `npm-cli.js` inside the Node folder: Windows zips keep npm beside `node.exe`, the macOS tarball under `lib/`. */
export function npmCliPath(layout: Layout, nodeVersion: string): string {
	const node = toolDir(layout, "node", nodeVersion);
	return layout.platform === "win32" ? join(node, "node_modules", "npm", "bin", "npm-cli.js") : join(node, "lib", "node_modules", "npm", "bin", "npm-cli.js");
}

export const nodeBinaryPath = (layout: Layout, nodeVersion: string): string => join(toolDir(layout, "node", nodeVersion), ...toolExecutable(layout.platform, "node").split("/"));

/** Where `npm install -g` puts a package under the private prefix: `lib/node_modules` on macOS, `node_modules` on Windows. */
export const packageDir = (layout: Layout, name: string): string =>
	layout.platform === "win32" ? join(layout.tools.npm, "node_modules", ...name.split("/")) : join(layout.tools.npm, "lib", "node_modules", ...name.split("/"));

const NETWORK_TEXT = /ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPROTO|ERR_SOCKET|FETCH_ERROR|network/;
const CERT_TEXT = /CERT_|UNABLE_TO_VERIFY|SELF_SIGNED|UNABLE_TO_GET_ISSUER|SSL routines|certificate/i;
const MISSING_TEXT = /E404|\b404\b|Not Found|ETARGET|notarget|No match found|No matching version/;
const REFUSED_TEXT = /E401|E403|\b40[13]\b/;
const SERVER_TEXT = /E50\d|\b50[0-4]\b/;
const DISK_TEXT = /ENOSPC|no space left/i;
const LOCKED_TEXT = /\b(EBUSY|EPERM|EACCES|EMFILE|ENOTEMPTY)\b/;

/** What the kit's `Get-NpmFailureKind` says about npm's output, in words for the log. */
export function npmFailureKind(text: string): string {
	if (CERT_TEXT.test(text)) return "certificate failure";
	if (NETWORK_TEXT.test(text)) return "network failure";
	if (MISSING_TEXT.test(text)) return "npm found no such version (the registry said 404, or the registry did not answer and npm used an old cached copy)";
	if (REFUSED_TEXT.test(text)) return "registry refused the request (401/403)";
	if (SERVER_TEXT.test(text)) return "registry server error (5xx)";
	return "npm failed";
}

/** The first lines of npm's error output that carry the cause, for the stage's detail. */
export function npmDetail(result: RunResult): string {
	const lines = `${result.stderr}\n${result.stdout}`.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
	return lines.filter((l) => /^npm (error|ERR!)/.test(l)).slice(0, 6).join(" | ") || lines.slice(0, 6).join(" | ");
}

/**
 * The `StageError` for a failed npm step on `what` (`name@version`): a registry-side failure (network, no such version, 401/403, 5xx) is category
 * `registry` with the kit's sentence, retried once; a certificate failure is `network` with the proxy-or-inspection wording; a full disk and a held
 * file keep their own categories; anything else is `other` with npm's own lines.
 */
export function npmFailure(stage: string, what: string, result: RunResult, step: string): StageError {
	const text = `${result.stderr}\n${result.stdout}`;
	const detail = `${step} exit ${result.code}: ${npmDetail(result)}`;
	if (result.timedOut) return new StageError("registry", { what }, `${step} did not finish in time (network failure, not an integrity mismatch)`);
	if (DISK_TEXT.test(text)) return new StageError("disk", {}, detail);
	const kind = npmFailureKind(text);
	if (kind === "certificate failure") return new StageError("network", { host: "registry.npmjs.org", cause: "tls" }, `${detail} (${kind})`);
	if (kind !== "npm failed") return new StageError("registry", { what }, `${detail} (${kind}; this is not an integrity mismatch)`);
	if (LOCKED_TEXT.test(text)) return new StageError("locked", {}, detail);
	return new StageError("other", { stage }, detail);
}

export interface NpmRun {
	/** Extra environment on top of the constructed one (tests point npm at a local registry). */
	env?: Readonly<Record<string, string>>;
	timeoutMs?: number;
}

/** Runs `npm <args>` under the private Node with the constructed environment (the OS proxy among it). The command and output go to the stage log. */
export async function runNpm(ctx: StageContext, args: readonly string[], options: NpmRun = {}): Promise<RunResult> {
	const node = ctx.versionsOf(["node"]).node as string;
	return ctx.exec(nodeBinaryPath(ctx.layout, node), [npmCliPath(ctx.layout, node), ...args], {
		env: ctx.childEnv(options.env),
		// The cwd is the private npm prefix's parent, where there is no package.json or .npmrc of a project.
		cwd: ctx.layout.tools.root,
		timeoutMs: options.timeoutMs ?? 1_800_000,
	});
}

/** Asks the registry for the pin's integrity and refuses a different one (`integrity`, never retried) or an unreadable answer (`registry`). */
export async function assertRegistryIntegrity(ctx: StageContext, pin: NpmPin, options: NpmRun = {}): Promise<void> {
	const what = `${pin.name}@${pin.version}`;
	const result = await runNpm(ctx, ["view", what, "dist.integrity", "--prefer-online"], { ...options, timeoutMs: options.timeoutMs ?? 120_000 });
	if (result.timedOut || result.code !== 0) throw npmFailure(ctx.stage, what, result, `registry lookup for ${what}`);
	const got = result.stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
	if (got === "") throw new StageError("registry", { what }, `the registry answered without dist.integrity for ${what} (npm view printed nothing; not an integrity mismatch)`);
	if (got !== pin.integrity) throw new StageError("integrity", { tool: pin.name }, `registry integrity mismatch for ${what}\n  pinned   ${pin.integrity}\n  registry ${got}`);
}

/** `npm install -g --prefix <private prefix> name@version`; a held file (antivirus) is noted in `fsErrors` when npm still succeeded. */
export async function installGlobal(ctx: StageContext, pin: NpmPin, options: NpmRun = {}): Promise<void> {
	const what = `${pin.name}@${pin.version}`;
	const result = await runNpm(ctx, ["install", "-g", "--prefix", ctx.layout.tools.npm, "--prefer-online", what], options);
	if (result.timedOut || result.code !== 0) throw npmFailure(ctx.stage, what, result, `npm install -g ${what}`);
	for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) if (LOCKED_TEXT.test(line)) ctx.fsErrors.push(line.trim().slice(0, 300));
}
