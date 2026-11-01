import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { agentModules, claudeStage, locateClaude, sdkPlatformPackage } from "../src/main/bootstrap/stages/claude.ts";
import { gitBashPath, piSettingsStage, withShellPath } from "../src/main/bootstrap/stages/pi-settings.ts";
import { StateStore } from "../src/main/bootstrap/state.ts";
import { toolDir } from "../src/main/paths.ts";
import { currentKey, makeStack, scratchRoot, testEngine, testLayout } from "./harness/engine-fixture.ts";
import type { StageContext } from "../src/main/bootstrap/stage.ts";

const scratch: string[] = [];
after(() => {
	for (const d of scratch) removeTree(d);
});
const isWindows = process.platform === "win32";

async function world() {
	const made = scratchRoot("sbd-set-");
	scratch.push(made.base);
	const layout = testLayout(made.root);
	mkdirSync(layout.agent, { recursive: true });
	const store = new StateStore(layout);
	return { ...made, layout, store };
}

describe("the pi-settings stage", () => {
	const GIT_A = "2.56.0.3";
	const GIT_B = "2.57.0.1";
	const installGit = async (w: Awaited<ReturnType<typeof world>>, version: string) => {
		const bash = join(toolDir(w.layout, "git", version), "bin", "bash.exe");
		mkdirSync(join(bash, ".."), { recursive: true });
		writeFileSync(bash, "stand-in");
		await w.store.setVersion("git", version);
		return bash;
	};
	const run = async (w: Awaited<ReturnType<typeof world>>) => {
		const stage = { ...piSettingsStage(), needs: [] as string[] };
		const engine = testEngine(w.root, () => [stage], { layout: w.layout });
		return engine.run(makeStack({}));
	};
	const settingsFile = (w: Awaited<ReturnType<typeof world>>): string => join(w.layout.agent, "settings.json");

	it("merges shellPath into the profile's settings.json and keeps every other key, then is skipped-verified", async () => {
		const w = await world();
		const bash = await installGit(w, GIT_A);
		writeFileSync(settingsFile(w), JSON.stringify({ defaultProvider: "claude-bridge", packages: ["npm:pi-intercom@0.18.1"], theme: { dark: true } }, null, 2));
		const first = await run(w);
		assert.equal(first.outcomes["pi-settings"]?.status, "installed", JSON.stringify(first.outcomes["pi-settings"]));
		assert.deepEqual(JSON.parse(readFileSync(settingsFile(w), "utf8")), { defaultProvider: "claude-bridge", packages: ["npm:pi-intercom@0.18.1"], theme: { dark: true }, shellPath: bash });
		assert.equal((await run(w)).outcomes["pi-settings"]?.status, "skipped-verified");
	});

	it("writes the key again when Git's version changes, and when the PM's edit replaced it", async () => {
		const w = await world();
		await installGit(w, GIT_A);
		writeFileSync(settingsFile(w), JSON.stringify({ a: 1 }));
		await run(w);
		const bashB = await installGit(w, GIT_B);
		const afterUpdate = await run(w);
		assert.equal(afterUpdate.outcomes["pi-settings"]?.status, "installed", "the evidence keeps Git's version");
		assert.equal(JSON.parse(readFileSync(settingsFile(w), "utf8")).shellPath, bashB);
		writeFileSync(settingsFile(w), JSON.stringify({ a: 1, shellPath: "C:\\Other\\bash.exe", mine: true }));
		const restored = await run(w);
		assert.equal(restored.outcomes["pi-settings"]?.status, "installed");
		assert.deepEqual(JSON.parse(readFileSync(settingsFile(w), "utf8")), { a: 1, mine: true, shellPath: bashB });
	});

	it("fails, naming the profile stage, when settings.json is missing, and leaves an invalid file alone", async () => {
		const w = await world();
		await installGit(w, GIT_A);
		const missing = await run(w);
		assert.equal(missing.outcomes["pi-settings"]?.status, "failed");
		assert.match(missing.outcomes["pi-settings"]?.failure?.detail ?? "", /is missing; run the profile stage first/);
		writeFileSync(settingsFile(w), "{ not json");
		const invalid = await run(w);
		assert.equal(invalid.outcomes["pi-settings"]?.status, "failed");
		assert.match(invalid.outcomes["pi-settings"]?.failure?.detail ?? "", /not valid JSON/);
		assert.equal(readFileSync(settingsFile(w), "utf8"), "{ not json");
	});

	it("formats like pi: two-space JSON and a final newline", () => {
		assert.equal(withShellPath({ a: 1 }, "C:\\G\\bash.exe"), '{\n  "a": 1,\n  "shellPath": "C:\\\\G\\\\bash.exe"\n}\n');
	});

	it("names bin/bash.exe of the active Git", async () => {
		const w = await world();
		await installGit(w, GIT_A);
		assert.equal(gitBashPath({ layout: w.layout, versionsOf: () => ({ git: GIT_A }) } as unknown as StageContext), join(toolDir(w.layout, "git", GIT_A), "bin", "bash.exe"));
	});
});

