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
		case "hosts": {
			const forge = view.hosts.current;
			if (forge === null) break;
			const { host } = forge;
			const tool = ctx.tr(`forge.tool.${forge.kind}`);
			const flow = forge.flow;
			// The checks, a refusal, the code, a problem and the outcome each speak once.
			if (flow.phase === "checking") parts.push(ctx.tr("forge.checking"));
			else if (flow.phase === "store-unavailable") parts.push(ctx.tr("forge.storeUnavailable"));
			else if (flow.phase === "plain-text") parts.push(ctx.tr("forge.storeUnavailable"), ctx.tr(flow.removed ? "forge.plainRemoved" : "forge.plainStays", { host }));
			else if (flow.phase === "foreign") parts.push(ctx.tr(flow.changed.length > 0 ? "forge.changed" : "forge.foreign", { host, tool }));
			else if (flow.phase === "code") parts.push(`${ctx.tr("forge.github.codeLabel")}: ${flow.code}`);
			else if (flow.phase === "unverified") parts.push(ctx.tr("forge.unverified", { host }));
			else if (flow.phase === "failed") parts.push(ctx.tr("forge.failed", { host, tool }));
			else if (flow.phase === "timeout") parts.push(ctx.tr("forge.timeout"));
			else if (flow.phase === "done") parts.push(ctx.tr("forge.done", { host }));
			break;
		}
		case "claude": {
			const flow = view.claude.flow;
			// The browser, a problem and the outcome each speak once; the address and the code are on the page, not read out.
			if (flow.phase === "browser") parts.push(ctx.tr("claude.browser"));
			else if (flow.phase === "failed") parts.push(ctx.tr("claude.failed"));
			else if (flow.phase === "timeout") parts.push(ctx.tr("claude.timeout"));
			else if (flow.phase === "unverified") parts.push(ctx.tr("claude.unverified"));
			else if (flow.phase === "done" || (flow.phase === "idle" && view.claude.state === "signed-in")) parts.push(ctx.tr("claude.done"));
			break;
		}
		case "linear": {
			const { flow, restart } = view.linear;
			// The start runs beside this step; its failure is drawn here too, so it is spoken here.
			if (view.start.failure !== null) {
				const sentences = catalogs[ctx.locale].start.failure as Record<string, string>;
				parts.push((sentences[view.start.failure.kind] ?? sentences.other ?? "").replaceAll("{pid}", String(view.start.failure.pid ?? "")));
			}
			if (flow.phase === "refused" || (view.linear.encryption === false && flow.phase === "idle")) parts.push(ctx.tr("linear.refused"));
			else if (flow.phase === "invalid") parts.push(ctx.tr("linear.invalid"));
			else if (flow.phase === "save-failed") parts.push(ctx.tr("linear.saveFailed"));
			else if (flow.phase === "setup-failed") parts.push(ctx.tr("linear.setupFailed"));
			else if (flow.phase === "done") parts.push(ctx.tr(flow.initialized === "kept" ? "linear.doneKept" : "linear.done"));
			if (restart.phase === "offer") parts.push(ctx.tr(restart.change === "saved" ? "linear.restart.savedLead" : "linear.restart.removedLead"));
			else if (restart.phase === "restarted") parts.push(ctx.tr("linear.restart.restarted"));
			else if (restart.phase === "failed") parts.push(ctx.tr("linear.restart.failed"));
			break;
		}
		case "projects": {
			const { rows, running, held } = view.projects;
			if (view.start.failure !== null) {
				const sentences = catalogs[ctx.locale].start.failure as Record<string, string>;
				parts.push((sentences[view.start.failure.kind] ?? sentences.other ?? "").replaceAll("{pid}", String(view.start.failure.pid ?? "")));
			}
			if (running) parts.push(ctx.tr("projects.running"));
			else if (held) parts.push(ctx.tr("projects.held"));
			else if (rows.length > 0 && !rows.some((r) => r.phase === "waiting")) parts.push(ctx.tr(rows.some((r) => r.phase === "failed") ? "projects.someFailed" : "projects.allDone"));
			break;
		}
		default:
	}
	return parts;
}

/** The parts of `next` that `previous` did not have, as one text; empty when nothing changed. */
export const newParts = (locale: Locale, previous: readonly string[], next: readonly string[]): string => next.filter((p) => !previous.includes(p)).join(locale === "zh-TW" ? "。" : ". ");
