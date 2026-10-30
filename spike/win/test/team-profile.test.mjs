import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { composeAgents, install, loadProfile, loadRecipe, markSkillsOnly, normalizeText, useTeamVersion } from "../lib/team-profile.mjs";

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
    assert.equal(read(agentDir, "AGENTS.md"), "# Team\n\nbe plain\n\n## Team: Waydo\n\n- rule one\n");
    const result = install({ profile, agentDir, recipe: { id: "r", name: "Waydo", version: "1.1.0", instructions: "- rule two" } });
    assert.equal(read(agentDir, "AGENTS.md"), "# Team\n\nbe plain\n\n## Team: Waydo\n\n- rule two\n");
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
    assert.match(read(agentDir, "AGENTS.md"), /\n## Team: Waydo PM 工作環境\n\n- 文案用語/);
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
