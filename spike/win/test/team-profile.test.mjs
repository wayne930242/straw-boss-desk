import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { TEAM_BEGIN, TEAM_END, composeAgents, install, loadProfile, loadRecipe, managedPath, markSkillsOnly, neutralize, normalizeText, replaceTeamBlock, safeRel, useTeamVersion } from "../lib/team-profile.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const cli = join(here, "..", "lib", "team-profile.mjs");

const put = (dir, rel, text) => {
  mkdirSync(dirname(join(dir, ...rel.split("/"))), { recursive: true });
  writeFileSync(join(dir, ...rel.split("/")), text);
};
const read = (dir, rel) => readFileSync(join(dir, ...rel.split("/")), "utf8");
const readJson = (dir, rel) => JSON.parse(read(dir, rel));

/** A small profile package on disk: AGENTS.md, one rule, one skill, both configs. */
function makeProfile(root, { version = "1.0.0", agents = "# Team\n\nbe plain\n", rules = { "a.md": "rule a v1\n" }, settings = { defaultModel: "m1", quietStartup: "header" }, herdr = { models: { default: "m1", agents: { scout: "m1" } } } } = {}) {
  rmSync(root, { recursive: true, force: true });
  put(root, "package.json", JSON.stringify({ name: "test-profile", version }));
  put(root, "AGENTS.md", agents);
  for (const [name, text] of Object.entries(rules)) put(root, `rules/${name}`, text);
  put(root, "skills/pm-workflow/SKILL.md", "skill v1\n");
  put(root, "config/settings.json", JSON.stringify(settings));
  put(root, "config/herdr-agents.json", JSON.stringify(herdr));
  return loadProfile(root);
}

let tmp, profileDir, agentDir;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "team-profile-"));
  profileDir = join(tmp, "profile");
  agentDir = join(tmp, "agent");
  mkdirSync(agentDir);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const kinds = (result) => result.changes.map((c) => `${c.kind}:${c.file ?? c.key}`).sort();
const manifest = () => readJson(agentDir, ".straw-boss-profile/manifest.json");
const listFiles = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).sort() : []);

