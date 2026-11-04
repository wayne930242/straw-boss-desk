import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../bootstrap/fsutil.ts";
import type { Layout } from "../paths.ts";
import type { StoreEntry } from "../platform/types.ts";

// Existing sign-ins and Ownership (spec: The code-host screens; boss decision K1, 2026-11-01). gh and glab name their store entries by host alone, whatever their configuration folder says, so
// the app's login would replace the PM's own token for that host and its logout would delete it. The app therefore owns a store entry only while the entry's name and account are in
// `state/accounts.json` and its current modification time equals the one recorded right after the app's own login. A write by anyone else changes that time (macOS `mdat`, Windows `LastWritten`),
// so a changed, missing, or unreadable time means foreign. Nothing here reads a secret, and the record holds none.

export type ForgeKind = "github" | "gitlab";

/** The service names a host's sign-in uses in the store: gh `gh:<host>` (one item per account, and an empty-account one) and `gh:_refreshable:<host>`; glab `glab:<host>:token` and the legacy `glab:<host>`. */
export function entryNames(kind: ForgeKind, host: string): string[] {
	return kind === "github" ? [`gh:${host}`, `gh:_refreshable:${host}`] : [`glab:${host}:token`, `glab:${host}`];
}

/** An entry the app made and still owns, with the modification time it read right after its login. */
export interface RecordedEntry {
	name: string;
	account: string;
	host: string;
	kind: ForgeKind;
	modified: string;
}

/** An entry the app made and then lost to a write by something else: kept by name only, never owned again. */
export interface LeftEntry {
	name: string;
	account: string;
	host: string;
	kind: ForgeKind;
}

export interface AccountsRecord {
	schema: 1;
	entries: RecordedEntry[];
	left: LeftEntry[];
}

export const EMPTY_RECORD: AccountsRecord = { schema: 1, entries: [], left: [] };

const keyOf = (e: { name: string; account: string }): string => JSON.stringify([e.name, e.account]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v !== "";

function recordedOf(v: unknown): RecordedEntry | null {
	if (!isObject(v) || !text(v.name) || typeof v.account !== "string" || !text(v.host) || (v.kind !== "github" && v.kind !== "gitlab") || !text(v.modified)) return null;
	return { name: v.name, account: v.account, host: v.host, kind: v.kind, modified: v.modified };
}

function leftOf(v: unknown): LeftEntry | null {
	if (!isObject(v) || !text(v.name) || typeof v.account !== "string" || !text(v.host) || (v.kind !== "github" && v.kind !== "gitlab")) return null;
	return { name: v.name, account: v.account, host: v.host, kind: v.kind };
}

/** The record in `raw`. A record that does not parse, or whose entries are malformed, owns nothing: an entry the app cannot prove is its own is foreign, which is the safe direction. */
export function parseAccountsRecord(raw: string): AccountsRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ...EMPTY_RECORD, entries: [], left: [] };
	}
	if (!isObject(parsed) || parsed.schema !== 1) return { ...EMPTY_RECORD, entries: [], left: [] };
	return {
		schema: 1,
		entries: (Array.isArray(parsed.entries) ? parsed.entries : []).map(recordedOf).filter((e): e is RecordedEntry => e !== null),
		left: (Array.isArray(parsed.left) ? parsed.left : []).map(leftOf).filter((e): e is LeftEntry => e !== null),
	};
}

const fileOf = (layout: Pick<Layout, "state">): string => join(layout.state, "accounts.json");

export function readAccountsRecord(layout: Pick<Layout, "state">): AccountsRecord {
	try {
		return parseAccountsRecord(readFileSync(fileOf(layout), "utf8"));
	} catch {
		return { ...EMPTY_RECORD, entries: [], left: [] };
	}
}

export function writeAccountsRecord(layout: Pick<Layout, "state">, record: AccountsRecord): void {
	writeFileAtomic(fileOf(layout), `${JSON.stringify(record, null, "\t")}\n`);
}

// ---- ownership ------------------------------------------------------------------------------------------------------------

export interface Classified {
	/** Entries the app owns: recorded, with a readable time equal to the recorded one. */
	owned: StoreEntry[];
	/** Everything else that was listed. */
	foreign: StoreEntry[];
	/** The foreign entries the app made itself: recorded under this name with another time, or already marked `left`. */
	changed: StoreEntry[];
}

/**
 * Splits a listing by ownership. A recorded name with another time, a recorded name whose time cannot be read (`modified` empty), an unrecorded name, and a `left` name whose time matches again are all
 * foreign: an empty time never matches, and a `left` entry never counts as owned again.
 */
export function classify(listed: readonly StoreEntry[], record: AccountsRecord): Classified {
	const recorded = new Map(record.entries.map((e) => [keyOf(e), e]));
	const left = new Set(record.left.map(keyOf));
	const out: Classified = { owned: [], foreign: [], changed: [] };
	for (const entry of listed) {
		const key = keyOf(entry);
		const mine = recorded.get(key);
		if (mine !== undefined && !left.has(key) && entry.modified !== "" && mine.modified !== "" && entry.modified === mine.modified) {
			out.owned.push(entry);
			continue;
		}
		out.foreign.push(entry);
		if (mine !== undefined || left.has(key)) out.changed.push(entry);
	}
	return out;
}

