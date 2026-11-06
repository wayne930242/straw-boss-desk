import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { developerToolsAside, developerToolsAsideScope, developerToolsOnDisk, putDeveloperToolsAside, putDeveloperToolsBack } from "./devtools-aside.ts";
import { runFixture, type FixtureIO, type GateContext } from "./hosted.ts";

// The fixture's commands are proved here against a recording IO; the real run is on a GitHub-hosted macOS runner only (the anchor workflow).

const hostedMac: GateContext = {
	env: { CI: "true", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "macos15", RUNNER_TEMP: "/Users/runner/work/_temp", SBD_REQUIRE_HOSTED_FIXTURES: "1" },
	userInfo: { username: "runner" },
	platform: "darwin",
};

/** A Mac with the Command Line Tools and two Xcode apps; `git` stops running once the tools are moved. */
function fakeMac(): FixtureIO & { calls: string[]; disk: Set<string> } {
	const disk = new Set(["/Library/Developer/CommandLineTools", "/Applications/Xcode_16.4.app", "/Applications/Xcode.app", "/Applications/Safari.app"]);
	const calls: string[] = [];
	return {
		calls,
		disk,
		async run(command, args) {
			calls.push(`${command} ${args.join(" ")}`);
			if (command === "/bin/test") return { code: disk.has(String(args[1])) ? 0 : 1, stdout: "", stderr: "" };
			if (command === "/bin/ls") return { code: 0, stdout: [...disk].filter((p) => p.startsWith("/Applications/")).map((p) => p.slice("/Applications/".length)).join("\n"), stderr: "" };
			if (command === "sudo") {
				assert.deepEqual(args.slice(0, 2), ["-n", "/bin/mv"]);
				const [from, to] = [String(args[2]), String(args[3])];
				if (!disk.has(from)) return { code: 1, stdout: "", stderr: "no such file" };
				disk.delete(from);
				disk.add(to);
				return { code: 0, stdout: "", stderr: "" };
			}
			if (command === "/usr/bin/git") return disk.has("/Library/Developer/CommandLineTools") || [...disk].some((p) => /Xcode.*\.app$/.test(p)) ? { code: 0, stdout: "git version", stderr: "" } : { code: 1, stdout: "", stderr: "xcode-select: error" };
			throw new Error(`unexpected command ${command}`);
		},
		writeFile() {},
		removeFile() {},
	};
}

