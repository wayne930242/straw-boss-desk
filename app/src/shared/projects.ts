// What the projects step and the Team recipe card are told about the repositories of a recipe (spec: First run, step 10; Projects: the default branch; Projects: symlinks in a repository
// (Windows)). Plain data, so it crosses the IPC boundary and the renderer imports only this file. Main sends phases, causes and values; the pages word them from the catalog.

/** What a row is doing while it works. `queued`: it waits for the install or update that has the tools folder to end (the supervisor's queue). */
export type ProjectStep = "queued" | "cloning" | "fetching" | "head" | "links" | "opening";

/** Why a row ended failed. The page words each; none carries a value beyond the repository's folder and the branch the recipe names. */
export type ProjectFailure =
	/** The recipe names the home base's folder (a recipe the validator refused would not get here; a hand-edited file might). */
	| { kind: "reserved-folder" }
	/** The folder exists and its `origin` is another address, or it has none. Nothing was touched. */
	| { kind: "other-origin" }
	/** The folder exists, is not a repository, and is not empty. Nothing was touched. */
	| { kind: "not-empty" }
	/** `git clone` or `git fetch` failed: the code host did not answer, did not accept the sign-in, or has no such repository. */
	| { kind: "clone"; cause: "network" | "auth" | "not-found" | "other" }
	/** The code host does not resolve or does not answer before the copy starts: it may be reachable only on the company network (spec: Network, A private code host). */
	| { kind: "clone"; cause: "network-private"; host: string }
	/** `origin` has no branch of that name. */
	| { kind: "branch-missing"; branch: string }
	/** Another Git step failed (`git remote set-head`, the listing of links, the read of `origin`). */
	| { kind: "git"; step: "head" | "links" | "origin" }
	/** The GUI would not open the folder as a base. */
	| { kind: "open"; cause: "settings-unsafe" | "not-allowed" | "gui-unavailable" | "busy" | "refused" | "timeout" }
	/** The app quit while the row worked; nothing says how far it got. */
	| { kind: "interrupted" };

export interface ProjectLinks {
	/** The paths (`.agents/skills`), at most ten, sorted. */
	paths: string[];
	/** How many more there are. */
	more: number;
}

export interface ProjectRow {
	/** The folder under the work folder, which is also the row's identity. */
	folder: string;
	label: string;
	host: string;
	defaultBranch: string | null;
	phase: "waiting" | "working" | "trust" | "done" | "failed";
	/** While `phase` is `working`. */
	step: ProjectStep | null;
	/** Done: the folder was there already (with the same `origin`) and was fetched, not cloned. */
	reused: boolean;
	/** Done: the folder is open as a base. A head-only run of an update leaves it as it was. */
	opened: boolean;
	/** Windows: the index entries of mode 120000 under `.agents`, `.pi` and `.claude`; null where the check does not run or found none. */
	links: ProjectLinks | null;
	failure: ProjectFailure | null;
	/** The first line of the failing program's own words, redacted, for **Details**; empty when there is none. */
	detail: string;
}

export interface ProjectsView {
	rows: ProjectRow[];
	/** A row is cloning, fetching, setting the head, listing links or opening. A row that waits on the PM's trust answer is not running work. */
	running: boolean;
	/** A row waits on the PM's answer to a project trust question in the GUI. The rows behind it wait for that answer, so the step may go on without them. */
	held: boolean;
}

export type ProjectAction = { type: "project-retry"; folder: string };

export const isProjectAction = (value: unknown): value is ProjectAction =>
	typeof value === "object" && value !== null && (value as { type?: unknown }).type === "project-retry" && typeof (value as { folder?: unknown }).folder === "string";
