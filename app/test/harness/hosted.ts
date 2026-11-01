// The guard for every fixture that changes the machine outside the test's own root (spec: Fixtures that change the machine).
// Test code only; never shipped. A fixture runs through `runFixture` or `fixtureTest`, which ask `hostedRunner` first.
import { rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { test } from "node:test";
import { processIO } from "./process-io.ts";
import { createScratchKeychain } from "./scratch-keychain.ts";

export type EnvLike = Readonly<Record<string, string | undefined>>;
export interface UserInfoLike { username: string }
export type HostedVerdict = { hosted: true } | { hosted: false; signal: string; reason: string };

/** The user name the GitHub-hosted images run the job as. */
const HOSTED_USER: Partial<Record<NodeJS.Platform, string>> = { darwin: "runner", win32: "runneradmin" };

function lookup(env: EnvLike, name: string): string | undefined {
	// Windows folds the case of variable names; a copy of its environment keeps whatever case the runner set.
	const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
	return key === undefined ? undefined : env[key];
}

/**
 * Yes only when every signal holds: CI=true, GITHUB_ACTIONS=true, RUNNER_ENVIRONMENT=github-hosted, ImageOS and RUNNER_TEMP set,
 * and the hosted images' user name. One signal alone is not enough, since a developer's shell may set CI.
 */
export function hostedRunner(env: EnvLike, userInfo: UserInfoLike, platform: NodeJS.Platform = process.platform): HostedVerdict {
	const no = (signal: string, reason: string): HostedVerdict => ({ hosted: false, signal, reason });
	if (lookup(env, "CI") !== "true") return no("CI", "CI is not true");
	if (lookup(env, "GITHUB_ACTIONS") !== "true") return no("GITHUB_ACTIONS", "GITHUB_ACTIONS is not true");
	if (lookup(env, "RUNNER_ENVIRONMENT") !== "github-hosted") return no("RUNNER_ENVIRONMENT", "RUNNER_ENVIRONMENT is not github-hosted");
	if (!lookup(env, "ImageOS")) return no("ImageOS", "ImageOS is not set");
	if (!lookup(env, "RUNNER_TEMP")) return no("RUNNER_TEMP", "RUNNER_TEMP is not set");
	const expected = HOSTED_USER[platform];
	if (expected === undefined) return no("platform", `${platform} has no GitHub-hosted image this guard knows`);
	if (userInfo.username !== expected) return no("user", `the user name is not ${expected}`);
	return { hosted: true };
}

// ---- fixtures ------------------------------------------------------------------------------------------------------

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut?: boolean }

export interface RunOptions {
	timeoutMs?: number;
	/** Written to the child's standard input (a password never goes on a command line). */
	stdin?: string;
	/** Added to the environment of this call. */
	env?: Readonly<Record<string, string>>;
}

/** Everything a fixture does to the machine goes through this, so the guard's test can prove a refusal made no call. */
export interface FixtureIO {
	run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
	writeFile(path: string, data: string): void;
	removeFile(path: string): void;
}

export interface Fixture {
	name: string;
	platforms: readonly NodeJS.Platform[];
	/**
	 * What a local run may use instead of the hosted runner. `keychain`: a scratch HOME with its own keychain (design 1b), whose default keychain and
	 * search list are checked to hold nothing from the real home before anything is written. Absent: a local run skips with the reason.
	 */
	scratch?: "keychain";
	body(io: FixtureIO): Promise<void>;
}

const registry: Fixture[] = [];

/** Registers a fixture. An unregistered fixture is invisible to the guard's own test, and the fixture scan keeps its commands out of test files. */
export function defineFixture(fixture: Fixture): Fixture {
	if (registry.some((f) => f.name === fixture.name)) throw new Error(`fixture ${fixture.name} is registered twice`);
	registry.push(fixture);
	return fixture;
}

export const registeredFixtures = (): readonly Fixture[] => registry;

export interface GateContext {
	env: EnvLike;
	userInfo: UserInfoLike;
	platform: NodeJS.Platform;
}

