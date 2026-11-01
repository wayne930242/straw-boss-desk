import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, type PathLike } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it, type TestContext } from "node:test";
import { validateRecipe } from "../../recipe/validate.mjs";
import {
	TEAM_BEGIN,
	TEAM_END,
	composeAgents,
	install,
	isPackageListed,
	loadProfile,
	managedPath,
	markSkillsOnly,
	neutralize,
	normalizeText,
	replaceTeamBlock,
	safeRel,
	useTeamVersion,
	writeAtomic,
	type InstallResult,
	type Profile,
	type TeamRecipe,
} from "../src/main/profile/team-profile.ts";
import { recipeValidationOptions } from "../src/main/bootstrap/recipe-config.ts";
import { parseStack } from "../src/main/bootstrap/stack.ts";

// The kit's tests of `spike/win/lib/team-profile.mjs`, moved with the installer (spec: Tasks 7), plus a case for each followup of
// `~/.local/share/sbd-review/profile-stage/`: RC-F002, RC-F003, RC-F004, RC-F005, P3R-F001, P3R-F002 and P3R-F003. The kit's command-line tests are gone with the
// command line; the same behavior is checked through the functions the stage calls.

const repoRoot = join(import.meta.dirname, "..", "..");
const isCI = process.env.CI === "true";

type Json = Record<string, any>;

const put = (dir: string, rel: string, text: string): void => {
	mkdirSync(dirname(join(dir, ...rel.split("/"))), { recursive: true });
	writeFileSync(join(dir, ...rel.split("/")), text);
};
const read = (dir: string, rel: string): string => readFileSync(join(dir, ...rel.split("/")), "utf8");
const readJson = (dir: string, rel: string): Json => JSON.parse(read(dir, rel)) as Json;

interface ProfileSpec {
	version?: string;
	agents?: string;
	rules?: Record<string, string>;
	settings?: Json;
	herdr?: Json;
}

/** A small profile package on disk: AGENTS.md, one rule, one skill (which the installer must not copy), both configs. */
function makeProfile(root: string, { version = "1.0.0", agents = "# Team\n\nbe plain\n", rules = { "a.md": "rule a v1\n" }, settings = { defaultModel: "m1", quietStartup: "header" }, herdr = { models: { default: "m1", agents: { scout: "m1" } } } }: ProfileSpec = {}): Profile {
	rmSync(root, { recursive: true, force: true });
	put(root, "package.json", JSON.stringify({ name: "test-profile", version }));
	put(root, "AGENTS.md", agents);
	for (const [name, text] of Object.entries(rules)) put(root, `rules/${name}`, text);
	put(root, "skills/pm-workflow/SKILL.md", "skill v1\n");
	put(root, "config/settings.json", JSON.stringify(settings));
	put(root, "config/herdr-agents.json", JSON.stringify(herdr));
	return loadProfile(root);
}

let tmp: string;
let profileDir: string;
let agentDir: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "team-profile-"));
	profileDir = join(tmp, "profile");
	agentDir = join(tmp, "agent");
	mkdirSync(agentDir);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const kinds = (result: InstallResult): string[] => result.changes.map((c) => `${c.kind}:${"file" in c ? c.file : ""}${"key" in c ? c.key : ""}`).sort();
const manifest = (): Json => readJson(agentDir, ".straw-boss-profile/manifest.json");
const listFiles = (dir: string): string[] => (existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]).sort() : []);
const noTemp = (): boolean => !listFiles(agentDir).some((f) => f.includes(".sbd-tmp-"));

