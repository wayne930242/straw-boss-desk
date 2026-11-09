import type { ElectronApplication, Page } from "playwright-core";

/**
 * Loads a page in the gallery window with `view`, and returns once `page` is on the new document. The main process answers when `loadFile` has finished; Playwright hears of the navigation a
 * moment later through its own channel, and until then a read through `page` goes to the old document, which is being destroyed. The old document is marked, and the page is the new one when it no
 * longer carries the mark.
 */
export async function loadGalleryFile(app: ElectronApplication, page: Page, file: "wizard" | "settings", view: unknown): Promise<void> {
	await page.evaluate(() => {
		(window as unknown as { __galleryOld?: boolean }).__galleryOld = true;
	});
	await app.evaluate(
		async (_, input: { file: string; view: unknown }) => {
			const g = globalThis as unknown as { __gallery: { state: Record<string, unknown>; win: { loadFile(p: string): Promise<void> }; dist: string } };
			g.__gallery.state[input.file] = input.view;
			g.__gallery.state.locale = (input.view as { locale: string }).locale;
			await g.__gallery.win.loadFile(`${g.__gallery.dist}/renderer/${input.file}.html`);
		},
		{ file, view },
	);
	await page.waitForFunction(() => (window as unknown as { __galleryOld?: boolean }).__galleryOld !== true, undefined, { polling: 50, timeout: 30_000 });
}
