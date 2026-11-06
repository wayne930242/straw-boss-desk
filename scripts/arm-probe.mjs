// Scratch: how long the app's Windows credential probe takes under an x64 Node on windows-11-arm (task 15 finding). Not part of the repository.
import { spawnSync } from "node:child_process";
import { CREDENTIAL_PROBE_SCRIPT } from "../app/src/main/platform/win-scripts.ts";

const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const run = (label, script, env = {}) => {
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	const t = Date.now();
	const r = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 300_000 });
	console.log(`${label}: ${((Date.now() - t) / 1000).toFixed(1)} s, exit ${r.status}, out ${JSON.stringify((r.stdout ?? "").trim().slice(0, 200))}, err ${JSON.stringify((r.stderr ?? "").trim().slice(0, 200))}`);
};
console.log(`node ${process.version} ${process.arch}; PROCESSOR_ARCHITECTURE=${process.env.PROCESSOR_ARCHITECTURE} ARCHITEW6432=${process.env.PROCESSOR_ARCHITEW6432}`);
run("trivial", "$PSVersionTable.PSVersion.ToString() + ' ' + [Environment]::Is64BitProcess + ' ' + [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture + ' ' + [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture");
run("trivial again", "1");
run("Add-Type small", "Add-Type -TypeDefinition 'public class SbdX { public static int F() { return 1; } }'; 1");
for (let i = 1; i <= 3; i++) run(`credential probe ${i}`, CREDENTIAL_PROBE_SCRIPT, { SBD_TARGET: `straw-boss-desk-probe-${Date.now()}${i}` });
