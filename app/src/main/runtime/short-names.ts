import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bunCacheDir, bunHome, systemEnv, type EnvLike, type ShortNames } from "../env.ts";
import { writeFileAtomic } from "../bootstrap/fsutil.ts";
import { sameFolder } from "../bootstrap/stages/paths-launchers.ts";
import type { Layout } from "../paths.ts";
import type { CommandRunner, Locate } from "../platform/types.ts";

// The 8.3 short names of bun's two folders (build notes: task 5, "bun 1.2.23 reads its environment as ANSI on Windows"; task 5b, T5-F001). `buildEnv` gives
// `BUN_INSTALL` and `BUN_INSTALL_CACHE_DIR` as long paths, which a `bun.exe` shim reached by a spawn without a shell reads as `?` in a root with characters
// outside the ANSI code page, and then keeps its cache in the project. The names are resolved once, here, and kept in `state/short-names.json` beside
// `state/layout.json`, so a later start never computes another place. Windows only; where the volume has no short names the long path comes back and
// nothing is recorded (the `launchers` stage fails the install with a plain sentence in that case, so a start does not meet it).

const FILE = "short-names.json";
export const SHORT_NAMES_RULE = 1;

interface ShortNamesRecord {
	schema: 1;
	rule: number;
	root: string;
	bunHome: string;
	bunCache: string;
}

const isShort = (path: string): boolean => /^[\x20-\x7e]+$/.test(path);

/**
 * The short form of `dir`, from `cmd /d /s /c "for %I in (.) do @echo %~sfI"` run with `dir` as its working directory: the folder reaches cmd as UTF-16 that
 * way, where a path in the command line would be cut to the ANSI code page. Null when the answer is not an ASCII path to the same folder.
 */
export async function shortPathOf(run: CommandRunner, locate: Locate, appEnv: EnvLike, dir: string): Promise<string | null> {
	mkdirSync(dir, { recursive: true });
	const r = await run(locate.system("cmd"), ["/d", "/s", "/c", "for %I in (.) do @echo %~sfI"], { cwd: dir, env: systemEnv("win32", appEnv), replaceEnv: true, timeoutMs: 30_000 });
	if (r.code !== 0) return null;
	const answer = (r.stdout.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").trim();
	if (answer === "" || !isShort(answer)) return null;
	return sameFolder(answer, dir) ? answer : null;
}

function readRecord(file: string): ShortNamesRecord | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const r = parsed as Partial<ShortNamesRecord>;
		if (r.schema !== 1 || r.rule !== SHORT_NAMES_RULE || typeof r.root !== "string" || typeof r.bunHome !== "string" || typeof r.bunCache !== "string") return null;
		return r as ShortNamesRecord;
	} catch {
		return null;
	}
}

export interface ShortNamesInput {
	layout: Layout;
	run: CommandRunner;
	locate: Locate;
	appEnv: EnvLike;
	log?: (line: string) => void;
}

/**
 * bun's folders by their short names, or null where there are none to give (macOS, or a volume without 8.3 names). The record is used while it was written for
 * this root and both short names still name the folders; otherwise the names are resolved again and the record is rewritten.
 */
export async function resolveShortNames(input: ShortNamesInput): Promise<ShortNames | null> {
	const { layout } = input;
	if (layout.platform !== "win32") return null;
	const file = join(layout.state, FILE);
	const home = bunHome(layout);
	const cache = bunCacheDir(layout);
	const recorded = readRecord(file);
	if (recorded && recorded.root === layout.root && sameFolder(recorded.bunHome, home) && sameFolder(recorded.bunCache, cache)) return { bunHome: recorded.bunHome, bunCache: recorded.bunCache };
	const shortHome = await shortPathOf(input.run, input.locate, input.appEnv, home);
	const shortCache = await shortPathOf(input.run, input.locate, input.appEnv, cache);
	if (shortHome === null || shortCache === null) {
		input.log?.(`bun's folders have no ASCII short names on this volume (home ${shortHome ?? "none"}, cache ${shortCache ?? "none"}); the long names are used`);
		return null;
	}
	const record: ShortNamesRecord = { schema: 1, rule: SHORT_NAMES_RULE, root: layout.root, bunHome: shortHome, bunCache: shortCache };
	writeFileAtomic(file, `${JSON.stringify(record, null, "\t")}\n`);
	return { bunHome: shortHome, bunCache: shortCache };
}
