// Test code only; never shipped. The helpers of the trust-under-auto-mode check in `follow.e2e.ts` (desk #54, spec: Build note "the trust question of a base the desk opens, under auto mode"):
// a project folder that makes pi ask its trust question, and what a pane's screen and the server's return list say of it. All of it reads published surfaces: the pane's screen through
// `herdr pane read`, and the GUI's `POST /api/auto/report` (pi-straw-boss `src/server/autoops.ts`, `src/control.ts`).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Words of pi's own interactive screen (pi 1.4.0 `interactive-mode.js`, `renderProjectTrustWarningIfNeeded`): printed in a session whose project was not trusted. */
export const NOT_TRUSTED_WARNING = "This project is not trusted";
/** The question pi draws (`project-trust.js`) and that pi-straw-boss's relay prints in the pane while the GUI asks (`src/trust/ask.ts`). */
export const TRUST_QUESTION = "Trust project folder?";
export const RELAYED_TO_GUI = "The question is in the Straw Boss window";

/** A pane's screen as one line of printable text: wrapped lines joined, every run of white space one space, anything outside ASCII a `?`. */
export const flatScreen = (screen: string): string => screen.replace(/[^\x20-\x7e\r\n\t]/g, "?").replace(/\s+/g, " ").trim();

export const screenShows = (screen: string, words: string): boolean => flatScreen(screen).includes(words);

/**
 * A folder with something pi gates behind trust: `.pi/settings.json` (pi 1.4.0 `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES`), empty so it changes nothing else. A README keeps it an
 * ordinary project folder.
 */
export function plantProject(dir: string): void {
	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(join(dir, "README.md"), "# trust e2e\n");
	writeFileSync(join(dir, ".pi", "settings.json"), "{}\n");
}

export interface TrustNote {
	session: string;
	count: number;
	gist: string;
}

/**
 * The `trust` lines of an auto-mode return list (`POST /api/auto/report`: `{report: {lines: [{session, tool, kind, count, first, gist}]}}`): one per session that auto mode answered "not
 * trusted for this session". Anything else, a missing report included, is no line.
 */
export function trustNotes(body: unknown): TrustNote[] {
	const lines = (body as { report?: { lines?: unknown } } | null | undefined)?.report?.lines;
	if (!Array.isArray(lines)) return [];
	return lines.flatMap((line: unknown) => {
		const l = line as { kind?: unknown; session?: unknown; count?: unknown; gist?: unknown } | null;
		if (l?.kind !== "trust") return [];
		return [{ session: String(l.session ?? ""), count: typeof l.count === "number" ? l.count : 1, gist: String(l.gist ?? "") }];
	});
}

/** How many times auto mode answered "not trusted" in the period. */
export const trustAnswers = (body: unknown): number => trustNotes(body).reduce((n, line) => n + line.count, 0);

/** Milliseconds as seconds with one decimal, for the CI log. */
export const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
