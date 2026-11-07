import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../bootstrap/fsutil.ts";
import type { Layout } from "../paths.ts";
import type { ProjectRow } from "../../shared/projects.ts";

// `state/projects.json` (spec: App data layout): what the projects step did for each repository of the active recipe, so a quit in the middle resumes where it was, a repository that is open as a
// base is not opened twice, and settings' Team recipe shows the rows after a restart. No secret: folders, labels, hosts and the words of the outcome.

export interface StoredRow extends ProjectRow {
	/** The address the recipe named when the row ran: a recipe that changes it runs the row again. */
	url: string;
	/** The opening id of an open that has not ended well: a run after a relaunch asks under it, so the server finds the workspace the first try made (CIN-F003). Never on an opened row. */
	openId?: string;
}

export interface ProjectRecord {
	schema: 1;
	/** The work folder the rows were made for. A different one starts over. */
	workFolder: string;
	rows: StoredRow[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const PHASES: readonly string[] = ["waiting", "working", "trust", "done", "failed"];

function rowOf(value: unknown): StoredRow | null {
	if (!isObject(value) || typeof value.folder !== "string" || typeof value.url !== "string" || typeof value.label !== "string" || typeof value.host !== "string") return null;
	if (typeof value.phase !== "string" || !PHASES.includes(value.phase)) return null;
	const links = isObject(value.links) && Array.isArray(value.links.paths) ? { paths: value.links.paths.filter((p): p is string => typeof p === "string").slice(0, 10), more: typeof value.links.more === "number" ? value.links.more : 0 } : null;
	const failure = isObject(value.failure) && typeof value.failure.kind === "string" ? (value.failure as unknown as ProjectRow["failure"]) : null;
	// A row that was working when the app stopped is not known to have finished: it reads as interrupted, and the next run does it again.
	const interrupted = value.phase === "working" || value.phase === "waiting" || value.phase === "trust";
	return {
		folder: value.folder,
		url: value.url,
		label: value.label,
		host: value.host,
		defaultBranch: typeof value.defaultBranch === "string" ? value.defaultBranch : null,
		phase: interrupted ? "failed" : (value.phase as ProjectRow["phase"]),
		step: null,
		reused: value.reused === true,
		// A base that was being opened may or may not exist: only a row that finished says it is open.
		opened: value.opened === true && !interrupted,
		...(typeof value.openId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value.openId) && !(value.opened === true && !interrupted) ? { openId: value.openId } : {}),
		...(value.delivery === "unknown" || value.delivery === "not_sent" ? { delivery: value.delivery } : {}),
		links,
		failure: interrupted ? { kind: "interrupted" } : failure,
		detail: typeof value.detail === "string" ? value.detail.slice(0, 300) : "",
	};
}

export class ProjectRecordStore {
	readonly #file: string;

	constructor(layout: Pick<Layout, "state">) {
		this.#file = join(layout.state, "projects.json");
	}

	read(): ProjectRecord | null {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.#file, "utf8"));
		} catch {
			return null;
		}
		if (!isObject(parsed) || parsed.schema !== 1 || typeof parsed.workFolder !== "string" || !Array.isArray(parsed.rows)) return null;
		return { schema: 1, workFolder: parsed.workFolder, rows: parsed.rows.map(rowOf).filter((r): r is StoredRow => r !== null) };
	}

	write(record: ProjectRecord): void {
		mkdirSync(dirname(this.#file), { recursive: true });
		writeFileAtomic(this.#file, `${JSON.stringify(record, null, 2)}\n`);
	}
}
