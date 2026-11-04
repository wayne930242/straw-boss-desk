import { spawn } from "node:child_process";
import { join } from "node:path";
import { buildEnv, type EnvLike, type EnvMap } from "../env.ts";
import { FORGE_LAUNCHERS, LAUNCHER_UNSET } from "../bootstrap/stages/launcher-files.ts";
import { toolDir, toolExecutable, type CurrentTools, type Layout } from "../paths.ts";
import type { ForgeKind } from "./existing.ts";

// How the app runs gh and glab for a sign-in (spec: The code-host screens). The calls use the pinned binary itself with the environment the launcher in `tools/bin` would give it (the private
// configuration folder, the prompt, update-check and telemetry switches, and none of `LAUNCHER_UNSET`), built from the same `FORGE_LAUNCHERS` table, so a sign-in made here and one made in a pane
// read and write the same folder. The binary is started directly, not through the `.cmd` launcher, so that cancelling a login ends the real process: killing a `cmd.exe` would leave `gh.exe`
// polling the device code and able to finish the login (the account check's `Stop-LoginProcess`).

export const cliOf = (kind: ForgeKind): "gh" | "glab" => (kind === "github" ? "gh" : "glab");

/** The pinned CLI's executable, or null when the active install has none (the `gh` or `glab` stage did not run). */
export function forgeBinary(layout: Layout, current: CurrentTools, kind: ForgeKind): string | null {
	const tool = cliOf(kind);
	const version = current[tool];
	return version === undefined ? null : join(toolDir(layout, tool, version), toolExecutable(layout.platform, tool));
}

/** The folder the CLI keeps its files in: gh `config/gh`, glab `config/glab-cli`. */
export const forgeConfigDir = (layout: Layout, kind: ForgeKind): string => (kind === "github" ? layout.ghConfig : layout.glabConfig);

export interface ForgeEnvInput {
	layout: Layout;
	current: CurrentTools;
	appEnv: EnvLike;
	kind: ForgeKind;
	/** The OS proxy setting as the engine gets it (`Supervisor.engineProxyEnv`); a variable the app's own environment sets wins. */
	proxyEnv?: Readonly<Record<string, string>>;
}

/** The environment a launcher gives `gh` or `glab`, on top of the constructed environment of every child. */
export function forgeEnv({ layout, current, appEnv, kind, proxyEnv = {} }: ForgeEnvInput): EnvMap {
	const spec = FORGE_LAUNCHERS[cliOf(kind)];
	const out: EnvMap = { ...proxyEnv, ...buildEnv({ layout, current, appEnv }) };
	const unset = new Set(LAUNCHER_UNSET.map((k) => (layout.platform === "win32" ? k.toLowerCase() : k)));
	for (const key of Object.keys(out)) if (unset.has(layout.platform === "win32" ? key.toLowerCase() : key)) delete out[key];
	if (spec.config !== undefined) out[spec.config.variable] = forgeConfigDir(layout, kind);
	for (const [name, value] of spec.env) out[name] = value;
	return out;
}

// ---- a login that runs until the person has approved it --------------------------------------------------------------------

/** The part of a child process the device-flow login uses; `child_process.spawn` returns it, and a test passes a stand-in. */
export interface LoginChild {
	stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
	stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
	on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnLogin = (file: string, args: readonly string[], options: { env: Record<string, string> }) => LoginChild;

/** The production spawn: no shell, no window, no standard input (gh's `--web` flow in a non-interactive session prints the code and waits). */
export const spawnLogin: SpawnLogin = (file, args, options) =>
	// SAFETY: a `ChildProcess` has every member of `LoginChild`; the cast only narrows `on` and `kill`'s overloads to the calls the sign-in makes.
	spawn(file, [...args], { env: options.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }) as unknown as LoginChild;

// ---- reading what a CLI printed ---------------------------------------------------------------------------------------------

/** gh's one-time code: four letters or digits, a dash, four more. */
export function parseDeviceCode(text: string): string | null {
	return /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(text)?.[1] ?? null;
}

/** The first line of `text` that says how a login ended or went wrong, for **Details**; empty when none does. */
export function loginLine(text: string): string {
	const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
	return (lines.find((l) => /Logged in|Authentication complete|error|failed|invalid|unauthorized|401|403|denied|expired/i.test(l)) ?? lines[0] ?? "").slice(0, 300);
}