describe("developer tools moved aside", () => {
	it("finds the Command Line Tools and every Xcode app, and nothing else in /Applications", async () => {
		assert.deepEqual(await developerToolsOnDisk(fakeMac()), ["/Library/Developer/CommandLineTools", "/Applications/Xcode_16.4.app", "/Applications/Xcode.app"]);
	});

	it("moves each aside with sudo, makes git fail, and puts everything back in reverse", async () => {
		const io = fakeMac();
		const before = new Set(io.disk);
		await runFixture(developerToolsAside, io, hostedMac);
		assert.deepEqual(io.disk, before, "the disk is as it was");
		const moves = io.calls.filter((c) => c.startsWith("sudo"));
		assert.equal(moves.length, 6);
		assert.ok(moves[0]?.includes("/Library/Developer/CommandLineTools /Library/Developer/CommandLineTools.sbd-aside"));
		assert.ok(io.calls.includes("/usr/bin/git --version"));
		assert.ok(moves[3]?.includes("Xcode.app.sbd-aside /Applications/Xcode.app"), "restored last-moved first");
	});

	it("fails, and still puts the tools back, when git keeps running after the move", async () => {
		const io = fakeMac();
		const run = io.run.bind(io);
		io.run = async (command, args, options) => (command === "/usr/bin/git" ? { code: 0, stdout: "git version", stderr: "" } : run(command, args, options));
		const before = new Set(io.disk);
		await assert.rejects(runFixture(developerToolsAside, io, hostedMac), /still runs/);
		assert.deepEqual(io.disk, before);
	});

	it("puts back what it moved when a later move fails", async () => {
		const io = fakeMac();
		const run = io.run.bind(io);
		io.run = async (command, args, options) => (command === "sudo" && String(args[2]) === "/Applications/Xcode.app" ? { code: 1, stdout: "", stderr: "denied" } : run(command, args, options));
		const before = new Set(io.disk);
		await assert.rejects(putDeveloperToolsAside(io), /could not move \/Applications\/Xcode\.app/);
		assert.deepEqual(io.disk, before);
		await putDeveloperToolsBack(io, []);
	});

	it("makes no call at all outside a hosted runner: a skipped scope locally, a refusal that fails under the required flag", async () => {
		const io = fakeMac();
		const developer: GateContext = { env: { CI: "true", HOME: "/Users/someone" }, userInfo: { username: "someone" }, platform: "darwin" };
		const local = developerToolsAsideScope(developer);
		assert.equal(local.state, "skipped");
		assert.match(local.state === "skipped" ? local.reason : "", /developer tools moved aside.*runs only on a GitHub-hosted runner/);
		const required = developerToolsAsideScope({ ...developer, env: { ...developer.env, SBD_REQUIRE_HOSTED_FIXTURES: "1" } });
		assert.equal(required.state, "refused");
		assert.equal(developerToolsAsideScope({ ...hostedMac, platform: "win32" }).state, "skipped", "Windows has none");
		assert.deepEqual(io.calls, []);
		const hosted = developerToolsAsideScope(hostedMac);
		assert.equal(hosted.state, "active");
		if (hosted.state === "active") {
			await hosted.enter(io);
			assert.equal(io.disk.has("/Library/Developer/CommandLineTools"), false);
			await hosted.leave(io);
			assert.equal(io.disk.has("/Library/Developer/CommandLineTools"), true);
		}
	});
	/** A hosted Mac whose /usr/bin/git answers once the tools are aside (macos-15-intel's image), and whose xcode-select and xcrun report no developer tools. */
	function gitStillRuns(): ReturnType<typeof fakeMac> {
		const io = fakeMac();
		const run = io.run.bind(io);
		io.run = async (command, args, options) => {
			if (command === "/usr/bin/git") return { code: 0, stdout: "git version 2.55.0\n", stderr: "" };
			if (command === "/usr/bin/xcode-select" || command === "/usr/bin/xcrun") return { code: 1, stdout: "", stderr: "no developer tools were found" };
			return run(command, args, options);
		};
		return io;
	}

	it("the scope refuses when /usr/bin/git still runs, names what it saw, and puts the tools back", async () => {
		const io = gitStillRuns();
		const before = new Set(io.disk);
		const scope = developerToolsAsideScope(hostedMac);
		assert.ok(scope.state === "active");
		await assert.rejects(scope.enter(io), /\/usr\/bin\/git still runs \(moved \["\/Library\/Developer\/CommandLineTools","\/Applications\/Xcode_16\.4\.app","\/Applications\/Xcode\.app"\]; xcode-select -p: no developer tools were found; git --version: git version 2\.55\.0; xcrun --find git: no developer tools were found/);
		assert.deepEqual(io.disk, before, "the tools are back");
	});

	it("with SBD_ASIDE_GIT_MAY_RUN=1 the scope goes on with a warning, keeps the tools aside for the run, and puts them back at the end", async () => {
		const io = gitStillRuns();
		const before = new Set(io.disk);
		const scope = developerToolsAsideScope({ ...hostedMac, env: { ...hostedMac.env, SBD_ASIDE_GIT_MAY_RUN: "1" } });
		assert.ok(scope.state === "active");
		const lines: string[] = [];
		const log = console.log;
		console.log = (...args: unknown[]) => void lines.push(args.join(" "));
		try {
			await scope.enter(io);
		} finally {
			console.log = log;
		}
		assert.match(lines.join("\n"), /^::warning title=developer tools aside::\/usr\/bin\/git runs with the developer tools aside/);
		assert.equal(io.disk.has("/Library/Developer/CommandLineTools"), false, "the tools stay aside");
		await scope.leave(io);
		assert.deepEqual(io.disk, before);
		const other = gitStillRuns();
		const strict = developerToolsAsideScope({ ...hostedMac, env: { ...hostedMac.env, SBD_ASIDE_GIT_MAY_RUN: "yes" } });
		assert.ok(strict.state === "active");
		await assert.rejects(strict.enter(other), /still runs/, "only the value 1 counts");
	});
});
