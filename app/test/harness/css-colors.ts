import { contrast, over, parseHex, type Rgb } from "./contrast.ts";

// What the desk's colour tests read from the stylesheets themselves (R9-F003): a small CSS reader (rules, declarations, `@media`), a resolver for the only colour forms the sheets may use,
// and the placement table's arithmetic. A test that copied the percentages or the colours would not follow a change in the CSS; this one reads them.

export interface Rule {
	selectors: string[];
	decls: Array<[property: string, value: string]>;
	/** The `@media` prelude the rule sits in, or null at the top level. */
	media: string | null;
}

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Splits `text` at `separator` characters that are outside parentheses and quotes. */
export function splitTop(text: string, separator: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quote: string | null = null;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i] as string;
		if (quote !== null) {
			if (c === "\\") i++;
			else if (c === quote) quote = null;
		} else if (c === '"' || c === "'") quote = c;
		else if (c === "(" || c === "[") depth++;
		else if (c === ")" || c === "]") depth--;
		else if (c === separator && depth === 0) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(text.slice(start));
	return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/** The index of the `}` that closes the `{` at `open`. */
function closing(text: string, open: number): number {
	let depth = 0;
	let quote: string | null = null;
	for (let i = open; i < text.length; i++) {
		const c = text[i] as string;
		if (quote !== null) {
			if (c === "\\") i++;
			else if (c === quote) quote = null;
		} else if (c === '"' || c === "'") quote = c;
		else if (c === "{") depth++;
		else if (c === "}" && --depth === 0) return i;
	}
	throw new Error("a block is not closed");
}

/** Every style rule of a stylesheet, `@media` blocks included (marked), `@keyframes` and other at-rules left out. */
export function parseRules(css: string, media: string | null = null): Rule[] {
	const text = stripComments(css);
	const rules: Rule[] = [];
	let at = 0;
	while (at < text.length) {
		const open = text.indexOf("{", at);
		if (open < 0) break;
		const prelude = text.slice(at, open).trim();
		const end = closing(text, open);
		const body = text.slice(open + 1, end);
		if (prelude.startsWith("@media")) rules.push(...parseRules(body, prelude));
		else if (!prelude.startsWith("@")) {
			const decls = splitTop(body, ";").flatMap((d): Array<[string, string]> => {
				const colon = d.indexOf(":");
				return colon < 0 ? [] : [[d.slice(0, colon).trim().toLowerCase(), d.slice(colon + 1).trim()]];
			});
			rules.push({ selectors: splitTop(prelude, ","), decls, media });
		}
		at = end + 1;
	}
	return rules;
}

export interface Rgba {
	rgb: Rgb;
	alpha: number;
}

/**
 * A colour value as the stylesheets may write it: a token (`var(--x)`, from `vars`), `transparent`, a hex colour, or `color-mix(in srgb, <colour> N%, transparent)`, which is that colour at
 * alpha N%. Anything else is not resolved, and the caller fails on it.
 */
export function resolveColor(value: string, vars: ReadonlyMap<string, string>, depth = 0): Rgba | null {
	const v = value.trim();
	if (depth > 8) return null;
	if (v === "transparent") return { rgb: [0, 0, 0], alpha: 0 };
	if (/^#[0-9a-f]{3,8}$/i.test(v)) {
		const { rgb, alpha } = parseHex(v);
		return { rgb, alpha };
	}
	const token = /^var\(\s*(--[\w-]+)\s*\)$/.exec(v);
	if (token) {
		const raw = vars.get(token[1] as string);
		return raw === undefined ? null : resolveColor(raw, vars, depth + 1);
	}
	const mix = /^color-mix\(\s*in srgb\s*,\s*(.+?)\s+(\d+(?:\.\d+)?)%\s*,\s*transparent\s*\)$/.exec(v);
	if (mix) {
		const inner = resolveColor(mix[1] as string, vars, depth + 1);
		return inner === null ? null : { rgb: inner.rgb, alpha: inner.alpha * (Number(mix[2]) / 100) };
	}
	return null;
}

/** `top` over an opaque `base`. */
export const composite = (top: Rgba, base: Rgb): Rgb => over(top.rgb, top.alpha, base);

export const ratio = (fg: Rgb, bg: Rgb): number => contrast(fg, bg);

// ---- the allowlist of colour-valued declarations ------------------------------------------------------------------------------

/** Properties whose value is, or holds, a colour. */
export const COLOR_PROPERTIES = new Set(["color", "background", "background-color", "background-image", "border", "border-color", "outline", "outline-color", "box-shadow", "text-shadow", "accent-color", "caret-color", "fill", "stroke", "scrollbar-color", "text-decoration-color", "column-rule-color"]);

/** CSS named colours: a name in a colour-valued declaration is a hand-written colour. */
const NAMED = new Set(
	"aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen canvas canvastext field fieldtext highlight highlighttext linktext buttonface buttontext graytext".split(" "),
);

/** Functions a colour-valued declaration may call besides the two colour forms: gradients and arithmetic over lengths. */
const NEUTRAL_FUNCTIONS = new Set(["linear-gradient", "radial-gradient", "conic-gradient", "calc", "min", "max", "clamp", "var", "color-mix"]);

const ALLOWED_FORMS = [/color-mix\(\s*in srgb\s*,\s*var\(\s*--[\w-]+\s*\)\s+\d+(?:\.\d+)?%\s*,\s*transparent\s*\)/g, /var\(\s*--[\w-]+\s*\)/g];

/** What in `value` is a hand-written colour: a hex colour, a colour function, a name, or a `color-mix` that is not `color-mix(in srgb, var(--x) N%, transparent)`. Empty when there is none. */
export function handWrittenColors(value: string): string[] {
	const found: string[] = [];
	let rest = value;
	for (const form of ALLOWED_FORMS) rest = rest.replace(form, " ");
	for (const m of rest.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) found.push(m[0]);
	for (const m of rest.matchAll(/([a-zA-Z-]+)\(/g)) if (!NEUTRAL_FUNCTIONS.has((m[1] as string).toLowerCase()) || (m[1] as string).toLowerCase() === "color-mix") found.push(`${m[1]}(`);
	for (const m of rest.matchAll(/(?<![\w-])([a-zA-Z]+)(?![\w(-])/g)) if (NAMED.has((m[1] as string).toLowerCase())) found.push(m[1] as string);
	return found;
}