export const currentContext = (): GateContext => ({ env: process.env, userInfo: os.userInfo(), platform: process.platform });

export type Gate = { run: true } | { run: false; reason: string; hostedRefusal: boolean };

const PLATFORM_NAME: Partial<Record<NodeJS.Platform, string>> = { darwin: "macOS", win32: "Windows" };

export function gate(fixture: Fixture, ctx: GateContext = currentContext()): Gate {
	if (!fixture.platforms.includes(ctx.platform)) {
		const names = fixture.platforms.map((p) => PLATFORM_NAME[p] ?? p).join(" and ");
		return { run: false, reason: `${fixture.name} runs only on ${names}`, hostedRefusal: false };
	}
	const verdict = hostedRunner(ctx.env, ctx.userInfo, ctx.platform);
	if (!verdict.hosted) return { run: false, reason: `${fixture.name} runs only on a GitHub-hosted runner: ${verdict.reason}`, hostedRefusal: true };
	return { run: true };
}

export const requireHosted = (env: EnvLike): boolean => lookup(env, "SBD_REQUIRE_HOSTED_FIXTURES") === "1";

/**
 * The gate of a test that changes nothing but reads the OS credential store (gh's and glab's credential helpers, task 5): the guard's six signals, not
 * one (nektos/act sets GITHUB_ACTIONS on a developer's machine). `run`: go ahead. Otherwise `reason` names the failing signal, and `fail` is true under
 * SBD_REQUIRE_HOSTED_FIXTURES=1, where a skip must not pass unseen.
 */
export type HostedCase = { run: true } | { run: false; reason: string; fail: boolean };

export function hostedCase(name: string, ctx: GateContext = currentContext()): HostedCase {
	const verdict = hostedRunner(ctx.env, ctx.userInfo, ctx.platform);
	if (verdict.hosted) return { run: true };
	return { run: false, reason: `${name} runs only on a GitHub-hosted runner: ${verdict.reason}`, fail: requireHosted(ctx.env) };
}

/**
 * Runs the fixture when the gate allows it. A refusal makes no call on `io`; under SBD_REQUIRE_HOSTED_FIXTURES=1 a hosted-runner refusal throws,
 * so a skip can never pass the anchor unseen.
 */
export async function runFixture(fixture: Fixture, io: FixtureIO, ctx: GateContext = currentContext()): Promise<Gate> {
	const verdict = gate(fixture, ctx);
	if (!verdict.run) {
		if (verdict.hostedRefusal && requireHosted(ctx.env)) throw new Error(`${verdict.reason} (SBD_REQUIRE_HOSTED_FIXTURES=1)`);
		return verdict;
	}
	await fixture.body(io);
	return verdict;
}

export const realIO: FixtureIO = {
	...processIO(process.env),
	writeFile: (path, data) => writeFileSync(path, data),
	removeFile: (path) => rmSync(path, { force: true }),
};

/**
 * Registers a node:test case for the fixture: skipped with a named reason off a hosted runner, failing there when SBD_REQUIRE_HOSTED_FIXTURES=1.
 * A fixture that names a `scratch` alternative runs locally on macOS against a scratch HOME with its own keychain instead of being skipped.
 */
export function fixtureTest(fixture: Fixture, ctx: GateContext = currentContext()): void {
	const verdict = gate(fixture, ctx);
	if (verdict.run || (verdict.hostedRefusal && requireHosted(ctx.env))) {
		test(fixture.name, async () => {
			await runFixture(fixture, realIO, ctx);
		});
		return;
	}
	if (verdict.hostedRefusal && fixture.scratch === "keychain" && ctx.platform === "darwin") {
		test(`${fixture.name} (scratch HOME keychain)`, async () => {
			const scratch = await createScratchKeychain();
			try {
				await fixture.body(scratch.io);
			} finally {
				await scratch.dispose();
			}
		});
		return;
	}
	test(fixture.name, { skip: verdict.reason }, () => {});
}
