import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keychainSmoke } from "./harness/keychain-smoke.ts";
import { fakeKeychain } from "./harness/fake-keychain.ts";
import { fixtureTest } from "./harness/hosted.ts";

// The real run: a GitHub-hosted macOS runner only. Anywhere else it is skipped with the named reason,
// and under SBD_REQUIRE_HOSTED_FIXTURES=1 a refusal on a hosted macOS runner fails the job.
fixtureTest(keychainSmoke);

describe("keychain smoke body", () => {
	it("adds, finds, deletes, and checks the item is gone", async () => {
		const io = fakeKeychain();
		await keychainSmoke.body(io);
		assert.deepEqual(io.commands, [
			"security add", "security find", "security delete", "security find",
		]);
	});

	it("deletes the item even when the find fails, and fails the test", async () => {
		const io = fakeKeychain();
		const run = io.run.bind(io);
		io.run = async (command, args, options) => (args[0]?.startsWith("find") && io.commands.length < 3 ? { code: 1, stdout: "", stderr: "denied" } : run(command, args, options));
		await assert.rejects(keychainSmoke.body(io), /find exited 1/);
		assert.ok(io.commands.includes("security delete"));
	});

	it("never reads the secret back", async () => {
		const seen: string[][] = [];
		const io = fakeKeychain();
		const run = io.run.bind(io);
		io.run = async (command, args, options) => { seen.push([...args]); return run(command, args, options); };
		await keychainSmoke.body(io);
		for (const args of seen.filter((a) => a[0]?.startsWith("find"))) assert.ok(!args.includes("-w") && !args.includes("-g"));
	});

	it("uses the probe's 10 s limit on every call", async () => {
		const io = fakeKeychain();
		const limits: Array<number | undefined> = [];
		const run = io.run.bind(io);
		io.run = async (command, args, options) => { limits.push(options?.timeoutMs); return run(command, args, options); };
		await keychainSmoke.body(io);
		assert.deepEqual(limits, [10_000, 10_000, 10_000, 10_000]);
	});
});
