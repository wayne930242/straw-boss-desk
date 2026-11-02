// The pure rules of **Window and page security** (spec: Runtime supervisor): which links the GUI view may hand to the default browser, which permission the GUI origin gets, and which
// frame may call the app. The Electron wiring is in `desk-window.ts`; everything that decides is here, so a unit test calls the rules and the e2e test checks only the wiring.

/** The preview links of the CTO's ask (`pm-dev` serves the preview on 8080 to 8100). The range is fixed, not a recipe setting (spec: Decisions, Preview links). */
export const PREVIEW_PORT_MIN = 8080;
export const PREVIEW_PORT_MAX = 8100;

/** The parsed host names a preview link may have. `URL` keeps an IPv6 host in brackets and does not strip a trailing dot, so `localhost.` is not here. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type ExternalRefusal = "not-a-url" | "scheme" | "credentials" | "host" | "port" | "gui-origin";

export type ExternalDecision = { open: true; href: string } | { open: false; reason: ExternalRefusal };

/**
 * Whether a link from the GUI view opens in the default browser, and the parsed `href` to hand to `shell.openExternal`. Opens: an `https:` URL, and a preview link: an `http:` URL
 * whose parsed host is exactly `localhost`, `127.0.0.1` or `[::1]`, on an explicit port from 8080 to 8100. Refused: any URL with a user name or password, any other scheme, any other
 * `http:` host, no port or a port outside the range, and the GUI's own listener (`guiPort`) on any of the three loopback hosts, even when its port lies in the range. The port is
 * compared on all three hosts, not one origin string, so `http://localhost:<gui port>/` is the GUI as well (FE2R-F006).
 */
export function externalLink(raw: string, guiPort: number | null): ExternalDecision {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { open: false, reason: "not-a-url" };
	}
	if (url.username !== "" || url.password !== "") return { open: false, reason: "credentials" };
	if (url.protocol === "https:") return { open: true, href: url.href };
	if (url.protocol !== "http:") return { open: false, reason: "scheme" };
	if (!LOOPBACK_HOSTS.has(url.hostname)) return { open: false, reason: "host" };
	const port = url.port === "" ? NaN : Number(url.port);
	if (!(port >= PREVIEW_PORT_MIN && port <= PREVIEW_PORT_MAX)) return { open: false, reason: "port" };
	if (guiPort !== null && port === guiPort) return { open: false, reason: "gui-origin" };
	return { open: true, href: url.href };
}

/** The GUI's origin for an address, or null when it is not an `http:` URL on 127.0.0.1. */
export function guiOriginOf(address: string): string | null {
	try {
		const url = new URL(address);
		return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "" ? url.origin : null;
	} catch {
		return null;
	}
}

/** The GUI listener's port for an address, or null. */
export function guiPortOf(address: string | null): number | null {
	if (address === null) return null;
	try {
		const port = new URL(address).port;
		return port === "" ? null : Number(port);
	} catch {
		return null;
	}
}

/** True when `url` belongs to the GUI's origin (`will-navigate` stays there). */
export function isGuiUrl(url: string, guiOrigin: string | null): boolean {
	if (guiOrigin === null) return false;
	try {
		return new URL(url).origin === guiOrigin;
	} catch {
		return false;
	}
}

/**
 * Whether a permission request or check is granted: the camera (Straw Link's QR join) for the GUI origin only, and nothing else for anybody. A request that also asks for the
 * microphone, or for a media type the page did not name, is refused.
 */
export function permissionAllowed(permission: string, requestingUrl: string, mediaTypes: readonly string[] | undefined, guiOrigin: string | null): boolean {
	if (permission !== "media" || !isGuiUrl(requestingUrl, guiOrigin)) return false;
	return mediaTypes !== undefined && mediaTypes.length > 0 && mediaTypes.every((t) => t === "video");
}

/** The title the page asked for, cut to a line a dialog can show; empty becomes undefined. */
export function dialogTitle(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	// eslint-disable-next-line no-control-regex
	const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
	return cleaned === "" ? undefined : cleaned;
}
