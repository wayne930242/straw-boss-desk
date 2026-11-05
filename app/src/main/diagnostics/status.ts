import type { StatusFields } from "../../shared/computer.ts";

// What Diagnostics shows of `cli.mjs status` (spec: Settings, Diagnostics). The JSON holds the page's address and its token (`gui.url`, `gui.token`) and the server's control secret, so
// nothing is passed on but four named fields and the names of the others; a value that is not the expected kind is left out rather than shown.

/** The named fields of a status, or null when the output is not a JSON object. */
export function statusFields(stdout: string): StatusFields | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const status = parsed as Record<string, unknown>;
	const text = (key: string): string | null => {
		const value = status[key];
		// A short plain word or version: anything longer or shaped like an address is not shown.
		return typeof value === "string" && /^[\w.+-]{1,40}$/.test(value) ? value : null;
	};
	const flag = (key: string): boolean | null => (typeof status[key] === "boolean" ? status[key] : null);
	return { state: text("state"), primary: flag("primary"), desk: flag("desk"), version: text("version") ?? (typeof status.version === "number" ? String(status.version) : null), keys: Object.keys(status).filter((k) => /^[\w.-]{1,40}$/.test(k)).sort() };
}
