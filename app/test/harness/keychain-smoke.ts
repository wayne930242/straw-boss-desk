// The macOS store smoke test: a throwaway item is added, found, and deleted in the default keychain with 10 s limits,
// so a runner keychain problem shows on day one. A guarded fixture: it never runs on a developer's Mac.
import { randomBytes } from "node:crypto";
import { defineFixture, type FixtureIO, type RunResult } from "./hosted.ts";

const LIMIT = { timeoutMs: 10_000 };

function must(step: string, result: RunResult): RunResult {
	if (result.code !== 0) throw new Error(`keychain smoke: ${step} exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
	return result;
}

export const keychainSmoke = defineFixture({
	name: "keychain smoke: add, find and delete a throwaway item in the default keychain",
	platforms: ["darwin"],
	async body(io: FixtureIO): Promise<void> {
		const service = `sbd-ci-smoke-${randomBytes(6).toString("hex")}`;
		const account = "sbd-smoke";
		let added = false;
		try {
			must("add", await io.run("security", ["add-generic-password", "-a", account, "-s", service, "-w", "sbd-smoke-secret"], LIMIT));
			added = true;
			// Attributes only: no -w, so the secret is never read back.
			const found = must("find", await io.run("security", ["find-generic-password", "-a", account, "-s", service], LIMIT));
			if (!found.stdout.includes(service)) throw new Error("keychain smoke: find did not list the item it just added");
		} finally {
			if (added) must("delete", await io.run("security", ["delete-generic-password", "-a", account, "-s", service], LIMIT));
		}
		const gone = await io.run("security", ["find-generic-password", "-a", account, "-s", service], LIMIT);
		if (gone.code === 0) throw new Error("keychain smoke: the item is still there after delete");
	},
});
