import { closeSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The token search (spec: Workflows step 4, followup R3-F003), ported from the kit's `spike/win/lib/token-scan.mjs`. It looks for a token's bytes in every file under some roots. Test code and
// diagnostics use it; the product never searches for a secret. Three forms are looked for: UTF-8, UTF-16LE, and go-keyring's stored form (`go-keyring-base64:` plus base64), which is what a leak
// through the `security -i` channel would carry. No size limit: files are read in 4 MB chunks. A path that cannot be read is tried once more and then listed with a reason. A link (symlink or
// junction) is not followed and is listed as unread with that reason, and so is a root that is missing or not a folder, so a search over a root that is not there cannot pass for a clean one.

const CHUNK = 4 * 1024 * 1024;

export interface Unread {
	path: string;
	reason: string;
}

export interface ScanResult {
	hits: string[];
	unread: Unread[];
	files: number;
	bytes: number;
}

export function needlesFor(token: string): Buffer[] {
	return [Buffer.from(token, "utf8"), Buffer.from(token, "utf16le"), Buffer.from(`go-keyring-base64:${Buffer.from(token, "utf8").toString("base64")}`, "utf8")];
}

interface Stats {
	files: number;
	bytes: number;
}

function fileHas(path: string, needles: readonly Buffer[], stats: Stats): boolean {
	const fd = openSync(path, "r");
	try {
		const max = Math.max(...needles.map((n) => n.length));
		const buf = Buffer.alloc(CHUNK + max);
		let carry = 0;
		for (;;) {
			const read = readSync(fd, buf, carry, CHUNK, null);
			if (read === 0) break;
			const len = carry + read;
			stats.bytes += read;
			const view = buf.subarray(0, len);
			if (needles.some((n) => view.includes(n))) {
				stats.files++;
				return true;
			}
			carry = Math.min(max - 1, len);
			buf.copy(buf, 0, len - carry, len);
		}
		stats.files++;
		return false;
	} finally {
		closeSync(fd);
	}
}

const why = (what: string, e: unknown): string => {
	const err = e as NodeJS.ErrnoException;
	return `${what}: ${err.code ?? err.name} ${String(err.message).replace(/\s+/g, " ")}`;
};

/** Scans `roots` for `token`. `skipDirs` are exact folder paths left out. */
export function scan(roots: readonly string[], token: string, { skipDirs = [] }: { skipDirs?: readonly string[] } = {}): ScanResult {
	const needles = needlesFor(token);
	const stats: Stats = { files: 0, bytes: 0 };
	const hits: string[] = [];
	const skipped: Unread[] = [];
	const dirs: string[] = [];
	for (const root of roots) {
		// A root that is missing, a file, or a link is a finding of its own: the search did not look where it was asked to.
		try {
			const st = lstatSync(root);
			if (st.isSymbolicLink()) skipped.push({ path: root, reason: "link: not followed (a symlink or junction)" });
			else if (st.isDirectory()) dirs.push(root);
			else skipped.push({ path: root, reason: "root is not a folder" });
		} catch (e) {
			skipped.push({ path: root, reason: why("root missing or unreadable", e) });
		}
	}
	while (dirs.length > 0) {
		const d = dirs.pop() as string;
		if (skipDirs.includes(d)) continue;
		let names;
		try {
			names = readdirSync(d, { withFileTypes: true });
		} catch (e) {
			skipped.push({ path: d, reason: why("list folder", e) });
			continue;
		}
		for (const ent of names) {
			const p = join(d, ent.name);
			let st;
			try {
				st = lstatSync(p);
			} catch (e) {
				skipped.push({ path: p, reason: why("open or read", e) });
				continue;
			}
			if (st.isSymbolicLink()) {
				skipped.push({ path: p, reason: "link: not followed (a symlink or junction)" });
				continue;
			}
			if (st.isDirectory()) dirs.push(p);
			else if (st.isFile()) {
				try {
					if (fileHas(p, needles, stats)) hits.push(p);
				} catch (e) {
					skipped.push({ path: p, reason: why("open or read", e) });
				}
			}
		}
	}
	// One more read of each unread file, for a file that was in use while a CLI ran; what reads now leaves the list.
	const unread: Unread[] = [];
	for (const u of skipped) {
		if (!u.reason.startsWith("open or read")) {
			unread.push(u);
			continue;
		}
		try {
			if (fileHas(u.path, needles, stats)) hits.push(u.path);
		} catch (e) {
			unread.push({ path: u.path, reason: why("open or read, again", e) });
		}
	}
	return { hits, unread, ...stats };
}

/** Replaces every known secret, and anything shaped like a token, in text bound for a log. */
export function hideSecrets(text: string, secrets: readonly string[] = []): string {
	let t = String(text ?? "");
	for (const s of secrets) if (s && s.length >= 6) t = t.split(s).join("<token>");
	return t.replace(/(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{10,}|gl[a-z]{2,4}-[A-Za-z0-9_-]{20,})/g, "<token>");
}

/** A root that lies inside another root is covered by it; scanning both would read its files twice. */
export function removeNestedRoots(roots: readonly string[], ci = process.platform === "win32"): string[] {
	const k = (x: string): string => (ci ? x.toLowerCase() : x);
	const seen = new Set<string>();
	const norm: string[] = [];
	for (const r of roots.filter(Boolean).map((x) => x.replace(/[\\/]+$/, ""))) {
		if (!seen.has(k(r))) {
			seen.add(k(r));
			norm.push(r);
		}
	}
	return norm.filter((r) => !norm.some((o) => k(o) !== k(r) && (k(r).startsWith(`${k(o)}/`) || k(r).startsWith(`${k(o)}\\`))));
}

/** Unread files split by whether they lie under a folder the spec names (an unread file there fails the search) or elsewhere (a warning). */
export function splitUnread(unread: readonly Unread[], strictRoots: readonly string[], ci = process.platform === "win32"): { strict: Unread[]; extra: Unread[] } {
	const k = (x: string): string => (ci ? x.toLowerCase() : x);
	const roots = strictRoots.filter(Boolean).map((r) => k(r.replace(/[\\/]+$/, "")));
	const strict: Unread[] = [];
	const extra: Unread[] = [];
	for (const u of unread) {
		const p = k(u.path);
		(roots.some((r) => p === r || p.startsWith(`${r}/`) || p.startsWith(`${r}\\`)) ? strict : extra).push(u);
	}
	return { strict, extra };
}
