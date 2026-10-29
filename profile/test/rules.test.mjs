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

/** The fastest of three runs, so a pause from another process does not look like backtracking. */
function bestOf(condition, input) {
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    condition.lastIndex = 0;
    condition.test(input);
    best = Math.min(best, performance.now() - start);
    if (best < 5) break;
  }
  return best;
}

/** Linear noise passes: a run over the bar fails only when a quarter of the input is more than 8x faster (superlinear) or it takes over 2 s. */
function assertFast(condition, input, bar, label) {
  const took = bestOf(condition, input);
  if (took < bar) return;
  const quarter = bestOf(condition, input.slice(0, Math.floor(input.length / 4)));
  assert.ok(took < 2000 && took / Math.max(quarter, 10) < 8, `${label} took ${Math.round(took)} ms (${Math.round(quarter)} ms on a quarter) on ${JSON.stringify(input.slice(0, 40))} (${input.length} bytes)`);
}

function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fuzzTokens = ["\n", "\n", " ", " ", "\t", ";", "|", "&", "&&", "||", "a=1", "x=", "env", "sudo", "time", "command", "nohup", "-i", "-u", "-t", "-w", "-g", "-", "t", "w", "gh", "glab", "auth", "status", "token", "git", "credential", "-manager", "get", "config", "security", "find-generic-password", "Get-", "Set-Item", "Where-", "$env:", "'", '"', "(", "`", "{", "then ", "do ", "/", "\\", "bash -c ", "eval ", "cat ", "hosts.yml", "--show-token", "--no-pager", "-C ", ".exe", "\r"];

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
      const seeds = ["\n", ";", "&& ", "do ", "then ", "x=1 ", "sudo ", "env ", "gh ", "gh auth status ", ";gh auth status -", "Get-", "git credential-", "/", "a/", "\"", "git -C a ", "security find-generic-password ", "a=1\n", "sudo\n", "env\n", "env -i\n", "env -u ", "bash -c ", "cat ", "|", "&", "git --no-pager ", "glab config get ", "sudo -u do ", "do cat ", "then less ", "glab", "do cat glab", "X=${HOME} ", "X=$(pwd) ", "X=\"a "];
      for (const seed of seeds) {
        const input = seed.repeat(Math.ceil(size / seed.length)).slice(0, size);
        for (const condition of rule.conditions) {
          assertFast(condition, input, 200, `${name} on a run of ${JSON.stringify(seed)}`);
        }
      }
    });

    it(`${name}: stays fast on the reviewer's shapes and a realistic .env heredoc`, () => {
      const dotenv = "cat > .env <<'EOF'\n" + "DATABASE_URL=postgres://u:p@localhost/db\nexport API_HOST=api.example.com\nFEATURE_FLAG=1\n# comment line\n".repeat(2800) + "EOF\n";
      assert.ok(dotenv.length > 120 * 1024);
      const shapes = [
        "a=1\n".repeat(80000),
        "env\n".repeat(80000),
        "sudo\n".repeat(50000),
        "env -i\n".repeat(40000),
        "gh auth status -" + "t".repeat(80000) + ".",
        "security find-generic-password -" + "w".repeat(80000) + ".",
        dotenv,
        "git commit -m 'x'\n" + dotenv,
        ("do cat ".repeat(28) + "glab".repeat(1250) + "\n").repeat(Math.ceil(240000 / 5300)),
        ("then less ".repeat(20) + "glab".repeat(250) + "\n").repeat(Math.ceil(240000 / 1200)),
        "cat " + "glab".repeat(60000),
        "sudo -u do ".repeat(22000),
      ];
      for (const input of shapes) {
        for (const condition of rule.conditions) {
          assertFast(condition, input, 50, name);
        }
      }
    });

    it(`${name}: no input in a seeded fuzz takes 50 ms`, () => {
      const random = mulberry32(0x5eed);
      const pick = () => fuzzTokens[Math.floor(random() * fuzzTokens.length)];
      const inputs = [];
      for (let i = 0; i < 1200; i++) inputs.push(Array.from({ length: 200 + Math.floor(random() * 2500) }, pick).join(""));
      for (let i = 0; i < 300; i++) {
        const unit = Array.from({ length: 1 + Math.floor(random() * 3) }, pick).join("");
        inputs.push(unit.repeat(Math.ceil(30000 / Math.max(unit.length, 1))));
      }
      for (const input of inputs) {
        for (const condition of rule.conditions) {
          assertFast(condition, input, 50, name);
        }
      }
    });

    it(`${name}: the rule text is one readable message`, () => {
      // pi-anchorloop's render() expands a dollar sign followed by a backtick through String.replaceAll, so such a pair corrupts the text at runtime.
      assert.ok(!rule.content.includes("$`"), "the body contains a dollar sign followed by a backtick");
      assert.ok(!rule.content.includes("$'") && !rule.content.includes("$&") && !rule.content.includes("$$"), "the body contains another replace pattern");
      const paragraphs = rule.content.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      assert.equal(new Set(paragraphs).size, paragraphs.length, "a paragraph is repeated");
      assert.ok(paragraphs.every((p) => !p.includes("`\n") && (p.match(/`/g) ?? []).length % 2 === 0), "a code span is cut");
    });
  }
});

// The rules run through pi-anchorloop's own ttsr.ts, loaded from the pinned devDependency (2.2.3).
// Node does not strip types under node_modules, so the file is copied to a temp folder and
// the folder is removed after the run. Nothing here is skipped: a missing install fails the suite.
describe("guard rules against pi-anchorloop's own ttsr.ts", () => {
  const source = join(profileDir, "node_modules", "pi-anchorloop", "pi", "ttsr.ts");
  let dir;
  let ttsr;

  before(async () => {
    assert.ok(existsSync(source), `no ${source}: run npm install in profile/`);
    const pkg = JSON.parse(readFileSync(join(profileDir, "node_modules", "pi-anchorloop", "package.json"), "utf8"));
    assert.equal(pkg.version, "2.2.3", "the pinned pi-anchorloop is what runs");
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

  // Every matching call is blocked: a blocking tool-call match skips the repeat policy
  // (pi-anchorloop 2.2.3), within a turn and in the first turn after a resume.
  it("blocks a second matching call in the same turn", () => {
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

  it("blocks the first matching call in the first turn after a resume", () => {
    const { rule } = load("forge-login-hands-off");
    const manager = new ttsr.TtsrManager([rule]);
    manager.restore([rule.name]);
    const { digest, filePaths } = ttsr.toolDigest("bash", { command: "gh auth token" });
    assert.equal(manager.check(digest, { source: "tool", toolName: "bash", filePaths }).length, 1, "the call after a resume was not blocked");
  });
});
