// tsc only emits .js; the status page and preload helper are plain files that sit in src/ and ship as-is.
import { existsSync } from "node:fs";
for (const f of ["src/status.html", "src/status.js", "config.default.json", "dist/main.js", "dist/preload.js", "dist/follow.js"]) {
	if (!existsSync(f)) { console.error(`missing ${f}`); process.exit(1); }
}
console.log("assets ok");
