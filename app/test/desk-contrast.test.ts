import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { composite, parseRules, resolveColor, ratio, type Rgba, type Rule } from "./harness/css-colors.ts";
import type { Rgb } from "./harness/contrast.ts";
import { tokenMap } from "./harness/contrast.ts";
import { readText } from "./harness/ui-rules.ts";

// Every foreground and background pair the desk's stylesheets use has at least 4.5:1 contrast (WCAG AA), derived from the stylesheets themselves (R9-F003). The colours, the tints and their
// percentages are read from `desk-tokens.css`, `desk.css`, `wizard.css`, `settings.css` and `screen.css`. What a test cannot read from CSS is which surface sits behind which text, so
// that is the table below (PLACEMENTS); the test fails on any rule that sets a `color` or a background and is not in it, and on any entry that names a rule the CSS does not have, so a new
// pair cannot be added without being listed, and a listed one cannot outlive its rule.

const renderer = join(import.meta.dirname, "..", "src", "renderer");
const sheets = ["desk.css", "wizard.css", "settings.css", "screen.css"];
const rules: Rule[] = sheets.flatMap((f) => parseRules(readText(join(renderer, f))));
/** The rules outside `@media`: reduced motion changes animation only. */
const plain = rules.filter((r) => r.media === null);

const vars = new Map<string, string>(tokenMap(readText(join(renderer, "desk-tokens.css"))));
// The `:root` custom properties of `desk.css` (the tints and the edge colour) are tokens too: `--tint-accent: color-mix(...)`.
for (const rule of plain.filter((r) => r.selectors.includes(":root"))) for (const [property, value] of rule.decls) if (property.startsWith("--")) vars.set(property, value);

/** The last declaration of `property` in the rules that carry exactly `selector` (the stylesheets order them as the cascade does). */
function declared(selector: string, property: string): string | undefined {
	let found: string | undefined;
	for (const rule of plain) if (rule.selectors.includes(selector)) for (const [p, v] of rule.decls) if (p === property) found = v;
	return found;
}

const colorOf = (selector: string): Rgba => {
	// `html, body` is one rule written with two selectors; its colour is the one the page gives every text that sets none.
	const value = declared(selector === "html, body" ? "body" : selector, "color");
	assert.ok(value !== undefined, `${selector} declares no color`);
	const resolved = resolveColor(value, vars);
	assert.ok(resolved !== null, `${selector}: color ${value} is not a token`);
	return resolved;
};

/** The background of a rule that sets a plain colour one: `background` or `background-color`. Null when it sets none, or a gradient. */
function surfaceOf(selector: string): Rgba | null {
	const value = declared(selector, "background-color") ?? declared(selector, "background");
	if (value === undefined) return null;
	return resolveColor(value, vars);
}

// ---- the page behind everything ------------------------------------------------------------------------------------------

/** `body`'s background names its colours as tokens: the opaque ones are the page, the translucent ones are the auras drawn over it. */
function pageBases(): Rgb[] {
	const background = declared("body", "background");
	assert.ok(background !== undefined, "body has a background");
	const names = [...new Set([...background.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1] as string))];
	const colors = names.map((name) => {
		const color = resolveColor(`var(${name})`, vars);
		assert.ok(color !== null, `${name}, which body's background uses, is a token colour`);
		return color;
	});
	const opaque = colors.filter((c) => c.alpha === 1).map((c) => c.rgb);
	const auras = colors.filter((c) => c.alpha < 1);
	assert.ok(opaque.length >= 2 && auras.length >= 1, `body's background: ${names.join(", ")}`);
	return [...opaque, ...opaque.flatMap((base) => auras.map((aura) => composite(aura, base)))];
}

// ---- where text sits ------------------------------------------------------------------------------------------------------

type Chain = readonly string[];
const PAGE: Chain[] = [[]];
/** The big surfaces: the wizard's card, the settings page's two columns, the runtime page's card, strip and notice rows. */
const CONTAINERS: Chain[] = [[".wizard"], [".card"], [".nav"], [".body"], [".strip"], [".notice"]];
/** Surfaces drawn inside the wizard's card and the settings body. */
const INNER = [".panel", ".finding", ".refusal", ".trust-item", ".path", ".stages li", ".accounts > li", "pre"];
const inside = (containers: readonly string[], inner: readonly string[]): Chain[] => containers.flatMap((c) => inner.map((i): Chain => [c, i]));
const NESTED: Chain[] = inside([".wizard", ".body"], INNER);
const EVERYWHERE: Chain[] = [...PAGE, ...CONTAINERS, ...NESTED];

interface Placement {
	/** The rule that sets the text colour: its own selector as the stylesheets write it. `inherited` is the colour the page gives text that sets none. */
	fg: string;
	/** The surfaces the text sits on, outermost first, each a selector whose background is drawn over the one before. */
	on: readonly Chain[];
	/** The rule's own background is drawn last (default: when it sets one). */
	own?: boolean;
	/** The base `.badge` background under a variant that sets no background of its own. */
	plus?: string;
}

