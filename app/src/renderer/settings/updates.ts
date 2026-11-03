import { h } from "../dom.ts";
import { sectionBox, soon, type SettingsCtx } from "./common.ts";

/** Updates (task 13 fills Check now and Restart to update): the app's version. */
export const updates = (ctx: SettingsCtx): HTMLElement => sectionBox(ctx, "updates", h("p", { id: "app-version" }, ctx.tr("settings.updates.version", { version: ctx.view.appVersion })), soon(ctx));
