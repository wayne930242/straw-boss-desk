// The UI rules of the spec (The wizard: UI rules) as functions over source text, so a test can prove each rule fails on a planted violation.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Violation { file: string; line: number; rule: string; text: string }

/** Every file under `dir` with one of the extensions, recursively. */
export function sourceFiles(dir: string, extensions: readonly string[]): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...sourceFiles(full, extensions));
		else if (extensions.some((e) => entry.name.endsWith(e))) out.push(full);
	}
	return out.sort();
}

export const readText = (file: string): string => readFileSync(file, "utf8");

function matchLines(file: string, text: string, rule: string, re: RegExp): Violation[] {
	const found: Violation[] = [];
	text.split(/\r?\n/).forEach((line, i) => {
		if (re.test(line)) found.push({ file, line: i + 1, rule, text: line.trim() });
	});
	return found;
}

/** Animation is CSS only: no script-driven frames and no Web Animations calls. */
export function scriptAnimation(file: string, text: string): Violation[] {
	return matchLines(file, text, "animation is CSS only (no requestAnimationFrame or .animate())", /\brequestAnimationFrame\b|\.animate\s*\(/);
}

/**
 * Cards and panels have a uniform border on all four sides or none: any one-sided border declaration fails (physical or logical, shorthand or longhand).
 * Corner radii such as border-top-left-radius are not sides.
 */
export function oneSidedBorders(file: string, text: string): Violation[] {
	const side = /(?:^|[\s;{])border-(?:left|right|top|bottom|inline|block)(?:-(?:start|end))?(?:-(?:width|style|color))?\s*:/i;
	return matchLines(file, text, "borders are uniform on all four sides or none", side);
}

/** The reduced-motion block must turn off every animation and transition. */
export function reducedMotionGaps(file: string, css: string): Violation[] {
	const gaps: Violation[] = [];
	const at = css.search(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/);
	if (at < 0) return [{ file, line: 1, rule: "a prefers-reduced-motion: reduce block exists", text: "" }];
	const block = css.slice(at);
	if (!/animation\s*:\s*none/i.test(block)) gaps.push({ file, line: 1, rule: "reduced motion turns animation off", text: "" });
	if (!/transition\s*:\s*none/i.test(block)) gaps.push({ file, line: 1, rule: "reduced motion turns transition off", text: "" });
	if (!/\*\s*,\s*\*::before\s*,\s*\*::after/.test(block)) gaps.push({ file, line: 1, rule: "reduced motion covers every element, not a list", text: "" });
	return gaps;
}

/** Flattened dotted keys of a nested catalog. */
export function flattenKeys(node: unknown, prefix = ""): string[] {
	if (typeof node !== "object" || node === null) return [prefix];
	return Object.entries(node).flatMap(([k, v]) => flattenKeys(v, prefix ? `${prefix}.${k}` : k));
}

export function valueAt(node: unknown, dotted: string): unknown {
	let cur = node;
	for (const part of dotted.split(".")) cur = (cur as Record<string, unknown> | undefined)?.[part];
	return cur;
}

/** `{name}` placeholders in a string, sorted. */
export const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();
