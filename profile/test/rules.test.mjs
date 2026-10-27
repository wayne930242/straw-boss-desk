import { strict as assert } from "node:assert";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { blocksToolCall, loadRule } from "./ttsr-match.mjs";

const profileDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const ruleFiles = ["bash-not-powershell", "forge-login-hands-off"];
const rulePath = (name) => join(profileDir, "rules", `${name}.md`);

describe("guard rules", () => {
  for (const name of ruleFiles) {
    const rule = loadRule(rulePath(name));

    it(`${name}: loads as a bash-scoped rule with fixtures`, () => {
      assert.deepEqual(rule.scope, { allowText: false, allowThinking: false, allowAnyTool: false, toolScopes: [{ toolName: "bash", pathGlob: undefined }] });
      assert.equal(rule.repeatMode, "after-gap");
      assert.ok(rule.blocks.length >= 5, "at least five blocks fixtures");
      assert.ok(rule.allows.length >= 5, "at least five allows fixtures");
      assert.ok(rule.content.trim().length > 0, "the rule text is what the agent reads");
    });

    it(`${name}: blocks every blocks fixture`, () => {
      for (const command of rule.blocks) assert.ok(blocksToolCall(rule, "bash", command), `should block: ${command}`);
    });

    it(`${name}: allows every allows fixture`, () => {
      for (const command of rule.allows) assert.ok(!blocksToolCall(rule, "bash", command), `should allow: ${command}`);
    });

    it(`${name}: blocks the known false positives, so the list stays true`, () => {
      for (const command of rule.falsePositives) assert.ok(blocksToolCall(rule, "bash", command), `no longer blocked, remove from falsePositives: ${command}`);
    });

    it(`${name}: applies to bash only`, () => {
      for (const command of rule.blocks) {
        assert.ok(!blocksToolCall(rule, "write", command), `write must not match: ${command}`);
        assert.ok(!blocksToolCall(rule, "edit", command), `edit must not match: ${command}`);
      }
    });

    it(`${name}: stays fast on a 240 KB command`, () => {
      const size = 240 * 1024;
      const seeds = ["\n", ";", "&& ", "do ", "then ", "x=1 ", "sudo ", "env ", "gh ", "gh auth status ", ";gh auth status -", "Get-", "git credential-", "/", "a/", "\"", "git -C a ", "security find-generic-password "];
      for (const seed of seeds) {
        const input = seed.repeat(Math.ceil(size / seed.length)).slice(0, size);
        for (const condition of rule.conditions) {
          const start = performance.now();
          condition.test(input);
          const took = performance.now() - start;
          assert.ok(took < 200, `${name} took ${Math.round(took)} ms on a run of ${JSON.stringify(seed)}`);
        }
      }
    });
  }
});

// The rules run through pi-anchorloop's own ttsr.ts, loaded from the pinned devDependency (2.0.0).
// Node does not strip types under node_modules, so the file is copied to a temp folder and
// the folder is removed after the run. Nothing here is skipped: a missing install fails the suite.
describe("guard rules against pi-anchorloop's own ttsr.ts", () => {
  const source = join(profileDir, "node_modules", "pi-anchorloop", "pi", "ttsr.ts");
  let dir;
  let ttsr;

  before(async () => {
    assert.ok(existsSync(source), `no ${source}: run npm install in profile/`);
    const pkg = JSON.parse(readFileSync(join(profileDir, "node_modules", "pi-anchorloop", "package.json"), "utf8"));
    assert.equal(pkg.version, "2.0.0", "the pinned pi-anchorloop is what runs");
    dir = mkdtempSync(join(tmpdir(), "ttsr-"));
    copyFileSync(source, join(dir, "ttsr.ts"));
    ttsr = await import(pathToFileURL(join(dir, "ttsr.ts")).href);
  });

  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const load = (name) => {
    const warnings = [];
    const rule = ttsr.buildRule(rulePath(name), readFileSync(rulePath(name), "utf8"), warnings);
    return { rule, warnings };
  };
  /** What the extension does on a tool call: a fresh manager per call, so the repeat policy does not interfere. */
  const verdict = (rule, toolName, input) => {
    const manager = new ttsr.TtsrManager([rule]);
    const { digest, filePaths } = ttsr.toolDigest(toolName, input);
    return manager.check(digest, { source: "tool", toolName, filePaths }).length > 0;
  };

  for (const name of ruleFiles) {
    it(`${name}: loads without warnings and blocks a tool call`, () => {
      const { rule, warnings } = load(name);
      assert.ok(rule, "ttsr.ts loads the rule");
      assert.deepEqual(warnings, []);
      assert.equal(ttsr.interrupts(rule, "tool"), true, "a match blocks the call instead of only reminding");
    });

    it(`${name}: every fixture gets the verdict the mirror gave`, () => {
      const { rule } = load(name);
      const mirror = loadRule(rulePath(name));
      for (const command of mirror.blocks) assert.ok(verdict(rule, "bash", { command }), `ttsr.ts should block: ${command}`);
      for (const command of mirror.allows) assert.ok(!verdict(rule, "bash", { command }), `ttsr.ts should allow: ${command}`);
      for (const command of mirror.falsePositives) assert.ok(verdict(rule, "bash", { command }), `ttsr.ts should block (known false positive): ${command}`);
      assert.equal(verdict(rule, "write", { path: "a.txt", content: mirror.blocks[0] }), false, "write is out of scope");
      assert.equal(verdict(rule, "edit", { path: "a.txt", edits: [{ oldText: "a", newText: mirror.blocks[0] }] }), false, "edit is out of scope");
    });
  }

  // Upstream seam (design record, "Upstream seams to add"): TtsrManager.#eligible applies the repeat
  // policy to blocking tool-call matches, so a rule that has fired is silent again until a turn ends,
  // and after a resume until the second turn. The guard rules need every matching call blocked.
  const seam = "pi-anchorloop: a blocking tool-call match must not go through the repeat policy (tracked upstream)";

  it("blocks a second matching call in the same turn", { todo: seam }, () => {
    const { rule } = load("forge-login-hands-off");
    const manager = new ttsr.TtsrManager([rule]);
    const call = (command) => {
      const { digest, filePaths } = ttsr.toolDigest("bash", { command });
      const matched = manager.check(digest, { source: "tool", toolName: "bash", filePaths });
      manager.markInjected(matched.map((r) => r.name));
      return matched.length > 0;
    };
    assert.equal(call("gh auth status -t"), true);
    assert.equal(call("glab auth status -t"), true, "the second call in the turn was not blocked");
  });

  it("blocks the first matching call in the first turn after a resume", { todo: seam }, () => {
    const { rule } = load("forge-login-hands-off");
    const manager = new ttsr.TtsrManager([rule]);
    manager.restore([rule.name]);
    const { digest, filePaths } = ttsr.toolDigest("bash", { command: "gh auth token" });
    assert.equal(manager.check(digest, { source: "tool", toolName: "bash", filePaths }).length, 1, "the call after a resume was not blocked");
  });
});