describe("file states", () => {
  it("1. missing: writes the file and records its hash", () => {
    const profile = makeProfile(profileDir);
    const result = install({ profile, agentDir });
    assert.equal(read(agentDir, "rules/a.md"), "rule a v1\n");
    assert.equal(read(agentDir, "skills/pm-workflow/SKILL.md"), "skill v1\n");
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
    assert.deepEqual(result.notices.map((n) => `${n.kind}:${n.file}:${n.reason}`), ["file-kept:rules/a.md:edited"]);
    // never beside the original: rules/ holds only the PM's file
    assert.deepEqual(listFiles(join(agentDir, "rules")), ["a.md"]);
  });

  it("3b. present with no record (the spike's AGENTS.md): leaves it, pending copy, no record", () => {
    put(agentDir, "AGENTS.md", "# Team profile (spike)\n");
    const result = install({ profile: makeProfile(profileDir), agentDir });
    assert.equal(read(agentDir, "AGENTS.md"), "# Team profile (spike)\n");
    assert.equal(read(agentDir, ".straw-boss-profile/pending/1.0.0/AGENTS.md"), "# Team\n\nbe plain\n");
    assert.deepEqual(result.notices.map((n) => `${n.file}:${n.reason}`), ["AGENTS.md:no-record"]);
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

  it("recipe instructions become one Team block in the recorded AGENTS.md; a recipe update changes only that block", () => {
    const profile = makeProfile(profileDir);
    install({ profile, agentDir, recipe: { id: "r", name: "Waydo", version: "1.0.0", instructions: "- rule one" } });
    const block = (body) => `${TEAM_BEGIN}\n## Team: Waydo\n\n${body}\n${TEAM_END}\n`;
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
    assert.deepEqual(result.notices.map((n) => `${n.kind}:${n.file}:${n.key}`), ["key-kept:settings.json:defaultModel"]);
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
    assert.equal(done[0].backup, ".straw-boss-profile/backup/2026-10-31T01-02-03-456Z/rules/a.md");
    assert.equal(read(agentDir, done[0].backup), "mine\n");
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
    const recipe = { id: "r", name: "Waydo", version: "1.0.0", instructions: "- x", straw: { relay: "https://relay.example/" } };
    put(agentDir, "AGENTS.md", "spike\n"); // so a pending copy exists too
    install({ profile, agentDir, recipe });
    const snapshot = () => Object.fromEntries(listFiles(agentDir).filter((f) => statSync(join(agentDir, f)).isFile()).map((f) => [f, readFileSync(join(agentDir, f), "utf8")]));
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
});

describe("recipe", () => {
  const recipeDir = join(repoRoot, "recipe");
  const recipeText = JSON.parse(readFileSync(join(recipeDir, "examples", "team.strawboss.json"), "utf8"));
  const write = (obj) => {
    const path = join(tmp, "recipe.json");
    writeFileSync(path, typeof obj === "string" ? obj : JSON.stringify(obj));
    return path;
  };

  it("the example recipe validates", async () => {
    const recipe = await loadRecipe({ recipePath: write(recipeText), recipeDir, reservedPackages: [] });
    assert.equal(recipe.id, "waydo-pm");
  });

  it("an invalid recipe is refused naming the rule, and the CLI installs nothing", () => {
    const bad = write({ ...recipeText, straw: { relay: "http://relay.example" } });
    const pins = join(tmp, "pins.json");
    writeFileSync(pins, JSON.stringify({ piPackages: [] }));
    const run = spawnSync(process.execPath, [cli, "install", "--root", repoRoot, "--agent-dir", agentDir, "--recipe", bad, "--pins", pins], { encoding: "utf8" });
    assert.equal(run.status, 1);
    const out = JSON.parse(run.stdout);
    assert.equal(out.ok, false);
    assert.match(out.error, /invalid recipe/);
    assert.ok(out.errors.some((e) => e.field === "straw.relay"));
    assert.deepEqual(listFiles(agentDir), []);
  });

  it("a recipe package that stack pins already list is refused", async () => {
    const withPkg = write({ ...recipeText, packages: [{ name: "pi-lens", version: "1.0.0", integrity: "sha512-" + "A".repeat(86) + "==" }] });
    await assert.rejects(loadRecipe({ recipePath: withPkg, recipeDir, reservedPackages: ["pi-lens"] }), /invalid recipe/);
  });

  it("a credential in the recipe is refused", async () => {
    const leaked = write({ ...recipeText, instructions: "use ghp_" + "a".repeat(36) });
    await assert.rejects(loadRecipe({ recipePath: leaked, recipeDir, reservedPackages: [] }), /secret-pattern/);
  });

  it("the CLI installs the real profile with the example recipe, then verify passes and a rerun changes nothing", () => {
    const recipe = write(recipeText);
    const pins = join(tmp, "pins.json");
    writeFileSync(pins, JSON.stringify({ piPackages: [{ name: "pi-lens" }] }));
    const args = (command) => [cli, command, "--root", repoRoot, "--agent-dir", agentDir, "--recipe", recipe, "--pins", pins];
    const first = JSON.parse(spawnSync(process.execPath, args("install"), { encoding: "utf8" }).stdout);
    assert.equal(first.ok, true);
    for (const rel of ["AGENTS.md", "rules/bash-not-powershell.md", "rules/forge-login-hands-off.md", "skills/pm-workflow/SKILL.md", "herdr-agents/config.json", "settings.json", "straw-boss/config.json"]) {
      assert.ok(existsSync(join(agentDir, ...rel.split("/"))), rel);
    }
    assert.equal(readJson(agentDir, "straw-boss/config.json").link.relay, "https://relay.waydo.example/");
    assert.match(read(agentDir, "AGENTS.md"), /\n<!-- straw-boss:team-block:begin -->\n## Team: Waydo PM 工作環境\n\n- 文案用語/);
    const verify = spawnSync(process.execPath, args("verify"), { encoding: "utf8" });
    assert.equal(verify.status, 0, verify.stdout);
    const again = JSON.parse(spawnSync(process.execPath, args("install"), { encoding: "utf8" }).stdout);
    assert.deepEqual(again.changes, []);
  });

  it("verify exits 1 while a change is pending", () => {
    const profile = makeProfile(profileDir);
    install({ profile, agentDir });
    rmSync(join(agentDir, "rules", "a.md"));
    const run = spawnSync(process.execPath, [cli, "verify", "--root", tmp, "--agent-dir", agentDir], { encoding: "utf8" });
    assert.equal(run.status, 1);
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
    assert.deepEqual(result.notices.map((n) => `${n.kind}:${n.file}:${n.key}`).sort(), ["key-kept:herdr-agents/config.json:models.agents.scout", "key-kept:herdr-agents/config.json:models.default"]);
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

  it("use-team through the CLI exits 1 on an escaping --file", () => {
    install({ profile: makeProfile(profileDir), agentDir });
    const run = spawnSync(process.execPath, [cli, "use-team", "--root", tmp, "--agent-dir", agentDir, "--file", "../victim"], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(JSON.parse(run.stdout).error, /refusing --file/);
  });

  it("a profile version that is not a folder name is refused", () => {
    const profile = makeProfile(profileDir);
    for (const version of ["../x", "a/b", "", ".hidden", "1.0.0\\x"]) assert.throws(() => install({ profile: { ...profile, version }, agentDir }), /refusing profile version/, version);
    assert.throws(() => makeProfile(profileDir, { version: "../evil" }), /refusing profile version/);
  });
});

describe("symbolic links and junctions are refused (R-F006)", () => {
  const outside = () => {
    const dir = join(tmp, "outside");
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  it("a rules folder that is a link is refused and nothing is written through it", () => {
    const dir = outside();
    symlinkSync(dir, join(agentDir, "rules"), "junction");
    assert.throws(() => install({ profile: makeProfile(profileDir), agentDir }), /symbolic link or junction/);
    assert.deepEqual(readdirSync(dir), []);
    assert.ok(!existsSync(join(agentDir, "AGENTS.md")), "nothing was written before the refusal");
  });

  it("a dangling link at a path the installer would create is not written through", () => {
    const dir = outside();
    symlinkSync(join(dir, "created-here.md"), join(agentDir, "AGENTS.md"));
    assert.throws(() => install({ profile: makeProfile(profileDir), agentDir }), /symbolic link or junction/);
    assert.ok(!existsSync(join(dir, "created-here.md")));
  });

  it("a state folder that is a link is refused", () => {
    symlinkSync(outside(), join(agentDir, ".straw-boss-profile"), "junction");
    assert.throws(() => install({ profile: makeProfile(profileDir), agentDir }), /symbolic link or junction/);
    assert.deepEqual(readdirSync(join(tmp, "outside")), []);
  });

  it("a settings.json that is a link is refused by the merge and by skills-only", () => {
    const target = join(outside(), "real-settings.json");
    writeFileSync(target, "{}");
    symlinkSync(target, join(agentDir, "settings.json"));
    assert.throws(() => install({ profile: makeProfile(profileDir), agentDir }), /symbolic link or junction/);
    assert.throws(() => markSkillsOnly({ agentDir, packages: [{ name: "a", version: "1.0.0" }] }), /symbolic link or junction/);
    assert.equal(readFileSync(target, "utf8"), "{}");
  });

  it("the agent folder itself may be a link", () => {
    const real = outside();
    const linked = join(tmp, "agent-link");
    symlinkSync(real, linked, "junction");
    install({ profile: makeProfile(profileDir), agentDir: linked });
    assert.equal(read(real, "rules/a.md"), "rule a v1\n");
  });
});

describe("a PM-edited AGENTS.md and a recipe update", () => {
  it("keeps the PM's file, puts the whole new version under pending, and reports it every run", () => {
    const profile = makeProfile(profileDir);
    install({ profile, agentDir, recipe: { id: "r", name: "Waydo", version: "1.0.0", instructions: "- one" } });
    put(agentDir, "AGENTS.md", read(agentDir, "AGENTS.md") + "\nmy own line\n");
    const mine = read(agentDir, "AGENTS.md");
    const update = { id: "r", name: "Waydo", version: "1.1.0", instructions: "- two" };
    const result = install({ profile, agentDir, recipe: update });
    assert.equal(read(agentDir, "AGENTS.md"), mine);
    assert.equal(read(agentDir, ".straw-boss-profile/pending/1.0.0/AGENTS.md"), composeAgents(profile.files.get("AGENTS.md"), update));
    assert.deepEqual(result.notices.map((n) => `${n.kind}:${n.file}:${n.reason}`), ["file-kept:AGENTS.md:edited"]);
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
    assert.deepEqual(result.notices.map((n) => `${n.kind}:${n.file}:${n.key}`), ["key-kept:straw-boss/config.json:link.relay"]);
    assert.equal(manifest().keys["straw-boss/config.json"]["link.relay"], "https://relay.a.example/");
  });
});

describe("verify with only notices", () => {
  it("exits 0 and says verified when the only difference is a file the PM kept", () => {
    put(agentDir, "AGENTS.md", "# the PM's own\n");
    const args = (command) => [cli, command, "--root", repoRoot, "--agent-dir", agentDir];
    const first = JSON.parse(spawnSync(process.execPath, args("install"), { encoding: "utf8" }).stdout);
    assert.equal(first.notices.length, 1);
    const verify = spawnSync(process.execPath, args("verify"), { encoding: "utf8" });
    assert.equal(verify.status, 0, verify.stdout);
    const out = JSON.parse(verify.stdout);
    assert.equal(out.verified, true);
    assert.equal(out.notices.length, 1);
    assert.equal(out.changes.length, 0);
  });
});

describe("the team block markers (R-F007)", () => {
  const faker = [
    "- real rule",
    "# Safety",
    "## Team: Someone Else",
    "---",
    "  ===",
    TEAM_END,
    "text <!-- more --> text",
    `${TEAM_BEGIN}`,
    "- last",
  ].join("\n");

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
  /** Runs install, throwing after the nth step as a killed process would, then the clean install again. */
  const snapshot = (dir) => Object.fromEntries(listFiles(dir).filter((f) => statSync(join(dir, f)).isFile()).map((f) => [f, readFileSync(join(dir, f), "utf8")]));

  it("leaves no temp files and, whatever step it stops at, the next run reaches the same final state", () => {
    const v1 = makeProfile(profileDir, { rules: { "a.md": "rule a v1\n", "b.md": "rule b\n" } });
    const recipe1 = { id: "r", name: "W", version: "1.0.0", instructions: "- one", straw: { relay: "https://r.example/" } };
    const v2 = makeProfile(join(tmp, "profile2"), { version: "1.1.0", rules: { "a.md": "rule a v2\n", "c.md": "rule c\n" }, settings: { defaultModel: "m2", quietStartup: "header" } });
    const recipe2 = { ...recipe1, version: "1.1.0", instructions: "- two" };

    // the reference: v1 then v2 with no crash
    install({ profile: v1, agentDir, recipe: recipe1 });
    install({ profile: v2, agentDir, recipe: recipe2 });
    const expected = snapshot(agentDir);
    assert.ok(!listFiles(agentDir).some((f) => f.includes(".sbd-tmp-")));
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
        assert.match(error.message, /simulated crash/);
        crashed = true;
      }
      assert.ok(!listFiles(agentDir).some((f) => f.includes(".sbd-tmp-")), `no temp file after a crash at step ${stop}`);
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
    const order = [];
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
    assert.ok(!listFiles(agentDir).some((f) => f.includes(".sbd-tmp-")));
    // the crash: the target already holds the team version, the manifest and pending copy are as they were
    put(agentDir, ".straw-boss-profile/manifest.json", manifestBefore);
    const result = install({ profile: next, agentDir });
    assert.deepEqual(result.notices, []);
    assert.deepEqual(kinds(result), ["file-recorded:rules/a.md"]);
  });
});

describe("P3 round: Windows-special names, temp files, --file, Markdown (RC-F002..F005)", () => {
  const outside = () => {
    const dir = join(tmp, "outside");
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  it("RC-F002: safeRel refuses segments ending in a dot or a space and Windows device names, with any extension and case", () => {
    const refused = ["x.", "rules/x. ", "rules/a ", "rules/...", "CON", "con", "rules/NUL.md", "aux.tar.gz", "Prn.txt", "COM1", "com9.md", "LPT3.x", "skills/Lpt1/SKILL.md", "COM\u00b9", "lpt\u00b2.md", "COM\u00b3.txt"];
    for (const rel of refused) assert.throws(() => safeRel(rel), /refusing/, JSON.stringify(rel));
    for (const rel of ["rules/console.md", "rules/null.md", "rules/com.md", "rules/com10.md", "rules/com0.md", "rules/lpt.md", "rules/a.b.md", ".straw-boss-profile/manifest.json", "rules/con-x.md"]) assert.equal(safeRel(rel), rel);
  });

  it("RC-F002: a manifest key or a --file with such a segment is refused before any write", () => {
    const profile = makeProfile(profileDir);
    install({ profile, agentDir });
    for (const rel of ["rules/NUL.md", "rules/a.md."]) assert.throws(() => useTeamVersion({ profile, agentDir, files: [rel] }), /refusing --file/, rel);
    const m = manifest();
    m.files["rules/CON.md"] = "0".repeat(64);
    put(agentDir, ".straw-boss-profile/manifest.json", JSON.stringify(m));
    assert.throws(() => install({ profile: makeProfile(profileDir, { version: "1.1.0", rules: { "a.md": "rule a v2\n" } }), agentDir }), /refusing manifest path/);
    assert.equal(read(agentDir, "rules/a.md"), "rule a v1\n");
  });

  it("RC-F003: a link planted at the old predictable temp name is not written through", () => {
    const target = join(outside(), "victim.txt");
    mkdirSync(join(agentDir, "rules"), { recursive: true });
    symlinkSync(target, join(agentDir, "rules", `a.md.sbd-tmp-${process.pid}`));
    install({ profile: makeProfile(profileDir), agentDir });
    assert.ok(!existsSync(target), "nothing was written outside the agent folder");
    assert.equal(read(agentDir, "rules/a.md"), "rule a v1\n");
  });

  it("RC-F003: no temp file is left behind after any write", () => {
    const seen = [];
    const profile = makeProfile(profileDir);
    install({ profile, agentDir, afterStep: () => seen.push(listFiles(agentDir).filter((f) => f.includes(".sbd-tmp-"))) });
    assert.ok(seen.every((names) => names.length === 0), "no temp file remains after a write");
    assert.ok(!listFiles(agentDir).some((f) => f.includes(".sbd-tmp-")));
  });

  it("RC-F003: a folder swapped for a link after planning is caught right before the next write", () => {
    const dir = outside();
    const profile = makeProfile(profileDir);
    assert.throws(
      () =>
        install({
          profile,
          agentDir,
          afterStep: (label) => {
            if (label === "write AGENTS.md") symlinkSync(dir, join(agentDir, "rules"), "junction");
          },
        }),
      /symbolic link or junction/,
    );
    assert.deepEqual(readdirSync(dir), [], "nothing was written through the link");
    assert.ok(!listFiles(agentDir).some((f) => f.includes(".sbd-tmp-")));
  });

  it("RC-F004: use-team refuses a file the manifest does not record and the profile does not ship", () => {
    const profile = makeProfile(profileDir);
    install({ profile, agentDir });
    put(agentDir, ".straw-boss-profile/pending/1.0.0/.straw-boss-profile/manifest.json", "{}");
    put(agentDir, ".straw-boss-profile/pending/1.0.0/rules/other.md", "x");
    const before = read(agentDir, ".straw-boss-profile/manifest.json");
    for (const rel of [".straw-boss-profile/manifest.json", "rules/other.md", "settings.json"]) assert.throws(() => useTeamVersion({ profile, agentDir, files: [rel] }), /not a file this installer manages/, rel);
    assert.equal(read(agentDir, ".straw-boss-profile/manifest.json"), before);
  });

  it("RC-F004: a repeated --file is switched once, and a later bad one stops everything before the first switch", () => {
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

  it("RC-F004: a file the PM already had (no record) can still be switched to the team version", () => {
    put(agentDir, "rules/a.md", "mine\n");
    const profile = makeProfile(profileDir);
    const result = install({ profile, agentDir });
    assert.equal(result.notices[0].reason, "no-record");
    assert.equal(useTeamVersion({ profile, agentDir, files: ["rules/a.md"] }).length, 1);
    assert.equal(read(agentDir, "rules/a.md"), "rule a v1\n");
  });

  it("RC-F005: setext underlines of any length are escaped", () => {
    assert.equal(neutralize("title\n=\nmore\n--\nx\n-\ny\n  ===  \n"), "title\n\\=\nmore\n\\--\nx\n\\-\ny\n  \\===  \n");
  });

  it("RC-F005: an unclosed code fence is escaped; a closed one is left alone", () => {
    assert.equal(neutralize("a\n```js\nlet x\n"), "a\n\\```js\nlet x\n");
    assert.equal(neutralize("~~~\nx\n~~~~\ny\n~~~\nz"), "~~~\nx\n~~~~\ny\n\\~~~\nz");
    assert.equal(neutralize("```\nx\n```\ny"), "```\nx\n```\ny");
    assert.equal(neutralize("````\n```\nx\n````"), "````\n```\nx\n````");
    assert.equal(neutralize("text ``` inline\n``` not `a fence`"), "text ``` inline\n``` not `a fence`");
  });

  it("RC-F005: the block cannot change the rendering of the rest of AGENTS.md, markers intact", () => {
    const text = composeAgents("# Profile\n\nbase\n", { name: "W", instructions: "intro\n=\n```sh\nrm -rf x\n- more\n--" });
    const region = text.slice(text.indexOf(TEAM_BEGIN), text.indexOf(TEAM_END) + TEAM_END.length);
    assert.ok(region.endsWith(TEAM_END));
    assert.equal(text.split(TEAM_BEGIN).length - 1, 1);
    assert.equal(text.split(TEAM_END).length - 1, 1);
    const lines = region.split("\n");
    assert.ok(!lines.some((l) => /^ {0,3}(=+|-+)\s*$/.test(l)), "no setext underline");
    assert.ok(!lines.some((l) => /^ {0,3}(`{3,}|~{3,})/.test(l)), "no fence is left open");
  });
});
