import { statfsSync } from "node:fs";
import os from "node:os";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import type { AppPlatform } from "../../paths.ts";
import { StageError } from "../errors.ts";
import type { Fetch } from "../download.ts";
import { assetFor, type PlatformKey, type Stack } from "../stack.ts";
import type { EngineRecipe } from "../recipe-config.ts";
import type { StageWarning } from "../state.ts";
import type { Evidence, Stage, StageContext } from "../stage.ts";
import { checkPaneLookups, MACHINE_BUN_SENTENCE, MACHINE_PI_SENTENCE, WSL_SENTENCE, type PaneFindings } from "../../pane-path.ts";

// The preflight stage (spec: Stages, `preflight`; Network): what must hold before anything is downloaded. It checks the machine (the Windows build that
// ships `tar.exe`, free space, the layout's decisions, Smart App Control), then that every host a download needs answers. A host the recipe names as a code
// host that does not answer is a warning, never a failure: it may be reachable only on the company network (`gitlab.moldplan.app` resolves only on the
// tailnet), and node, Git, pi, and the optional tools still install.
//
// `detect` does the checking and returns evidence when everything passes, so a second run is `skipped-verified` and the checks still ran; the stage
// asks for its result to be recorded then too (`recordDetect`), which is how `state/bootstrap.json` holds the warnings.

export const MIN_FREE_BYTES = 3 * 1024 ** 3;
/** Windows 10 version 1803 (build 17134) is the first with `tar.exe`, which the engine extracts archives with. */
export const MIN_WINDOWS_BUILD = 17134;
export const REACH_TIMEOUT_MS = 8000;
const NPM_REGISTRY_HOST = "registry.npmjs.org";

export type ReachKind = "ok" | "dns" | "tls" | "path";

export interface PreflightOptions {
	platform: AppPlatform;
	/** Free bytes available to this user at `path` (default: `fs.statfsSync`). */
	freeBytes?: (path: string) => number;
	/** `os.release()`. */
	release?: () => string;
	/** One host's limit (default 8 s); the hosts are checked at once, so the whole check takes about this long when one is blackholed. */
	reachTimeoutMs?: number;
	/** Windows: what a pane's lookup of `bash`, `pi`, and `bun` finds (default: the registry's `Path` values, read with `reg.exe`). A test passes its own. */
	panePath?: (ctx: StageContext) => Promise<PaneFindings>;
}

const flatten = (error: unknown): string => {
	const parts: string[] = [];
	for (let e: unknown = error, depth = 0; e instanceof Error && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
		parts.push(`${(e as NodeJS.ErrnoException).code ?? ""} ${e.name} ${e.message}`);
	}
	return parts.join(" | ");
};

/** What kind of failure a `fetch` error is: a name that does not resolve, a certificate this computer does not trust, or anything else on the path. */
export function reachKindOf(error: unknown): ReachKind {
	const text = flatten(error);
	if (/CERT_|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ERR_CERT|ERR_SSL|ERR_TLS|certificate/i.test(text)) return "tls";
	if (/ENOTFOUND|EAI_AGAIN|EAI_NONAME|ERR_NAME_NOT_RESOLVED|getaddrinfo/i.test(text)) return "dns";
	return "path";
}

/** Asks `https://<host>/` with a HEAD request. Any HTTP answer, whatever its status, means the host is reachable; only a failure to get one does not. */
export async function reachHost(fetch: Fetch, host: string, timeoutMs: number, signal: AbortSignal): Promise<{ kind: ReachKind; detail: string }> {
	const limit = AbortSignal.timeout(timeoutMs);
	try {
		const response = await fetch(`https://${host}/`, { method: "HEAD", signal: AbortSignal.any([signal, limit]) });
		await response.body?.cancel().catch(() => {});
		return { kind: "ok", detail: `HTTP ${response.status}` };
	} catch (error) {
		if (limit.aborted) return { kind: "path", detail: `no answer within ${timeoutMs / 1000} s` };
		return { kind: reachKindOf(error), detail: flatten(error).slice(0, 300) };
	}
}

