import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { Layout } from "../paths.ts";
import { ZipWriter } from "./zip.ts";

// **Collect diagnostics** (spec: Logs and failures, the kit's `collect.ps1` rule): a zip of `logs/`, `state/` without `start.json`, `stack/active.json` and the profile manifest, with every text
// file passed through the redactor. The set is built by listing exactly those places, so the folders the spec names as never collected (`agent/`, `claude/`, `config/gh`, `config/glab-cli`,
// `secrets/`, `gitconfig`, and Chromium's `electron/`) are never opened, not opened and then filtered out. A link is never followed (a link in `logs/` that points into `secrets/` must not
// carry it in), and a file that is not text, or is larger than a log can be, is left out and counted.

/** A rotated log is at most 5 MB (spec: Logs and failures); a file larger than this is not a log of ours. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** The whole archive holds at most this much text before compression: ten rotations of every log fit; more means something is wrong and the collection stops. */
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export interface Redact {
	redact(text: string): string;
}

export interface CollectInput {
	layout: Layout;
	redactor: Redact;
	/** The zip to write. */
	file: string;
	/** Lines for `diagnostics.txt`: the app, its build, the platform. Never a secret. */
	facts: Readonly<Record<string, string>>;
	now?: () => Date;
}

export interface CollectResult {
	file: string;
	/** The archive names of the files it holds, `diagnostics.txt` included. */
	names: string[];
	/** The files left out, with the reason (never their content). */
	skipped: Array<{ name: string; reason: "binary" | "too-large" | "link" | "unreadable" }>;
}

/** The archive name of `state/start.json` in any case: Windows folds case, so `Start.JSON` is the same file. */
const isStartFile = (relative: string): boolean => relative.toLowerCase() === "start.json";

interface Source {
	/** The file on disk. */
	path: string;
	/** Its name in the archive. */
	name: string;
}

/** Every regular file under `dir` (not following links), as `prefix/relative` names; a link is returned as skipped. */
function walk(dir: string, prefix: string, keep: (relative: string) => boolean, skipped: CollectResult["skipped"], relative = ""): Source[] {
	let entries: string[];
	try {
		entries = readdirSync(join(dir, relative)).sort();
	} catch {
		return [];
	}
	const out: Source[] = [];
	for (const entry of entries) {
		const rel = relative === "" ? entry : posix.join(relative, entry);
		const path = join(dir, rel);
		let stat;
		try {
			stat = lstatSync(path);
		} catch {
			skipped.push({ name: posix.join(prefix, rel), reason: "unreadable" });
			continue;
		}
		if (stat.isSymbolicLink()) {
			skipped.push({ name: posix.join(prefix, rel), reason: "link" });
			continue;
		}
		if (stat.isDirectory()) {
			out.push(...walk(dir, prefix, keep, skipped, rel));
			continue;
		}
		if (!stat.isFile()) {
			skipped.push({ name: posix.join(prefix, rel), reason: "unreadable" });
			continue;
		}
		if (keep(rel)) out.push({ path, name: posix.join(prefix, rel) });
	}
	return out;
}

/** The places diagnostics come from: nothing outside this list is opened. */
export function diagnosticSources(layout: Layout, skipped: CollectResult["skipped"]): Source[] {
	const sources: Source[] = [];
	sources.push(...walk(layout.logs, "logs", () => true, skipped));
	sources.push(...walk(layout.state, "state", (rel) => !isStartFile(rel), skipped));
	for (const single of [
		{ path: join(layout.stack, "active.json"), name: "stack/active.json" },
		{ path: join(layout.agent, ".straw-boss-profile", "manifest.json"), name: "profile/manifest.json" },
	]) {
		try {
			const stat = lstatSync(single.path);
			if (stat.isSymbolicLink()) skipped.push({ name: single.name, reason: "link" });
			else if (stat.isFile()) sources.push(single);
		} catch {
			// not there: a root that never got that far
		}
	}
	return sources;
}

export function collectDiagnostics(input: CollectInput): CollectResult {
	const { layout, redactor } = input;
	const skipped: CollectResult["skipped"] = [];
	const sources = diagnosticSources(layout, skipped);
	const zip = new ZipWriter(input.file);
	const names: string[] = [];
	let total = 0;
	try {
		for (const source of sources) {
			let data: Buffer;
			try {
				if (lstatSync(source.path).size > MAX_FILE_BYTES) {
					skipped.push({ name: source.name, reason: "too-large" });
					continue;
				}
				data = readFileSync(source.path);
			} catch {
				skipped.push({ name: source.name, reason: "unreadable" });
				continue;
			}
			if (data.length > MAX_FILE_BYTES) {
				skipped.push({ name: source.name, reason: "too-large" });
				continue;
			}
			if (data.includes(0)) {
				skipped.push({ name: source.name, reason: "binary" });
				continue;
			}
			const text = Buffer.from(redactor.redact(data.toString("utf8")), "utf8");
			total += text.length;
			if (total > MAX_TOTAL_BYTES) throw new Error("the diagnostics are far larger than expected, so nothing was collected");
			zip.add({ name: source.name, data: text, mtime: input.now?.() ?? new Date() });
			names.push(source.name);
		}
		const header = Object.entries(input.facts).map(([key, value]) => `${key}: ${value}`);
		const left = skipped.map((s) => `  ${s.name} (${s.reason})`);
		const summary = [
			"Straw Boss Desk diagnostics",
			`collected: ${(input.now?.() ?? new Date()).toISOString()}`,
			...header,
			"",
			"This archive holds logs/, state/ (without start.json), stack/active.json and the profile manifest, with credential-shaped text masked.",
			"It never holds the agent, Claude, GitHub, GitLab or secrets folders, nor Chromium's profile.",
			...(left.length === 0 ? [] : ["", "Left out:", ...left]),
			"",
		].join("\n");
		zip.add({ name: "diagnostics.txt", data: Buffer.from(redactor.redact(summary), "utf8"), mtime: input.now?.() ?? new Date() });
		names.push("diagnostics.txt");
		zip.finish();
	} catch (error) {
		zip.abort();
		throw error;
	}
	return { file: input.file, names, skipped };
}
