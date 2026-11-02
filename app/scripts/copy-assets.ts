// tsc emits only .js; the shell page and its stylesheet ship as they are.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
mkdirSync(join(root, "dist", "renderer"), { recursive: true });
for (const f of ["welcome.html", "style.css"]) copyFileSync(join(root, "src", "renderer", f), join(root, "dist", "renderer", f));
// The credential shapes every log redacts (`logs/start.jsonl` reads them at launch): the recipe's own file, so the two never drift.
mkdirSync(join(root, "dist", "assets"), { recursive: true });
copyFileSync(join(root, "..", "recipe", "secret-patterns.json"), join(root, "dist", "assets", "secret-patterns.json"));

const required = ["dist/main/index.js", "dist/preload/shell.cjs", "dist/renderer/welcome.js", "dist/renderer/welcome.html", "dist/renderer/style.css", "dist/renderer/i18n/zh-TW.js", "dist/assets/secret-patterns.json"];
for (const f of required) {
	if (!existsSync(join(root, f))) throw new Error(`missing build output ${f}`);
}
console.log("assets ok");
