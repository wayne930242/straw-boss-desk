import { strict as assert } from "node:assert";
import { copyFileSync, mkdtempSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { blocksToolCall, loadRule } from "./ttsr-match.mjs";

const profileDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const ruleFiles = ["bash-not-powershell", "forge-login-hands-off"];

describe("guard rules", () => {
  for (const name of ruleFiles) {
    const path = join(profileDir, "rules", `${name}.md`);
    const rule = loadRule(path);

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

    it(`${name}: applies to bash only`, () => {
      for (const command of rule.blocks) {
        assert.ok(!blocksToolCall(rule, "write", command), `write must not match: ${command}`);
        assert.ok(!blocksToolCall(rule, "edit", command), `edit must not match: ${command}`);
      }
    });
  }
});

// Cross-check against the real ttsr.ts when a copy of pi-anchorloop is on this machine.
// Set PI_ANCHORLOOP_TTSR to its path; the default is the pi agent's npm install.
const ttsrPath = process.env.PI_ANCHORLOOP_TTSR ?? join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-anchorloop", "pi", "ttsr.ts");

describe("guard rules against pi-anchorloop's own ttsr.ts", { skip: existsSync(ttsrPath) ? false : `no ttsr.ts at ${ttsrPath}` }, () => {
  it("every fixture gets the verdict the mirror gave", async () => {
    // Node does not strip types under node_modules, so load a copy from a temp dir.
    const dir = mkdtempSync(join(tmpdir(), "ttsr-"));
    const copy = join(dir, "ttsr.ts");
    copyFileSync(ttsrPath, copy);
    const { buildRule, TtsrManager, toolDigest } = await import(pathToFileURL(copy).href);
    for (const name of ruleFiles) {
      const path = join(profileDir, "rules", `${name}.md`);
      const mirror = loadRule(path);
      const warnings = [];
      const { readFileSync } = await import("node:fs");
      const rule = buildRule(path, readFileSync(path, "utf8"), warnings);
      assert.ok(rule, `${name}: ttsr.ts loads the rule`);
      assert.deepEqual(warnings, [], `${name}: no loader warnings`);
      const manager = new TtsrManager([rule]);
      const verdict = (command) => {
        const { digest, filePaths } = toolDigest("bash", { command });
        return manager.check(digest, { source: "tool", toolName: "bash", filePaths }).length > 0;
      };
      for (const command of mirror.blocks) assert.ok(verdict(command), `ttsr.ts should block: ${command}`);
      for (const command of mirror.allows) assert.ok(!verdict(command), `ttsr.ts should allow: ${command}`);
      const { digest, filePaths } = toolDigest("write", { path: "a.txt", content: mirror.blocks[0] });
      assert.equal(manager.check(digest, { source: "tool", toolName: "write", filePaths }).length, 0, "write is out of scope");
    }
  });
});
