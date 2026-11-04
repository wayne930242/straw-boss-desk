import type { CredentialStore, StoreEntry } from "../platform/types.ts";
import { entryNames, type ForgeKind } from "./existing.ts";

// The store probe and the listing (spec: The code-host screens, **Before either sign-in**). Both ask the `CredentialStore` of the platform layer; this module only turns their failures into the
// answers the screens need. A probe that fails, times out, or throws, and a listing that fails for any reason, all mean the same thing: the store is not available, so the step stops before
// the PM makes a token ("it would have to keep your token as plain text"). An empty listing means no entry; a failed one never does.

export type StoreCheck = { ok: true } | { ok: false; detail: string };

const firstLine = (text: string): string => text.trim().split(/\r?\n/)[0]?.slice(0, 300) ?? "";

/** Writes, reads back, and deletes a throwaway entry. The platform's probe has 10 s per command on macOS, so a locked keychain's dialog is answered or ends here as a failed probe. */
export async function probeStore(store: CredentialStore): Promise<StoreCheck> {
	try {
		const result = await store.probe();
		return result.ok ? { ok: true } : { ok: false, detail: firstLine(result.reason) };
	} catch (error) {
		return { ok: false, detail: firstLine((error as Error).message) };
	}
}

export type HostListing = { ok: true; entries: StoreEntry[] } | { ok: false; detail: string };

/** The host's entries in the store by their names, accounts and times. A failure is `ok: false`, not an empty list. */
export async function listHostEntries(store: CredentialStore, kind: ForgeKind, host: string): Promise<HostListing> {
	try {
		return { ok: true, entries: await store.list(entryNames(kind, host)) };
	} catch (error) {
		return { ok: false, detail: firstLine((error as Error).message) };
	}
}