describe("locating the Agent SDK's claude", () => {
	const modules = isWindows ? "C:\\agent\\npm\\node_modules" : "/agent/npm/node_modules";
	const j = (...parts: string[]) => join(modules, ...parts);
	const tableExists = (...files: string[]) => (path: string) => files.includes(path);

	it("finds the platform package nested under the bridge, or hoisted beside it, for each platform key", () => {
		for (const [key, exe] of [["darwin-arm64", "claude"], ["darwin-x64", "claude"], ["win32-x64", "claude.exe"]] as const) {
			const nested = j("pi-claude-bridge", "node_modules", "@anthropic-ai", sdkPlatformPackage(key), exe);
			const hoisted = j("@anthropic-ai", sdkPlatformPackage(key), exe);
			assert.equal(locateClaude(modules, key, tableExists(nested))?.exe, nested);
			assert.equal(locateClaude(modules, key, tableExists(hoisted))?.exe, hoisted);
			assert.equal(locateClaude(modules, key, tableExists(nested, hoisted))?.exe, nested, "the bridge's own copy first");
		}
	});

	it("does not take another platform's package, and answers null when there is none", () => {
		const other = j("@anthropic-ai", sdkPlatformPackage("darwin-x64"), "claude");
		assert.equal(locateClaude(modules, "darwin-arm64", tableExists(other)), null);
		assert.equal(locateClaude(modules, "win32-x64", tableExists()), null);
	});

	it("looks under the agent folder's npm node_modules", () => {
		assert.equal(agentModules(testLayout(join(modules, "..", "..", "root"))), join(testLayout(join(modules, "..", "..", "root")).agent, "npm", "node_modules"));
	});
});

describe("the claude stage", { skip: isWindows ? "the stand-in claude is a shell script; the Windows e2e runs the real one" : false }, () => {
	const stage = { ...claudeStage(), needs: [] as string[] };
	const key = currentKey();

	async function withClaude(version: string, printed: string) {
		const w = await world();
		for (const tool of ["node", "git", "herdr"]) await w.store.setVersion(tool, "1.0.0");
		const pkg = join(agentModules(w.layout), "pi-claude-bridge", "node_modules", "@anthropic-ai", sdkPlatformPackage(key));
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "x", version }));
		writeFileSync(join(pkg, "claude"), `#!/bin/sh\necho '${printed}'\n`);
		chmodSync(join(pkg, "claude"), 0o755);
		return { ...w, pkg };
	}
	const runStage = (w: Awaited<ReturnType<typeof withClaude>>) => testEngine(w.root, () => [stage], { layout: w.layout }).run(makeStack({}));

	it("runs claude --version, records the SDK's version and the executable's hash, and is skipped-verified the second time", async () => {
		const w = await withClaude("0.3.316", "2.1.316 (Claude Code)");
		const first = await runStage(w);
		assert.equal(first.outcomes.claude?.status, "installed", JSON.stringify(first.outcomes.claude));
		assert.match(first.outcomes.claude?.evidence ?? "", /claude-agent-sdk 0\.3\.316; claude --version -> 2\.1\.316 \(Claude Code\)/);
		assert.equal((await runStage(w)).outcomes.claude?.status, "skipped-verified");
		// The agent folder lies under the root here, so the key is relative to the root; with the agent folder elsewhere it carries the `agent:` role.
		assert.deepEqual(Object.keys(new StateStore(w.layout).record("claude")?.hashes ?? {}), [`agent/npm/node_modules/pi-claude-bridge/node_modules/@anthropic-ai/${sdkPlatformPackage(key)}/claude`]);
	});

	it("runs again when the executable changes or the SDK moves to another version", async () => {
		const w = await withClaude("0.3.316", "2.1.316 (Claude Code)");
		await runStage(w);
		writeFileSync(join(w.pkg, "claude"), "#!/bin/sh\necho '2.1.316 (Claude Code) patched'\n");
		assert.equal((await runStage(w)).outcomes.claude?.status, "installed");
		writeFileSync(join(w.pkg, "package.json"), JSON.stringify({ name: "x", version: "0.3.317" }));
		assert.equal((await runStage(w)).outcomes.claude?.status, "installed");
	});

	it("fails by name when the platform package is missing, and when claude prints no version", async () => {
		const w = await world();
		for (const tool of ["node", "git", "herdr"]) await w.store.setVersion(tool, "1.0.0");
		const missing = await runStage(w as never);
		assert.equal(missing.outcomes.claude?.status, "failed");
		assert.match(missing.outcomes.claude?.failure?.detail ?? "", new RegExp(`has no ${sdkPlatformPackage(key)}/claude`));
		const odd = await withClaude("0.3.316", "not a version");
		const failed = await runStage(odd);
		assert.equal(failed.outcomes.claude?.status, "failed");
		assert.match(failed.outcomes.claude?.failure?.detail ?? "", /printed "not a version"/);
	});
});