/** A symbolic link or junction; where the OS refuses (Windows without the privilege) the test skips on a developer's machine and fails on CI. */
function link(t: TestContext, target: string, path: PathLike, type?: "file" | "dir" | "junction"): boolean {
	try {
		symlinkSync(target, path, type);
		return true;
	} catch (error) {
		if (isCI || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
		t.skip("this machine does not let the test create a symbolic link");
		return false;
	}
}
const dirLink = (target: string, path: PathLike): void => symlinkSync(target, path, "junction");

describe("file states", () => {
	it("1. missing: writes the file and records its hash; the skill stays in the package", () => {
		const profile = makeProfile(profileDir);
		const result = install({ profile, agentDir });
		assert.equal(read(agentDir, "rules/a.md"), "rule a v1\n");
		assert.ok(!existsSync(join(agentDir, "skills")), "pi loads the skill from the installed package, so a copy would collide with it");
		assert.ok(kinds(result).includes("file-written:rules/a.md"));
		assert.match(manifest().files["rules/a.md"], /^[0-9a-f]{64}$/);
		assert.deepEqual(result.notices, []);
	});

	it("2. present and equal to the recorded hash: replaces it", () => {
		install({ profile: makeProfile(profileDir), agentDir });
		const next = makeProfile(profileDir, { version: "1.1.0", rules: { "a.md": "rule a v2\n" } });
		const result = install({ profile: next, agentDir });
		assert.equal(read(agentDir, "rules/a.md"), "rule a v2\n");
		assert.ok(kinds(result).includes("file-replaced:rules/a.md"));
		assert.equal(manifest().profile.version, "1.1.0");
		assert.deepEqual(listFiles(join(agentDir, ".straw-boss-profile")).filter((f) => f.startsWith("pending")), []);
	});

	it("3a. present and edited: leaves it and puts the new version under pending/<version>/", () => {
		install({ profile: makeProfile(profileDir), agentDir });
		put(agentDir, "rules/a.md", "my own rule\n");
		const result = install({ profile: makeProfile(profileDir, { version: "1.1.0", rules: { "a.md": "rule a v2\n" } }), agentDir });
		assert.equal(read(agentDir, "rules/a.md"), "my own rule\n");
		assert.equal(read(agentDir, ".straw-boss-profile/pending/1.1.0/rules/a.md"), "rule a v2\n");
		assert.deepEqual(result.notices.map((n) => `${n.kind}:${n.file}:${"reason" in n ? n.reason : ""}`), ["file-kept:rules/a.md:edited"]);
		// never beside the original: rules/ holds only the PM's file
		assert.deepEqual(listFiles(join(agentDir, "rules")), ["a.md"]);
	});

	it("3b. present with no record (the spike's AGENTS.md): leaves it, pending copy, no record", () => {
		put(agentDir, "AGENTS.md", "# Team profile (spike)\n");
		const result = install({ profile: makeProfile(profileDir), agentDir });
		assert.equal(read(agentDir, "AGENTS.md"), "# Team profile (spike)\n");
		assert.equal(read(agentDir, ".straw-boss-profile/pending/1.0.0/AGENTS.md"), "# Team\n\nbe plain\n");
		assert.deepEqual(result.notices.map((n) => `${n.file}:${"reason" in n ? n.reason : ""}`), ["AGENTS.md:no-record"]);
		assert.equal(manifest().files["AGENTS.md"], undefined);
	});

	it("3c. present and already equal to the new version with no record: records it, no pending", () => {
		put(agentDir, "rules/a.md", "rule a v1\n");
		const result = install({ profile: makeProfile(profileDir), agentDir });
		assert.ok(kinds(result).includes("file-recorded:rules/a.md"));
		assert.equal(result.notices.length, 0);
	});

	it("4a. a file the profile no longer ships, unchanged: deleted", () => {
		install({ profile: makeProfile(profileDir, { rules: { "a.md": "rule a v1\n", "b.md": "rule b\n" } }), agentDir });
		const result = install({ profile: makeProfile(profileDir, { version: "1.1.0" }), agentDir });
		assert.ok(!existsSync(join(agentDir, "rules", "b.md")));
		assert.ok(kinds(result).includes("file-removed:rules/b.md"));
		assert.equal(manifest().files["rules/b.md"], undefined);
	});

	it("4b. a file the profile no longer ships, edited: left and reported on every run", () => {
		install({ profile: makeProfile(profileDir, { rules: { "a.md": "rule a v1\n", "b.md": "rule b\n" } }), agentDir });
		put(agentDir, "rules/b.md", "my b\n");
		const next = makeProfile(profileDir, { version: "1.1.0" });
		for (let i = 0; i < 2; i++) {
			const result = install({ profile: next, agentDir });
			assert.equal(read(agentDir, "rules/b.md"), "my b\n");
			assert.deepEqual(result.notices.map((n) => `${n.kind}:${n.file}`), ["dropped-file-kept:rules/b.md"]);
		}
	});

	it("a skill the kit's installer copied (a manifest entry) is removed again when it is unchanged, so it cannot collide with the package's own", () => {
		// What a VM that ran the kit has: skills/pm-workflow/SKILL.md, recorded in the manifest.
		put(agentDir, "skills/pm-workflow/SKILL.md", "skill v1\n");
		put(agentDir, ".straw-boss-profile/manifest.json", JSON.stringify({ version: 1, files: { "skills/pm-workflow/SKILL.md": createHash("sha256").update("skill v1\n").digest("hex") }, keys: {} }));
		const result = install({ profile: makeProfile(profileDir), agentDir });
		assert.ok(kinds(result).includes("file-removed:skills/pm-workflow/SKILL.md"));
		assert.ok(!existsSync(join(agentDir, "skills", "pm-workflow", "SKILL.md")));
	});

	it("recipe instructions become one Team block in the recorded AGENTS.md; a recipe update changes only that block", () => {
		const profile = makeProfile(profileDir);
		install({ profile, agentDir, recipe: { id: "r", name: "Waydo", version: "1.0.0", instructions: "- rule one" } });
		const block = (body: string): string => `${TEAM_BEGIN}\n## Team: Waydo\n\n${body}\n${TEAM_END}\n`;
		assert.equal(read(agentDir, "AGENTS.md"), `# Team\n\nbe plain\n\n${block("- rule one")}`);
		const result = install({ profile, agentDir, recipe: { id: "r", name: "Waydo", version: "1.1.0", instructions: "- rule two" } });
		assert.equal(read(agentDir, "AGENTS.md"), `# Team\n\nbe plain\n\n${block("- rule two")}`);
		assert.deepEqual(kinds(result), ["file-replaced:AGENTS.md"]);
	});

	it("writes UTF-8 without a BOM and with LF endings whatever the source had", () => {
		const profile = makeProfile(profileDir, { agents: "﻿# 團隊\r\n\r\n用繁體中文\r\n" });
		install({ profile, agentDir });
		const bytes = readFileSync(join(agentDir, "AGENTS.md"));
		assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
		assert.ok(!bytes.includes(0x0d));
		assert.equal(bytes.toString("utf8"), "# 團隊\n\n用繁體中文\n");
		assert.equal(normalizeText("a\r\nb\rc"), "a\nb\nc");
		assert.equal(composeAgents("x", null), "x\n");
	});
});

describe("merged keys", () => {
	it("sets absent keys, keeps the PM's own keys, and records what it wrote", () => {
		put(agentDir, "settings.json", JSON.stringify({ shellPath: "C:\\git\\bash.exe", packages: ["npm:x@1"] }));
		install({ profile: makeProfile(profileDir), agentDir });
		const s = readJson(agentDir, "settings.json");
		assert.deepEqual(s, { shellPath: "C:\\git\\bash.exe", packages: ["npm:x@1"], defaultModel: "m1", quietStartup: "header" });
		assert.deepEqual(readJson(agentDir, "herdr-agents/config.json"), { models: { default: "m1", agents: { scout: "m1" } } });
		assert.equal(manifest().keys["settings.json"].defaultModel, "m1");
		assert.equal(manifest().keys["herdr-agents/config.json"]["models.agents.scout"], "m1");
	});

	it("replaces a key that still holds the value last written", () => {
		install({ profile: makeProfile(profileDir), agentDir });
		const result = install({ profile: makeProfile(profileDir, { version: "1.1.0", settings: { defaultModel: "m2", quietStartup: "header" } }), agentDir });
		assert.equal(readJson(agentDir, "settings.json").defaultModel, "m2");
		assert.ok(result.changes.some((c) => c.kind === "key-replaced" && c.file === "settings.json" && c.key === "defaultModel"));
	});

	it("keeps a key the PM changed and reports it", () => {
		install({ profile: makeProfile(profileDir), agentDir });
		const s = readJson(agentDir, "settings.json");
		s.defaultModel = "mine";
		put(agentDir, "settings.json", JSON.stringify(s));
		const result = install({ profile: makeProfile(profileDir, { version: "1.1.0", settings: { defaultModel: "m2", quietStartup: "header" } }), agentDir });
		assert.equal(readJson(agentDir, "settings.json").defaultModel, "mine");
		assert.deepEqual(result.notices.map((n) => `${n.kind}:${n.file}:${"key" in n ? n.key : ""}`), ["key-kept:settings.json:defaultModel"]);
	});

	it("keeps a differing key with no record (the spike's settings.json)", () => {
		put(agentDir, "settings.json", JSON.stringify({ defaultModel: "spike" }));
		const result = install({ profile: makeProfile(profileDir), agentDir });
		assert.equal(readJson(agentDir, "settings.json").defaultModel, "spike");
		assert.equal(readJson(agentDir, "settings.json").quietStartup, "header");
		assert.equal(result.notices.length, 1);
	});

	it("refuses a settings.json that is not JSON and changes nothing", () => {
		put(agentDir, "settings.json", "{ not json");
		assert.throws(() => install({ profile: makeProfile(profileDir), agentDir }), /not valid JSON/);
		assert.ok(!existsSync(join(agentDir, "AGENTS.md")));
	});
});

describe("pending, backup, and 'use the team version'", () => {
	it("saves the PM's copy under backup/<timestamp>/ and takes the pending copy", () => {
		install({ profile: makeProfile(profileDir), agentDir });
		put(agentDir, "rules/a.md", "mine\n");
		const next = makeProfile(profileDir, { version: "1.1.0", rules: { "a.md": "rule a v2\n" } });
		install({ profile: next, agentDir });
		const done = useTeamVersion({ profile: next, agentDir, files: ["rules/a.md"], now: new Date("2026-10-31T01:02:03.456Z") });
		assert.equal(done[0]?.backup, ".straw-boss-profile/backup/2026-10-31T01-02-03-456Z/rules/a.md");
		assert.equal(read(agentDir, done[0]?.backup as string), "mine\n");
		assert.equal(read(agentDir, "rules/a.md"), "rule a v2\n");
		assert.ok(!existsSync(join(agentDir, ".straw-boss-profile/pending/1.1.0/rules/a.md")));
		// the team version is now the recorded one, so the next update replaces it silently
		const result = install({ profile: makeProfile(profileDir, { version: "1.2.0", rules: { "a.md": "rule a v3\n" } }), agentDir });
		assert.ok(kinds(result).includes("file-replaced:rules/a.md"));
	});

	it("fails when there is no pending copy", () => {
		const profile = makeProfile(profileDir);
		install({ profile, agentDir });
		assert.throws(() => useTeamVersion({ profile, agentDir, files: ["rules/a.md"] }), /no pending/);
	});
});

describe("idempotent rerun", () => {
	it("a second run changes nothing, byte for byte", () => {
		const profile = makeProfile(profileDir);
		const recipe: TeamRecipe = { id: "r", name: "Waydo", version: "1.0.0", instructions: "- x", straw: { relay: "https://relay.example/" } };
		put(agentDir, "AGENTS.md", "spike\n"); // so a pending copy exists too
		install({ profile, agentDir, recipe });
		const snapshot = (): Record<string, string> => Object.fromEntries(listFiles(agentDir).filter((f) => statSync(join(agentDir, f)).isFile()).map((f) => [f, readFileSync(join(agentDir, f), "utf8")]));
		const before = snapshot();
		const dry = install({ profile, agentDir, recipe, dryRun: true });
		assert.deepEqual(dry.changes, []);
		assert.equal(dry.manifestChanged, false);
		const second = install({ profile, agentDir, recipe });
		assert.deepEqual(second.changes, []);
		assert.deepEqual(snapshot(), before);
		assert.equal(readJson(agentDir, "straw-boss/config.json").link.relay, "https://relay.example/");
	});

	it("a dry run writes nothing", () => {
		install({ profile: makeProfile(profileDir), agentDir, dryRun: true });
		assert.deepEqual(listFiles(agentDir), []);
	});

	it("verify: a dry run reports a change while one is pending", () => {
		const profile = makeProfile(profileDir);
		install({ profile, agentDir });
		rmSync(join(agentDir, "rules", "a.md"));
		const dry = install({ profile, agentDir, dryRun: true });
		assert.deepEqual(kinds(dry), ["file-written:rules/a.md"]);
	});
});

describe("the real profile package and the example recipe", () => {
	const recipeText = readFileSync(join(repoRoot, "recipe", "examples", "team.strawboss.json"), "utf8");
	const stack = parseStack(JSON.parse(readFileSync(join(repoRoot, "stack.json"), "utf8")));
	const validated = (text: string, extra: Json = {}): ReturnType<typeof validateRecipe> => validateRecipe(text, { ...recipeValidationOptions(stack), ...extra });

	it("the example recipe validates with the stack's reserved package names", () => {
		const result = validated(recipeText);
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal(result.ok ? result.recipe.id : null, "waydo-pm");
	});

	it("a recipe package that the stack already lists is refused, and so is a credential in the text", () => {
		const base = JSON.parse(recipeText) as Json;
		const withPkg = validated(JSON.stringify({ ...base, packages: [{ name: "pi-lens", version: "1.0.0", integrity: `sha512-${"A".repeat(86)}==` }] }));
		assert.equal(withPkg.ok, false);
		const leaked = validated(JSON.stringify({ ...base, instructions: `use ghp_${"a".repeat(36)}` }));
		assert.equal(leaked.ok, false);
		assert.ok(!leaked.ok && leaked.errors.some((e: { rule: string }) => e.rule === "secret-pattern"));
	});

	it("installs the repository's profile/ with the example recipe, verifies, and a rerun changes nothing", () => {
		const result = validated(recipeText);
		assert.equal(result.ok, true);
		const recipe = (result.ok ? result.recipe : null) as TeamRecipe;
		const profile = loadProfile(join(repoRoot, "profile"));
		const first = install({ profile, agentDir, recipe });
		assert.ok(first.changes.length > 0);
		for (const rel of ["AGENTS.md", "rules/bash-not-powershell.md", "rules/forge-login-hands-off.md", "herdr-agents/config.json", "settings.json", "straw-boss/config.json"]) {
			assert.ok(existsSync(join(agentDir, ...rel.split("/"))), rel);
		}
		assert.ok(!existsSync(join(agentDir, "skills")), "the skill comes from the installed package");
		assert.equal(readJson(agentDir, "straw-boss/config.json").link.relay, "https://relay.waydo.example/");
		assert.match(read(agentDir, "AGENTS.md"), /\n<!-- straw-boss:team-block:begin -->\n## Team: Waydo PM 工作環境\n\n- 文案用語/);
		const verify = install({ profile, agentDir, recipe, dryRun: true });
		assert.deepEqual(verify.changes, []);
		assert.equal(verify.manifestChanged, false);
		assert.deepEqual(install({ profile, agentDir, recipe }).changes, []);
	});

	it("only notices left (a file the PM kept) still verifies: no changes, no manifest change", () => {
		put(agentDir, "AGENTS.md", "# the PM's own\n");
		const profile = loadProfile(join(repoRoot, "profile"));
		const first = install({ profile, agentDir });
		assert.equal(first.notices.length, 1);
		const verify = install({ profile, agentDir, dryRun: true });
		assert.equal(verify.changes.length, 0);
		assert.equal(verify.manifestChanged, false);
		assert.equal(verify.notices.length, 1);
	});
});

describe("recipe packages are skills-only", () => {
	it("lists each package as { source, extensions: [] } and leaves other entries alone", () => {
		put(agentDir, "settings.json", JSON.stringify({ packages: ["npm:a@1.0.0", "npm:b@2.0.0", { source: "npm:c@3.0.0" }] }));
		const marked = markSkillsOnly({ agentDir, packages: [{ name: "b", version: "2.0.0" }, { name: "c", version: "3.0.0" }] });
		assert.deepEqual(marked, ["npm:b@2.0.0", "npm:c@3.0.0"]);
		assert.deepEqual(readJson(agentDir, "settings.json").packages, ["npm:a@1.0.0", { source: "npm:b@2.0.0", extensions: [] }, { source: "npm:c@3.0.0", extensions: [] }]);
		assert.deepEqual(markSkillsOnly({ agentDir, packages: [{ name: "b", version: "2.0.0" }] }), []);
	});

	it("fails when the package was not installed", () => {
		put(agentDir, "settings.json", JSON.stringify({ packages: [] }));
		assert.throws(() => markSkillsOnly({ agentDir, packages: [{ name: "z", version: "1.0.0" }] }), /not listed/);
	});

	it("isPackageListed tells a plain listing from a skills-only one, and the exact version", () => {
		put(agentDir, "settings.json", JSON.stringify({ packages: ["npm:a@1.0.0", { source: "npm:b@2.0.0", extensions: [] }, { source: "npm:c@3.0.0" }, { source: "npm:d@4.0.0", extensions: ["x"] }] }));
		assert.equal(isPackageListed(agentDir, "a", "1.0.0", false), true);
		assert.equal(isPackageListed(agentDir, "a", "1.0.0", true), false, "a plain string entry loads everything");
		assert.equal(isPackageListed(agentDir, "a", "1.0.1", false), false);
		assert.equal(isPackageListed(agentDir, "b", "2.0.0", true), true);
		assert.equal(isPackageListed(agentDir, "c", "3.0.0", true), false, "an object with no extensions key loads everything");
		assert.equal(isPackageListed(agentDir, "d", "4.0.0", true), false);
		assert.equal(isPackageListed(join(agentDir, "none"), "a", "1.0.0", false), false);
	});
});

describe("a PM value that is not an object under a profile key (R-F001)", () => {
	it("keeps a scalar or an array where the profile wants an object, and reports it", () => {
		put(agentDir, "herdr-agents/config.json", JSON.stringify({ models: ["mine"] }));
		put(agentDir, "settings.json", JSON.stringify({ quietStartup: { nested: 1 }, defaultModel: "m1" }));
		const profile = makeProfile(profileDir, { settings: { defaultModel: "m1", quietStartup: { level: "header" } } });
		const result = install({ profile, agentDir });
		assert.deepEqual(readJson(agentDir, "herdr-agents/config.json"), { models: ["mine"] });
		// an object the PM has with other keys is an object: the new key goes in beside theirs
		assert.deepEqual(readJson(agentDir, "settings.json").quietStartup, { nested: 1, level: "header" });
		assert.deepEqual(result.notices.map((n) => `${n.kind}:${n.file}:${"key" in n ? n.key : ""}`).sort(), ["key-kept:herdr-agents/config.json:models.agents.scout", "key-kept:herdr-agents/config.json:models.default"]);
		const again = install({ profile, agentDir });
		assert.deepEqual(again.changes, []);
		assert.deepEqual(readJson(agentDir, "herdr-agents/config.json"), { models: ["mine"] });
	});

	it("a scalar under a parent key is kept the same way", () => {
		put(agentDir, "herdr-agents/config.json", JSON.stringify({ models: "pm-own-value" }));
		const result = install({ profile: makeProfile(profileDir), agentDir });
		assert.deepEqual(readJson(agentDir, "herdr-agents/config.json"), { models: "pm-own-value" });
		assert.equal(result.notices.length, 2);
	});
});

describe("paths cannot leave the agent folder (R-F002)", () => {
	const hostile = ["../victim.txt", "a/../../victim.txt", "/etc/passwd", "C:/Windows/x", "C:x", "\\\\server\\share\\x", "..\\x", "rules//a.md", "./a.md", "rules/a.md:stream", "", "a\u0000b"];

	it("safeRel refuses every escaping or odd form", () => {
		for (const rel of hostile) assert.throws(() => safeRel(rel), /refusing/, JSON.stringify(rel));
		for (const rel of ["rules/a.md", "skills/pm-workflow/SKILL.md", ".straw-boss-profile/manifest.json"]) assert.equal(safeRel(rel), rel);
	});

	it("managedPath keeps the result inside the agent folder", () => {
		assert.equal(managedPath(agentDir, "rules/a.md"), join(agentDir, "rules", "a.md"));
		assert.throws(() => managedPath(agentDir, "../x"), /refusing/);
	});

	it("a hostile manifest key deletes nothing and writes nothing", () => {
		const victim = join(tmp, "victim.txt");
		writeFileSync(victim, "x");
		const profile = makeProfile(profileDir);
		install({ profile, agentDir });
		const m = manifest();
		m.files["../victim.txt"] = createHash("sha256").update("x").digest("hex");
		put(agentDir, ".straw-boss-profile/manifest.json", JSON.stringify(m));
		const before = readFileSync(join(agentDir, "rules/a.md"), "utf8");
		assert.throws(() => install({ profile: makeProfile(profileDir, { version: "1.1.0", rules: { "a.md": "rule a v2\n" } }), agentDir }), /refusing manifest path/);
		assert.equal(read(tmp, "victim.txt"), "x");
		assert.equal(read(agentDir, "rules/a.md"), before, "nothing was written before the refusal");
	});

	it("a manifest that is not an object of files is refused with a plain message", () => {
		put(agentDir, ".straw-boss-profile/manifest.json", JSON.stringify({ files: ["x"], keys: {} }));
		assert.throws(() => install({ profile: makeProfile(profileDir), agentDir }), /not a manifest this installer wrote/);
	});

	it("use-team refuses a --file that escapes, and nothing is written outside", () => {
		const profile = makeProfile(profileDir);
		install({ profile, agentDir });
		for (const rel of ["../x", "/abs", "C:/x", "a/../../x"]) assert.throws(() => useTeamVersion({ profile, agentDir, files: [rel] }), /refusing/, rel);
		assert.deepEqual(listFiles(tmp).filter((f) => f === "x" || f === "abs"), []);
	});

	it("a profile version that is not a folder name is refused", () => {
		const profile = makeProfile(profileDir);
		for (const version of ["../x", "a/b", "", ".hidden", "1.0.0\\x"]) assert.throws(() => install({ profile: { ...profile, version }, agentDir }), /refusing profile version/, version);
		assert.throws(() => makeProfile(profileDir, { version: "../evil" }), /refusing profile version/);
	});
});

describe("symbolic links and junctions are refused (R-F006)", () => {
	const outside = (): string => {
		const dir = join(tmp, "outside");
		mkdirSync(dir, { recursive: true });
		return dir;
	};

	it("a rules folder that is a link is refused and nothing is written through it", () => {
		const dir = outside();
		dirLink(dir, join(agentDir, "rules"));
		assert.throws(() => install({ profile: makeProfile(profileDir), agentDir }), /symbolic link or junction/);
		assert.deepEqual(readdirSync(dir), []);
		assert.ok(!existsSync(join(agentDir, "AGENTS.md")), "nothing was written before the refusal");
	});

	it("a dangling link at a path the installer would create is not written through", (t) => {
		const dir = outside();
		if (!link(t, join(dir, "created-here.md"), join(agentDir, "AGENTS.md"), "file")) return;
		assert.throws(() => install({ profile: makeProfile(profileDir), agentDir }), /symbolic link or junction/);
		assert.ok(!existsSync(join(dir, "created-here.md")));
	});

	it("a state folder that is a link is refused", () => {
		dirLink(outside(), join(agentDir, ".straw-boss-profile"));
		assert.throws(() => install({ profile: makeProfile(profileDir), agentDir }), /symbolic link or junction/);
		assert.deepEqual(readdirSync(join(tmp, "outside")), []);
	});

	it("a settings.json that is a link is refused by the merge and by skills-only", (t) => {
		const target = join(outside(), "real-settings.json");
		writeFileSync(target, "{}");
		if (!link(t, target, join(agentDir, "settings.json"), "file")) return;
		assert.throws(() => install({ profile: makeProfile(profileDir), agentDir }), /symbolic link or junction/);
		assert.throws(() => markSkillsOnly({ agentDir, packages: [{ name: "a", version: "1.0.0" }] }), /symbolic link or junction/);
		assert.equal(readFileSync(target, "utf8"), "{}");
	});

	it("the agent folder itself may be a link", () => {
		const real = outside();
		const linked = join(tmp, "agent-link");
		dirLink(real, linked);
		install({ profile: makeProfile(profileDir), agentDir: linked });
		assert.equal(read(real, "rules/a.md"), "rule a v1\n");
	});
});

describe("a PM-edited AGENTS.md and a recipe update", () => {
	it("keeps the PM's file, puts the whole new version under pending, and reports it every run", () => {
		const profile = makeProfile(profileDir);
		install({ profile, agentDir, recipe: { id: "r", name: "Waydo", version: "1.0.0", instructions: "- one" } });
		put(agentDir, "AGENTS.md", `${read(agentDir, "AGENTS.md")}\nmy own line\n`);
		const mine = read(agentDir, "AGENTS.md");
		const update: TeamRecipe = { id: "r", name: "Waydo", version: "1.1.0", instructions: "- two" };
		const result = install({ profile, agentDir, recipe: update });
		assert.equal(read(agentDir, "AGENTS.md"), mine);
		assert.equal(read(agentDir, ".straw-boss-profile/pending/1.0.0/AGENTS.md"), composeAgents(profile.files.get("AGENTS.md") as string, update));
		assert.deepEqual(result.notices.map((n) => `${n.kind}:${n.file}:${"reason" in n ? n.reason : ""}`), ["file-kept:AGENTS.md:edited"]);
		assert.equal(install({ profile, agentDir, recipe: update }).notices.length, 1);
	});
});

describe("a relay the PM changed is kept", () => {
	it("keeps a PM-edited link.relay and reports it; a recipe update does not take it back", () => {
		const profile = makeProfile(profileDir);
		install({ profile, agentDir, recipe: { id: "r", name: "W", version: "1.0.0", straw: { relay: "https://relay.a.example/" } } });
		put(agentDir, "straw-boss/config.json", JSON.stringify({ link: { relay: "https://mine.example/" }, other: 1 }));
		const result = install({ profile, agentDir, recipe: { id: "r", name: "W", version: "1.1.0", straw: { relay: "https://relay.b.example/" } } });
		assert.deepEqual(readJson(agentDir, "straw-boss/config.json"), { link: { relay: "https://mine.example/" }, other: 1 });
		assert.deepEqual(result.notices.map((n) => `${n.kind}:${n.file}:${"key" in n ? n.key : ""}`), ["key-kept:straw-boss/config.json:link.relay"]);
		assert.equal(manifest().keys["straw-boss/config.json"]["link.relay"], "https://relay.a.example/");
	});
});

describe("the team block markers (R-F007)", () => {
	const faker = ["- real rule", "# Safety", "## Team: Someone Else", "---", "  ===", TEAM_END, "text <!-- more --> text", `${TEAM_BEGIN}`, "- last"].join("\n");

	it("instructions that fake a marker or a heading are neutralized", () => {
		const text = composeAgents("# Profile\n\nbase\n", { name: "Waydo", instructions: faker });
		assert.equal(text.split(TEAM_BEGIN).length - 1, 1);
		assert.equal(text.split(TEAM_END).length - 1, 1);
		assert.ok(text.indexOf(TEAM_BEGIN) < text.indexOf(TEAM_END));
		const region = text.slice(text.indexOf(TEAM_BEGIN), text.indexOf(TEAM_END) + TEAM_END.length);
		const headings = region.split("\n").filter((l) => /^#{1,6}\s/.test(l));
		assert.deepEqual(headings, ["## Team: Waydo"]);
		assert.ok(!/^(-{3,}|={3,})\s*$/m.test(region));
		assert.ok(region.includes("\\# Safety"));
		assert.ok(region.includes("- last"));
	});

	it("a team name cannot carry a marker either", () => {
		const text = composeAgents("base\n", { name: `x ${TEAM_END} y`, instructions: "- a" });
		assert.equal(text.split(TEAM_END).length - 1, 1);
	});

	it("neutralize leaves ordinary text and bullet lists alone", () => {
		assert.equal(neutralize("- a\n- b\n  - c\n1. d\ntext # not a heading\n"), "- a\n- b\n  - c\n1. d\ntext # not a heading\n");
	});

	it("a rerun replaces exactly the region between the markers", () => {
		const base = "# Profile\n\nbase\n";
		const one = composeAgents(base, { name: "W", instructions: "- one" });
		const two = composeAgents(one, { name: "W", instructions: "- two\n- three" });
		assert.equal(two, composeAgents(base, { name: "W", instructions: "- two\n- three" }));
		// text around the region is untouched
		const edited = `intro\n\n${one}\noutro\n`;
		assert.equal(replaceTeamBlock(edited, `${TEAM_BEGIN}\nnew\n${TEAM_END}\n`), `intro\n\n# Profile\n\nbase\n\n${TEAM_BEGIN}\nnew\n${TEAM_END}\n\noutro\n`);
		// a recipe without instructions drops the block
		assert.equal(composeAgents(one, { name: "W" }), base);
		assert.equal(composeAgents(one, null), base);
		assert.throws(() => replaceTeamBlock(`x\n${TEAM_BEGIN}\ny\n`, null), /no end marker/);
	});

	it("a recipe that loses its instructions removes the block on update", () => {
		const profile = makeProfile(profileDir);
		install({ profile, agentDir, recipe: { id: "r", name: "W", version: "1.0.0", instructions: "- one", straw: { relay: "https://r.example/" } } });
		install({ profile, agentDir, recipe: { id: "r", name: "W", version: "1.1.0" } });
		assert.equal(read(agentDir, "AGENTS.md"), "# Team\n\nbe plain\n");
		assert.equal(readJson(agentDir, "straw-boss/config.json").link.relay, "https://r.example/");
	});
});

describe("a crash between the writes (R-F003, R-F005)", () => {
	const snapshot = (dir: string): Record<string, string> => Object.fromEntries(listFiles(dir).filter((f) => statSync(join(dir, f)).isFile()).map((f) => [f, readFileSync(join(dir, f), "utf8")]));

	it("leaves no temp files and, whatever step it stops at, the next run reaches the same final state", () => {
		const v1 = makeProfile(profileDir, { rules: { "a.md": "rule a v1\n", "b.md": "rule b\n" } });
		const recipe1: TeamRecipe = { id: "r", name: "W", version: "1.0.0", instructions: "- one", straw: { relay: "https://r.example/" } };
		const v2 = makeProfile(join(tmp, "profile2"), { version: "1.1.0", rules: { "a.md": "rule a v2\n", "c.md": "rule c\n" }, settings: { defaultModel: "m2", quietStartup: "header" } });
		const recipe2: TeamRecipe = { ...recipe1, version: "1.1.0", instructions: "- two" };

		// the reference: v1 then v2 with no crash
		install({ profile: v1, agentDir, recipe: recipe1 });
		install({ profile: v2, agentDir, recipe: recipe2 });
		const expected = snapshot(agentDir);
		assert.ok(noTemp());
		assert.ok(!existsSync(join(agentDir, "rules", "b.md")), "b.md was removed");

		for (let stop = 1; ; stop++) {
			rmSync(agentDir, { recursive: true, force: true });
			mkdirSync(agentDir);
			install({ profile: v1, agentDir, recipe: recipe1 });
			let steps = 0;
			let crashed = false;
			try {
				install({
					profile: v2,
					agentDir,
					recipe: recipe2,
					afterStep: () => {
						if (++steps === stop) throw new Error("simulated crash");
					},
				});
			} catch (error) {
				assert.match((error as Error).message, /simulated crash/);
				crashed = true;
			}
			assert.ok(noTemp(), `no temp file after a crash at step ${stop}`);
			for (const f of ["settings.json", "herdr-agents/config.json", "straw-boss/config.json", ".straw-boss-profile/manifest.json"]) JSON.parse(read(agentDir, f)); // never torn
			const rerun = install({ profile: v2, agentDir, recipe: recipe2 });
			assert.deepEqual(rerun.notices, [], `step ${stop}: nothing is reported as the PM's edit`);
			assert.deepEqual(snapshot(agentDir), expected, `final state after a crash at step ${stop}`);
			assert.deepEqual(install({ profile: v2, agentDir, recipe: recipe2 }).changes, []);
			if (!crashed) break;
		}
	});

	it("a dropped file is deleted before the manifest stops listing it", () => {
		install({ profile: makeProfile(profileDir, { rules: { "a.md": "rule a v1\n", "b.md": "rule b\n" } }), agentDir });
		const next = makeProfile(profileDir, { version: "1.1.0" });
		const order: string[] = [];
		install({ profile: next, agentDir, afterStep: (label) => order.push(label) });
		assert.ok(order.indexOf("remove rules/b.md") >= 0);
		assert.equal(order.at(-1), "write manifest");
		assert.ok(order.indexOf("remove rules/b.md") < order.indexOf("write manifest"));
	});

	it("use-team records the new hash and leaves no temp file; a crash after its target write is picked up by the next install", () => {
		install({ profile: makeProfile(profileDir), agentDir });
		put(agentDir, "rules/a.md", "mine\n");
		const next = makeProfile(profileDir, { version: "1.1.0", rules: { "a.md": "rule a v2\n" } });
		install({ profile: next, agentDir });
		const manifestBefore = read(agentDir, ".straw-boss-profile/manifest.json");
		useTeamVersion({ profile: next, agentDir, files: ["rules/a.md"] });
		assert.equal(manifest().files["rules/a.md"], createHash("sha256").update("rule a v2\n").digest("hex"));
		assert.ok(noTemp());
		// the crash: the target already holds the team version, the manifest and pending copy are as they were
		put(agentDir, ".straw-boss-profile/manifest.json", manifestBefore);
		const result = install({ profile: next, agentDir });
		assert.deepEqual(result.notices, []);
		assert.deepEqual(kinds(result), ["file-recorded:rules/a.md"]);
	});
});

// ---- the followups ------------------------------------------------------------------------------------------------------------------

describe("RC-F002 and P3R-F001: names Windows rewrites or opens as a device", () => {
	it("RC-F002: safeRel refuses segments ending in a dot or a space and Windows device names, with any extension and case", () => {
		const refused = ["x.", "rules/x. ", "rules/a ", "rules/...", "CON", "con", "rules/NUL.md", "aux.tar.gz", "Prn.txt", "COM1", "com9.md", "LPT3.x", "skills/Lpt1/SKILL.md", "COM¹", "lpt².md", "COM³.txt"];
		for (const rel of refused) assert.throws(() => safeRel(rel), /refusing/, JSON.stringify(rel));
		for (const rel of ["rules/console.md", "rules/null.md", "rules/com.md", "rules/com10.md", "rules/lpt.md", "rules/a.b.md", ".straw-boss-profile/manifest.json", "rules/con-x.md"]) assert.equal(safeRel(rel), rel);
	});

	it("P3R-F001: a space before the extension, COM0, LPT0, CONIN$ and CONOUT$ are device names too", () => {
		const refused = ["con .md", "rules/nul .txt", "rules/AUX  .tar.gz", "COM0", "rules/com0.md", "LPT0.md", "lpt0", "CONIN$", "rules/conin$.md", "CONOUT$", "conout$.txt", "skills/CON /SKILL.md"];
		for (const rel of refused) assert.throws(() => safeRel(rel), /refusing/, JSON.stringify(rel));
		// A name that only starts or ends like a device name is an ordinary name.
		for (const rel of ["rules/con.d/a.md", "rules/conin.md", "rules/conout.md", "rules/com00.md", "rules/lpt10.md", "rules/a con.md", "rules/prn-x.md", "rules/nul_.md"]) {
			if (rel === "rules/con.d/a.md") assert.throws(() => safeRel(rel), /device name/, "a folder called con.d is CON as well");
			else assert.equal(safeRel(rel), rel);
		}
	});

	it("RC-F002: a manifest key or a --file with such a segment is refused before any write", () => {
		const profile = makeProfile(profileDir);
		install({ profile, agentDir });
		for (const rel of ["rules/NUL.md", "rules/a.md.", "rules/con .md"]) assert.throws(() => useTeamVersion({ profile, agentDir, files: [rel] }), /refusing --file/, rel);
		const m = manifest();
		m.files["rules/CON.md"] = "0".repeat(64);
		put(agentDir, ".straw-boss-profile/manifest.json", JSON.stringify(m));
		assert.throws(() => install({ profile: makeProfile(profileDir, { version: "1.1.0", rules: { "a.md": "rule a v2\n" } }), agentDir }), /refusing manifest path/);
		assert.equal(read(agentDir, "rules/a.md"), "rule a v1\n");
	});

	it("P3R-F001: a profile package that ships such a file name is refused when it is loaded", () => {
		assert.throws(() => makeProfile(profileDir, { rules: { "con .md": "x\n" } }), /refusing profile file/);
		assert.throws(() => makeProfile(profileDir, { rules: { "COM0.md": "x\n" } }), /refusing profile file/);
	});
});

describe("a profile package that ships a link", () => {
	it("is refused when it is loaded: a link in rules/ or at AGENTS.md is not followed to a file elsewhere", (t) => {
		const secret = join(tmp, "outside-secret.txt");
		writeFileSync(secret, "not the package's");
		makeProfile(profileDir);
		rmSync(join(profileDir, "rules", "a.md"));
		if (!link(t, secret, join(profileDir, "rules", "a.md"), "file")) return;
		assert.throws(() => loadProfile(profileDir), /not a regular file; the profile package is damaged/);
		makeProfile(profileDir);
		rmSync(join(profileDir, "AGENTS.md"));
		link(t, secret, join(profileDir, "AGENTS.md"), "file");
		assert.throws(() => loadProfile(profileDir), /not a regular file/);
		makeProfile(profileDir);
		mkdirSync(join(tmp, "elsewhere", "deep"), { recursive: true });
		writeFileSync(join(tmp, "elsewhere", "deep", "x.md"), "x");
		dirLink(join(tmp, "elsewhere"), join(profileDir, "rules", "linked"));
		assert.throws(() => loadProfile(profileDir), /not a regular file/);
	});

	it("is refused when a config file is not a JSON object", () => {
		makeProfile(profileDir);
		writeFileSync(join(profileDir, "config", "settings.json"), "[1]");
		assert.throws(() => loadProfile(profileDir), /is not a JSON object; the profile package is damaged/);
		writeFileSync(join(profileDir, "config", "settings.json"), "{ nope");
		assert.throws(() => loadProfile(profileDir), /is not readable JSON/);
	});
});

describe("RC-F003: the temp file and the links of a write", () => {
	const outside = (): string => {
		const dir = join(tmp, "outside");
		mkdirSync(dir, { recursive: true });
		return dir;
	};

	it("a link planted at the old predictable temp name is not written through", (t) => {
		const target = join(outside(), "victim.txt");
		mkdirSync(join(agentDir, "rules"), { recursive: true });
		if (!link(t, target, join(agentDir, "rules", `a.md.sbd-tmp-${process.pid}`), "file")) return;
		install({ profile: makeProfile(profileDir), agentDir });
		assert.ok(!existsSync(target), "nothing was written outside the agent folder");
		assert.equal(read(agentDir, "rules/a.md"), "rule a v1\n");
	});

	it("the temp file is created with wx: a link already at that exact name stops the write, and nothing lands outside", (t) => {
		const target = join(outside(), "victim.txt");
		mkdirSync(join(agentDir, "rules"), { recursive: true });
		const path = join(agentDir, "rules", "a.md");
		const planted = `${path}.sbd-tmp-fixed`;
		if (!link(t, target, planted, "file")) return;
		assert.throws(() => writeAtomic(agentDir, path, "data", { tempName: () => planted }), (error: NodeJS.ErrnoException) => error.code === "EEXIST");
		assert.ok(!existsSync(target), "the link was not followed");
		assert.ok(!existsSync(path), "the target was not written");
	});

	it("a plain file already at the temp name is not overwritten either", () => {
		mkdirSync(join(agentDir, "rules"), { recursive: true });
		const path = join(agentDir, "rules", "a.md");
		const planted = `${path}.sbd-tmp-fixed`;
		writeFileSync(planted, "someone else's");
		assert.throws(() => writeAtomic(agentDir, path, "data", { tempName: () => planted }), (error: NodeJS.ErrnoException) => error.code === "EEXIST");
		assert.equal(readFileSync(planted, "utf8"), "someone else's");
	});

	it("a folder swapped for a link after planning is caught right before the next write", () => {
		const dir = outside();
		const profile = makeProfile(profileDir);
		assert.throws(
			() =>
				install({
					profile,
					agentDir,
					afterStep: (label) => {
						if (label === "write AGENTS.md") dirLink(dir, join(agentDir, "rules"));
					},
				}),
			/symbolic link or junction/,
		);
		assert.deepEqual(readdirSync(dir), [], "nothing was written through the link");
		assert.ok(noTemp());
	});

	it("a parent swapped for a link between the first check and the temp write is caught, and nothing is written through it", () => {
		const dir = outside();
		const path = join(agentDir, "rules", "a.md");
		mkdirSync(join(agentDir, "rules"), { recursive: true });
		const hooks = {
			beforeTemp: () => {
				rmSync(join(agentDir, "rules"), { recursive: true });
				dirLink(dir, join(agentDir, "rules"));
			},
		};
		// The message names the check that caught it: a link that appears here must be stopped before the temp file exists, not only before the rename.
		assert.throws(() => writeAtomic(agentDir, path, "data", hooks), /before its temp file is created.*symbolic link or junction/);
		assert.deepEqual(readdirSync(dir), [], "the temp file was not created through the link");
	});

	it("a parent swapped for a link after the temp file is written is caught before the rename, and the target stays unwritten", () => {
		const dir = outside();
		const path = join(agentDir, "rules", "a.md");
		mkdirSync(join(agentDir, "rules"), { recursive: true });
		writeFileSync(join(dir, "a.md"), "outside original");
		const hooks = {
			beforeRename: () => {
				rmSync(join(agentDir, "rules"), { recursive: true });
				dirLink(dir, join(agentDir, "rules"));
			},
		};
		assert.throws(() => writeAtomic(agentDir, path, "data", hooks), /before the rename.*symbolic link or junction/);
		assert.equal(readFileSync(join(dir, "a.md"), "utf8"), "outside original", "the file outside was not replaced");
		assert.deepEqual(readdirSync(dir), ["a.md"], "no temp file landed outside");
	});

	it("a parent that is already a link, even a dangling one, is refused before any folder is made", () => {
		const gone = join(tmp, "outside", "not-yet");
		mkdirSync(join(agentDir), { recursive: true });
		dirLink(gone, join(agentDir, "rules"));
		assert.throws(() => writeAtomic(agentDir, join(agentDir, "rules", "deep", "a.md"), "data"), /^Error: refusing write path .*symbolic link or junction/);
		assert.ok(!existsSync(gone), "no folder was made behind the link");
	});

	it("refuses a path outside the agent folder, and leaves no temp file after any failure", () => {
		assert.throws(() => writeAtomic(agentDir, join(tmp, "elsewhere.txt"), "x"), /outside the agent folder/);
		assert.ok(!existsSync(join(tmp, "elsewhere.txt")));
		mkdirSync(join(agentDir, "rules"), { recursive: true });
		const path = join(agentDir, "rules", "a.md");
		assert.throws(() => writeAtomic(agentDir, path, "x", { beforeRename: () => { throw new Error("boom"); } }), /boom/);
		assert.ok(noTemp());
		assert.ok(!existsSync(path));
	});

	it("no temp file is left behind after any write of an install", () => {
		const seen: boolean[] = [];
		install({ profile: makeProfile(profileDir), agentDir, afterStep: () => seen.push(noTemp()) });
		assert.ok(seen.length > 0 && seen.every(Boolean), "no temp file remains after a write");
		assert.ok(noTemp());
	});
});

describe("P3R-F003: a deletion looks for links once more", () => {
	it("a profile file the profile dropped is not deleted through a folder swapped for a link after planning", () => {
		const dir = join(tmp, "outside");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "b.md"), "outside file");
		install({ profile: makeProfile(profileDir, { rules: { "a.md": "rule a v1\n", "b.md": "rule b\n" } }), agentDir });
		const next = makeProfile(profileDir, { version: "1.1.0", agents: "# Team v2\n" });
		assert.throws(
			() =>
				install({
					profile: next,
					agentDir,
					afterStep: (label) => {
						if (label === "write AGENTS.md") {
							rmSync(join(agentDir, "rules"), { recursive: true });
							dirLink(dir, join(agentDir, "rules"));
						}
					},
				}),
			/symbolic link or junction/,
		);
		assert.equal(readFileSync(join(dir, "b.md"), "utf8"), "outside file", "the file outside was not deleted");
	});

	it("use-team does not delete the pending copy through a folder swapped for a link after its writes", () => {
		const profile = makeProfile(profileDir);
		install({ profile, agentDir });
		put(agentDir, "rules/a.md", "mine\n");
		const next = makeProfile(profileDir, { version: "1.1.0", rules: { "a.md": "rule a v2\n" } });
		install({ profile: next, agentDir });
		const dir = join(tmp, "outside-pending");
		mkdirSync(join(dir, "1.1.0", "rules"), { recursive: true });
		writeFileSync(join(dir, "1.1.0", "rules", "a.md"), "outside pending");
		let writes = 0;
		assert.throws(
			() =>
				useTeamVersion({
					profile: next,
					agentDir,
					files: ["rules/a.md"],
					hooks: {
						// The writes are the backup, the target, and the manifest; the pending copy is deleted after the last.
						beforeRename: () => {
							if (++writes !== 3) return;
							rmSync(join(agentDir, ".straw-boss-profile", "pending"), { recursive: true });
							dirLink(dir, join(agentDir, ".straw-boss-profile", "pending"));
						},
					},
				}),
			/symbolic link or junction/,
		);
		assert.equal(writes, 3);
		assert.equal(readFileSync(join(dir, "1.1.0", "rules", "a.md"), "utf8"), "outside pending", "the file outside was not deleted");
	});
});

describe("RC-F004: use-team switches only files the installer manages, once each", () => {
	it("refuses a file the manifest does not record and the profile does not ship", () => {
		const profile = makeProfile(profileDir);
		install({ profile, agentDir });
		put(agentDir, ".straw-boss-profile/pending/1.0.0/.straw-boss-profile/manifest.json", "{}");
		put(agentDir, ".straw-boss-profile/pending/1.0.0/rules/other.md", "x");
		const before = read(agentDir, ".straw-boss-profile/manifest.json");
		for (const rel of [".straw-boss-profile/manifest.json", "rules/other.md", "settings.json"]) assert.throws(() => useTeamVersion({ profile, agentDir, files: [rel] }), /not a file this installer manages/, rel);
		assert.equal(read(agentDir, ".straw-boss-profile/manifest.json"), before);
	});

	it("a repeated --file is switched once, and a later bad one stops everything before the first switch", () => {
		install({ profile: makeProfile(profileDir), agentDir });
		put(agentDir, "rules/a.md", "mine\n");
		const next = makeProfile(profileDir, { version: "1.1.0", rules: { "a.md": "rule a v2\n" } });
		install({ profile: next, agentDir });
		assert.throws(() => useTeamVersion({ profile: next, agentDir, files: ["rules/a.md", "rules/zzz.md"] }), /not a file this installer manages/);
		assert.equal(read(agentDir, "rules/a.md"), "mine\n", "nothing was switched");
		const done = useTeamVersion({ profile: next, agentDir, files: ["rules/a.md", "rules/a.md"] });
		assert.equal(done.length, 1);
		assert.equal(read(agentDir, "rules/a.md"), "rule a v2\n");
	});

	it("a file the PM already had (no record) can still be switched to the team version", () => {
		put(agentDir, "rules/a.md", "mine\n");
		const profile = makeProfile(profileDir);
		const result = install({ profile, agentDir });
		assert.equal((result.notices[0] as { reason: string }).reason, "no-record");
		assert.equal(useTeamVersion({ profile, agentDir, files: ["rules/a.md"] }).length, 1);
		assert.equal(read(agentDir, "rules/a.md"), "rule a v1\n");
	});
});

describe("RC-F005 and P3R-F002: recipe text cannot reshape the Markdown around the block", () => {
	it("RC-F005: setext underlines of any length are escaped", () => {
		assert.equal(neutralize("title\n=\nmore\n--\nx\n-\ny\n  ===  \n"), "title\n\\=\nmore\n\\--\nx\n\\-\ny\n  \\===  \n");
	});

	it("RC-F005: a code fence still open at the end is closed there; a closed one is left alone", () => {
		assert.equal(neutralize("a\n```js\nlet x\n"), "a\n```js\nlet x\n\n```");
		assert.equal(neutralize("~~~\nx\n~~~~\ny\n~~~\nz"), "~~~\nx\n~~~~\ny\n~~~\nz\n~~~", "the second ~~~ opens a fence that nobody closes");
		assert.equal(neutralize("```\nx\n```\ny"), "```\nx\n```\ny");
		assert.equal(neutralize("````\n```\nx\n````"), "````\n```\nx\n````");
		assert.equal(neutralize("text ``` inline\n``` not `a fence`"), "text ``` inline\n``` not `a fence`");
	});

	it("P3R-F002: an inner fence of the other kind does not leave a second fence open", () => {
		// The kit escaped the outer opener, which turned the inner `~~~` into an opener nobody closed.
		for (const text of ["```\n~~~\nx", "````\n~~~\n```"]) {
			const out = neutralize(text);
			let open: string | null = null;
			for (const line of out.split("\n")) {
				const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line) ?? /^ {0,3}(`{3,}|~{3,})/.exec(line);
				if (m === null) continue;
				const fence = m[1] as string;
				if (open === null) open = fence;
				else if (fence[0] === open[0] && fence.length >= open.length && /^ {0,3}(`{3,}|~{3,})\s*$/.test(line)) open = null;
			}
			assert.equal(open, null, `no fence is open after ${JSON.stringify(text)} -> ${JSON.stringify(out)}`);
			assert.ok(out.startsWith(text), "the text itself is kept, and only a closing fence is added");
		}
	});

	it("P3R-F002: a line that opens a raw HTML block gets its `<` escaped; ordinary HTML and text are left alone", () => {
		assert.equal(neutralize("<pre>\nx"), "\\<pre>\nx");
		assert.equal(neutralize("  <SCRIPT src=x>\n<style>\n<textarea\n<?php\n<![CDATA[\n<!DOCTYPE html>"), "  \\<SCRIPT src=x>\n\\<style>\n\\<textarea\n\\<?php\n\\<![CDATA[\n\\<!DOCTYPE html>");
		assert.equal(neutralize("a <b>bold</b> text\n<br>\n<div>x</div>\n<prefix>\n    <pre>"), "a <b>bold</b> text\n<br>\n<div>x</div>\n<prefix>\n    <pre>");
	});

	it("RC-F005: the block cannot change the rendering of the rest of AGENTS.md, markers intact", () => {
		const text = composeAgents("# Profile\n\nbase\n", { name: "W", instructions: "intro\n=\n```sh\nrm -rf x\n- more\n--" });
		const region = text.slice(text.indexOf(TEAM_BEGIN), text.indexOf(TEAM_END) + TEAM_END.length);
		assert.ok(region.endsWith(TEAM_END));
		assert.equal(text.split(TEAM_BEGIN).length - 1, 1);
		assert.equal(text.split(TEAM_END).length - 1, 1);
		const lines = region.split("\n");
		assert.ok(!lines.some((l) => /^ {0,3}(=+|-+)\s*$/.test(l)), "no setext underline");
		const fences = lines.filter((l) => /^ {0,3}(`{3,}|~{3,})/.test(l));
		assert.equal(fences.length % 2, 0, "every fence is closed");
	});
});
