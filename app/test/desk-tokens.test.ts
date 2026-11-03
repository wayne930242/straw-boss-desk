import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, it } from "node:test";
import { deskTokensCss, expectedTokens, guiStylesheet, integrityOf, pinnedTarball, pinOf, rootTokens, tarFiles } from "../scripts/lib/desk-tokens.ts";
import { contrast, over, parseHex, tint, tokenMap, type Rgb } from "./harness/contrast.ts";
import { readText, sourceFiles } from "./harness/ui-rules.ts";

// The desk's pages use the tokens of the pi-straw-boss GUI's default dark theme (boss decision, 2026-11-03): generated from the pinned package, never copied by hand, and checked here.

const renderer = join(import.meta.dirname, "..", "src", "renderer");
const stackJson = readFileSync(join(import.meta.dirname, "..", "..", "stack.json"), "utf8");
const committed = readFileSync(join(renderer, "desk-tokens.css"), "utf8");

/** A one-file-per-entry ustar archive, gzipped, as `npm pack` makes. */
function tgz(files: Record<string, string>): Buffer {
	const blocks: Buffer[] = [];
	for (const [name, content] of Object.entries(files)) {
		const body = Buffer.from(content);
		const header = Buffer.alloc(512);
		header.write(name, 0, "utf8");
		header.write("0000644\0", 100);
		header.write("0000000\0", 108);
		header.write("0000000\0", 116);
		header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
		header.write("00000000000\0", 136);
		header.write("        ", 148);
		header.write("0", 156);
		header.write("ustar\0", 257);
		header.write("00", 263);
		const sum = [...header].reduce((a, b) => a + b, 0);
		header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
		blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

const CSS = `:root{--bg:#16161e;--accent:#7dcfff;--mono:ui-monospace, "SF Mono", Menlo;--sans:system-ui, "A;B";--a:1;--b:2;--c:3;--d:4;--e:5;--f:6;--g:7;--h:8}*{margin:0}html{color-scheme:dark}.x{color:red}`;
const PAGE = `<html><head><link rel="stylesheet" crossorigin href="./assets/index-XYZ.css"></head></html>`;
const fakePackage = (css = CSS) => tgz({ "package/package.json": "{}", "package/dist/gui/index.html": PAGE, "package/dist/gui/assets/index-XYZ.css": css });

describe("the tokens generator", () => {
	it("reads the first :root block, keeping values with commas, parentheses and quoted semicolons whole", () => {
		const tokens = rootTokens(CSS);
		assert.equal(tokens.length, 12);
		assert.deepEqual(tokens[0], ["--bg", "#16161e"]);
		assert.deepEqual(tokens[2], ["--mono", 'ui-monospace, "SF Mono", Menlo']);
		assert.deepEqual(tokens[3], ["--sans", 'system-ui, "A;B"']);
		assert.throws(() => rootTokens("html{}"), /no :root/);
		assert.throws(() => rootTokens(":root{--a:1}"), /holds 1 custom/);
	});

	it("finds the stylesheet the package's GUI page names, and fails when there is none", () => {
		const found = guiStylesheet(fakePackage());
		assert.equal(found.file, "assets/index-XYZ.css");
		assert.equal(found.css, CSS);
		assert.throws(() => guiStylesheet(tgz({ "package/dist/gui/index.html": "<html></html>" })), /names no stylesheet/);
		assert.throws(() => guiStylesheet(tgz({ "package/package.json": "{}" })), /no dist\/gui\/index.html/);
		assert.equal(tarFiles(fakePackage(), new Set(["package/nope"])).size, 0);
	});

	it("writes every token of the block and the GUI's dark colour scheme, and refuses a stylesheet that is no longer dark", () => {
		const pin = { name: "pi-straw-boss", version: "9.9.9", integrity: "sha512-abcdefghijklmnopqrstuvwxyz" };
		const css = deskTokensCss(pin, guiStylesheet(fakePackage()));
		assert.match(css, /pi-straw-boss@9\.9\.9/);
		assert.match(css, /color-scheme: dark;/);
		assert.deepEqual(rootTokens(css), rootTokens(CSS));
		assert.throws(() => deskTokensCss(pin, { file: "x.css", css: CSS.replace("color-scheme:dark", "color-scheme:light") }), /color-scheme: dark/);
	});

	it("takes only a tarball that matches the pinned integrity, and keeps nothing else", async () => {
		const bytes = fakePackage();
		const pin = { name: "pi-straw-boss", version: "9.9.9", integrity: integrityOf(bytes) };
		const dir = join(process.env.TMPDIR ?? "/tmp", `sbd-tokens-${process.pid}`);
		const answer = (body: Buffer): typeof fetch => (async () => new Response(new Uint8Array(body))) as typeof fetch;
		assert.deepEqual(await pinnedTarball(pin, dir, answer(bytes)), bytes);
		// Now cached: a fetch that would fail is never called.
		assert.deepEqual(await pinnedTarball(pin, dir, (() => Promise.reject(new Error("no network"))) as typeof fetch), bytes);
		await assert.rejects(pinnedTarball({ ...pin, version: "9.9.8" }, dir, answer(fakePackage(CSS.replace("#16161e", "#000000")))), /integrity .* does not match the pin/);
	});

	it("reads the pin from stack.json and fails on a package that is not pinned", () => {
		assert.equal(pinOf(stackJson, "pi-straw-boss").name, "pi-straw-boss");
		assert.throws(() => pinOf(stackJson, "not-a-package"), /no pin/);
	});
});

describe("desk-tokens.css", () => {
	it("is exactly what the pinned pi-straw-boss package gives (fails when a token is edited by hand or the pin moves without `npm run tokens`)", async () => {
		const expected = await expectedTokens(stackJson, process.env.SBD_TOKENS_CACHE);
		assert.equal(committed, expected);
	});

	it("holds only custom properties and the colour scheme, in a single :root block", () => {
		const body = committed.replace(/\/\*[\s\S]*?\*\//, "").trim();
		assert.match(body, /^:root \{[\s\S]*\}$/);
		for (const line of body.split("\n").slice(1, -1)) assert.match(line, /^\t(--[\w-]+|color-scheme): .+;$/, line);
	});
});

describe("the desk's stylesheets", () => {
	const pages = ["wizard", "settings", "screen"] as const;
	const own = ["desk.css", "wizard.css", "settings.css", "screen.css"].map((f) => join(renderer, f));

	it("write no colour of their own: every one is a token of the GUI's theme or a mix of tokens", () => {
		for (const file of own) {
			const css = readText(file).replace(/\/\*[\s\S]*?\*\//g, "");
			assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, `${file} has a hex colour`);
			assert.doesNotMatch(css, /\b(?:rgb|rgba|hsl|hsla|oklch|lab)\(/, `${file} has a colour function`);
			assert.doesNotMatch(css, /\b(?:white|black|red|green|blue|orange)\b\s*[;}]/, `${file} has a named colour`);
		}
	});

	it("are all loaded by each page, tokens first", () => {
		for (const page of pages) {
			const links = [...readText(join(renderer, `${page}.html`)).matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
			assert.deepEqual(links, ["desk-tokens.css", "desk.css", `${page}.css`]);
		}
		assert.equal(sourceFiles(renderer, [".css"]).length, 5);
	});

	it("give every foreground and background pair they use at least 4.5:1 (WCAG AA)", () => {
		const t = tokenMap(committed);
		const c = (name: string): Rgb => parseHex(t.get(`--${name}`) ?? "").rgb;
		const panelOver = (base: Rgb): Rgb => {
			const p = parseHex(t.get("--panel") ?? "");
			return over(p.rgb, p.alpha, base);
		};
		// The page behind everything runs from --bg to --bg-2; a pair has to hold on both ends.
		const pairs: Array<[string, Rgb, (base: Rgb) => Rgb]> = [];
		const add = (name: string, fg: Rgb, bg: (base: Rgb) => Rgb): number => pairs.push([name, fg, bg]);
		const pageBg = (b: Rgb): Rgb => b;
		const panel = (b: Rgb): Rgb => panelOver(b);
		const hoverTint = (b: Rgb): Rgb => tint(c("hi"), 4, panelOver(b));
		add("text on the page", c("text"), pageBg);
		add("text on a panel", c("text"), panel);
		add("text on an input (surface-0)", c("text"), () => c("surface-0"));
		add("text on a code block (sunken)", c("text"), () => c("sunken"));
		add("text on a hovered button (hover tint on a panel)", c("text"), hoverTint);
		add("quiet text on the page", c("dim"), pageBg);
		add("quiet text on a panel", c("dim"), panel);
		add("quiet text on a code block", c("dim"), () => c("sunken"));
		add("placeholder on an input", c("dim"), () => c("surface-0"));
		add("accent text on a panel", c("accent"), panel);
		add("accent text on the page", c("accent"), pageBg);
		add("accent badge text on its tint", c("accent"), (b) => tint(c("accent"), 14, panelOver(b)));
		add("done badge text on its tint", c("ok"), (b) => tint(c("ok"), 12, panelOver(b)));
		add("failure text on its tint", c("err-soft"), (b) => tint(c("err"), 12, panelOver(b)));
		add("text on a warning", c("text"), (b) => tint(c("amber"), 8, panelOver(b)));
		add("text on a pressed button", c("text"), (b) => tint(c("accent"), 22, panelOver(b)));
		add("ink on the primary button", c("ink"), () => c("accent"));
		add("ink on the primary button, hovered", c("ink"), () => c("accent-hi"));
		add("text on the notice row (bg-2)", c("text"), () => c("bg-2"));
		for (const [name, fg, bg] of pairs) {
			for (const end of [c("bg"), c("bg-2")]) {
				const ratio = contrast(fg, bg(end));
				assert.ok(ratio >= 4.5, `${name}: ${ratio.toFixed(2)}:1`);
			}
		}
		assert.ok(pairs.length >= 18);
	});
});
