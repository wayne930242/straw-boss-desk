// The fixture scan: a machine-changing command in a test file outside this folder fails the build, so a new fixture cannot slip in unregistered.
// The patterns live here (and are exempt from the scan with the rest of this folder), each with a sample the scan's own test plants.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface Pattern { name: string; re: RegExp; sample: string }

export const MACHINE_CHANGING: readonly Pattern[] = [
	{ name: "store-add", re: /\badd-generic-password\b/, sample: "security add-generic-password -a x -s y -w z" },
	{ name: "store-delete", re: /\bdelete-generic-password\b/, sample: "security delete-generic-password -a x -s y" },
	{ name: "store-credwrite", re: /\bCredWrite/, sample: "CredWriteW(&cred, 0)" },
	{ name: "store-creddelete", re: /\bCredDelete/, sample: "CredDeleteW(target, 1, 0)" },
	{ name: "store-cmdkey", re: /\bcmdkey\b/i, sample: "cmdkey /generic:x /user:y /pass:z" },
	{ name: "registry-reg", re: /\breg(?:\.exe)?\s+(?:add|delete)\b/i, sample: "reg add HKCU\\Software\\x /v y" },
	{ name: "registry-set-itemproperty", re: /\bSet-ItemProperty\b/, sample: "Set-ItemProperty -Path HKCU:\\x -Name y" },
	{ name: "registry-setvalue", re: /\bSetValue\b/, sample: "key.SetValue(name, value)" },
	{ name: "registry-hkcu-environment", re: /HKCU:?\\{1,2}Environment/i, sample: "HKCU\\Environment" },
	{ name: "shell-profile", re: /\.zshrc\b/, sample: "~/.zshrc" },
	{ name: "sudo", re: /\bsudo\b/, sample: "sudo mv /Library/Developer /tmp" },
	{ name: "cert-add-trusted", re: /\badd-trusted-cert\b/, sample: "security add-trusted-cert -d ca.pem" },
	{ name: "cert-certutil", re: /\bcertutil\b/i, sample: "certutil -addstore Root ca.cer" },
	{ name: "cert-import", re: /\bImport-Certificate\b/, sample: "Import-Certificate -FilePath ca.cer" },
	// T6-F005: how a fixture takes its certificate out again, and the click that answers the Windows store's confirmation dialogs.
	{ name: "cert-drive", re: /\bCert:\\{1,2}/i, sample: "Remove-Item 'Cert:\\CurrentUser\\Root\\0123ABCD'" },
	{ name: "cert-remove-trusted", re: /\bremove-trusted-cert\b/, sample: "security remove-trusted-cert -d ca.pem" },
	{ name: "cert-delete", re: /\bdelete-certificate\b/, sample: "security delete-certificate -Z 0123ABCD" },
	{ name: "dialog-bm-click", re: /\bBM_CLICK\b/, sample: "SendMessage(button, BM_CLICK, IntPtr.Zero, IntPtr.Zero)" },
	{ name: "dialog-bm-click-code", re: /\b0x00F5\b/i, sample: "SendMessage(button, 0x00F5, 0, 0)" },
];

/** The commands the spec names (Fixtures that change the machine: The scan), one string each; every one must match a pattern above. */
export const SPEC_COMMAND_WORDS: readonly string[] = [
	"add-generic-password", "delete-generic-password", "CredWrite", "CredDelete", "cmdkey", "reg add", "reg delete", "Set-ItemProperty",
	"key.SetValue(", "HKCU\\Environment", ".zshrc", "sudo", "add-trusted-cert", "certutil", "Import-Certificate",
	"Cert:\\", "remove-trusted-cert", "delete-certificate", "BM_CLICK",
];

export interface Finding { file: string; line: number; pattern: string }

/** Every file under `testRoot` except the `harness` folder and `node_modules`; returns each line that matches a pattern. */
export function scanForMachineChanges(testRoot: string, patterns: readonly Pattern[] = MACHINE_CHANGING): Finding[] {
	const findings: Finding[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			const rel = relative(testRoot, full);
			if (rel === "harness" || rel === "node_modules" || rel.split(sep).includes("node_modules")) continue;
			if (statSync(full).isDirectory()) { walk(full); continue; }
			const lines = readFileSync(full, "utf8").split(/\r?\n/);
			lines.forEach((text, i) => {
				for (const p of patterns) if (p.re.test(text)) findings.push({ file: rel, line: i + 1, pattern: p.name });
			});
		}
	};
	walk(testRoot);
	return findings;
}