/**
 * The record after looking at the host's current listing: an owned entry that turned foreign moves to `left`; a recorded or `left` entry that the listing no longer finds is dropped (the PM removed it).
 * Entries of other hosts and kinds are untouched. `changed` lists what moved to `left` now.
 */
export function reconcile(record: AccountsRecord, listed: readonly StoreEntry[], kind: ForgeKind, host: string): { record: AccountsRecord; movedToLeft: RecordedEntry[]; changed: boolean } {
	const present = new Set(listed.map(keyOf));
	const split = classify(listed, record);
	const ownedNow = new Set(split.owned.map(keyOf));
	const mine = (e: { kind: ForgeKind; host: string }): boolean => e.kind === kind && e.host === host;
	const entries: RecordedEntry[] = [];
	const left: LeftEntry[] = record.left.filter((e) => !mine(e) || present.has(keyOf(e)));
	const movedToLeft: RecordedEntry[] = [];
	for (const e of record.entries) {
		if (!mine(e)) entries.push(e);
		else if (ownedNow.has(keyOf(e))) entries.push(e);
		else if (present.has(keyOf(e))) {
			movedToLeft.push(e);
			if (!left.some((l) => keyOf(l) === keyOf(e))) left.push({ name: e.name, account: e.account, host: e.host, kind: e.kind });
		}
		// else: gone from the store, so gone from the record.
	}
	const next: AccountsRecord = { schema: 1, entries, left };
	return { record: next, movedToLeft, changed: JSON.stringify(next) !== JSON.stringify(record) };
}

/**
 * The record after a login that passed: for the host, every entry listed now that was not there before the login, or that the app owned before it (a **Sign in again**), with the time just read.
 * An entry with no readable time is not recorded (it stays foreign). The host's earlier entries and `left` entries are replaced.
 */
export function recordLogin(record: AccountsRecord, input: { kind: ForgeKind; host: string; before: readonly StoreEntry[]; after: readonly StoreEntry[] }): AccountsRecord {
	const { kind, host, before, after } = input;
	const wasThere = new Set(before.map(keyOf));
	const wasOwned = new Set(classify(before, record).owned.map(keyOf));
	const mine = (e: { kind: ForgeKind; host: string }): boolean => e.kind === kind && e.host === host;
	const created: RecordedEntry[] = after
		.filter((e) => e.modified !== "" && (!wasThere.has(keyOf(e)) || wasOwned.has(keyOf(e))))
		.map((e) => ({ name: e.name, account: e.account, host, kind, modified: e.modified }));
	return { schema: 1, entries: [...record.entries.filter((e) => !mine(e)), ...created], left: record.left.filter((e) => !mine(e)) };
}

/** The record without the host's entries and `left` entries (its logout ran, or the PM removed them). */
export function dropHost(record: AccountsRecord, kind: ForgeKind, host: string): AccountsRecord {
	const mine = (e: { kind: ForgeKind; host: string }): boolean => e.kind === kind && e.host === host;
	return { schema: 1, entries: record.entries.filter((e) => !mine(e)), left: record.left.filter((e) => !mine(e)) };
}

/** Marks every owned entry of the host `left` (its sign-out found a foreign entry beside them, so no logout ran). */
export function markHostLeft(record: AccountsRecord, kind: ForgeKind, host: string): { record: AccountsRecord; left: LeftEntry[] } {
	const mine = (e: { kind: ForgeKind; host: string }): boolean => e.kind === kind && e.host === host;
	const moved: LeftEntry[] = record.entries.filter(mine).map((e) => ({ name: e.name, account: e.account, host: e.host, kind: e.kind }));
	const left = [...record.left];
	for (const m of moved) if (!left.some((l) => keyOf(l) === keyOf(m))) left.push(m);
	return { record: { schema: 1, entries: record.entries.filter((e) => !mine(e)), left }, left: moved };
}

/**
 * The state a forge's row shows, from the record and the host's current listing (already reconciled). An entry the app lost to a write by something else shows first (`left`); then the app's own
 * sign-in; then a foreign one it only found.
 */
export function stateOf(record: AccountsRecord, listed: readonly StoreEntry[], kind: ForgeKind, host: string): "signed-in" | "not-signed-in" | "foreign" | "left" {
	const mine = (e: { kind: ForgeKind; host: string }): boolean => e.kind === kind && e.host === host;
	const split = classify(listed, record);
	const leftKeys = new Set(record.left.filter(mine).map(keyOf));
	if (listed.some((e) => leftKeys.has(keyOf(e)))) return "left";
	if (split.owned.length > 0 && record.entries.some(mine)) return "signed-in";
	if (split.foreign.length > 0) return "foreign";
	return "not-signed-in";
}
