// tsc emits only .js; the shell page and its stylesheet ship as they are.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
mkdirSync(join(root, "dist", "renderer"), { recursive: true });
for (const f of ["welcome.html", "style.css"]) copyFileSync(join(root, "src", "renderer", f), join(root, "dist", "renderer", f));

const required = ["dist/main/index.js", "dist/preload/shell.cjs", "dist/renderer/welcome.js", "dist/renderer/welcome.html", "dist/renderer/style.css", "dist/renderer/i18n/zh-TW.js"];
for (const f of required) {
	if (!existsSync(join(root, f))) throw new Error(`missing build output ${f}`);
}
console.log("assets ok");
