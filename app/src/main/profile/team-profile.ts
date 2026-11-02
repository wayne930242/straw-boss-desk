import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, type Dirent } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

// The team-profile installer (port of the kit's `spike/win/lib/team-profile.mjs`; spec: Tasks 7, team-profile section 7). It copies the files of the
// profile package (AGENTS.md, rules/, config/) and the active recipe's additions into the pi agent folder without ever overwriting a file the PM changed,
// and records what it wrote in `<agent>/.straw-boss-profile/manifest.json`. The profile package's skills are not copied: pi loads them in place from the
// installed package (kit RUNBOOK, known deviation 1; a copy would collide with the package's own skill of the same name).
//
// Followups applied here (`~/.local/share/sbd-review/profile-stage/`): RC-F002 and P3R-F001 (`safeRel` refuses the names Windows rewrites or opens as
// devices), RC-F003 (`writeAtomic` creates its temp file with `wx` and looks for links again right before each write), RC-F004 (`use-team` switches only
// managed files, once each), RC-F005 and P3R-F002 (`neutralize` keeps recipe text from reshaping the Markdown around the team block), P3R-F003 (a
// deletion looks for links again right before it).
//
// What stays open (the same-user model: whoever can swap a folder for a link inside the agent folder can already replace the installed binaries, spec
// T4-F008): a parent folder swapped for a link in the instant between the last link check and the system call that follows it (Node has no `openat`), for a
// write, a rename, a delete, and for the reads of `use-team` (it checks that each file is regular, then reads it); and a `<target>.sbd-tmp-<hex>` file left
// beside the target when such a swap is undone before the rename.

const STATE_DIR = ".straw-boss-profile";
const MANIFEST = "manifest.json";

const sha256 = (buf: Buffer | string): string => createHash("sha256").update(buf).digest("hex");
const posix = (p: string): string => p.split(sep).join("/");
type Json = Record<string, unknown>;
const isPlain = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/** UTF-8, no BOM, LF line endings: what every managed file is written as. */
export function normalizeText(text: string): string {
	return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function walk(dir: string, base: string = dir): string[] {
	const out: string[] = [];
	const entries: Dirent[] = readdirSync(dir, { withFileTypes: true });
	for (const entry of entries.sort((a: Dirent, b: Dirent) => (a.name < b.name ? -1 : 1))) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full, base));
		else out.push(posix(relative(base, full)));
	}
	return out;
}

/** [path, value] pairs of an object's leaves; arrays and scalars are leaves. */
export function leaves(obj: Json, prefix: string[] = []): Array<[string[], unknown]> {
	const out: Array<[string[], unknown]> = [];
	for (const [k, v] of Object.entries(obj)) {
		if (isPlain(v) && Object.keys(v).length > 0) out.push(...leaves(v, [...prefix, k]));
		else out.push([[...prefix, k], v]);
	}
	return out;
}

/** What `lookup` found: the value, no such key, or a parent on the way that is not an object (the PM's own value, kept as it is). */
type Lookup = { kind: "found"; value: unknown } | { kind: "absent" } | { kind: "blocked" };

function lookup(obj: Json, path: readonly string[]): Lookup {
	let o: unknown = obj;
	for (const k of path) {
		if (!isPlain(o)) return { kind: "blocked" };
		if (!Object.hasOwn(o, k)) return { kind: "absent" };
		o = o[k];
	}
	return { kind: "found", value: o };
}
function setPath(obj: Json, path: readonly string[], value: unknown): void {
	if (path.some((k) => k === "__proto__" || k === "constructor" || k === "prototype")) throw new Error(`refusing key ${shown(path.join("."))}; nothing was changed`);
	let o = obj;
	for (const k of path.slice(0, -1)) {
		if (!isPlain(o[k])) o[k] = {};
		o = o[k] as Json;
	}
	o[path[path.length - 1] as string] = value;
}

const shown = (v: unknown): string => JSON.stringify(String(v).slice(0, 80));

/** An object with its keys sorted at every level: how the manifest is written, so a rewrite of unchanged content is byte-identical (T7-F012 b). */
const sortObj = (o: Json): Json => Object.fromEntries(Object.keys(o).sort().map((k) => [k, isPlain(o[k]) ? sortObj(o[k] as Json) : o[k]]));

