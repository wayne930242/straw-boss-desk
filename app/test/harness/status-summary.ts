// What the e2e may print of `cli.mjs status`: its JSON holds the GUI's address and token (`gui.token`, `gui.url`), and a CI log is public, so only the named fields and the key names are logged (T9-F005).
export function statusSummary(stdout: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return "(the status output is not JSON)";
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "(the status output is not an object)";
	const status = parsed as Record<string, unknown>;
	const shown: Record<string, unknown> = {};
	for (const key of ["state", "primary", "desk", "version"]) if (typeof status[key] === "string" || typeof status[key] === "boolean" || typeof status[key] === "number") shown[key] = status[key];
	return `${JSON.stringify(shown)} (fields: ${Object.keys(status).join(", ")})`;
}
