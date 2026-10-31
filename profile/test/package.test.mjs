import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const profileDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(readFileSync(join(profileDir, rel), "utf8"));

describe("package", () => {
  it("is a pi package that exposes the skills folder", () => {
    const pkg = readJson("package.json");
    assert.equal(pkg.name, "straw-boss-desk-profile");
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
    assert.ok(pkg.keywords.includes("pi-package"));
    assert.deepEqual(pkg.pi, { skills: ["./skills"] });
    assert.equal(pkg.dependencies, undefined, "no runtime dependencies");
  });

  it("npm pack lists only the intended files", () => {
    const run = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: profileDir,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    assert.equal(run.status, 0, run.stderr);
    const [info] = JSON.parse(run.stdout);
    assert.deepEqual(info.files.map((f) => f.path.replaceAll("\\", "/")).sort(), [
      "AGENTS.md",
      "LICENSE",
      "config/herdr-agents.json",
      "config/settings.json",
      "package.json",
      "rules/bash-not-powershell.md",
      "rules/forge-login-hands-off.md",
      "skills/pm-workflow/SKILL.md",
    ]);
  });
});

describe("configs", () => {
  it("herdr-agents routes the roles and carries no tasks block", () => {
    const config = readJson("config/herdr-agents.json");
    assert.equal(config.tasks, undefined);
    assert.equal(config.models.default, "claude-bridge/claude-sonnet-5-5");
    assert.deepEqual(Object.keys(config.models.agents).sort(), ["adversarial-reviewer", "planner", "reviewer", "scout", "visual-tester", "worker"]);
    for (const role of ["planner", "reviewer", "adversarial-reviewer"]) assert.equal(config.models.agents[role], "claude-bridge/claude-opus-5-5");
    for (const role of ["scout", "worker", "visual-tester"]) assert.equal(config.models.agents[role], "claude-bridge/claude-sonnet-5-5");
  });

  it("settings own only the profile's keys, with Haiku not enabled", () => {
    const settings = readJson("config/settings.json");
    assert.deepEqual(Object.keys(settings).sort(), ["collapseChangelog", "defaultModel", "defaultProvider", "defaultThinkingLevel", "enableInstallTelemetry", "enabledModels", "quietStartup"]);
    assert.deepEqual(settings.enabledModels, ["claude-bridge/claude-sonnet-5-5", "claude-bridge/claude-opus-5-5"]);
    assert.equal(settings.shellPath, undefined);
    assert.equal(settings.packages, undefined);
  });

  it("the skill has the frontmatter pi requires", () => {
    const text = readFileSync(join(profileDir, "skills/pm-workflow/SKILL.md"), "utf8");
    const match = /^---\nname: pm-workflow\ndescription: (.+)\n---\n/.exec(text);
    assert.ok(match, "name and description frontmatter");
    assert.ok(match[1].startsWith("Use when"));
  });
});
