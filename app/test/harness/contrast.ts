// WCAG contrast for the desk's colour pairs, over the tokens of `desk-tokens.css` (a colour there is `#rgb`, `#rrggbb` or `#rrggbbaa`).
export type Rgb = [number, number, number];

export function parseHex(hex: string): { rgb: Rgb; alpha: number } {
	let h = hex.trim().replace(/^#/, "");
	if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
	if (h.length !== 6 && h.length !== 8) throw new Error(`not a colour: ${hex}`);
	const n = (i: number): number => Number.parseInt(h.slice(i, i + 2), 16);
	return { rgb: [n(0), n(2), n(4)], alpha: h.length === 8 ? n(6) / 255 : 1 };
}

/** `top` over `base`, both opaque unless `alpha` says otherwise. */
export const over = (top: Rgb, alpha: number, base: Rgb): Rgb => [0, 1, 2].map((i) => (top[i] as number) * alpha + (base[i] as number) * (1 - alpha)) as Rgb;

/** `color-mix(in srgb, c p%, transparent)` over a base is the same as `c` at alpha `p`. */
export const tint = (c: Rgb, percent: number, base: Rgb): Rgb => over(c, percent / 100, base);

function luminance([r, g, b]: Rgb): number {
	const lin = (v: number): number => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: Rgb, b: Rgb): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
}

/** The custom properties of a tokens stylesheet. */
export function tokenMap(css: string): Map<string, string> {
	return new Map([...css.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1] as string, (m[2] as string).trim()]));
}
