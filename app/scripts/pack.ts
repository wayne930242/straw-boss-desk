// Builds the app and packages it with electron-builder. SBD_BUILD=release makes the shipped product; any other value is the development build.
// usage: node scripts/pack.ts [--dir] [extra electron-builder arguments]
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { packPlan } from "./build-config.ts";

const root = join(import.meta.dirname, "..");
const plan = packPlan(process.env);

function run(args: string[]): void {
	const r = spawnSync(process.execPath, args, {
		cwd: root,
		stdio: "inherit",
		// A signing identity in the builder's keychain must never decide what this build is.
		env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
	});
	if (r.status !== 0) throw new Error(`node ${args.join(" ")} exited ${r.status}`);
}

console.log(`packing ${plan.identity.productName} (${plan.identity.kind}) into ${plan.outputDir}`);
run([join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.main.json"]);
run([join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.renderer.json"]);
run([join(root, "scripts", "copy-assets.ts")]);
run([join(root, "node_modules", "electron-builder", "cli.js"), ...process.argv.slice(2), "--publish", "never", ...plan.configArgs]);