const PLACEMENTS: Placement[] = [
	{ fg: "html, body", on: EVERYWHERE },
	{ fg: "h3", on: [...CONTAINERS, ...inside([".wizard"], [".trust-item"])] },
	{ fg: "h3.remove-title", on: [...CONTAINERS, ...inside([".body"], [".panel", ".finding"])] },
	{ fg: ".note", on: [...PAGE, ...CONTAINERS, ...inside([".wizard", ".body"], [".panel", ".trust-item"])] },
	{ fg: ".refusal .note", on: [[".wizard", ".refusal"], [".body", ".refusal"]] },
	{ fg: ".finding .note", on: [[".wizard", ".finding"], [".body", ".finding"]] },
	{ fg: "a", on: [...CONTAINERS, ...inside([".wizard", ".body"], [".panel", ".finding", ".refusal", ".trust-item"])] },
	{ fg: "pre", on: [...CONTAINERS, ...inside([".wizard", ".body"], [".panel", ".finding", ".refusal", ".trust-item"])] },
	{ fg: ".problem", on: [...CONTAINERS, ...inside([".wizard", ".body"], [".panel", ".finding", ".refusal"])] },
	{ fg: ".warn", on: [...CONTAINERS, ...inside([".wizard", ".body"], [".panel", ".finding"])] },
	{ fg: "button", on: [...CONTAINERS, ...inside([".wizard", ".body"], [".panel", ".finding", ".refusal", ".trust-item", ".accounts > li"])] },
	{ fg: "button", on: [...CONTAINERS, ...inside([".wizard", ".body"], [".panel", ".finding", ".refusal", ".accounts > li"])].map((c): Chain => [...c, "button:hover:not(:disabled)"]), own: false },
	{ fg: 'button[aria-pressed="true"]', on: [...CONTAINERS] },
	{ fg: 'button[aria-current="true"]', on: [...CONTAINERS] },
	{ fg: "button.primary", on: [...CONTAINERS, ...inside([".wizard", ".body"], [".panel", ".finding", ".refusal"])] },
	{ fg: "button.primary", on: [...CONTAINERS, ...inside([".wizard", ".body"], [".panel", ".finding", ".refusal"])].map((c): Chain => [...c, "button.primary:hover:not(:disabled)"]), own: false },
	{ fg: 'input[type="text"]', on: [...CONTAINERS, ...inside([".wizard", ".body"], [".panel"])] },
	{ fg: 'input[type="password"]', on: [...CONTAINERS, ...inside([".wizard", ".body"], [".panel"])] },
	{ fg: "::placeholder", on: [...CONTAINERS, ...inside([".wizard", ".body"], [".panel"])].map((c): Chain => [...c, 'input[type="text"]']), own: false },
	{ fg: ".field-label", on: [...CONTAINERS, ...inside([".wizard", ".body"], [".panel"])] },
	{ fg: ".badge", on: [...CONTAINERS, ...inside([".wizard", ".body"], [".stages li", ".accounts > li"])] },
	{ fg: ".badge-working", on: [...CONTAINERS, ...inside([".wizard", ".body"], [".stages li", ".accounts > li"])], own: false, plus: ".badge" },
	{ fg: ".badge-done", on: [...CONTAINERS, ...inside([".wizard", ".body"], [".stages li", ".accounts > li"])] },
	{ fg: ".badge-failed", on: [...CONTAINERS, ...inside([".wizard", ".body"], [".stages li", ".accounts > li"])] },
	{ fg: ".badge-warn", on: [...CONTAINERS, ...inside([".wizard", ".body"], [".stages li", ".accounts > li"])] },
	{ fg: ".badge-waiting", on: [...CONTAINERS, ...inside([".wizard", ".body"], [".stages li", ".accounts > li"])] },
	{ fg: ".badge-skipped", on: [...CONTAINERS, ...inside([".wizard", ".body"], [".stages li", ".accounts > li"])] },
	{ fg: ".badge-blocked", on: [...CONTAINERS, ...inside([".wizard", ".body"], [".stages li", ".accounts > li"])] },
	{ fg: "th", on: [...CONTAINERS, ...inside([".wizard", ".body"], [".panel"])] },
	{ fg: ".refusal th", on: [[".wizard", ".refusal"], [".body", ".refusal"]] },
	{ fg: "details", on: [...CONTAINERS, ...inside([".wizard", ".body"], [".panel", ".trust-item"])] },
	{ fg: ".refusal details", on: [[".wizard", ".refusal"], [".body", ".refusal"]] },
	{ fg: ".finding details", on: [[".wizard", ".finding"], [".body", ".finding"]] },
	{ fg: "details > pre", on: [...CONTAINERS, ...inside([".wizard", ".body"], [".panel", ".refusal", ".finding"])].map((c): Chain => [...c, "pre"]), own: false },
	{ fg: ".status", on: [...CONTAINERS, ...inside([".wizard", ".body"], [".panel", ".refusal", ".finding"])] },
	{ fg: ".brand", on: [[".wizard"]] },
	{ fg: ".progress", on: [[".wizard"]] },
	{ fg: ".drop", on: [[".wizard"]] },
	{ fg: ".drop:hover", on: [[".wizard"]] },
	{ fg: ".drop.over", on: [[".wizard"]] },
	{ fg: ".nav h2", on: [[".nav"]] },
	{ fg: ".language-label", on: [[".body"], [".wizard"]] },
	{ fg: ".strip", on: [[]] },
	{ fg: ".leftovers", on: [[".card"]] },
	// The text the PM selects: the page's own text colour on the selection tint, over every surface.
	{ fg: "html, body", on: EVERYWHERE.map((c): Chain => [...c, "::selection"]), own: false },
];