/**
 * Names Windows opens as a device whatever the extension (`NUL.md` is still the null device): CON, PRN, AUX, NUL, CONIN$, CONOUT$, COM0 to COM9 and LPT0 to
 * LPT9 with the superscript digits too. Win32 compares the part before the first dot with trailing spaces dropped, so `con .md` is CON (P3R-F001).
 */
export const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|(com|lpt)[0-9\u00b9\u00b2\u00b3]) *(\..*)?$/i;

/**
 * A relative POSIX path that stays inside its folder: no `..`, no root, drive, UNC or stream (`:`), no backslash, no empty segment, and no
 * segment Windows rewrites (a trailing dot or space is dropped, a device name opens a device instead of a file).
 */
export function safeRel(rel: unknown, what = "path"): string {
	const bad = (why: string): never => {
		throw new Error(`refusing ${what} ${shown(rel)}: ${why}; nothing was changed`);
	};
	if (typeof rel !== "string" || rel === "") return bad("it is empty");
	if (/[\u0000-\u001f]/.test(rel)) bad("it has a control character");
	if (rel.includes("\\")) bad("it has a backslash");
	if (rel.includes(":")) bad("it has a drive letter or stream marker");
	if (rel.startsWith("/")) bad("it is absolute");
	for (const seg of rel.split("/")) {
		if (seg === "" || seg === "." || seg === "..") bad("it has an empty, '.' or '..' segment");
		if (/[. ]$/.test(seg)) bad("a segment ends in a dot or a space, which Windows drops");
		if (DEVICE_NAME.test(seg)) bad("a segment is a Windows device name");
	}
	return rel;
}

/** One folder name that goes into a path (the profile version). */
function safeSegment(value: unknown, what: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)) throw new Error(`refusing ${what} ${shown(value)}: not usable as a folder name; nothing was changed`);
	return value;
}

/**
 * The absolute path of rel under agentDir, after safeRel, a check that it resolves inside agentDir, and a check that no part of it that
 * exists is a symbolic link or junction (a link could point anywhere, and a dangling one would be written through).
 */
export function managedPath(agentDir: string, rel: string, what = "path"): string {
	safeRel(rel, what);
	const root = resolve(agentDir);
	const full = resolve(root, ...rel.split("/"));
	if (!full.startsWith(root + sep)) throw new Error(`refusing ${what} ${shown(rel)}: it resolves outside the agent folder; nothing was changed`);
	assertNoLinks(root, full, what, rel);
	return full;
}

/** Throws when any part of full below root that exists is a symbolic link or junction; a part that does not exist yet is fine. */
export function assertNoLinks(root: string, full: string, what: string, rel: string = posix(relative(root, full))): void {
	let walked = root;
	for (const seg of relative(root, full).split(sep)) {
		walked = join(walked, seg);
		let st;
		try {
			st = lstatSync(walked);
		} catch (error) {
			if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return;
			throw error;
		}
		if (st.isSymbolicLink()) throw new Error(`refusing ${what} ${shown(rel)}: ${shown(relative(root, walked))} is a symbolic link or junction; remove it or fix the folder, nothing was changed`);
	}
}

/** Test seams of `writeAtomic`: each is called at the moment a hostile process of the same user would act. Never set by the product. */
export interface WriteHooks {
	/** The temp file's name; the product uses a random one. */
	tempName?: (path: string) => string;
	/** Called after the first link check, before the temp file is created. */
	beforeTemp?: () => void;
	/** Called after the temp name was found free, right before the exclusive create. */
	beforeCreate?: () => void;
	/** Called with the temp name right after the exclusive create, before the check that the name still holds what was created. */
	afterCreate?: (tmp: string) => void;
	/** Called after the temp file is written, before the last link check and the rename. */
	beforeRename?: () => void;
}

/**
 * A write that never leaves a partial file: a temp file in the same folder, renamed over the target. The temp name is random and created with
 * `wx`, so an existing entry (a planted link included) makes the write fail instead of being followed. Folders can change after planning, so the path
 * is checked for links again right before the temp file is written and right before the rename (RC-F003).
 */
