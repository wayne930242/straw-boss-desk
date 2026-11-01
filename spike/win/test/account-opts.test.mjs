import assert from "node:assert/strict";
import { test } from "node:test";
import { dialogSteps, parse, RISKY_FLAG } from "../../mac/account-opts.mjs";

const cmds = [["probe"], ["setup"], ["gh"], ["gh", "--skip-push"], ["glab", "--token-file", "/tmp/x"], ["glab", "--skip-push", "--skip-search"], ["cleanup"], ["x1", "before"]];

test("no default argument set reaches a dialog step", () => {
  for (const a of cmds) assert.deepEqual(dialogSteps(parse(a)), [], a.join(" "));
});

test("the explicit flag enables the dialog steps and nothing else does", () => {
  assert.deepEqual(dialogSteps(parse(["probe", RISKY_FLAG])), ["P1:store-unavailable"]);
  assert.deepEqual(dialogSteps(parse(["glab", RISKY_FLAG])), ["U2"]);
  assert.deepEqual(dialogSteps(parse(["gh", "--no-keychain", RISKY_FLAG])), ["U1"]);
  assert.deepEqual(dialogSteps(parse(["gh", RISKY_FLAG])), []);
  assert.deepEqual(dialogSteps(parse(["gh", "--no-keychain"])), []);
});

test("--login and --skip-u2 are unknown options", () => {
  assert.throws(() => parse(["gh", "--login"]), /unknown option/);
  assert.throws(() => parse(["glab", "--skip-u2"]), /unknown option/);
});
