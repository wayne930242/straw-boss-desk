import type { Page } from "playwright-core";

// A screenshot of the whole settings page, the part below the fold included. The settings layout is as high as the window (`settings.css`: `.layout { height: 100% }`) and its panels scroll inside it
// (`.body { overflow: auto }`), so `fullPage: true` alone shoots the window and cuts off a confirmation, a result or a list of problems that runs longer (T14-F010). For the shot the layout takes the height
// of its content and the panels stop scrolling; the page is put back afterwards. The rule goes in as a constructed style sheet: the page's Content Security Policy (`style-src 'self'`) refuses an inline
// `<style>` (what `page.addStyleTag` makes), and a sheet built from script is allowed.
// The page's own background is on `body` as a fixed gradient, which paints the window's height only; with the page taller than the window the rest showed as a darker band (SA-T14-5). For the shot `html` has no
// background of its own, and the body's gradient scrolls with the page and sits on a flat colour, so it covers the whole canvas.
const WHOLE = "html, body, .layout { height: auto !important; min-height: 100% !important; } html { background: transparent !important; } body { background-attachment: scroll !important; background-color: var(--bg) !important; } .body, .nav { overflow: visible !important; }";

export async function shotWhole(page: Page, path: string): Promise<void> {
	const sheet = await page.evaluateHandle((css) => {
		const s = new CSSStyleSheet();
		s.replaceSync(css);
		document.adoptedStyleSheets = [...document.adoptedStyleSheets, s];
		return s;
	}, WHOLE);
	try {
		await page.screenshot({ path, fullPage: true });
	} finally {
		await page.evaluate((s) => {
			document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== s);
		}, sheet);
		await sheet.dispose();
	}
}
