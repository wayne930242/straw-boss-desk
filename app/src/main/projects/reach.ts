import type { Fetch } from "../bootstrap/download.ts";
import { REACH_TIMEOUT_MS, reachHost } from "../bootstrap/stages/preflight.ts";

// The projects step asks again whether a repository's code host answers (spec: Network, A private code host; Stages, `preflight`: "the check runs again at the projects step"). The same HEAD request as the
// preflight's, so a host the preflight warned about is judged the same way here. A host that does not resolve or does not answer is `unreachable`; a certificate this computer does not trust is `tls`, which
// Git reports in its own words; any HTTP answer, whatever its status, is `ok`.

export type HostReach = "ok" | "tls" | "unreachable";

/** Asks `host` (a name, with a port when the address has one) with the app's network stack. */
export type HostProbe = (host: string, signal: AbortSignal) => Promise<HostReach>;

export function hostProbe(fetch: Fetch, timeoutMs: number = REACH_TIMEOUT_MS): HostProbe {
	return async (host, signal) => {
		const found = await reachHost(fetch, host, timeoutMs, signal);
		if (found.kind === "ok") return "ok";
		return found.kind === "tls" ? "tls" : "unreachable";
	};
}
