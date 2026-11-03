import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

// The desk's own pages use the design tokens of the pi-straw-boss GUI's default dark theme (boss decision, 2026-11-03). They are not copied by hand: this reads the `:root` block of the GUI's
// stylesheet out of the pinned npm tarball (version and integrity from `stack.json`), and `renderer/desk-tokens.css` is generated from it. A test fails when the two differ.
// The published package ships the built stylesheet (`dist/gui/assets/index-<hash>.css`, named by `dist/gui/index.html`), not the source `gui/style.css`.

export interface PinnedPackage {
	name: string;
	version: string;
	integrity: string;
}

/** The pin of `name` in `stack.json`'s `piPackages`. */
export function pinOf(stackJson: string, name: string): PinnedPackage {
	const stack = JSON.parse(stackJson) as { piPackages?: Array<{ name: string; version: string; integrity: string }> };
	const pin = stack.piPackages?.find((p) => p.name === name);
	if (pin === undefined) throw new Error(`stack.json has no pin for ${name}`);
	return { name: pin.name, version: pin.version, integrity: pin.integrity };
}

export const tarballUrl = (pin: PinnedPackage): string => `https://registry.npmjs.org/${pin.name}/-/${pin.name}-${pin.version}.tgz`;

/** `sha512-<base64>` of the bytes, the form npm records in `integrity`. */
export const integrityOf = (bytes: Uint8Array): string => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/** The tarball of the pin: from `cacheDir` when it is there and matches the integrity, else downloaded, checked, and kept. A mismatch throws and keeps nothing. */
export async function pinnedTarball(pin: PinnedPackage, cacheDir: string = join(tmpdir(), "sbd-desk-tokens-cache"), fetchImpl: typeof fetch = fetch): Promise<Buffer> {
	const file = join(cacheDir, `${pin.name}-${pin.version}.tgz`);
	if (existsSync(file)) {
		const cached = readFileSync(file);
		if (integrityOf(cached) === pin.integrity) return cached;
	}
	const response = await fetchImpl(tarballUrl(pin), { signal: AbortSignal.timeout(120_000) });
	if (!response.ok) throw new Error(`${tarballUrl(pin)}: HTTP ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	const got = integrityOf(bytes);
	if (got !== pin.integrity) throw new Error(`${pin.name}@${pin.version}: integrity ${got} does not match the pin ${pin.integrity}`);
	mkdirSync(cacheDir, { recursive: true });
	const part = `${file}.${process.pid}.part`;
	writeFileSync(part, bytes);
	renameSync(part, file);
	return bytes;
}

/** The named files of a gzipped tar, by their path inside it. A file that is not there is absent from the map. */
export function tarFiles(tgz: Uint8Array, wanted: ReadonlySet<string>): Map<string, Buffer> {
	const tar = gunzipSync(tgz);
	const found = new Map<string, Buffer>();
	const text = (buf: Buffer, from: number, length: number): string => {
		const slice = buf.subarray(from, from + length);
		const end = slice.indexOf(0);
		return slice.subarray(0, end < 0 ? slice.length : end).toString("utf8");
	};
	let longName: string | null = null;
	for (let at = 0; at + 512 <= tar.length; ) {
		const header = tar.subarray(at, at + 512);
		if (header.every((b) => b === 0)) break;
		const size = Number.parseInt(text(header, 124, 12).trim() || "0", 8);
		const type = String.fromCharCode(header[156] ?? 0);
		const prefix = text(header, 345, 155);
		let name = prefix === "" ? text(header, 0, 100) : `${prefix}/${text(header, 0, 100)}`;
		const body = tar.subarray(at + 512, at + 512 + size);
		at += 512 + Math.ceil(size / 512) * 512;
		if (type === "L") {
			longName = text(body, 0, body.length);
			continue;
		}
		if (type === "x" || type === "g") continue;
		if (longName !== null) {
			name = longName;
			longName = null;
		}
		if ((type === "0" || type === "\0") && wanted.has(name)) found.set(name, Buffer.from(body));
	}
	return found;
}

/** The stylesheet the GUI's page loads, read out of the pinned tarball: `dist/gui/index.html` names it. */
export function guiStylesheet(tgz: Uint8Array): { file: string; css: string } {
	const index = tarFiles(tgz, new Set(["package/dist/gui/index.html"])).get("package/dist/gui/index.html");
	if (index === undefined) throw new Error("the package has no dist/gui/index.html");
	const href = /<link[^>]*rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+\.css)"/.exec(index.toString("utf8"))?.[1];
	if (href === undefined) throw new Error("dist/gui/index.html names no stylesheet");
	const path = `package/dist/gui/${href}`;
	const css = tarFiles(tgz, new Set([path])).get(path);
	if (css === undefined) throw new Error(`the package has no ${path}`);
	return { file: href, css: css.toString("utf8") };
}

/** Splits a declaration list at the semicolons that are not inside parentheses or quotes. */
function declarations(body: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let quote = "";
	let start = 0;
	for (let i = 0; i < body.length; i++) {
		const c = body[i] as string;
		if (quote !== "") {
			if (c === "\\") i++;
			else if (c === quote) quote = "";
		} else if (c === '"' || c === "'") quote = c;
		else if (c === "(") depth++;
		else if (c === ")") depth--;
		else if (c === ";" && depth === 0) {
			out.push(body.slice(start, i));
			start = i + 1;
		}
	}
	out.push(body.slice(start));
	return out.map((d) => d.trim()).filter((d) => d !== "");
}

/** The custom properties (`--name: value`) of the first `:root` block of a stylesheet, in order. The GUI declares its default (dark) theme there. */
export function rootTokens(css: string): Array<[string, string]> {
	const at = css.search(/:root\s*\{/);
	if (at < 0) throw new Error("the stylesheet has no :root block");
	const open = css.indexOf("{", at);
	let depth = 0;
	let close = -1;
	for (let i = open; i < css.length; i++) {
		if (css[i] === "{") depth++;
		else if (css[i] === "}" && --depth === 0) {
			close = i;
			break;
		}
	}
	if (close < 0) throw new Error("the :root block does not end");
	const tokens: Array<[string, string]> = [];
	for (const d of declarations(css.slice(open + 1, close))) {
		const colon = d.indexOf(":");
		const name = d.slice(0, colon).trim();
		if (colon > 0 && name.startsWith("--")) tokens.push([name, d.slice(colon + 1).trim()]);
	}
	if (tokens.length < 10) throw new Error(`the :root block holds ${tokens.length} custom properties`);
	return tokens;
}

/** The desk's token stylesheet for the pinned package. `color-scheme: dark` is the GUI's own (`html{color-scheme:dark}` in the same stylesheet, which is checked). */
export function deskTokensCss(pin: PinnedPackage, stylesheet: { file: string; css: string }): string {
	if (!/html\s*\{[^}]*color-scheme\s*:\s*dark/.test(stylesheet.css)) throw new Error("the GUI's stylesheet no longer declares color-scheme: dark on html");
	const lines = rootTokens(stylesheet.css).map(([name, value]) => `\t${name}: ${value};`);
	return `/* Generated by scripts/desk-tokens.ts from ${pin.name}@${pin.version} (${pin.integrity.slice(0, 19)}…), ${stylesheet.file}: the GUI's default dark theme. Do not edit; run \`npm run tokens\` after a pin changes. */\n:root {\n\tcolor-scheme: dark;\n${lines.join("\n")}\n}\n`;
}

/** The tokens file a pin should produce, fetching and checking the tarball as needed. */
export async function expectedTokens(stackJson: string, cacheDir?: string): Promise<string> {
	const pin = pinOf(stackJson, "pi-straw-boss");
	return deskTokensCss(pin, guiStylesheet(await pinnedTarball(pin, cacheDir)));
}
