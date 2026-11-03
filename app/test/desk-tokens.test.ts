import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { after, describe, it } from "node:test";
import { deskTokensCss, expectedTokens, guiStylesheet, integrityOf, pinnedTarball, pinOf, rootTokens, tarFiles } from "../scripts/lib/desk-tokens.ts";
import { COLOR_PROPERTIES, handWrittenColors, parseRules } from "./harness/css-colors.ts";
import { readText, sourceFiles } from "./harness/ui-rules.ts";

// The desk's pages use the tokens of the pi-straw-boss GUI's default dark theme (boss decision, 2026-11-03): generated from the pinned package, never copied by hand, and checked here.

const renderer = join(import.meta.dirname, "..", "src", "renderer");
const stackJson = readFileSync(join(import.meta.dirname, "..", "..", "stack.json"), "utf8");
const committed = readFileSync(join(renderer, "desk-tokens.css"), "utf8");

/** Scratch folders of these tests, removed when they are done (R9-F004 c): none is left in TMPDIR. */
const scratchDirs: string[] = [];
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "sbd-tokens-"));
	scratchDirs.push(dir);
	return dir;
};
after(() => {
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

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
		const block = ":root{--a:1;--b:2;--c:3;--d:4;--e:5;--f:6;--g:7;--h:8;--i:9;--j:10}";
		assert.equal(rootTokens(`@media (prefers-color-scheme:light){html{}} ${block}`).length, 10, "an at-rule before the block is no problem");
		assert.equal(rootTokens(`/* :root{ in a comment */ a{content:"{"} ${block}`).length, 10, "braces in strings and comments are skipped");
		assert.throws(() => rootTokens(`@media (prefers-color-scheme:light){${block}} ${block}`), /inside an at-rule/, "a light block ahead of the default one is refused");
		assert.throws(() => rootTokens(`@supports (color:red){${block}}`), /inside an at-rule/);
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
		const dir = scratch();
		const answer = (body: Buffer): typeof fetch => (async () => new Response(new Uint8Array(body))) as typeof fetch;
		assert.deepEqual(await pinnedTarball(pin, dir, answer(bytes)), bytes);
		// Now cached: a fetch that would fail is never called.
		assert.deepEqual(await pinnedTarball(pin, dir, (() => Promise.reject(new Error("no network"))) as typeof fetch), bytes);
		await assert.rejects(pinnedTarball({ ...pin, version: "9.9.8" }, dir, answer(fakePackage(CSS.replace("#16161e", "#000000")))), /integrity .* does not match the pin/);
	});

	it("says what is missing when the tarball cannot be fetched and the cache is cold (offline), not only 'fetch failed' (R9-F004 c)", async () => {
		const pin = { name: "pi-straw-boss", version: "9.9.9", integrity: integrityOf(fakePackage()) };
		await assert.rejects(pinnedTarball(pin, scratch(), (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch), /could not be fetched; connect to the network, or set SBD_TOKENS_CACHE to a folder that holds pi-straw-boss-9\.9\.9\.tgz \(fetch failed\)/);
		await assert.rejects(pinnedTarball(pin, scratch(), (async () => new Response("no", { status: 503 })) as typeof fetch), /could not be fetched.*HTTP 503/);
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

	it("write no colour of their own: every colour-valued declaration holds only tokens, mixes of tokens with transparent, transparent and currentColor", () => {
		let checked = 0;
		for (const file of own) {
			for (const rule of parseRules(readText(file))) {
				for (const [property, value] of rule.decls) {
					if (!COLOR_PROPERTIES.has(property) && !property.startsWith("--")) continue;
					assert.deepEqual(handWrittenColors(value), [], `${file}: ${rule.selectors.join(", ")} { ${property}: ${value} }`);
					checked++;
				}
			}
		}
		assert.ok(checked > 80, `${checked} colour-valued declarations read`);
	});

	it("catches hand-written colours of every form (an allowlist, not a list of the forms somebody thought of)", () => {
		for (const bad of ["#fff", "#16161e", "rgb(1, 2, 3)", "rgba(1,2,3,.5)", "hsl(10 20% 30%)", "hwb(10 20% 30%)", "lab(50 10 10)", "oklab(0.5 0.1 0.1)", "oklch(0.5 0.1 10)", "color(display-p3 1 0 0)", "light-dark(white, black)", "red", "White", "rebeccapurple", "color-mix(in srgb, white 50%, transparent)", "color-mix(in oklab, var(--accent) 50%, transparent)", "color-mix(in srgb, var(--accent) 50%, red)", "linear-gradient(red, var(--bg))", "1px solid #abc", "canvas"]) {
			assert.notDeepEqual(handWrittenColors(bad), [], bad);
		}
		for (const good of ["var(--text)", "transparent", "currentColor", "color-mix(in srgb, var(--accent) 14%, transparent)", "1px solid var(--line)", "linear-gradient(var(--bg), var(--bg-2))", "radial-gradient(1100px 640px at 12% -10%, var(--aura-1), transparent 62%)", "2px dashed var(--line)", "none", "var(--line-c) transparent"]) {
			assert.deepEqual(handWrittenColors(good), [], good);
		}
	});

	it("make the page's scrollbars and native controls dark (SA-08): the dark colour scheme comes from the tokens, the scrollbar colours from tokens too", () => {
		assert.match(committed, /^\s*color-scheme: dark;$/m);
		const desk = parseRules(readText(join(renderer, "desk.css")));
		const html = desk.find((r) => r.selectors.includes("html") && r.decls.some(([p]) => p === "scrollbar-color"));
		assert.ok(html, "desk.css sets scrollbar-color on html, which every scroller inherits");
		assert.match(html.decls.find(([p]) => p === "scrollbar-color")?.[1] ?? "", /^var\(--[\w-]+\) transparent$/);
	});

	it("are all loaded by each page, tokens first", () => {
		for (const page of pages) {
			const links = [...readText(join(renderer, `${page}.html`)).matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
			assert.deepEqual(links, ["desk-tokens.css", "desk.css", `${page}.css`]);
		}
		assert.equal(sourceFiles(renderer, [".css"]).length, 5);
	});
});
