import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nodeBinaryPath } from "../bootstrap/npm.ts";
import { agentPackageDir } from "../bootstrap/pi-cli.ts";
import type { CurrentTools, Layout } from "../paths.ts";
import { herdrBinary } from "../paths.ts";

// What a start needs from the install, read from the state files and the disk, and what stops it (spec: Runtime supervisor, Start; Build notes T7-F002). Nothing here runs a program.

/**
 * The field of a stage record in `state/bootstrap.json` that task 7b's package stage sets when a failed install left a package that may still load code
 * (T7-F002): `startBlock: { kind: "package-may-load", package, sentence }`. A start refuses while any stage record carries one and shows its `sentence`; the next
 * successful run of that stage writes a record without it (**Repair** runs the stage). It is read from the raw file, as `StateStore.startBlocks()` reads it on
 * 7b's branch, and a value that does not parse is still a block: dropping it would let pi start.
 */
export const START_BLOCK_FIELD = "startBlock";

export interface PackageBlock {
	stage: string;
	/** The npm package name; the stage's own name when the record gives none. */
	package: string;
	/** The plain English line for the PM; empty when the record gives none (the screen's catalog line stands in). */
	sentence: string;
}

/** The stack package whose `cli.mjs` the supervisor runs directly, without pi (R7-F002). Its stage is `pkg:<name>`. */
export const STACK_PACKAGE = "pi-straw-boss";
export const STACK_STAGE = `pkg:${STACK_PACKAGE}`;

/**
 * Every stack package whose code runs from `<agent>/npm/node_modules` without pi (R7-F002, T8A-F003). Pi's package list and a start block cannot stop these, so a start
 * runs nothing until each one's stage (`pkg:<name>`) is `ok`:
 *   - `pi-straw-boss`: the app runs its `dist/server/cli.mjs`.
 *   - `pi-intercom`: the sb server loads `broker/client.ts`, `broker/spawn.ts` and `config.ts` from `<agent>/npm/node_modules/pi-intercom` through tsx, whatever `settings.json`
 *     lists (pi-straw-boss 0.51.0 `findIntercom` in `chunk-*.mjs` and `loadIntercom` in `main.mjs`).
 * `cli.mjs` imports nothing else from `node_modules` by name: its `chunk-*.mjs` and `main.mjs` import only `node:` modules and each other, and `tsx` (found from the
 * package's own folder, `findTsx`) is a dependency of `pi-straw-boss`, covered by that package's stage and the supply-chain limit of seam U7. A later stack package that the
 * server or the supervisor executes the same way is added here.
 */
export const DIRECT_PACKAGES: readonly string[] = [STACK_PACKAGE, "pi-intercom"];

/** The stages that write the npm prefix or pi's package list in place (`pi` is `npm install -g` into `tools/npm`); a `running` record on one of them, with the engine lock free, is an interrupted install (R7-F001, R13-F009). */
export const isPackageStage = (stage: string): boolean => stage === "pi" || stage === "profile" || stage.startsWith("pkg:") || stage.startsWith("team-pkg:");

export interface StartGate {
	/** `bootstrap.json` is there but cannot be read, or has no `stages` object: nothing in it can be trusted (R7-F007). */
	unreadable: boolean;
	/** `bootstrap.json` is not there. After an install it means the engine quarantined it. */
	missing: boolean;
	/** Stage records that carry a `startBlock`. */
	blocks: PackageBlock[];
	/** Package stages whose record is `running`. */
	interrupted: string[];
	/** The status of each `DIRECT_PACKAGES` stage (`pkg:<name>`), null when it has no record. */
	direct: Array<{ package: string; status: string | null }>;
}

/**
 * What `state/bootstrap.json` says about whether a start is safe, read from the raw file as `StateStore.startBlocks()` reads it on 7b's branch: a `startBlock` that does not
 * parse is still a block, and a file that does not parse is not "no blocks" (a start must never go on blind).
 */
