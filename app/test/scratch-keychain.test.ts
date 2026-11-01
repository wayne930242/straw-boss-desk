import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { type FixtureIO } from "./harness/hosted.ts";
import { createScratchKeychain, keychainPaths, underHome } from "./harness/scratch-keychain.ts";

describe("scratch keychain guard", () => {
	it("reads quoted keychain paths from security output", () => {
		assert.deepEqual(keychainPaths('    "/Users/a/Library/Keychains/login.keychain-db"\n    "/Library/Keychains/System.keychain"\n'), ["/Users/a/Library/Keychains/login.keychain-db", "/Library/Keychains/System.keychain"]);
		assert.deepEqual(keychainPaths("security: SecKeychainCopyDomainDefault: A default keychain could not be found.\n"), []);
	});

	it("treats /private/var and /var as one folder", () => {
		assert.equal(underHome("/private/var/f/sbd-kc-1", "/var/f/sbd-kc-1/Library/Keychains/login.keychain-db"), true);
		assert.equal(underHome("/private/var/f/sbd-kc-1", "/Users/a/Library/Keychains/login.keychain-db"), false);
		assert.equal(underHome("/private/var/f/sbd-kc-1", "/private/var/f/sbd-kc-10/x"), false);
	});

	it("refuses, and writes nothing, when the default keychain is outside the scratch HOME", async () => {
		const calls: string[] = [];
		let home = "";
		const io: FixtureIO = {
			async run(_command, args, options) {
				calls.push(`${args[0]}${options?.stdin ? " (stdin)" : ""}`);
				// HOME is not honored: the real login keychain is the default.
				if (args[0] === "default-keychain") return { code: 0, stdout: '    "/Users/someone/Library/Keychains/login.keychain-db"\n', stderr: "" };
				return { code: 0, stdout: "", stderr: "" };
			},
			writeFile: () => { throw new Error("no file"); },
			removeFile: () => { throw new Error("no file"); },
		};
		await assert.rejects(createScratchKeychain({ makeIO: (env) => { home = env.HOME ?? ""; return io; } }), /HOME is not honored, nothing was written/);
		assert.deepEqual(calls, ["default-keychain"], "it stopped at the first read-only check");
		assert.ok(home !== "" && !existsSync(home), "the scratch folder is gone");
	});

	it("refuses when the user search list holds a keychain from outside", async () => {
		const calls: string[] = [];
		const io: FixtureIO = {
			async run(_command, args, options) {
				calls.push(`${args[0]}${options?.stdin ? " (stdin)" : ""}`);
				if (args[0] === "list-keychains") return { code: 0, stdout: '    "/Users/someone/Library/Keychains/login.keychain-db"\n', stderr: "" };
				return { code: 0, stdout: "", stderr: "" };
			},
			writeFile: () => { throw new Error("no file"); },
			removeFile: () => { throw new Error("no file"); },
		};
		await assert.rejects(createScratchKeychain({ makeIO: () => io }), /outside/);
		assert.ok(!calls.some((c) => c.includes("stdin")), "no keychain was created");
	});
});
