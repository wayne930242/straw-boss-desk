// Does the Claude Agent SDK, as pi-claude-bridge installed it, have a Windows executable for this machine?
// usage: node sdk-exe.mjs <pi-claude-bridge package dir>
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const bridge = process.argv[2];
const res = { nodeArch: process.arch, platform: process.platform, sdk: null, packages: {}, executables: [] };
// The SDK's package.json is not exported (require.resolve of it fails with ERR_PACKAGE_PATH_NOT_EXPORTED), so look at the folders npm
// laid out: nested under the bridge, or hoisted beside it. The platform packages sit in the same @anthropic-ai folder as the SDK.
const scopes = [join(bridge, "node_modules", "@anthropic-ai"), join(dirname(bridge), "@anthropic-ai")];
try {
	const scope = scopes.find((d) => existsSync(join(d, "claude-agent-sdk", "package.json")));
	if (!scope) throw new Error(`claude-agent-sdk not found under ${scopes.join(" or ")}`);
	const sdkDir = join(scope, "claude-agent-sdk");
	res.sdk = { path: sdkDir, version: JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8")).version };
	for (const arch of ["x64", "arm64"]) {
		const name = `@anthropic-ai/claude-agent-sdk-win32-${arch}`;
		const dir = join(scope, `claude-agent-sdk-win32-${arch}`);
		if (!existsSync(join(dir, "package.json"))) { res.packages[name] = { installed: false }; continue; }
		const exe = join(dir, "claude.exe");
		res.packages[name] = { installed: true, dir, claudeExe: existsSync(exe) };
		if (existsSync(exe)) {
			const v = spawnSync(exe, ["--version"], { encoding: "utf8", timeout: 60000 });
			res.executables.push({ name, exe, status: v.status, out: (v.stdout || "").trim(), err: (v.stderr || v.error?.message || "").trim().slice(0, 200) });
		}
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