export function writeAtomic(agentDir: string, path: string, data: string | Buffer, hooks: WriteHooks = {}): void {
	const root = resolve(agentDir);
	if (!resolve(path).startsWith(root + sep)) throw new Error(`refusing to write ${shown(path)}: it is outside the agent folder; nothing was changed`);
	assertNoLinks(root, path, "write path");
	mkdirSync(dirname(path), { recursive: true });
	const tmp = hooks.tempName?.(path) ?? `${path}.sbd-tmp-${randomBytes(8).toString("hex")}`;
	// Only a temp file this call created is removed on failure: when `wx` finds the name taken, what is there is someone else's.
	let created = false;
	try {
		hooks.beforeTemp?.();
		assertNoLinks(root, path, "write path (checked again before its temp file is created)");
		refuseExisting(tmp);
		hooks.beforeCreate?.();
		const fd = openSync(tmp, "wx");
		try {
			hooks.afterCreate?.(tmp);
			assertCreatedPlainFile(fd, tmp, path);
			created = true;
			writeFileSync(fd, data);
		} finally {
			closeSync(fd);
		}
		hooks.beforeRename?.();
		assertNoLinks(root, path, "write path (checked again before the rename)");
		renameSync(tmp, path);
	} catch (error) {
		if (created) rmSync(tmp, { force: true });
		throw error;
	}
}

/**
 * Windows opens through a dangling link even with `wx` and creates its target, and the entry can be swapped between the create and now: what is at the temp
 * name must be a plain file, and the very file the descriptor holds (same device and inode), before anything is written (T7-F006).
 */
function assertCreatedPlainFile(fd: number, tmp: string, path: string): void {
	const named = lstatSync(tmp, { bigint: true });
	const opened = fstatSync(fd, { bigint: true });
	if (!named.isFile() || named.dev !== opened.dev || named.ino !== opened.ino) {
		throw new Error(`refusing to write ${shown(path)}: its temp file ${shown(basename(tmp))} is not a plain file, or is not the file that was created; nothing was changed`);
	}
}

/** Throws EEXIST when anything, a link included, is at path. Windows' `wx` does not stop at a dangling link, so the name is looked at first. */
function refuseExisting(path: string): void {
	try {
		lstatSync(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		throw error;
	}
	throw Object.assign(new Error(`EEXIST: ${shown(basename(path))} already exists; nothing was changed`), { code: "EEXIST" });
}

/** Deletes a managed file after looking for links once more, since planning ran earlier (P3R-F003). */
function removeManaged(agentDir: string, path: string, what: string): void {
	assertNoLinks(resolve(agentDir), path, what);
	rmSync(path, { force: true });
}

/**
 * Whether two paths are one file (same device and inode). On a case-insensitive volume (the default on macOS and Windows) the old and the new spelling of
 * a profile file that only changed its letter case are one file, and a string comparison of the two names cannot tell (T7-F004).
 */
function sameFile(a: string, b: string): boolean {
	try {
		const x = lstatSync(a, { bigint: true });
		const y = lstatSync(b, { bigint: true });
		return x.ino !== 0n && x.dev === y.dev && x.ino === y.ino;
	} catch {
		return false;
	}
}

/** `file` for a regular file, `absent` for nothing, `other` for anything else, a link included (it is looked at, never followed). */
function fileKind(path: string): "file" | "absent" | "other" {
	try {
		return lstatSync(path).isFile() ? "file" : "other";
	} catch (error) {
		if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return "absent";
		throw error;
	}
}

/** SHA256 of a regular file; anything else (a folder, a device) is refused rather than read. */
function fileHash(path: string, rel: string): string {
	if (!lstatSync(path).isFile()) throw new Error(`${shown(rel)} exists but is not a regular file; nothing was changed`);
	return sha256(readFileSync(path));
}

function readJsonOr<T>(path: string, fallback: T): Json | T {
	if (!existsSync(path)) return fallback;
	const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
	try {
		return JSON.parse(text) as Json;
	} catch (error) {
		throw new Error(`${path} is not valid JSON (${(error as Error).message.split("\n")[0]}); fix or remove it, nothing was changed`);
	}
}

/**
 * A file of the profile package read as text. A link on the way (the package folder, `rules/`, `config/`, a folder below them), and a link, a folder, or a
 * device in the file's own place, are refused, so nothing the package points at elsewhere is ever read (T7-F005).
 */
function readPackageFile(profileDir: string, file: string): string {
	assertNoLinks(dirname(profileDir), dirname(file), "profile folder");
	if (!lstatSync(file).isFile()) throw new Error(`${file} is not a regular file; the profile package is damaged`);
	return readFileSync(file, "utf8");
}

/** A JSON file of the profile package that must hold an object; a package that ships anything else is refused by name. */
function readJsonObject(profileDir: string, file: string): Json {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readPackageFile(profileDir, file));
	} catch (error) {
		throw new Error(`${file} is not readable JSON (${(error as Error).message.split("\n")[0]}); the profile package is damaged`);
	}
	if (!isPlain(parsed)) throw new Error(`${file} is not a JSON object; the profile package is damaged`);
	return parsed;
}

