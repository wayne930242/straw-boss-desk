import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../../paths.ts";
import { StageError } from "../errors.ts";
import type { PlatformKey } from "../stack.ts";
import { detectFromRecord, fileKey, type Evidence, type Stage, type StageContext } from "../stage.ts";
import { readManifest } from "./pi.ts";

// The `claude` stage (spec: Stages). pi-claude-bridge talks to Claude through the Claude Agent SDK, which ships a native `claude` executable in a platform
// package (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`, an optional dependency of the SDK). That executable is also what signs the PM in and
// answers every model call, so the stage locates the one pi-claude-bridge installed, runs `--version` with the app's environment, and records its hash.
// It has no pin of its own: the version is whatever the pinned pi-claude-bridge brought, and `detect` compares the record with what is on disk now.

const SCOPE = "@anthropic-ai";

/** The Agent SDK package the stack pins beside pi-claude-bridge (stack.json), so the bundled `claude` is the one whose Keychain naming was read. */
export const CLAUDE_SDK = "@anthropic-ai/claude-agent-sdk";

/** The platform package the SDK installs for this machine: `claude-agent-sdk-darwin-arm64`, `claude-agent-sdk-win32-x64`, ... */
export const sdkPlatformPackage = (key: PlatformKey): string => `claude-agent-sdk-${key}`;

/**
 * The `claude` executable of the SDK platform package for `key`, under `<agent>/npm/node_modules` (where `pi install npm:pi-claude-bridge` puts it): nested
 * under the bridge or hoisted beside it, the two layouts the kit's `sdk-exe.mjs` found. Null when neither holds it.
 */
export function locateClaude(modulesDir: string, key: PlatformKey, exists: (path: string) => boolean = existsSync): { exe: string; packageDir: string } | null {
	const exeName = key.startsWith("win32") ? "claude.exe" : "claude";
	const scopes = [join(modulesDir, "pi-claude-bridge", "node_modules", SCOPE), join(modulesDir, SCOPE)];
	for (const scope of scopes) {
		const packageDir = join(scope, sdkPlatformPackage(key));
		const exe = join(packageDir, exeName);
		if (exists(exe)) return { exe, packageDir };
	}
	return null;
}

/** `<agent>/npm/node_modules`: the folder pi installs its npm packages into. */
export const agentModules = (layout: Layout): string => join(layout.agent, "npm", "node_modules");

export function claudeStage(pinnedSdk?: string): Stage {
	const found = (ctx: StageContext): { exe: string; packageDir: string; version: string } => {
		const located = locateClaude(agentModules(ctx.layout), ctx.key);
		if (located === null) {
			throw new StageError("other", { stage: "claude" }, `pi-claude-bridge's Claude Agent SDK has no ${sdkPlatformPackage(ctx.key)}/claude under ${agentModules(ctx.layout)}: the platform package was not installed`);
		}
		const version = readManifest(join(located.packageDir, "package.json"))?.version ?? "";
		if (pinnedSdk !== undefined && version !== "" && version !== pinnedSdk) {
			throw new StageError("other", { stage: "claude" }, `${located.packageDir} is ${version}, the stack pins the Agent SDK at ${pinnedSdk}: a second copy of the SDK is in the tree`);
		}
		return { ...located, version };
	};
	return {
		name: "claude",
		needs: ["pkg:pi-claude-bridge"],
		plannedVersion: (ctx) => found(ctx).version,
		async detect(ctx) {
			let now: ReturnType<typeof found>;
			try {
				now = found(ctx);
			} catch {
				return null;
			}
			if (now.version === "") return null;
			return detectFromRecord(ctx, { version: now.version });
		},
		async install() {
			// Nothing to install: the SDK platform package came with pi-claude-bridge.
		},
		async verify(ctx) {
			const now = found(ctx);
			if (now.version === "") throw new StageError("other", { stage: "claude" }, `${now.packageDir}/package.json names no version`);
			const result = await ctx.exec(now.exe, ["--version"], { env: ctx.childEnv(), timeoutMs: 120_000 });
			const line = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/)[0] ?? "";
			if (result.code !== 0) throw new StageError("other", { stage: "claude" }, `${now.exe} --version failed (exit ${result.code}): ${line}`);
			// `2.1.316 (Claude Code)`: the executable's own version is the SDK's 0.3.x counterpart, so only its shape is checked.
			if (!/^\d+\.\d+\.\d+/.test(result.stdout.trim())) throw new StageError("other", { stage: "claude" }, `${now.exe} --version printed ${JSON.stringify(line)}`);
			const evidence: Evidence = { text: `claude-agent-sdk ${now.version}; claude --version -> ${line}`, version: now.version, files: [fileKey(ctx.layout, now.exe)] };
			return evidence;
		},
		async activate() {
			// The engine records the executable's hash after this.
		},
	};
}