/** Rules that set a background and carry no text of their own: bars, dots, and the borders' tints. A new background rule has to be a surface in the table or listed here. */
const NO_TEXT = new Set([".seg", '.seg[data-state="done"]', '.seg[data-state="current"]', ".strip-dot"]);

/** The rules whose background is a surface that text sits on, by selector, and which of them the table puts in a chain. */
const TEXT_SURFACE_RULES = (): string[] =>
	plain
		.filter((r) => r.decls.some(([p, v]) => (p === "background" || p === "background-color") && !/gradient|\burl\(/.test(v)))
		.flatMap((r) => r.selectors)
		.filter((s) => s !== "html" && s !== "body");

function surface(base: Rgb, chain: Chain): Rgb {
	let under = base;
	for (const selector of chain) {
		const layer = surfaceOf(selector);
		assert.ok(layer !== null, `${selector} sets no plain background, so it cannot be a surface`);
		under = composite(layer, under);
	}
	return under;
}

describe("the desk's colour pairs (WCAG AA, 4.5:1), derived from the stylesheets", () => {
	const bases = pageBases();

	it("hold for every placement: each text colour read from its rule, each surface from its", () => {
		let checked = 0;
		const inherited = colorOf("html, body");
		for (const placement of PLACEMENTS) {
			const fg = placement.fg === "html, body" ? inherited : colorOf(placement.fg);
			assert.equal(fg.alpha, 1, `${placement.fg}: the text colour is opaque`);
			for (const chain of placement.on) {
				const full = [...chain, ...(placement.plus ? [placement.plus] : []), ...(placement.own !== false && placement.fg !== "html, body" && surfaceOf(placement.fg) !== null ? [placement.fg] : [])];
				for (const base of bases) {
					const value = ratio(fg.rgb, surface(base, full));
					assert.ok(value >= 4.5, `${placement.fg} on ${full.join(" > ") || "the page"}: ${value.toFixed(2)}:1`);
					checked++;
				}
			}
		}
		assert.ok(checked > 1000, `${checked} pairs checked`);
	});

	it("leave no rule that sets a text colour out of the table, and name no rule the stylesheets lack", () => {
		const setting = new Set(plain.flatMap((r) => (r.decls.some(([p]) => p === "color") ? r.selectors : [])));
		const listed = new Set(PLACEMENTS.map((p) => p.fg));
		// `html, body` is one rule written with two selectors; the table names it as the stylesheets do.
		setting.delete("html");
		setting.delete("body");
		setting.add("html, body");
		for (const selector of setting) assert.ok(listed.has(selector), `${selector} sets a color and is not in the placement table`);
		for (const selector of listed) assert.ok(setting.has(selector), `the placement table names ${selector}, which sets no color`);
		for (const name of ["html, body"]) assert.ok(rules.some((r) => r.selectors.includes("html") && r.selectors.includes("body") && r.decls.some(([p]) => p === "color")), `${name} is one rule`);
	});

	it("put every rule that sets a plain background into a placement, or list it as carrying no text", () => {
		const chained = new Set(PLACEMENTS.flatMap((p) => [...p.on.flat(), ...(p.plus ? [p.plus] : []), ...(p.own !== false && surfaceOf(p.fg) !== null ? [p.fg] : [])]));
		for (const selector of TEXT_SURFACE_RULES()) assert.ok(chained.has(selector) || NO_TEXT.has(selector), `${selector} sets a background that no placement puts text on`);
		for (const selector of NO_TEXT) assert.ok(plain.some((r) => r.selectors.includes(selector)), `NO_TEXT names ${selector}, which the stylesheets lack`);
	});

	it("read the tints from the stylesheets: a tint nobody can resolve is a failure, not a skipped pair", () => {
		for (const name of ["--tint-accent", "--tint-ok", "--tint-err", "--tint-warn", "--tint-hover"]) {
			const color = resolveColor(`var(${name})`, vars);
			assert.ok(color !== null && color.alpha > 0 && color.alpha < 1, `${name} is a translucent token colour`);
		}
	});

	it("knows the pairs the review found were below AA before their rules used the text colour (quiet text on the refusal and the finding)", () => {
		const dim = resolveColor("var(--dim)", vars);
		assert.ok(dim !== null);
		const worst = (chain: Chain) => Math.min(...bases.map((b) => ratio(dim.rgb, surface(b, chain))));
		assert.ok(worst([".wizard", ".refusal"]) < 4.5, "dim on the refusal is below AA, which is why th, details and notes there use --text");
		assert.ok(worst([".wizard", ".finding"]) < 4.5, "dim on the finding is below AA, which is why details and notes there use --text");
	});
});
