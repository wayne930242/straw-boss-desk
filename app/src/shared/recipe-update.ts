import type { ProjectsView } from "./projects.ts";

// What settings' Team recipe card is told by main and may ask for (spec: Settings, Team recipe; team-profile section 5, Delivery and updates). Plain data, so it crosses the IPC boundary and the
// renderer imports only this file. Main sends phases, reasons and values; the page words them from the catalog.

export type RecipeChange =
	| { kind: "name"; from: string; to: string }
	| { kind: "version"; from: string; to: string }
	| { kind: "forge-added" | "forge-removed"; forge: "github" | "gitlab"; host: string }
	| { kind: "repo-added"; folder: string; host: string; label: string; defaultBranch: string | null }
	| { kind: "repo-removed"; folder: string }
	| { kind: "repo-branch"; folder: string; from: string | null; to: string | null }
	| { kind: "repo-url"; folder: string; host: string }
	| { kind: "repo-label"; folder: string; from: string; to: string }
	| { kind: "relay"; from: string | null; to: string | null }
	| { kind: "linear"; to: boolean }
	| { kind: "tool-added"; name: string; version: string | null }
	| { kind: "tool-removed"; name: string }
	| { kind: "profile"; from: string | null; to: string | null }
	| { kind: "package-added"; name: string; version: string }
	| { kind: "package-removed"; name: string }
	| { kind: "package-changed"; name: string; from: string; to: string }
	/** The new text in full (the agent reads all of it); null when the update removes the team's instructions. */
	| { kind: "instructions"; text: string | null }
	| { kind: "update-host"; from: string | null; to: string | null };

/** Where the active recipe came from: a file the PM opened, or the address of an update. */
export type RecipeSource = { kind: "file"; fileName: string } | { kind: "url"; host: string };

export interface ActiveRecipeView {
	id: string;
	name: string;
	version: string;
	source: RecipeSource;
	/** The host a daily check asks, or null when the recipe has no `updateUrl`. */
	updateHost: string | null;
}

/** Why an offered recipe was not taken. The page words each. */
export type RecipeRefusalReason =
	/** The fetch was refused by one of its rules (`fetch`), or the file the PM chose could not be read. */
	| "fetch"
	| "invalid"
	/** The id is not the active recipe's (an update must keep it). */
	| "other-id"
	/** The version is not above the active one. */
	| "not-newer"
	| "unreadable";

export type FetchReason = "scheme" | "credentials" | "host" | "redirects" | "too-large" | "status" | "network";

export type RecipeCardState =
	/** Nothing newer is offered. `checkedAt` is the last check that finished, or null. */
	| { phase: "idle"; checkedAt: string | null }
	| { phase: "checking" }
	/** A newer version of this recipe, or another recipe the PM opened (`replaces`), with what changes item by item. */
	| { phase: "offered"; origin: "url" | "file"; id: string; name: string; version: string; replaces: boolean; changes: RecipeChange[]; sha256: string }
	| { phase: "applying"; step: "recipe" | "install" | "projects" }
	| { phase: "applied"; version: string; at: string }
	/** The PM kept the old one; `version` is the one kept out, which is not offered again. */
	| { phase: "kept"; version: string }
	| { phase: "refused"; reason: RecipeRefusalReason; fetch?: FetchReason; status?: number; fields?: Array<{ field: string; rule: string }>; version?: string }
	/** The install step of the update failed in `stage`; the old recipe is back. */
	| { phase: "failed"; stage: string; category: string; restored: boolean; at: string }
	| { phase: "error"; kind: "busy" | "other"; detail: string };

export interface RecipeCardView {
	active: ActiveRecipeView | null;
	state: RecipeCardState;
	projects: ProjectsView;
	/** The wizard is over and the card may act. */
	enabled: boolean;
}

export type RecipeAction =
	| { type: "recipe-check" }
	| { type: "recipe-apply" }
	| { type: "recipe-keep" }
	| { type: "recipe-replace" }
	| { type: "project-retry"; folder: string };

const TYPES: readonly string[] = ["recipe-check", "recipe-apply", "recipe-keep", "recipe-replace", "project-retry"];

export const isRecipeAction = (value: unknown): value is RecipeAction => {
	if (typeof value !== "object" || value === null) return false;
	const type = (value as { type?: unknown }).type;
	if (typeof type !== "string" || !TYPES.includes(type)) return false;
	return type !== "project-retry" || typeof (value as { folder?: unknown }).folder === "string";
};
