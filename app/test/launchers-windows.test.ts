import assert from "node:assert/strict";
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { systemEnv } from "../src/main/env.ts";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { FORGE_LAUNCHERS, launcherFiles, optionalLaunchers } from "../src/main/bootstrap/stages/launcher-files.ts";
import { pathFiles } from "../src/main/bootstrap/stages/path-files.ts";
import { computeLayout, toolDir, toolExecutable, type Layout } from "../src/main/paths.ts";
import { run } from "./harness/e2e-light.ts";

// T5-F007: the .cmd launchers under a root whose name holds `^`, `!`, `%`, `&`, a space, and CJK characters. The tools are copies of node.exe, which
// prints what it is asked (`-p`), so the answer shows the environment the launcher built. Windows only: cmd.exe parses these characters its own way.
const skip = process.platform === "win32" ? false : "Windows only: cmd.exe's handling of ^ ! % & in a batch file's own path";

const ROOT_NAMES = ["a^b!c%d&e 測試", "plain 測試", "100%", "x!y!", "^^", "a&b", "(1) b"];

describe("the .cmd launchers under a root with cmd's special characters (T5-F007)", { skip }, () => {
	let base = "";
	const roots: Array<{ name: string; layout: Layout }> = [];

	before(() => {
		base = realpathSync.native(mkdtempSync(join(tmpdir(), "sbd-cmd-")));
		const enabled = { clis: ["gh"] as ("gh" | "glab")[], optional: ["bun"] };
		const versions = { node: "24.22.1", git: "2.56.0.3", herdr: "0.9.5", gh: "2.103.3", optional: { bun: "1.2.23" } };
		let copied: string | null = null;
		for (const name of ROOT_NAMES) {
			const root = join(base, name);
			const layout = computeLayout({ root, home: base, platform: "win32" });
			const bin = layout.tools.bin;
			mkdirSync(bin, { recursive: true });
			const specs = [FORGE_LAUNCHERS.gh, ...optionalLaunchers("bun")];
			for (const [file, text] of Object.entries({ ...launcherFiles("win32", specs), ...pathFiles("win32", layout, versions, enabled) })) writeFileSync(join(bin, file), text);
			for (const [tool, version] of [["gh", "2.103.3"], ["bun", "1.2.23"]] as const) {
				const exe = join(toolDir(layout, tool, version), ...toolExecutable("win32", tool).split("/"));
				mkdirSync(dirname(exe), { recursive: true });
				// One real copy of node.exe, then links (the temporary folder is on one volume).
				if (copied === null) {
					copyFileSync(process.execPath, exe);
					copied = exe;
				} else {
					try {
						linkSync(copied, exe);
					} catch {
						copyFileSync(process.execPath, exe);
					}
				}
			}
			roots.push({ name, layout });
		}
	});

	after(() => removeTree(base));

	const comspec = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
	const ask = async (layout: Layout, launcher: string, expression: string, delayed: boolean): Promise<string> => {
		const flags = delayed ? ["/v:on"] : [];
		const result = await run(comspec, ["/d", ...flags, "/c", `${launcher}.cmd`, "-p", expression], { env: systemEnv("win32", process.env), cwd: layout.tools.bin });
		assert.equal(result.code, 0, `${launcher}.cmd under ${layout.root} (delayed expansion ${delayed ? "on" : "default"}): ${result.stderr || result.stdout}`);
		return result.stdout.trim();
	};

	for (const delayed of [false, true]) {
		it(`finds its root, reads paths.cmd, and builds its environment${delayed ? " with delayed expansion switched on (cmd /v:on, as the per-user setting does)" : ""}`, async () => {
			for (const { layout } of roots) {
				assert.equal(await ask(layout, "gh", "process.env.GH_CONFIG_DIR", delayed), join(layout.root, "config", "gh"), layout.root);
				assert.equal(await ask(layout, "gh", "process.env.DO_NOT_TRACK", delayed), "1", layout.root);
				assert.equal(await ask(layout, "gh", "process.env.GH_TELEMETRY", delayed), "disabled", layout.root);
				// bun's folders arrive as their 8.3 short names (an ASCII spelling of the same folder); with 8.3 off they are the long names.
				const home = await ask(layout, "bun", "process.env.BUN_INSTALL", delayed);
				assert.equal(realpathSync.native(home).toLowerCase(), join(layout.root, "tools", "bun-home").toLowerCase(), layout.root);
				const cache = await ask(layout, "bun", "process.env.BUN_INSTALL_CACHE_DIR", delayed);
				assert.equal(realpathSync.native(cache).toLowerCase(), join(layout.root, "tools", "bun-home", "install", "cache").toLowerCase(), layout.root);
				// bunx is `bun x ...`: the stand-in node would read `x` as a script, so it is only checked by its text (tool-stages tests).
			}
		});
	}

	it("leaves the caller's working folder alone: the launcher does not stay in tools\\bin", async () => {
		// An absolute launcher path on the command line is quoted by Node for spaces only, so this root has none of cmd's special characters.
		const { layout } = roots.find((r) => r.name === "plain 測試") as { layout: Layout };
		const elsewhere = join(base, "elsewhere 測試");
		mkdirSync(elsewhere);
		const result = await run(comspec, ["/d", "/c", join(layout.tools.bin, "gh.cmd"), "-p", "process.cwd()"], { env: systemEnv("win32", process.env), cwd: elsewhere });
		assert.equal(result.code, 0, result.stderr || result.stdout);
		assert.equal(result.stdout.trim().toLowerCase(), elsewhere.toLowerCase());
	});
});
