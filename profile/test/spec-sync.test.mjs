import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const spec = readFileSync(join(repoDir, "docs", "specs", "2026-10-27-team-profile.md"), "utf8");

/** Every fenced block in the spec: [{ fence, lang, text }], where text ends with a newline. */
function fencedBlocks(markdown) {
  const blocks = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^(`{3,})(\w*)\s*$/.exec(lines[i]);
    if (!open) continue;
    const body = [];
    for (i++; i < lines.length && lines[i] !== open[1]; i++) body.push(lines[i]);
    blocks.push({ fence: open[1], lang: open[2], text: body.join("\n") + "\n" });
  }
  return blocks;
}

const blocks = fencedBlocks(spec);

describe("the spec's code blocks are the profile files", () => {
  const files = ["AGENTS.md", "rules/bash-not-powershell.md", "rules/forge-login-hands-off.md", "skills/pm-workflow/SKILL.md"];
  for (const file of files) {
    it(`${file} is byte-identical to its spec block`, () => {
      const text = readFileSync(join(repoDir, "profile", file), "utf8");
      assert.ok(blocks.some((b) => b.lang === "markdown" && b.text === text), `no markdown block in the spec equals profile/${file}`);
    });
  }

  for (const file of ["config/herdr-agents.json", "config/settings.json"]) {
    it(`${file} equals its spec block`, () => {
      const data = JSON.parse(readFileSync(join(repoDir, "profile", file), "utf8"));
      assert.ok(blocks.some((b) => b.lang === "json" && JSON.stringify(JSON.parse(b.text)) === JSON.stringify(data)), `no json block in the spec equals profile/${file}`);
    });
  }

  it("the recipe example in section 5 is recipe/examples/team.strawboss.json", () => {
    const data = JSON.parse(readFileSync(join(repoDir, "recipe", "examples", "team.strawboss.json"), "utf8"));
    assert.ok(blocks.some((b) => b.lang === "json" && JSON.stringify(JSON.parse(b.text)) === JSON.stringify(data)));
  });
});
