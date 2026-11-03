import { sectionBox, soon, type SettingsCtx } from "./common.ts";

/** Team guidance (the installer's notices, with Keep mine or Use the team version): a later task fills it. */
export const guidance = (ctx: SettingsCtx): HTMLElement => sectionBox(ctx, "guidance", soon(ctx));
