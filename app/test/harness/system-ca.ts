// A fixture that puts a throw-away CA into the OS certificate store of a GitHub-hosted runner and takes it out again (task 6, spec: Fixtures that change
// the machine: "a test CA added to the OS certificate store"). It is registered through the guard, so it runs on a hosted runner only; off one, a test that
// uses it skips by name, and under SBD_REQUIRE_HOSTED_FIXTURES=1 it fails there. Windows gets the CurrentUser root store (never the machine store),
// macOS the System keychain of the ephemeral runner (a user-domain trust setting asks the person at the keyboard).
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createTestCa, type TestCa } from "./test-ca.ts";
import { defineFixture, type FixtureIO } from "./hosted.ts";

export interface TrustedCa {
	ca: TestCa;
	/** The scratch folder holding the DER file the store imported (a `.cer`, never `.pem`). */
	dir: string;
	store: string;
}

/** What the test does while the CA is trusted. The test sets it before the fixture runs and reads nothing back but exceptions. */
export const trustedCaScenario: { run: ((trusted: TrustedCa) => Promise<void>) | null } = { run: null };

const SYSTEM_KEYCHAIN = "/Library/Keychains/System.keychain";

// Windows: `certutil -user -addstore Root` and the .NET store API both stop at a "Security Warning" dialog (it waits for a click that never comes on a
// runner; found on windows-2025). The CurrentUser Root store is a registry key of the same user, one key for each certificate named by its SHA-1
// thumbprint, holding the certificate wrapped as a serialized certificate property: id 0x20, reserved 1, length, DER. Writing it is a write to HKCU only,
// the certificate API reads it like any other, and deleting the key takes it out.
const userRootKey = (ca: TestCa): string => `HKCU\\Software\\Microsoft\\SystemCertificates\\Root\\Certificates\\${createHash("sha1").update(ca.caDer).digest("hex").toUpperCase()}`;

function certificateBlob(ca: TestCa): string {
	const header = Buffer.alloc(12);
	header.writeUInt32LE(0x20, 0);
	header.writeUInt32LE(1, 4);
	header.writeUInt32LE(ca.caDer.length, 8);
	return Buffer.concat([header, ca.caDer]).toString("hex");
}

async function must(io: FixtureIO, command: string, args: readonly string[], timeoutMs: number, what: string): Promise<void> {
	const result = await io.run(command, args, { timeoutMs });
	assert.equal(result.code, 0, `${what} exited with ${result.code}${result.timedOut ? " (timed out)" : ""}: ${(result.stderr || result.stdout).trim().slice(0, 400)}`);
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
		const scenario = trustedCaScenario.run;
		if (scenario === null) throw new Error("trustedCaScenario.run is not set");
		const dir = realpathSync(mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "sbd-test-ca-")));
		const ca = createTestCa("os-store");
		const file = join(dir, "straw-boss-test-ca.cer");
		writeFileSync(file, ca.caDer);
		const win = process.platform === "win32";
		const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
		try {
			if (win) await must(io, join(system32, "reg.exe"), ["add", userRootKey(ca), "/v", "Blob", "/t", "REG_BINARY", "/d", certificateBlob(ca), "/f"], 60_000, "reg add");
			else await must(io, "/usr/bin/sudo", ["/usr/bin/security", "add-trusted-cert", "-d", "-r", "trustRoot", "-k", SYSTEM_KEYCHAIN, file], 120_000, "security add-trusted-cert");
			assert.equal(await inSystemStore(io, ca), true, "the CA is in the store as a new Node process reads it (tls.getCACertificates('system'))");
			await scenario({ ca, dir, store: win ? "Windows CurrentUser\\Root" : "macOS System keychain" });
		} finally {
			try {
				if (win) await io.run(join(system32, "reg.exe"), ["delete", userRootKey(ca), "/f"], { timeoutMs: 60_000 });
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
