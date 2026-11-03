import { sectionBox, soon, type SettingsCtx } from "./common.ts";

/** Diagnostics (task 14 fills the status, the logs, Collect diagnostics and Repair). */
export const diagnostics = (ctx: SettingsCtx): HTMLElement => sectionBox(ctx, "diagnostics", soon(ctx));
