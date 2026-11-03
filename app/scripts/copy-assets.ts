// tsc emits only .js; the shell page and its stylesheet ship as they are.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
mkdirSync(join(root, "dist", "renderer"), { recursive: true });
for (const f of ["desk-tokens.css", "desk.css", "wizard.html", "wizard.css", "settings.html", "settings.css", "screen.html", "screen.css"]) copyFileSync(join(root, "src", "renderer", f), join(root, "dist", "renderer", f));
// The credential shapes every log redacts (`logs/start.jsonl` reads them at launch): the recipe's own file, so the two never drift.
mkdirSync(join(root, "dist", "assets"), { recursive: true });
copyFileSync(join(root, "..", "recipe", "secret-patterns.json"), join(root, "dist", "assets", "secret-patterns.json"));
// The recipe validator (it imports `./secret-patterns.json` beside it) and the app's own `stack.json`: the wizard validates the recipe a PM opens with the first, and installs from the second
// (`stack/active.json` is seeded from it). The recipe folder stays the one source; nothing is copied into the repository.
mkdirSync(join(root, "dist", "assets", "recipe"), { recursive: true });
for (const f of ["validate.mjs", "secret-patterns.json"]) copyFileSync(join(root, "..", "recipe", f), join(root, "dist", "assets", "recipe", f));
copyFileSync(join(root, "..", "stack.json"), join(root, "dist", "assets", "stack.json"));

const required = ["dist/main/index.js", "dist/preload/shell.cjs", "dist/preload/gui.cjs", "dist/renderer/screen.js", "dist/renderer/desk-tokens.css", "dist/renderer/desk.css", "dist/renderer/screen.html", "dist/renderer/screen.css", "dist/renderer/wizard.js", "dist/renderer/wizard.html", "dist/renderer/wizard.css", "dist/renderer/settings.js", "dist/renderer/settings.html", "dist/renderer/settings.css", "dist/assets/recipe/validate.mjs", "dist/assets/recipe/secret-patterns.json", "dist/assets/stack.json", "dist/renderer/i18n/zh-TW.js", "dist/assets/secret-patterns.json"];
for (const f of required) {
	if (!existsSync(join(root, f))) throw new Error(`missing build output ${f}`);
}
console.log("assets ok");