export interface Profile {
	name: string;
	version: string;
	/** Managed files by relative path (AGENTS.md and rules/), as text. */
	files: Map<string, string>;
	/** The keys the profile owns in `settings.json`. */
	settings: Json;
	/** The keys the profile owns in `herdr-agents/config.json`. */
	herdr: Json;
}

/** What the profile package ships and the installer copies: AGENTS.md and rules/, plus the two config objects. Skills stay in the package. */
export function loadProfile(profileDir: string): Profile {
	const pkg = readJsonObject(profileDir, join(profileDir, "package.json"));
	const version = safeSegment(pkg.version, "profile version");
	const files = new Map<string, string>();
	for (const rel of ["AGENTS.md"]) files.set(rel, readPackageFile(profileDir, join(profileDir, rel)));
	// A `rules` that is a link is refused before it is listed, a dangling one too: only a real folder, or nothing, is a profile without rules.
	assertNoLinks(profileDir, join(profileDir, "rules"), "profile folder");
	if (existsSync(join(profileDir, "rules"))) {
		for (const rel of walk(join(profileDir, "rules"), profileDir)) files.set(safeRel(rel, "profile file"), readPackageFile(profileDir, join(profileDir, ...rel.split("/"))));
	}
	return {
		name: String(pkg.name),
		version,
		files,
		settings: readJsonObject(profileDir, join(profileDir, "config", "settings.json")),
		herdr: readJsonObject(profileDir, join(profileDir, "config", "herdr-agents.json")),
	};
}

export const TEAM_BEGIN = "<!-- straw-boss:team-block:begin -->";
export const TEAM_END = "<!-- straw-boss:team-block:end -->";

