// The e2e suites on the hosted Windows runner claim that pi-straw-boss 0.53.0 starts under a full administrator token (spec: seam U12, Open for the boss item 14). That claim is true
// only while the runner's token is elevated, so each suite asserts it first (S53-F004): the test's own token carries the High Mandatory Level label, which a UAC-filtered
// administrator token (Medium) does not. It reads the test process's own token with `whoami /groups`; no process list, no command line.
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** The mandatory label of an elevated process (High Mandatory Level). */
export const HIGH_MANDATORY_SID = "S-1-16-12288";
/** BUILTIN\Administrators. */
export const ADMINISTRATORS_SID = "S-1-5-32-544";

/** The SIDs in the output of `whoami /groups /fo csv /nh` (name, type, SID, attributes), whatever the language of the names. */
export function groupSids(csv: string): string[] {
	const sids: string[] = [];
	for (const line of csv.split(/\r?\n/)) {
		const m = /^"(?:[^"]*)","(?:[^"]*)","(S-\d+(?:-\d+)+)"/.exec(line.trim());
		if (m?.[1] !== undefined) sids.push(m[1]);
	}
	return sids;
}

/** True when the token carries the High Mandatory Level label and the Administrators group: a full administrator token. */
export const isElevatedToken = (csv: string): boolean => {
	const sids = groupSids(csv);
	return sids.includes(HIGH_MANDATORY_SID) && sids.includes(ADMINISTRATORS_SID);
};

/** Reads this process's token groups. Windows only. */
export function readTokenGroups(): string {
	const whoami = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe");
	return execFileSync(whoami, ["/groups", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
}

/**
 * On Windows, throws unless this process holds an elevated token; logs the result once. The suites call it from their `before` hook on a hosted runner, so a runner image that stops
 * running as an elevated administrator fails the run instead of silently leaving the elevated-start claim unproven.
 */
export function assertElevatedRunner(log: (line: string) => void = console.log): void {
	if (process.platform !== "win32") return;
	const csv = readTokenGroups();
	const elevated = isElevatedToken(csv);
	log(`elevation: the test's token is ${elevated ? "elevated" : "NOT elevated"} (${groupSids(csv).filter((s) => s === HIGH_MANDATORY_SID || s === ADMINISTRATORS_SID).join(", ") || "no High label or Administrators SID"})`);
	if (!elevated) throw new Error("the hosted Windows runner's token is not elevated (no High Mandatory Level label with the Administrators group): the elevated-start proof of seam U12 does not hold");
}
