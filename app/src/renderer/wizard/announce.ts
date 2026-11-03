import type { Locale } from "../../shared/locale.ts";
import { catalogs } from "../i18n/index.ts";
import { trOr, type Ctx } from "./common.ts";
import { failureSentence, nowLine } from "./install.ts";

// What a screen reader is told (T9-F004). The page redraws a whole step on every change, so the step is not a live region: this page keeps one `#announce` region and speaks only the parts
// that were not in the last announcement. A step change speaks its heading; a stage that starts, a refusal, a problem, a failure speak their own sentence once.

/** The sentences that describe this view for someone who cannot see it, each one a part that can appear or go on its own. */
export function announcementParts(ctx: Ctx): string[] {
	const { view } = ctx;
	if (view.step === "launching") return [ctx.tr("welcome.launching")];
	const parts = [ctx.tr(`steps.${view.step}`)];
	switch (view.step) {
		case "recipe":
			if (view.recipe.refused.length > 0) parts.push(ctx.tr("recipe.refusedTitle"));
			break;
		case "folder":
			if (view.folder.problem !== null) parts.push(trOr(ctx, `folder.problems.${view.folder.problem}`, "folder.problems.outside-home"));
			break;
		case "install": {
			const i = view.install;
			const now = nowLine(ctx, i);
			if (now !== null) parts.push(now);
			if (i.status === "done") parts.push(ctx.tr("install.allDone"));
			for (const f of i.failures) parts.push(failureSentence(ctx, f));
			if (i.crashed !== null) parts.push(ctx.tr("install.crashed"));
			break;
		}
		case "start": {
			const s = view.start;
			if (s.status === "starting") parts.push(ctx.tr("banner.starting"));
			if (s.failure !== null) {
				const sentences = catalogs[ctx.locale].start.failure as Record<string, string>;
				parts.push((sentences[s.failure.kind] ?? sentences.other ?? "").replaceAll("{pid}", String(s.failure.pid ?? "")));
			}
			break;
		}
		default:
	}
	return parts;
}

/** The parts of `next` that `previous` did not have, as one text; empty when nothing changed. */
export const newParts = (locale: Locale, previous: readonly string[], next: readonly string[]): string => next.filter((p) => !previous.includes(p)).join(locale === "zh-TW" ? "。" : ". ");
