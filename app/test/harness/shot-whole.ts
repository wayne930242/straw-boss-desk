import type { Page } from "playwright-core";

// A screenshot of the whole settings page, the part below the fold included. The settings layout is as high as the window (`settings.css`: `.layout { height: 100% }`) and its panels scroll inside it
// (`.body { overflow: auto }`), so `fullPage: true` alone shoots the window and cuts off a confirmation, a result or a list of problems that runs longer (T14-F010). For the shot the layout takes the height
// of its content and the panels stop scrolling; the page is put back afterwards.
const WHOLE = "html, body, .layout { height: auto !important; min-height: 100% !important; } .body, .nav { overflow: visible !important; }";

export async function shotWhole(page: Page, path: string): Promise<void> {
	const style = await page.addStyleTag({ content: WHOLE });
	try {
		await page.screenshot({ path, fullPage: true });
	} finally {
		await style.evaluate((el) => (el as Element).remove());
	}
}
