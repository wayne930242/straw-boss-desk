// A fixture that puts a throw-away CA into the OS certificate store of a GitHub-hosted runner and takes it out again (task 6, spec: Fixtures that change
// the machine: "a test CA added to the OS certificate store"). It is registered through the guard, so it runs on a hosted runner only; off one, a test that
// uses it skips by name, and under SBD_REQUIRE_HOSTED_FIXTURES=1 it fails there. Windows gets the CurrentUser root store (never the machine store),
// macOS the System keychain of the ephemeral runner (a user-domain trust setting asks the person at the keyboard).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestCa, type TestCa } from "./test-ca.ts";
import { defineFixture, type FixtureIO } from "./hosted.ts";

export interface TrustedCa {
	ca: TestCa;
	/** The scratch folder holding the DER file the store imported (a `.cer`, never `.pem`). */
	dir: string;
	store: string;
}

/**
 * What the test does around the CA. The test sets both before the fixture runs and reads nothing back but exceptions. `before` runs with the CA made and
 * not in the store (the fixture has checked that a new Node process does not see it), so a client's refusal can be observed first (the control, T6-F002);
 * `run` runs once the store holds it.
 */
export const trustedCaScenario: { before: ((trusted: TrustedCa) => Promise<void>) | null; run: ((trusted: TrustedCa) => Promise<void>) | null } = { before: null, run: null };

const SYSTEM_KEYCHAIN = "/Library/Keychains/System.keychain";

// Windows: adding a root to the CurrentUser store stops at a "Security Warning" dialog, and removing it at a "Root Certificate Store" one (class #32770, buttons Yes = 6 and No = 7); each waits
// for a click, and the policy value under HKCU\\Software\\Policies\\Microsoft\\SystemCertificates\\Root\\ProtectedRoots does not remove it; the .NET and
// PowerShell store APIs refuse ("UI is not allowed"), and a Blob written straight into the registry key is deleted again by Windows (all found on
// windows-2025). The hosted runner's session is interactive, so a second process finds the dialog by its window and presses Yes with BM_CLICK, and the
// fixture waits for both. Nothing outside the CurrentUser store is written, and never HKLM.
const CLICK_YES = String.raw`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SbdWin {
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hDlg, int id);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
}
'@
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($w in $wins) {
    if (($w.Current.Name -eq 'Security Warning' -or $w.Current.Name -eq 'Root Certificate Store') -and $w.Current.ClassName -eq '#32770') {
      $yes = [SbdWin]::GetDlgItem([IntPtr]$w.Current.NativeWindowHandle, 6)
      [void][SbdWin]::SendMessage($yes, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
      Write-Output 'clicked'
      exit 0
    }
  }
  Start-Sleep -Milliseconds 250
}
Write-Output 'no dialog'
exit 3
`;

async function must(io: FixtureIO, command: string, args: readonly string[], timeoutMs: number, what: string): Promise<void> {
	const result = await io.run(command, args, { timeoutMs });
	assert.equal(result.code, 0, `${what} exited with ${result.code}${result.timedOut ? " (timed out)" : ""}: ${(result.stderr || result.stdout).trim().slice(0, 400)}`);
}

/** Runs a command that raises one of those dialogs, with the clicker beside it. */
async function withDialog(io: FixtureIO, command: string, args: readonly string[], system32: string, what: string): Promise<void> {
	const powershell = join(system32, "WindowsPowerShell", "v1.0", "powershell.exe");
	const [clicker, result] = await Promise.all([
		io.run(powershell, ["-NoProfile", "-Command", CLICK_YES], { timeoutMs: 90_000 }),
		io.run(command, args, { timeoutMs: 90_000 }),
	]);
	assert.equal(result.code, 0, `${what} exited with ${result.code}${result.timedOut ? " (timed out)" : ""}; the dialog clicker said ${clicker.stdout.trim() || clicker.stderr.trim().slice(0, 200)}`);
}

/**
 * Whether the OS store holds the CA, asked of a new Node process each time: a process reads the store once and keeps it (`tls.getCACertificates("system")`
 * answers from that copy), so the process that added the CA cannot see it go.
 */
async function inSystemStore(io: FixtureIO, ca: TestCa): Promise<boolean> {
	const script = "const c=require('node:crypto'),t=require('node:tls');const want=process.env.SBD_CA_FINGERPRINT;process.stdout.write(t.getCACertificates('system').some((p)=>new c.X509Certificate(p).fingerprint256===want)?'yes':'no')";
	const result = await io.run(process.execPath, ["-e", script], { timeoutMs: 60_000, env: { SBD_CA_FINGERPRINT: ca.ca.fingerprint256 } });
	assert.equal(result.code, 0, `listing the OS store exited with ${result.code}: ${result.stderr.trim().slice(0, 300)}`);
	return result.stdout.trim() === "yes";
}

export const trustedTestCa = defineFixture({
	name: "a test CA in the OS certificate store (Windows CurrentUser root store, macOS System keychain), taken out again",
	platforms: ["win32", "darwin"],
	async body(io: FixtureIO): Promise<void> {
		const scenario = { before: trustedCaScenario.before, run: trustedCaScenario.run };
		if (scenario.run === null) throw new Error("trustedCaScenario.run is not set");
		const dir = realpathSync(mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "sbd-test-ca-")));
		const ca = createTestCa("os-store");
		const file = join(dir, "straw-boss-test-ca.cer");
		writeFileSync(file, ca.caDer);
		const win = process.platform === "win32";
		const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
		const store = win ? "Windows CurrentUser\\Root" : "macOS System keychain";
		// Nothing is in the store yet, so a failure here has nothing to take out again.
		try {
			assert.equal(await inSystemStore(io, ca), false, "the CA is not in the store before the fixture adds it");
			await scenario.before?.({ ca, dir, store });
		} catch (error) {
			rmSync(dir, { recursive: true, force: true });
			throw error;
		}
		try {
			if (win) await withDialog(io, join(system32, "certutil.exe"), ["-user", "-addstore", "-f", "Root", file], system32, "certutil -addstore");
			else await must(io, "/usr/bin/sudo", ["/usr/bin/security", "add-trusted-cert", "-d", "-r", "trustRoot", "-k", SYSTEM_KEYCHAIN, file], 120_000, "security add-trusted-cert");
			assert.equal(await inSystemStore(io, ca), true, "the CA is in the store as a new Node process reads it (tls.getCACertificates('system'))");
			await scenario.run({ ca, dir, store });
		} finally {
			try {
				if (win) {
					const thumbprint = createHash("sha1").update(ca.caDer).digest("hex").toUpperCase();
					const powershell = join(system32, "WindowsPowerShell", "v1.0", "powershell.exe");
					await withDialog(io, powershell, ["-NoProfile", "-Command", `Remove-Item 'Cert:\\CurrentUser\\Root\\${thumbprint}' -DeleteKey -ErrorAction Stop`], system32, "Remove-Item on the Root store");
				}
				else {
					await io.run("/usr/bin/sudo", ["/usr/bin/security", "remove-trusted-cert", "-d", file], { timeoutMs: 120_000 });
					await io.run("/usr/bin/sudo", ["/usr/bin/security", "delete-certificate", "-c", ca.commonName, SYSTEM_KEYCHAIN], { timeoutMs: 120_000 });
				}
				assert.equal(await inSystemStore(io, ca), false, "the CA is out of the store again");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	},
});
