import { copyFileSync, linkSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { toolDir, type Layout } from "../../src/main/paths.ts";

// Test code: a `tools/node/<version>` folder whose `node` is the node running the test and whose npm is that node's own, so the stages that run npm
// under the private Node (`npm.ts`) run for real in a unit test. Windows keeps `node.exe` and `node_modules` at the top of the folder, macOS under `bin/`
// and `lib/`; the folder holds links to the real ones (a copy of `node.exe` where a hard link is refused).
export function installFakeNode(layout: Layout, version: string): string {
	const folder = toolDir(layout, "node", version);
	const home = dirname(process.execPath);
	if (layout.platform === "win32") {
		mkdirSync(folder, { recursive: true });
		try {
			linkSync(process.execPath, join(folder, "node.exe"));
		} catch {
			copyFileSync(process.execPath, join(folder, "node.exe"));
		}
		symlinkSync(join(home, "node_modules"), join(folder, "node_modules"), "junction");
	} else {
		mkdirSync(join(folder, "bin"), { recursive: true });
		mkdirSync(join(folder, "lib"), { recursive: true });
		symlinkSync(process.execPath, join(folder, "bin", "node"));
		symlinkSync(join(dirname(home), "lib", "node_modules"), join(folder, "lib", "node_modules"));
	}
	return folder;
}
