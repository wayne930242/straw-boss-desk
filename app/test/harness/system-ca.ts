// A fixture that puts a throw-away CA into the OS certificate store of a GitHub-hosted runner and takes it out again (task 6, spec: Fixtures that change
// the machine: "a test CA added to the OS certificate store"). It is registered through the guard, so it runs on a hosted runner only; off one, a test that
// uses it skips by name, and under SBD_REQUIRE_HOSTED_FIXTURES=1 it fails there. Windows gets the CurrentUser root store (never the machine store),
// macOS the System keychain of the ephemeral runner (a user-domain trust setting asks the person at the keyboard).
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
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

async function must(io: FixtureIO, command: string, args: readonly string[], timeoutMs: number, what: string): Promise<void> {
	const result = await io.run(command, args, { timeoutMs });
	assert.equal(result.code, 0, `${what} exited with ${result.code}${result.timedOut ? " (timed out)" : ""}: ${(result.stderr || result.stdout).trim().slice(0, 400)}`);
}

const inSystemStore = (ca: TestCa): boolean => tls.getCACertificates("system").some((pem) => pem.trim() === ca.caPem.trim());

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
			if (win) await must(io, join(system32, "certutil.exe"), ["-user", "-addstore", "-f", "Root", file], 120_000, "certutil -addstore");
			else await must(io, "/usr/bin/sudo", ["/usr/bin/security", "add-trusted-cert", "-d", "-r", "trustRoot", "-k", SYSTEM_KEYCHAIN, file], 120_000, "security add-trusted-cert");
			assert.equal(inSystemStore(ca), true, "the CA is in the store as Node reads it (tls.getCACertificates('system'))");
			await scenario({ ca, dir, store: win ? "Windows CurrentUser\\Root" : "macOS System keychain" });
		} finally {
			try {
				if (win) await io.run(join(system32, "certutil.exe"), ["-user", "-delstore", "Root", ca.commonName], { timeoutMs: 120_000 });
				else {
					await io.run("/usr/bin/sudo", ["/usr/bin/security", "remove-trusted-cert", "-d", file], { timeoutMs: 120_000 });
					await io.run("/usr/bin/sudo", ["/usr/bin/security", "delete-certificate", "-c", ca.commonName, SYSTEM_KEYCHAIN], { timeoutMs: 120_000 });
				}
				assert.equal(inSystemStore(ca), false, "the CA is out of the store again");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	},
});