export function readStartGate(layout: Layout): StartGate {
	const gate: StartGate = { unreadable: false, missing: false, blocks: [], interrupted: [], direct: DIRECT_PACKAGES.map((name) => ({ package: name, status: null })) };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(layout.state, "bootstrap.json"), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") gate.missing = true;
		else gate.unreadable = true;
		return gate;
	}
	const stages = typeof parsed === "object" && parsed !== null ? (parsed as { stages?: unknown }).stages : undefined;
	if (typeof stages !== "object" || stages === null || Array.isArray(stages)) {
		gate.unreadable = true;
		return gate;
	}
	for (const [stage, record] of Object.entries(stages)) {
		const fields = typeof record === "object" && record !== null ? (record as Record<string, unknown>) : null;
		if (fields === null) {
			gate.unreadable = true;
			continue;
		}
		const direct = gate.direct.find((d) => stage === `pkg:${d.package}`);
		if (direct) direct.status = typeof fields.status === "string" ? fields.status : "unknown";
		if (isPackageStage(stage) && fields.status === "running") gate.interrupted.push(stage);
		const raw = fields[START_BLOCK_FIELD];
		if (raw === undefined || raw === null) continue;
		const block = typeof raw === "object" ? (raw as Record<string, unknown>) : {};
		const name = typeof block.package === "string" && block.package !== "" ? block.package : stage.startsWith("team-pkg:") ? stage.slice("team-pkg:".length) : stage;
		gate.blocks.push({ stage, package: name, sentence: typeof block.sentence === "string" ? block.sentence : "" });
	}
	return gate;
}

/** The stage records that carry a start block. Empty when the file is missing, unreadable, or has none. */
export const packageBlocks = (layout: Layout): PackageBlock[] => readStartGate(layout).blocks;

export interface Installed {
	current: CurrentTools;
	node: string;
	herdr: string;
	sbCli: string;
}

export interface InstallProblem {
	/** What is missing, as a path or a state name; shown in the failure's reason. */
	missing: string[];
}

const REQUIRED_TOOLS = ["node", "git", "herdr"] as const;

/** The active tool versions of `state/current.json`, or null when the file is missing or does not parse. */
function readVersions(layout: Layout): Record<string, string> | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(layout.state, "current.json"), "utf8"));
		const versions = typeof parsed === "object" && parsed !== null ? (parsed as { versions?: unknown }).versions : undefined;
		if (typeof versions !== "object" || versions === null) return null;
		return Object.fromEntries(Object.entries(versions).filter((e): e is [string, string] => typeof e[1] === "string"));
	} catch {
		return null;
	}
}

/** The install a start needs: the active versions of Node, Git and Herdr, their programs, and pi-straw-boss's CLI. Reports every piece that is missing. */
export function readInstalled(layout: Layout): Installed | InstallProblem {
	const versions = readVersions(layout);
	const missing: string[] = [];
	if (versions === null) return { missing: ["state/current.json"] };
	for (const tool of REQUIRED_TOOLS) if (versions[tool] === undefined) missing.push(`${tool} (not active in state/current.json)`);
	if (missing.length > 0) return { missing };
	const current: CurrentTools = { node: versions.node as string, git: versions.git as string, herdr: versions.herdr as string, ...(versions.gh ? { gh: versions.gh } : {}), ...(versions.glab ? { glab: versions.glab } : {}) };
	const node = nodeBinaryPath(layout, current.node);
	const herdr = herdrBinary(layout, current);
	const sbCli = join(agentPackageDir(layout, "pi-straw-boss"), "dist", "server", "cli.mjs");
	for (const file of [node, herdr, sbCli]) if (!existsSync(file)) missing.push(file);
	return missing.length > 0 ? { missing } : { current, node: node, herdr, sbCli };
}

export const isInstalled = (found: Installed | InstallProblem): found is Installed => "current" in found;
