import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "./harness/fixtures.ts";
import {
	defineFixture, gate, hostedRunner, registeredFixtures, runFixture,
	type EnvLike, type FixtureIO, type GateContext,
} from "./harness/hosted.ts";

const macRunner: EnvLike = {
	CI: "true", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "macos15", RUNNER_TEMP: "/Users/runner/work/_temp",
	HOME: "/Users/runner", PATH: "/usr/bin",
};
const winRunner: EnvLike = {
	CI: "true", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "win25", RUNNER_TEMP: "D:\\a\\_temp",
	USERPROFILE: "C:\\Users\\runneradmin",
};
// A developer's Mac shell: CI is sometimes set there (a local act or a pre-commit hook), the rest is theirs.
const developerMac: EnvLike = {
	CI: "true", HOME: "/Users/someone", USER: "someone", SHELL: "/bin/zsh", PATH: "/opt/homebrew/bin:/usr/bin", TMPDIR: "/var/folders/xx/T/",
	HERDR_ENV: "1", PI_CODING_AGENT: "true",
};

describe("hostedRunner", () => {
	it("refuses an empty environment", () => {
		const v = hostedRunner({}, { username: "runner" }, "darwin");
		assert.equal(v.hosted, false);
	});

	it("refuses CI=true alone", () => {
		const v = hostedRunner({ CI: "true" }, { username: "runner" }, "darwin");
		assert.deepEqual(v, { hosted: false, signal: "GITHUB_ACTIONS", reason: "GITHUB_ACTIONS is not true" });
	});

	it("refuses every hosted variable with a developer's user name", () => {
		const v = hostedRunner(macRunner, { username: "someone" }, "darwin");
		assert.deepEqual(v, { hosted: false, signal: "user", reason: "the user name is not runner" });
	});

	it("refuses a copy of a developer Mac's environment", () => {
		const v = hostedRunner(developerMac, { username: "someone" }, "darwin");
		assert.equal(v.hosted, false);
		// Even with the right user name, the missing hosted variables refuse it.
		assert.equal(hostedRunner(developerMac, { username: "runner" }, "darwin").hosted, false);
	});

	it("accepts the full hosted set on both platforms", () => {
		assert.deepEqual(hostedRunner(macRunner, { username: "runner" }, "darwin"), { hosted: true });
		assert.deepEqual(hostedRunner(winRunner, { username: "runneradmin" }, "win32"), { hosted: true });
	});

	it("refuses when any single signal is missing or wrong, naming it", () => {
		const cases: Array<[string, string | undefined, string]> = [
			["CI", "1", "CI"], ["GITHUB_ACTIONS", undefined, "GITHUB_ACTIONS"], ["RUNNER_ENVIRONMENT", "self-hosted", "RUNNER_ENVIRONMENT"],
			["ImageOS", undefined, "ImageOS"], ["RUNNER_TEMP", "", "RUNNER_TEMP"],
		];
		for (const [name, value, signal] of cases) {
			const env: Record<string, string | undefined> = { ...macRunner, [name]: value };
			const v = hostedRunner(env, { username: "runner" }, "darwin");
			assert.equal(v.hosted, false, name);
			assert.equal(v.hosted === false && v.signal, signal, name);
		}
	});

	it("takes each platform's own user name, and no other platform", () => {
		assert.equal(hostedRunner(winRunner, { username: "runner" }, "win32").hosted, false);
		assert.equal(hostedRunner(macRunner, { username: "runneradmin" }, "darwin").hosted, false);
		assert.equal(hostedRunner(macRunner, { username: "runner" }, "linux").hosted, false);
	});

	it("reads variable names without regard to case, as Windows does", () => {
		const env = { ci: "true", github_actions: "true", Runner_Environment: "github-hosted", IMAGEOS: "win25", runner_temp: "D:\\a\\_temp" };
		assert.deepEqual(hostedRunner(env, { username: "runneradmin" }, "win32"), { hosted: true });
	});
});

/** An IO that records every call and would answer success to all of them. */
function recordingIO(): FixtureIO & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		async run(command, args) { calls.push(`run ${command} ${args.join(" ")}`); return { code: 0, stdout: "", stderr: "" }; },
		writeFile(path) { calls.push(`write ${path}`); },
		removeFile(path) { calls.push(`remove ${path}`); },
	};
}

describe("registered fixtures", () => {
	it("include the keychain smoke test", () => {
		assert.ok(registeredFixtures().some((f) => f.name.startsWith("keychain smoke")));
	});

	it("refuse a non-hosted environment before the command runner or the file writer records one call", async () => {
		const nonHosted: EnvLike[] = [{}, { CI: "true" }, developerMac, { ...macRunner, RUNNER_ENVIRONMENT: "self-hosted" }];
		for (const fixture of registeredFixtures()) {
			for (const env of nonHosted) {
				for (const platform of fixture.platforms) {
					const io = recordingIO();
					const ctx: GateContext = { env, userInfo: { username: "someone" }, platform };
					const result = await runFixture(fixture, io, ctx);
					assert.equal(result.run, false, fixture.name);
					assert.deepEqual(io.calls, [], `${fixture.name} made a call before the guard refused`);
				}
			}
		}
	});

	it("refuse by throwing when SBD_REQUIRE_HOSTED_FIXTURES=1", async () => {
		for (const fixture of registeredFixtures()) {
			const io = recordingIO();
			const ctx: GateContext = { env: { SBD_REQUIRE_HOSTED_FIXTURES: "1" }, userInfo: { username: "someone" }, platform: fixture.platforms[0] ?? "darwin" };
			await assert.rejects(runFixture(fixture, io, ctx), /runs only on a GitHub-hosted runner/);
			assert.deepEqual(io.calls, []);
		}
	});

	it("skip on another platform without failing the required run", () => {
		for (const fixture of registeredFixtures()) {
			const other: NodeJS.Platform = fixture.platforms.includes("darwin") ? "win32" : "darwin";
			const g = gate(fixture, { env: { ...macRunner, SBD_REQUIRE_HOSTED_FIXTURES: "1" }, userInfo: { username: "runner" }, platform: other });
			assert.equal(g.run, false);
			assert.equal(g.run === false && g.hostedRefusal, false);
		}
	});

	it("refuse a second registration under the same name", () => {
		const [first] = registeredFixtures();
		assert.ok(first);
		assert.throws(() => defineFixture({ ...first }), /registered twice/);
	});
});
