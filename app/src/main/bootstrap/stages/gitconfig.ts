import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../fsutil.ts";

// The private Git configuration (`GIT_CONFIG_GLOBAL`, `<root>/gitconfig`) is shared by two stages and by the PM's later settings: `git` owns a block at the
// start of the file (identity placeholder, `core.longpaths`, `init.defaultBranch`), `git-helpers` owns one at the end (the forge credential helpers, which
// must come after every general `[credential]` setting). Anything outside the two blocks is left exactly as it is.

export type BlockPosition = "first" | "last";

const begin = (name: string): string => `# >>> straw-boss ${name} (written by the app; change settings outside this block)`;
const end = (name: string): string => `# <<< straw-boss ${name}`;

/** The file as text: no byte order mark, LF line ends (Git on Windows writes either). A missing file is empty. */
export function readGitconfig(file: string): string {
	if (!existsSync(file)) return "";
	return readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/** Raised when a block has a start line and no end line: the file was edited by hand, and rewriting around it could lose what is inside. */
export class GitconfigBlockError extends Error {
	constructor(name: string) {
		super(`the "${name}" block in the Git configuration has no end line; fix the file by hand`);
		this.name = "GitconfigBlockError";
	}
}

function split(text: string, name: string): { before: string; block: string | null; after: string } {
	const start = text.indexOf(begin(name));
	if (start < 0) return { before: text, block: null, after: "" };
	const stop = text.indexOf(end(name), start);
	if (stop < 0) throw new GitconfigBlockError(name);
	const lineEnd = text.indexOf("\n", stop);
	const next = lineEnd < 0 ? text.length : lineEnd + 1;
	return { before: text.slice(0, start), block: text.slice(start, next), after: text.slice(next) };
}

/** The block as written: its start line, `body`, its end line, each ending in a newline. */
export function blockText(name: string, body: string): string {
	return `${begin(name)}\n${body.replace(/\n+$/, "")}\n${end(name)}\n`;
}

/** True when the file holds the block `name` with exactly `body`, and (for a `last` block) nothing but blank lines follows it. */
export function hasBlock(file: string, name: string, body: string, position: BlockPosition): boolean {
	const text = readGitconfig(file);
	let parts: ReturnType<typeof split>;
	try {
		parts = split(text, name);
	} catch {
		return false;
	}
	if (parts.block !== blockText(name, body)) return false;
	return position === "first" || parts.after.trim() === "";
}

/** Writes the block `name` into the file: replaced where it is, else added at the start or the end. Atomic; everything outside the block is kept. */
export function upsertBlock(file: string, name: string, body: string, position: BlockPosition): void {
	const text = readGitconfig(file);
	const { before, block, after } = split(text, name);
	const fresh = blockText(name, body);
	let out: string;
	if (block !== null && position === "first") out = `${before}${fresh}${after}`;
	else if (block !== null) out = `${before}${after.trim() === "" ? "" : after}`.replace(/\n*$/, "\n") + fresh;
	else if (position === "first") out = `${fresh}${text === "" ? "" : `\n${text}`}`;
	else out = `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${fresh}`;
	writeFileAtomic(file, out.replace(/^\n+/, ""));
}

/** Removes the block `name` when the file has it. */
export function removeBlock(file: string, name: string): void {
	const text = readGitconfig(file);
	const { before, block, after } = split(text, name);
	if (block === null) return;
	writeFileAtomic(file, `${before}${after}`);
}

/** A git config value, quoted and escaped only when it has to be (a backslash, double quote, `#` or `;`, a line break, or edge whitespace). */
export function configValue(value: string): string {
	if (/[\\"#;\n]/.test(value) || /^\s|\s$/.test(value)) return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
	return value;
}
