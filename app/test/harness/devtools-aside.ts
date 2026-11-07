// The fixture that moves the macOS developer tools aside (spec: Fixtures that change the machine; task 5 anchor). On a bare Mac `/usr/bin/git` is a stub that
// asks to install the Xcode tools; with the real tools present a stage that called it by mistake would pass. So the hosted macOS run moves the Xcode apps and
// `/Library/Developer/CommandLineTools` aside with sudo (the runner is ephemeral), and any call into a developer-tools stub fails loudly. A local run
// skips it, always: the developer tools on the author's Mac are the author's. Registered through the guard in `hosted.ts`; the `sudo` stays in this folder.
import { defineFixture, gate, requireHosted, currentContext, type FixtureIO, type GateContext } from "./hosted.ts";

const ASIDE = ".sbd-aside";
const CLT = "/Library/Developer/CommandLineTools";
const APPLICATIONS = "/Applications";

async function exists(io: FixtureIO, path: string): Promise<boolean> {
	return (await io.run("/bin/test", ["-e", path], { timeoutMs: 10_000 })).code === 0;
}

/** The developer-tools folders that exist: the Command Line Tools and every `/Applications/Xcode*.app`. */
export async function developerToolsOnDisk(io: FixtureIO): Promise<string[]> {
	const found: string[] = [];
	if (await exists(io, CLT)) found.push(CLT);
	const listing = await io.run("/bin/ls", ["-1", APPLICATIONS], { timeoutMs: 10_000 });
	for (const name of listing.stdout.split("\n")) if (/^Xcode.*\.app$/.test(name)) found.push(`${APPLICATIONS}/${name}`);
	return found;
}

async function sudoMove(io: FixtureIO, from: string, to: string): Promise<void> {
	const moved = await io.run("sudo", ["-n", "/bin/mv", from, to], { timeoutMs: 120_000 });
	if (moved.code !== 0) throw new Error(`could not move ${from} to ${to}: ${(moved.stderr || moved.stdout).trim().slice(0, 200)}`);
}

/** Moves each developer-tools folder to `<folder>.sbd-aside` and returns what it moved. */
export async function putDeveloperToolsAside(io: FixtureIO): Promise<string[]> {
	const moved: string[] = [];
	try {
		for (const path of await developerToolsOnDisk(io)) {
			await sudoMove(io, path, `${path}${ASIDE}`);
			moved.push(path);
		}
	} catch (error) {
		await putDeveloperToolsBack(io, moved);
		throw error;
	}
	return moved;
}

export async function putDeveloperToolsBack(io: FixtureIO, moved: readonly string[]): Promise<void> {
	for (const path of [...moved].reverse()) await sudoMove(io, `${path}${ASIDE}`, path);
}

/** True when `/usr/bin/git` (the stub) refuses to run: no developer tools are found. */
export async function gitStubFails(io: FixtureIO): Promise<boolean> {
	const r = await io.run("/usr/bin/git", ["--version"], { timeoutMs: 60_000 });
	return r.code !== 0;
}

export const developerToolsAside = defineFixture({
	name: "developer tools moved aside: Xcode and CommandLineTools",
	platforms: ["darwin"],
	async body(io: FixtureIO): Promise<void> {
		const moved = await putDeveloperToolsAside(io);
		try {
			if (!(await gitStubFails(io))) throw new Error("developer tools aside: /usr/bin/git still runs, so a call into the stub would not fail");
		} finally {
			await putDeveloperToolsBack(io, moved);
		}
	},
});

export type AsideScope =
	| { state: "active"; enter(io: FixtureIO): Promise<void>; leave(io: FixtureIO): Promise<void> }
	| { state: "skipped"; reason: string }
	/** A hosted-runner refusal under SBD_REQUIRE_HOSTED_FIXTURES=1: the suite fails instead of skipping. */
	| { state: "refused"; reason: string };

/**
 * The fixture as a scope around a whole suite: `enter` moves the tools aside and `leave` puts them back. Outside a hosted macOS runner the scope is
 * `skipped` with the fixture's name and the failing signal, or `refused` when the anchor workflow requires hosted fixtures.
 */
export function developerToolsAsideScope(ctx: GateContext = currentContext()): AsideScope {
	const verdict = gate(developerToolsAside, ctx);
	if (!verdict.run) return verdict.hostedRefusal && requireHosted(ctx.env) ? { state: "refused", reason: `${verdict.reason} (SBD_REQUIRE_HOSTED_FIXTURES=1)` } : { state: "skipped", reason: verdict.reason };
	let moved: string[] = [];
	return {
		state: "active",
		async enter(io) {
			moved = await putDeveloperToolsAside(io);
			if (!(await gitStubFails(io))) {
				// What still lets the stub run (macos-15-intel, task 15): where the developer directory points, what lies in /Applications and under /Library/Developer, and the stub's own answer.
				const first = (text: string): string => text.trim().split("\n")[0]?.slice(0, 200) ?? "";
				const select = await io.run("/usr/bin/xcode-select", ["-p"], { timeoutMs: 20_000 });
				const git = await io.run("/usr/bin/git", ["--version"], { timeoutMs: 60_000 });
				const where = await io.run("/usr/bin/xcrun", ["--find", "git"], { timeoutMs: 60_000 });
				const apps = await io.run("/bin/ls", ["-1", APPLICATIONS], { timeoutMs: 10_000 });
				const dev = await io.run("/bin/ls", ["-la", "/Library/Developer"], { timeoutMs: 10_000 });
				const seen = `moved ${JSON.stringify(moved)}; xcode-select -p: ${first(select.stdout || select.stderr)}; git --version: ${first(git.stdout || git.stderr)}; xcrun --find git: ${first(where.stdout || where.stderr)}; /Applications: ${apps.stdout.split("\n").filter((n) => /xcode|developer/i.test(n)).join(", ")}; /Library/Developer: ${dev.stdout.split("\n").slice(0, 8).join(" | ")}`;
				// macos-15-intel's image answers `git --version` from /usr/bin/git with git 2.55.0 while no developer tools exist (`xcrun --find git` says none were found), so that path is not the stub
				// there. The nightly workflow sets SBD_ASIDE_GIT_MAY_RUN=1 for that runner alone: the tools are still aside, only the "a stub call fails loudly" half of the fixture cannot hold, and the
				// run says so as a warning. It holds only while the machine itself says the tools are gone, `xcode-select -p` and `xcrun --find git` both failing (T15R-F001): a developer directory
				// or a git that `xcrun` finds means tools the move missed, and that still refuses. Everywhere else the refusal stands.
				const gone = select.code !== 0 && where.code !== 0;
				if (ctx.env.SBD_ASIDE_GIT_MAY_RUN === "1" && gone) {
					console.log(`::warning title=developer tools aside::/usr/bin/git runs with the developer tools aside, so a call into it would not fail loudly on this runner (${seen})`);
					return;
				}
				const relaxed = ctx.env.SBD_ASIDE_GIT_MAY_RUN === "1" ? "; SBD_ASIDE_GIT_MAY_RUN=1 goes on only when xcode-select -p and xcrun --find git both fail" : "";
				await putDeveloperToolsBack(io, moved);
				throw new Error(`developer tools aside: /usr/bin/git still runs (${seen})${relaxed}`);
			}
		},
		async leave(io) {
			await putDeveloperToolsBack(io, moved);
			moved = [];
		},
	};
}
