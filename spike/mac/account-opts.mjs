// Command-line options of account-check.mjs, kept apart so a test can import them without the SPIKE guard or a run.
import { resolve } from "node:path";

export const RISKY_FLAG = "--store-unavailable-risky-dialog";

export function parse(argv) {
  const o = { cmd: argv[0], sub: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reuse-login") o.reuseLogin = true;
    else if (a === "--skip-push") o.skipPush = true;
    else if (a === "--skip-search") o.skipSearch = true;
    else if (a === "--no-keychain") o.noKeychain = true;
    else if (a === RISKY_FLAG) o.riskyDialog = true;
    else if (a === "--token-file") o.tokenFile = resolve(argv[++i]);
    else if (a === "--code-file") o.codeFile = resolve(argv[++i]);
    else if (!a.startsWith("--")) o.sub = a;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

/** The steps that can make macOS show a SecurityAgent unlock dialog (a locked, read-only keychain written to). Only the explicit flag enables them. */
export function dialogSteps(o) {
  if (!o.riskyDialog) return [];
  if (o.cmd === "probe") return ["P1:store-unavailable"];
  if (o.cmd === "glab") return ["U2"];
  if (o.cmd === "gh" && o.noKeychain) return ["U1"];
  return [];
}