/** The hosts the downloads of this run come from: the pinned URLs of the required tools, the enabled optional tools, and the CLIs of the recipe's forges, and the npm registry. */
export function downloadHosts(stack: Stack, key: PlatformKey, recipe: EngineRecipe): string[] {
	const tools = ["node", "git", "herdr", "fd", "rg"];
	if (recipe.forges.some((f) => f.kind === "github")) tools.push("gh");
	if (recipe.forges.some((f) => f.kind === "gitlab")) tools.push("glab");
	const hosts = new Set<string>([NPM_REGISTRY_HOST]);
	for (const tool of [...tools, ...recipe.tools]) hosts.add(new URL(assetFor(stack, tool, key).url).host);
	return [...hosts];
}

/** The sentence of **Network**, **A private code host**. */
export const privateHostSentence = (host: string): string => `Could not reach ${host}; it may be reachable only on the company network, so connect to that network and try again.`;

const SAC_STATE = ["off", "on", "evaluation"] as const;

async function smartAppControl(ctx: StageContext): Promise<string> {
	try {
		const reg = ctx.platform.locate.system("reg");
		const r = await ctx.exec(reg, ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy", "/v", "VerifiedAndReputablePolicyState"], { timeoutMs: 15_000 });
		const m = /VerifiedAndReputablePolicyState\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(r.stdout);
		const value = m?.[1] === undefined ? null : Number.parseInt(m[1], 16);
		return value === null ? "unknown" : (SAC_STATE[value] ?? `unknown (${value})`);
	} catch {
		return "unknown";
	}
}

/** The default pane lookup: both `Path` values from `reg.exe`, walked as a pane does (a read of HKLM and HKCU, never a write). */
const registryPanePath = (ctx: StageContext): Promise<PaneFindings> =>
	checkPaneLookups({ run: (file, args, runOptions) => ctx.exec(file, args, runOptions), locate: ctx.platform.locate, exists: existsSync, env: ctx.appEnv });

const nearestExisting = (path: string): string => {
	let current = path;
	while (!existsSync(current) && dirname(current) !== current) current = dirname(current);
	return current;
};

const gigabytes = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export function preflightStage(options: PreflightOptions): Stage {
	const freeBytes =
		options.freeBytes ??
		((path: string): number => {
			const stats = statfsSync(path);
			return Number(stats.bavail) * Number(stats.bsize);
		});
	const release = options.release ?? os.release;
	const timeoutMs = options.reachTimeoutMs ?? REACH_TIMEOUT_MS;
	/** The failure `detect` found, for `install` to throw without checking the network twice. */
	const found = new WeakMap<StageContext, StageError>();

	async function check(ctx: StageContext): Promise<Evidence> {
		const facts: string[] = [];

		// The stack must carry every pin this machine needs; a missing one is a stack problem, named before any download.
		for (const tool of ["node", "git", "herdr", "fd", "rg"]) assetFor(ctx.stack, tool, ctx.key);

		if (options.platform === "win32") {
			const build = Number(release().split(".")[2] ?? "0");
			if (!Number.isFinite(build) || build < MIN_WINDOWS_BUILD) {
				throw new StageError("other", { stage: "preflight" }, `Windows build ${release()} is older than 1803 (build ${MIN_WINDOWS_BUILD}), which is the first with the tar.exe this app extracts downloads with`);
			}
			facts.push(`Windows ${release()}`);
		} else {
			facts.push(`macOS (Darwin ${release()})`);
		}
		facts.push(ctx.key);

		const free = freeBytes(nearestExisting(ctx.layout.root));
		if (free < MIN_FREE_BYTES) throw new StageError("disk", {}, `${gigabytes(free)} free where ${ctx.layout.root} is; the install needs ${gigabytes(MIN_FREE_BYTES)}`);
		facts.push(`${gigabytes(free)} free`);
		for (const reason of ctx.layout.record.reasons) facts.push(`layout: ${reason}`);

		const warnings: StageWarning[] = [];
		// The Smart App Control query (reg.exe, up to 15 s) runs while the hosts are asked, so it never adds to the 10 s an unreachable host's sentence needs (T5-F011 c).
		const sacPending = options.platform === "win32" ? smartAppControl(ctx) : null;
		// The same for the pane lookup: two `reg.exe` reads. A failure to read is logged and skipped; the check is a warning, never a failure.
		const panePending =
			options.platform === "win32"
				? (options.panePath ?? registryPanePath)(ctx).then(
						(found) => found,
						(error: unknown) => {
							ctx.log.event({ event: "pane-path-unreadable", detail: (error as Error).message });
							return null;
						},
					)
				: null;

		const hosts = downloadHosts(ctx.stack, ctx.key, ctx.recipe);
		const forgeHosts = [...new Set(ctx.recipe.forges.map((f) => f.host))].filter((h) => !hosts.includes(h));
		const started = Date.now();
		const results = await Promise.all([...hosts, ...forgeHosts].map(async (host) => ({ host, ...(await reachHost(ctx.fetch, host, timeoutMs, ctx.signal)) })));
		ctx.log.event({ event: "reach", ms: Date.now() - started, results: results.map((r) => `${r.host}: ${r.kind} (${r.detail})`) });

		const blocked = results.filter((r) => r.kind !== "ok" && hosts.includes(r.host));
		const first = blocked[0];
		if (first !== undefined) {
			const cause = first.kind === "tls" ? "tls" : "path";
			throw new StageError("network", { host: first.host, cause }, `cannot reach ${blocked.map((r) => `${r.host} (${r.kind}: ${r.detail})`).join(", ")}`);
		}
		if (sacPending !== null) {
			const sac = await sacPending;
			facts.push(`Smart App Control ${sac}`);
			if (sac === "on" || sac === "evaluation") {
				warnings.push({ kind: "smart-app-control", sentence: sac === "on" ? "Smart App Control is on, which blocks unsigned programs such as Straw Boss." : "Smart App Control is in evaluation mode; Windows may turn it on later and then block Straw Boss." });
			}
		}
		if (panePending !== null) {
			const pane = await panePending;
			if (pane !== null) {
				facts.push(`a pane runs bash from ${pane.firstBash ?? "nowhere"}`);
				if (pane.wslBash && pane.firstBash !== null) warnings.push({ kind: "wsl-bash", path: pane.firstBash, sentence: WSL_SENTENCE });
				if (pane.machinePi !== null) warnings.push({ kind: "machine-pi", path: pane.machinePi, sentence: MACHINE_PI_SENTENCE });
				// The shims hold `bun.cmd` and `bunx.cmd` only for a recipe that names bun; without one a machine bun is the PM's own business.
				if (ctx.recipe.tools.includes("bun")) {
					for (const path of [pane.machineBun, pane.machineBunx]) if (path !== null) warnings.push({ kind: "machine-bun", path, sentence: MACHINE_BUN_SENTENCE });
				}
			}
		}
		for (const r of results) {
			if (r.kind !== "ok" && !hosts.includes(r.host)) warnings.push({ kind: "forge-host-unreachable", host: r.host, sentence: privateHostSentence(r.host) });
		}
		facts.push(`reached ${hosts.join(", ")}`);
		return { text: facts.join("; "), version: "1", ...(warnings.length > 0 ? { warnings } : {}) };
	}

	return {
		name: "preflight",
		needs: [],
		recordDetect: true,
		noRetry: true,
		plannedVersion: () => "1",
		async detect(ctx) {
			try {
				return await check(ctx);
			} catch (error) {
				// The engine's own cancel is not a finding.
				if (ctx.signal.aborted) throw error;
				found.set(ctx, error instanceof StageError ? error : new StageError("other", { stage: "preflight" }, (error as Error).message, { cause: error }));
				return null;
			}
		},
		async install(ctx) {
			const failure = found.get(ctx);
			if (failure !== undefined) throw failure;
			// Not reached when `detect` passed; if it is reached without a finding, check again and report what is found.
			await check(ctx);
		},
		async verify(ctx) {
			return check(ctx);
		},
		async activate() {},
	};
}
