// Does the Claude Agent SDK, as pi-claude-bridge installed it, have a Windows executable for this machine?
// usage: node sdk-exe.mjs <pi-claude-bridge package dir>
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const bridge = process.argv[2];
const req = createRequire(join(bridge, "package.json"));
const res = { nodeArch: process.arch, platform: process.platform, sdk: null, packages: {}, executables: [] };
try {
	const sdkPkg = req.resolve("@anthropic-ai/claude-agent-sdk/package.json");
	res.sdk = { path: dirname(sdkPkg), version: JSON.parse((await import("node:fs")).readFileSync(sdkPkg, "utf8")).version };
	const sdkReq = createRequire(sdkPkg);
	for (const arch of ["x64", "arm64"]) {
		const name = `@anthropic-ai/claude-agent-sdk-win32-${arch}`;
		try {
			const p = sdkReq.resolve(`${name}/package.json`);
			const exe = join(dirname(p), "claude.exe");
			res.packages[name] = { installed: true, dir: dirname(p), claudeExe: existsSync(exe) };
			if (existsSync(exe)) {
				const v = spawnSync(exe, ["--version"], { encoding: "utf8", timeout: 60000 });
				res.executables.push({ name, exe, status: v.status, out: (v.stdout || "").trim(), err: (v.stderr || v.error?.message || "").trim().slice(0, 200) });
			}
		} catch { res.packages[name] = { installed: false }; }
	}
} catch (e) { res.error = e.message; }
// Anything called claude.exe under the bridge's node_modules, in case the layout differs.
const found = [];
(function walk(d, depth) {
	if (depth > 5) return;
	let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
	for (const e of ents) { const p = join(d, e.name); if (e.isDirectory()) walk(p, depth + 1); else if (e.name.toLowerCase() === "claude.exe") found.push(p); }
})(dirname(bridge), 0);
res.claudeExeFiles = found.slice(0, 10);
console.log(JSON.stringify(res));