/** A line that opens a Markdown HTML block that does not end at a blank line (CommonMark types 1, 3, 4 and 5), or a comment: the rest of the document would be raw HTML. */
const HTML_BLOCK_OPENER = /^( {0,3})<(?=(?:pre|script|style|textarea)(?:[\s>]|$)|[?!])/i;
/** A heading, a rule, or a setext underline (a line of only `=` or `-`, even one character): it would pass for structure of the profile or turn the line above into a heading. */
const STRUCTURE_LINE = /^ {0,3}(#{1,6}(\s|$)|([-*_=])(\s*\3){2,}\s*$|(=+|-+)\s*$)/;

/**
 * Makes text from a recipe inert inside the team block: it can neither fake a block marker (`<!--` is escaped) nor pass for a section of the
 * profile (a heading, a rule line or a setext underline gets a backslash, so it reads as plain text, not Markdown structure), and it cannot open a raw
 * HTML block (the leading `<` of `<pre>`, `<script>`, `<style>`, `<textarea>`, `<?` and `<!` is escaped). A code fence that is still open at the end is
 * closed there, so the rest of AGENTS.md still renders as it would without the block (RC-F005, P3R-F002). Fences are tracked as CommonMark closes
 * them: same character, at least as long, nothing after it.
 */
export function neutralize(text: string): string {
	const lines = normalizeText(text).replaceAll("<!--", "&lt;!--").replaceAll("-->", "--&gt;").split("\n");
	let open: { char: string; len: number } | null = null;
	const out = lines.map((line) => {
		if (open !== null) {
			const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
			if (close !== null && (close[1] as string)[0] === open.char && (close[1] as string).length >= open.len) open = null;
		} else {
			const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
			if (fence !== null && !((fence[1] as string)[0] === "`" && (fence[2] as string).includes("`"))) open = { char: (fence[1] as string)[0] as string, len: (fence[1] as string).length };
		}
		if (STRUCTURE_LINE.test(line)) return line.replace(/^( {0,3})/, "$1\\");
		return line.replace(HTML_BLOCK_OPENER, "$1\\<");
	});
	// A fence still open at the end would turn everything after the block into code: close it with the same character and length.
	if (open !== null) {
		const fence: { char: string; len: number } = open;
		out.push(fence.char.repeat(fence.len));
	}
	return out.join("\n");
}

/** text with the region between the team markers (markers included) replaced by block, or removed when block is null; appended when there is no region. */
export function replaceTeamBlock(text: string, block: string | null): string {
	const begin = text.indexOf(TEAM_BEGIN);
	if (begin < 0) return block ? `${text.replace(/\n*$/, "\n")}\n${block}` : text;
	const end = text.indexOf(TEAM_END, begin);
	if (end < 0) throw new Error("the team block has a begin marker but no end marker; nothing was changed");
	const before = text.slice(0, begin);
	const after = text.slice(end + TEAM_END.length).replace(/^\n/, "");
	if (block) return before + block + after;
	return before.replace(/\n+$/, "\n") + (after ? `\n${after}` : "");
}

/** The parts of a validated recipe the installer reads. */
export interface TeamRecipe {
	id: string;
	name: string;
	version: string;
	instructions?: string;
	straw?: { relay?: string };
}

/** AGENTS.md plus the recipe's team block between markers, the text the installer records and protects. */
export function composeAgents(base: string, recipe: Pick<TeamRecipe, "name" | "instructions"> | null): string {
	let text = replaceTeamBlock(normalizeText(base), null);
	if (!text.endsWith("\n")) text += "\n";
	if (recipe?.instructions) {
		const block = `${TEAM_BEGIN}\n## Team: ${neutralize(String(recipe.name)).replace(/\n/g, " ")}\n\n${neutralize(recipe.instructions).replace(/\n+$/, "")}\n${TEAM_END}\n`;
		text = replaceTeamBlock(text, block);
	}
	return text;
}

export type Change = { kind: "file-written" | "file-recorded" | "file-replaced" | "pending-written" | "file-removed"; file: string } | { kind: "key-set" | "key-recorded" | "key-replaced"; file: string; key: string };
export type Notice =
	| { kind: "file-kept"; file: string; reason: "edited" | "no-record"; pending: string }
	| { kind: "key-kept"; file: string; key: string }
	| { kind: "dropped-file-kept"; file: string };

export interface InstallResult {
	changes: Change[];
	notices: Notice[];
	manifestChanged: boolean;
	profileVersion: string;
}

interface Manifest extends Json {
	version: number;
	files: Record<string, string>;
	keys: Record<string, Json>;
}

export interface InstallOptions {
	profile: Profile;
	agentDir: string;
	recipe?: TeamRecipe | null;
	dryRun?: boolean;
	/** Test seam: called with a label after each write or deletion. */
	afterStep?: ((label: string) => void) | null;
	/** Test seams of `writeAtomic`. */
	hooks?: WriteHooks;
}

/**
 * Installs (or, with dryRun, only plans) the profile into agentDir.
 * Returns { changes, notices, ... }: `changes` are writes made (or that would be), `notices` are things kept for the PM.
 * Every path is checked while planning, so a refusal happens before the first write. Writes run in an order a crash can resume from: content files and
 * merged keys, then deletions, the manifest last (a rerun re-records what is already in place and finishes what is left).
 */
export function install({ profile, agentDir, recipe = null, dryRun = false, afterStep = null, hooks = {} }: InstallOptions): InstallResult {
	safeSegment(profile.version, "profile version");
	const manifestPath = managedPath(agentDir, `${STATE_DIR}/${MANIFEST}`, "manifest path");
	const old = readJsonOr<Json>(manifestPath, { version: 1, files: {}, keys: {} });
	if (!isPlain(old) || !isPlain(old.files ?? {}) || !isPlain(old.keys ?? {})) throw new Error(`${manifestPath} is not a manifest this installer wrote; fix or remove it, nothing was changed`);
	const oldFiles = (old.files ?? {}) as Record<string, string>;
	const oldKeys = (old.keys ?? {}) as Record<string, unknown>;
	const next: Manifest = { version: 1, profile: { name: profile.name, version: profile.version }, recipe: recipe ? { id: recipe.id, version: recipe.version } : null, files: {}, keys: {} };
	const changes: Change[] = [];
	const notices: Notice[] = [];
	const writes: Array<[string, string]> = [];
	const removes: string[] = [];

	const shipped = new Map(profile.files);
	shipped.set("AGENTS.md", composeAgents(profile.files.get("AGENTS.md") as string, recipe));

	// A recorded name this profile no longer ships that is, on this volume, the file a shipped name now opens (a case-only rename on a case-insensitive
	// volume): its record belongs to the shipped name, and the "no longer shipped" pass below must not delete the file the rule now lives in (T7-F004).
	const respelled = new Set<string>();
	const recordFor = (rel: string, path: string): string | undefined => {
		const exact = oldFiles[rel];
		if (exact !== undefined) return exact;
		for (const [was, hash] of Object.entries(oldFiles)) {
			if (was === rel || shipped.has(was) || respelled.has(was)) continue;
			if (sameFile(managedPath(agentDir, was, "manifest path"), path)) {
				respelled.add(was);
				return hash;
			}
		}
		return undefined;
	};

	// ---- copied files ----
	for (const [rel, raw] of shipped) {
		const text = normalizeText(raw);
		const hash = sha256(Buffer.from(text, "utf8"));
		const path = managedPath(agentDir, rel, "profile file");
		const recorded = existsSync(path) ? recordFor(rel, path) : undefined;
		if (!existsSync(path)) {
			writes.push([path, text]);
			changes.push({ kind: "file-written", file: rel });
			next.files[rel] = hash;
			continue;
		}
		const current = fileHash(path, rel);
		if (current === hash) {
			next.files[rel] = hash;
			if (recorded !== hash) changes.push({ kind: "file-recorded", file: rel });
		} else if (recorded !== undefined && current === recorded) {
			writes.push([path, text]);
			changes.push({ kind: "file-replaced", file: rel });
			next.files[rel] = hash;
		} else {
			// Changed by the PM, or the spike's file with no record: keep it, put the team version aside.
			const pendingRel = `${STATE_DIR}/pending/${profile.version}/${rel}`;
			const pending = managedPath(agentDir, pendingRel, "pending path");
			if (!existsSync(pending) || fileHash(pending, pendingRel) !== hash) {
				writes.push([pending, text]);
				changes.push({ kind: "pending-written", file: rel });
			}
			notices.push({ kind: "file-kept", file: rel, reason: recorded === undefined ? "no-record" : "edited", pending: pendingRel });
			if (recorded !== undefined) next.files[rel] = recorded;
		}
	}

	// ---- files the profile no longer ships ----
	// The manifest is the only place these paths come from, and anything can have written it: each one is checked like any other path.
	for (const [rel, recorded] of Object.entries(oldFiles)) {
		const path = managedPath(agentDir, rel, "manifest path");
		if (shipped.has(rel) || respelled.has(rel)) continue;
		if (!existsSync(path)) continue;
		if (fileHash(path, rel) === recorded) {
			removes.push(path);
			changes.push({ kind: "file-removed", file: rel });
		} else {
			notices.push({ kind: "dropped-file-kept", file: rel });
			next.files[rel] = recorded;
		}
	}

	// ---- merged JSON keys ----
	const targets: Array<[string, Array<[string[], unknown]>]> = [
		["settings.json", leaves(profile.settings)],
		["herdr-agents/config.json", leaves(profile.herdr)],
	];
	if (recipe?.straw?.relay) targets.push(["straw-boss/config.json", [[["link", "relay"], recipe.straw.relay]]]);
	for (const [rel, entries] of targets) {
		const path = managedPath(agentDir, rel, "config path");
		const doc = readJsonOr<Json>(path, {});
		if (!isPlain(doc)) throw new Error(`${path} is not a JSON object; nothing was changed`);
		const recordedKeys: Json = isPlain(oldKeys[rel]) ? (oldKeys[rel] as Json) : {};
		const keysNext: Json = {};
		let touched = false;
		for (const [keyPath, value] of entries) {
			const key = keyPath.join(".");
			const found = lookup(doc, keyPath);
			const recorded = recordedKeys[key];
			if (found.kind === "absent") {
				setPath(doc, keyPath, value);
				touched = true;
				changes.push({ kind: "key-set", file: rel, key });
				keysNext[key] = value;
			} else if (found.kind === "found" && same(found.value, value)) {
				keysNext[key] = value;
				if (!same(recorded, value)) changes.push({ kind: "key-recorded", file: rel, key });
			} else if (found.kind === "found" && recorded !== undefined && same(found.value, recorded)) {
				setPath(doc, keyPath, value);
				touched = true;
				changes.push({ kind: "key-replaced", file: rel, key });
				keysNext[key] = value;
			} else {
				// Changed by the PM, or a parent of the key holds a value of theirs that is not an object (a scalar or an array): never overwritten.
				notices.push({ kind: "key-kept", file: rel, key });
				if (recorded !== undefined) keysNext[key] = recorded;
			}
		}
		// keys recorded earlier that this version no longer ships stay as they are
		for (const [key, value] of Object.entries(recordedKeys)) if (!(key in keysNext) && !entries.some(([p]) => p.join(".") === key)) keysNext[key] = value;
		if (touched) writes.push([path, `${JSON.stringify(doc, null, 2)}\n`]);
		if (Object.keys(keysNext).length > 0) next.keys[rel] = keysNext;
	}

	// ---- manifest ----
	const manifestText = `${JSON.stringify(sortObj(next), null, 2)}\n`;
	const manifestChanged = !existsSync(manifestPath) || readFileSync(manifestPath, "utf8") !== manifestText;

	if (!dryRun) {
		for (const [path, text] of writes) {
			writeAtomic(agentDir, path, text, hooks);
			afterStep?.(`write ${posix(relative(agentDir, path))}`);
		}
		for (const path of removes) {
			removeManaged(agentDir, path, "profile file");
			afterStep?.(`remove ${posix(relative(agentDir, path))}`);
		}
		if (manifestChanged) {
			writeAtomic(agentDir, manifestPath, manifestText, hooks);
			afterStep?.("write manifest");
		}
	}
	return { changes, notices, manifestChanged, profileVersion: profile.version };
}

export interface UseTeamOptions {
	profile: Profile;
	agentDir: string;
	files: readonly string[];
	now?: Date;
	hooks?: WriteHooks;
}

/** "Use the team version": the PM's copy is saved under backup/<timestamp>/, then the pending copy takes its place. */
export function useTeamVersion({ profile, agentDir, files, now = new Date(), hooks = {} }: UseTeamOptions): Array<{ file: string; backup: string }> {
	safeSegment(profile.version, "profile version");
	const manifestPath = managedPath(agentDir, `${STATE_DIR}/${MANIFEST}`, "manifest path");
	const manifest = readJsonOr<null>(manifestPath, null);
	if (manifest === null) throw new Error("no manifest: nothing was installed here");
	if (!isPlain(manifest.files)) throw new Error(`${manifestPath} is not a manifest this installer wrote; fix or remove it, nothing was changed`);
	const recorded = manifest.files as Record<string, string>;
	const stamp = now.toISOString().replace(/[:.]/g, "-");
	// Check every file before touching any of them.
	// Only a file this installer manages can be switched: one the manifest records, or one the profile ships (a file the PM already had has no record
	// yet, and its pending copy is what this switches). A repeated --file counts once, so nothing is half-switched by the second pass.
	const unique = [...new Set(files)];
	for (const rel of unique) {
		safeRel(rel, "--file");
		if (!Object.hasOwn(recorded, rel) && !profile.files.has(rel)) throw new Error(`refusing --file ${shown(rel)}: it is not a file this installer manages; nothing was changed`);
	}
	const plan = unique.map((rel) => {
		const pendingRel = `${STATE_DIR}/pending/${profile.version}/${rel}`;
		const backupRel = `${STATE_DIR}/backup/${stamp}/${rel}`;
		return {
			rel,
			target: managedPath(agentDir, rel, "--file"),
			pendingRel,
			backupRel,
			pending: managedPath(agentDir, pendingRel, "pending path"),
			backup: managedPath(agentDir, backupRel, "backup path"),
		};
	});
	// Each pending copy and each existing target must be a regular file before the first switch: a folder or a FIFO found halfway would leave the files before
	// it switched and the manifest recording them (T7-F011).
	for (const p of plan) {
		const pending = fileKind(p.pending);
		if (pending === "absent") throw new Error(`no pending version of ${p.rel}`);
		if (pending === "other") throw new Error(`the pending version of ${p.rel} is not a regular file; nothing was changed`);
		if (fileKind(p.target) === "other") throw new Error(`${shown(p.rel)} exists but is not a regular file; nothing was changed`);
	}
	const done: Array<{ file: string; backup: string }> = [];
	for (const p of plan) {
		if (existsSync(p.target)) writeAtomic(agentDir, p.backup, readFileSync(p.target), hooks);
		const bytes = readFileSync(p.pending);
		writeAtomic(agentDir, p.target, bytes, hooks);
		// The manifest records the new hash before the pending copy goes, so a crash in between leaves a state the next install sorts out.
		recorded[p.rel] = sha256(bytes);
		writeAtomic(agentDir, manifestPath, `${JSON.stringify(sortObj(manifest), null, 2)}\n`, hooks);
		removeManaged(agentDir, p.pending, "pending path");
		done.push({ file: p.rel, backup: posix(p.backupRel) });
	}
	return done;
}

/** Lists a recipe package in settings.json as { source, extensions: [] }, so it adds skills but loads no code (spec section 5). Returns the sources it changed. */
export function markSkillsOnly({ agentDir, packages, hooks = {} }: { agentDir: string; packages: ReadonlyArray<{ name: string; version: string }>; hooks?: WriteHooks }): string[] {
	const path = managedPath(agentDir, "settings.json", "settings path");
	const doc = readJsonOr<null>(path, null);
	if (doc === null) throw new Error("settings.json missing; install the profile first");
	const list: unknown[] = Array.isArray(doc.packages) ? [...(doc.packages as unknown[])] : [];
	const marked: string[] = [];
	for (const pkg of packages) {
		const source = `npm:${pkg.name}@${pkg.version}`;
		const i = list.findIndex((e) => (typeof e === "string" ? e : isPlain(e) ? e.source : undefined) === source);
		if (i < 0) throw new Error(`${source} is not listed in settings.json; install it first`);
		const current = list[i];
		const entry: Json = typeof current === "string" ? { source } : { ...(current as Json) };
		entry.extensions = [];
		if (!same(current, entry)) {
			list[i] = entry;
			marked.push(source);
		}
	}
	doc.packages = list;
	if (marked.length > 0) writeAtomic(agentDir, path, `${JSON.stringify(doc, null, 2)}\n`, hooks);
	return marked;
}

/** True when settings.json lists `npm:name@version` (the stage's exact pin) and, with `skillsOnly`, with an empty `extensions` list. */
export function isPackageListed(agentDir: string, name: string, version: string, skillsOnly: boolean): boolean {
	let doc: Json | null;
	try {
		doc = readJsonOr<null>(join(agentDir, "settings.json"), null);
	} catch {
		return false;
	}
	if (doc === null || !Array.isArray(doc.packages)) return false;
	const source = `npm:${name}@${version}`;
	for (const entry of doc.packages as unknown[]) {
		if (typeof entry === "string") {
			if (entry === source && !skillsOnly) return true;
			continue;
		}
		if (isPlain(entry) && entry.source === source) {
			if (!skillsOnly) return true;
			if (Array.isArray(entry.extensions) && entry.extensions.length === 0) return true;
		}
	}
	return false;
}
