import type { LaterItem } from "../../shared/wizard.ts";
import type { Ctx } from "./common.ts";

/** The words for one sign-in put off. */
export function laterLabel(tr: Ctx["tr"], item: LaterItem): string {
	return "host" in item ? tr(`later.${item.item}`, { host: item.host }) : tr(`later.${item.item}`);
}
