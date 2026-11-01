// macOS account checks, option 1b of the design: every check process runs with HOME=$SPIKE/home (or $SPIKE/home-ro, whose keychain cannot be written), so /usr/bin/security, which
// gh and glab call through go-keyring, uses a scratch login keychain and never opens the user's own. Run it through account-check.sh.
//
//   probe                                  P1: the scratch keychain exists, is the only one in the search list, and a throwaway item stays in it
//   setup                                  F1 + G1: install gh/glab (forge-install.sh), write the launchers and the private Git configuration
//   gh --login [--skip-push] [--no-keychain]       G2-G8 (or U1 with --no-keychain), then the token search; the one-time code goes to --code-file
//   glab --login --token-file <f> [--skip-push]    L1-L7, then U2 and the token search with the same token, then the revoke of the token (C1)
//   cleanup                                logout of both CLIs, delete-keychain, rm -rf $SPIKE (only after S1 and X1)
//   x1 before|after                        fingerprint of the user's own gh/glab items (attributes and file hashes only, never a secret)
//
// Prints PASS/FAIL/WARN lines and writes the steps to $SPIKE/results/<name>.json (no secrets). Exit 1 on any FAIL.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, openSync, realpathSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ghTokenVerdict, glabTokenVerdict, gitValueList, hostTokenFindings, removeNestedRoots, splitUnread, yamlEntriesOfFile } from "../win/lib/account-verdict.mjs";
import { hideSecrets, scan } from "../win/lib/token-scan.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SPIKE = process.env.SPIKE ?? "";
if (SPIKE !== "/tmp/sbd-macacct") {
  console.log("refusing: SPIKE must be /tmp/sbd-macacct");
  process.exit(1);
}
const HOME_KC = join(SPIKE, "home");
const HOME_RO = join(SPIKE, "home-ro");
const HOME_EMPTY = join(SPIKE, "home-empty");
const RO_KC = join(HOME_RO, "Library/Keychains/login.keychain-db");
const TOOLS = join(SPIKE, "tools");
const TMP = join(SPIKE, "tmp");
const RESULTS = join(SPIKE, "results");
const KEEP = join(userInfo().homedir, ".local/share/sbd-review/mac-account");
const KC_PATH = join(HOME_KC, "Library/Keychains/login.keychain-db");
const GIT_CONFIG = join(HOME_KC, ".config/git/config");
const SECURITY = "/usr/bin/security";
const GIT = "/usr/bin/git";
const REAL_HOME = userInfo().homedir;
const pins = JSON.parse(readFileSync(join(here, "../win/pins.json"), "utf8")).binaries;

// ---- steps ----
const steps = [];
let resultName = "run";
const secrets = [];
function add(name, status, detail, ms = 0) {
  const d = hideSecrets(detail, secrets);
  steps.push({ name, status, detail: d, ms });
  console.log(`${status} ${name} ${d}`);
}
const ok = (b) => (b ? "PASS" : "FAIL");
function save() {
  mkdirSync(RESULTS, { recursive: true });
  const body = JSON.stringify({ name: resultName, at: new Date().toISOString(), steps }, null, 2);
  writeFileSync(join(RESULTS, `${resultName}.json`), body);
  mkdirSync(join(KEEP, "results"), { recursive: true });
  writeFileSync(join(KEEP, "results", `${resultName}.json`), body);
  const fails = steps.filter((s) => s.status === "FAIL").length;
  console.log(fails > 0 ? `${fails} FAIL` : "no FAIL");
  return fails;
}

// ---- environment, guard, load gate ----
const homeOf = (mode) => (mode === "ro" ? HOME_RO : mode === "empty" ? HOME_EMPTY : HOME_KC);
function envFor(mode, extra = {}) {
  return {
    HOME: homeOf(mode),
    PATH: `${join(TOOLS, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: TMP,
    GIT_CONFIG_GLOBAL: GIT_CONFIG,
    LANG: "en_US.UTF-8",
    USER: process.env.USER ?? "spike",
    LOGNAME: process.env.USER ?? "spike",
    TERM: "dumb",
    SHELL: "/bin/zsh",
    GH_BROWSER: "/usr/bin/true", // the person opens the device page; nothing is opened on the screen
    ...extra,
  };
}
function run(file, args, { mode = "kc", input, env = {}, timeout = 120_000 } = {}) {
  const t = Date.now();
  const r = spawnSync(file, args, { env: envFor(mode, env), input, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? (r.error ? -1 : 1), out: r.stdout ?? "", err: (r.stderr ?? "") + (r.error ? ` ${r.error.message}` : ""), ms: Date.now() - t };
}
const sec = (args, mode = "kc", input) => run(SECURITY, args, { mode, input, timeout: 20_000 });
const firstLine = (t) => hideSecrets(String(t).split(/\r?\n/).find((l) => l.trim()) ?? "", secrets).trim();

const SPIKE_REAL = realpathSync(SPIKE);
const inSpike = (p) => p.startsWith(SPIKE + "/") || p.startsWith(SPIKE_REAL + "/");
const sameFile = (a, b) => a === b || a.replace(SPIKE_REAL, SPIKE) === b.replace(SPIKE_REAL, SPIKE);
const keychainPaths = (text) => [...String(text).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
/** The guard: before every gh, glab or git call. The default keychain and the user search list must be under $SPIKE, or (no-keychain mode) absent. */
function assertScratch(mode, skipWritable = false) {
  const home = homeOf(mode);
  if (!home.startsWith(SPIKE + "/") || envFor(mode).HOME !== home) throw new Error(`guard: HOME is not under ${SPIKE}`);
  const def = sec(["default-keychain", "-d", "user"], mode);
  const list = sec(["list-keychains", "-d", "user"], mode);
  const defPaths = def.code === 0 ? keychainPaths(def.out) : [];
  const listPaths = list.code === 0 ? keychainPaths(list.out) : [];
  const outside = [...defPaths, ...listPaths].filter((p) => !inSpike(p));
  if (outside.length > 0) throw new Error(`guard: keychain outside ${SPIKE}: ${outside.join(", ")}`);
  if (mode === "kc" && (defPaths.length !== 1 || !sameFile(defPaths[0], KC_PATH))) throw new Error(`guard: the default keychain is ${JSON.stringify(defPaths)}, not ${KC_PATH}`);
  if (mode === "ro") {
    if (defPaths.length !== 1 || !sameFile(defPaths[0], RO_KC)) throw new Error(`guard: the default keychain is ${JSON.stringify(defPaths)}, not ${RO_KC}`);
    if (skipWritable) return;
    try {
      accessSync(RO_KC, constants.W_OK);
      throw new Error("guard: the store-unavailable keychain is writable");
    } catch (e) {
      if (e.code !== "EACCES") throw e;
    }
  }
}

function load1() {
  const m = /load averages?:\s*([0-9.]+)/.exec(spawnSync("/usr/bin/uptime", { encoding: "utf8" }).stdout);
  return m ? Number(m[1]) : 0;
}
async function loadGate(what) {
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    const l = load1();
    if (l < 35) return;
    if (Date.now() > deadline) throw new Error(`load gate: 1-minute load stayed at ${l} (>= 35) for 20 minutes before ${what}`);
    console.log(`load ${l} >= 35, waiting before ${what}`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

// ---- keychain ----
function dumpItems(mode = "kc") {
  // dump-keychain without -d prints attributes only, never the secret data.
  const r = sec(["dump-keychain", KC_PATH], mode);
  const items = [];
  let cur = null;
  for (const line of r.out.split("\n")) {
    if (/^keychain:/.test(line)) cur = { cls: "", svce: null, acct: null, srvr: null };
    else if (cur && /^class:/.test(line)) {
      cur.cls = /class: "(\w+)"/.exec(line)?.[1] ?? "";
      items.push(cur);
    } else if (cur) {
      const m = /^\s+"(svce|acct|srvr)"<blob>=(?:"(.*)"|<NULL>|0x[0-9A-F]+\s+"(.*)")/.exec(line);
      if (m) cur[m[1]] = m[2] ?? m[3] ?? "";
    }
  }
  return { code: r.code, items };
}

function setupKeychain() {
  mkdirSync(join(HOME_KC, "Library/Keychains"), { recursive: true, mode: 0o700 });
  mkdirSync(TMP, { recursive: true, mode: 0o700 });
  const pw = randomBytes(18).toString("hex");
  secrets.push(pw);
  const script = [
    `create-keychain -p ${pw} ${KC_PATH}`,
    `default-keychain -d user -s ${KC_PATH}`,
    `list-keychains -d user -s ${KC_PATH}`,
    `set-keychain-settings ${KC_PATH}`,
  ].join("\n") + "\n";
  const r = sec(["-i"], "kc", script);
  return r;
}

function setupReadOnly() {
  mkdirSync(join(HOME_RO, "Library/Keychains"), { recursive: true, mode: 0o700 });
  const pw = randomBytes(18).toString("hex");
  secrets.push(pw);
  const script = [`create-keychain -p ${pw} ${RO_KC}`, `default-keychain -d user -s ${RO_KC}`, `list-keychains -d user -s ${RO_KC}`, `lock-keychain ${RO_KC}`].join("\n") + "\n";
  const r = sec(["-i"], "ro", script);
  chmodSync(RO_KC, 0o444);
  chmodSync(dirname(RO_KC), 0o555);
  return r;
}

// ---- P1 ----
async function probe() {
  resultName = "p1";
  for (const d of [SPIKE, HOME_KC, HOME_EMPTY, TMP, join(SPIKE, "secret"), join(SPIKE, "work")]) mkdirSync(d, { recursive: true, mode: 0o700 });
  // Read-only first: with HOME=<scratch> and no plist, the default keychain must not be the user's. If it is, HOME is not honored: stop before anything is created.
  const def0 = sec(["default-keychain", "-d", "user"], "empty");
  const list0 = sec(["list-keychains", "-d", "user"], "empty");
  const seen = [...keychainPaths(def0.out), ...keychainPaths(list0.out)];
  const leak = seen.filter((p) => !inSpike(p));
  add("P1:home-honored", ok(leak.length === 0), `empty scratch HOME: default-keychain exit ${def0.code} ${firstLine(def0.out + def0.err)}; list-keychains exit ${list0.code}; paths outside ${SPIKE}: ${leak.length}${leak.length ? " -> HOME IS NOT HONORED, nothing was created" : ""}`);
  if (leak.length > 0) return save();
  const r = setupKeychain();
  add("P1:create-keychain", ok(r.code === 0 && existsSync(KC_PATH)), `security -i (password on stdin): exit ${r.code}; keychain file exists: ${existsSync(KC_PATH)}; ${firstLine(r.err)}`);
  try {
    assertScratch("kc");
    add("P1:guard-kc", "PASS", `default keychain and user search list are only ${KC_PATH}`);
  } catch (e) {
    add("P1:guard-kc", "FAIL", e.message);
    return save();
  }
  const realKc = join(REAL_HOME, "Library/Keychains/login.keychain-db");
  const nonce = `sbd-probe-${randomBytes(8).toString("hex")}`;
  const a = sec(["add-generic-password", "-s", nonce, "-a", "probe", "-w", "probe-value"], "kc");
  const f = sec(["find-generic-password", "-s", nonce, "-a", "probe", KC_PATH], "kc");
  const inScratch = dumpItems("kc").items.some((i) => i.svce === nonce);
  const info = sec(["show-keychain-info", KC_PATH], "kc");
  // The user's own keychain: an attribute lookup of the nonce name only, no -w and no -g.
  const real = run(SECURITY, ["find-generic-password", "-s", nonce, realKc], { mode: "kc", env: { HOME: REAL_HOME }, timeout: 20_000 });
  const d = sec(["delete-generic-password", "-s", nonce, "-a", "probe"], "kc");
  let gone = false;
  for (let i = 0; i < 10 && !gone; i++) {
    gone = !dumpItems("kc").items.some((x) => x.svce === nonce);
    if (!gone) await new Promise((r) => setTimeout(r, 500));
  }
  add("P1:item", ok(a.code === 0 && f.code === 0 && inScratch && real.code !== 0 && d.code === 0 && gone),
    `add exit ${a.code} (no keychain argument, so it went to the default); find in scratch exit ${f.code}; listed in scratch dump: ${inScratch}; found in the user's login keychain: ${real.code === 0} (exit ${real.code}); delete exit ${d.code}; gone afterwards: ${gone}; ${firstLine(info.err + info.out)}`);
  // Store unavailable. The design's first idea, a HOME with no keychain at all, made `security add-generic-password` wait for a SecurityAgent dialog on the
  // screen (30 s timeout in the first P1 run), so the check uses a scratch keychain that exists but is locked and read-only: the write fails at once.
  const roSetup = setupReadOnly();
  const nk = run(SECURITY, ["add-generic-password", "-s", nonce, "-a", "probe", "-w", "probe-value"], { mode: "ro", input: "", timeout: 30_000 });
  const nkRealHit = run(SECURITY, ["find-generic-password", "-s", nonce, realKc], { mode: "kc", env: { HOME: REAL_HOME }, timeout: 20_000 });
  const nkScratchHit = dumpItems("kc").items.some((i) => i.svce === nonce);
  add("P1:store-unavailable", ok(roSetup.code === 0 && nk.code !== 0 && nk.code !== -1 && nkRealHit.code !== 0 && !nkScratchHit),
    `locked read-only scratch keychain: setup exit ${roSetup.code}; add exit ${nk.code} in ${nk.ms} ms (no dialog wait) ${firstLine(nk.err + nk.out)}; found in the user's keychain: ${nkRealHit.code === 0}; found in the scratch keychain: ${nkScratchHit}`);
  try {
    assertScratch("ro");
    add("P1:guard-ro", "PASS", "the default keychain and search list of the store-unavailable home are only its own read-only keychain");
  } catch (e) {
    add("P1:guard-ro", "FAIL", e.message);
  }
  add("P1:finding", "WARN", "a HOME with no keychain at all is not usable for U1/U2: security add-generic-password waited for a SecurityAgent dialog until its 30 s timeout (first P1 run, 2026-11-01)");
  return save();
}

// ---- F1 + G1 ----
function setup() {
  resultName = "f1";
  mkdirSync(TMP, { recursive: true, mode: 0o700 });
  const clean = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SPIKE, SBD_NODE: process.execPath, HOME: HOME_KC, TMPDIR: TMP };
  const st = spawnSync("/bin/bash", [join(here, "forge-install.sh"), "self-test"], { env: clean, encoding: "utf8" });
  add("F1:refusals", ok(st.status === 0), `forge-install.sh self-test: ${st.stdout.trim().split("\n").join(" | ")}`);
  const ins = spawnSync("/bin/bash", [join(here, "forge-install.sh"), "install"], { env: clean, encoding: "utf8", timeout: 600_000 });
  add("F1:install", ok(ins.status === 0), ins.status === 0 ? ins.stdout.trim().split("\n").join(" | ") : (ins.stdout + ins.stderr).trim().split("\n").slice(-3).join(" | "));
  if (ins.status !== 0) return save();
  const fc = join(here, "../win/lib/forge-cli.mjs");
  const forgeArgs = ["--tools", TOOLS, "--forge", "github:github.com", "--forge", "gitlab:gitlab.moldplan.app"];
  const l = spawnSync(process.execPath, [fc, "launchers", "--platform", "darwin", ...forgeArgs], { encoding: "utf8", env: clean });
  const g = spawnSync(process.execPath, [fc, "git-config", "--file", GIT_CONFIG, ...forgeArgs], { encoding: "utf8", env: clean });
  add("F1:launchers", ok(l.status === 0 && g.status === 0), `launchers: ${l.stdout.trim()}; git-config: ${g.stdout.trim()}`);
  for (const [cli, want] of [["gh", pins.gh.version], ["glab", pins.glab.version]]) {
    const v = run(join(TOOLS, "bin", cli), ["--version"]);
    add(`F1:version-${cli}`, ok(v.code === 0 && (v.out + v.err).includes(want)), `${cli} --version through the launcher -> ${firstLine(v.out + v.err)}`);
  }
  const sys = spawnSync(GIT, ["config", "--system", "--get-all", "credential.helper"], { encoding: "utf8", env: clean });
  for (const [cli, host] of [["gh", "github.com"], ["glab", "gitlab.moldplan.app"]]) {
    const vals = helperValues(host);
    const good = vals.length === 2 && vals[0] === "" && vals[1].startsWith("!") && vals[1].endsWith(`/bin/${cli}' auth git-credential`);
    add(`G1:git-helper-${cli}`, ok(good), `credential.https://${host}.helper: ${vals.length} values; first empty: ${vals[0] === ""}; second: ${vals[1] ?? ""}; system helper (cleared by the empty entry): ${sys.stdout.trim() || "none"}`);
  }
  return save();
}
function helperValues(host) {
  const g = run(GIT, ["config", "--get-all", `credential.https://${host}.helper`]);
  return gitValueList(g.out);
}

// ---- shared steps ----
const FORGE = {
  gh: { host: "github.com", repo: "https://github.com/wayne930242/sbd-account-check", cfg: join(SPIKE, "config/gh"), key: "oauth_token", version: pins.gh.version },
  glab: { host: "gitlab.moldplan.app", repo: "https://gitlab.moldplan.app/weihung/sbd-account-check", cfg: join(SPIKE, "config/glab-cli"), key: "token", version: pins.glab.version },
};
const launcher = (cli) => join(TOOLS, "bin", cli);
const forge = (cli, args, o = {}) => run(launcher(cli), args, o);

function findings(cli) {
  const f = FORGE[cli];
  if (cli === "gh") {
    const h = hostTokenFindings(yamlEntriesOfFile(join(f.cfg, "hosts.yml")), { host: f.host, key: f.key });
    const c = hostTokenFindings(yamlEntriesOfFile(join(f.cfg, "config.yml")), { host: f.host, key: f.key, prefix: ["hosts"] });
    return { own: h.own + c.own, hosts: h.own, config: c.own, other: [...h.other, ...c.other] };
  }
  const g = hostTokenFindings(yamlEntriesOfFile(join(f.cfg, "config.yml")), { host: f.host, key: f.key, prefix: ["hosts"], directOnly: true });
  return { own: g.own, hosts: 0, config: g.own, other: g.other };
}
const yamlKeys = (p) => (existsSync(p) ? [...new Set(readFileSync(p, "utf8").split("\n").map((l) => /^\s*([A-Za-z0-9_.-]+)\s*:/.exec(l)?.[1]).filter(Boolean))] : []);

function logout(cli, why, mode) {
  const f = FORGE[cli];
  const r = forge(cli, ["auth", "logout", "--hostname", f.host], { mode });
  const left = findings(cli).own;
  add(`logout:${why}`, ok(r.code === 0 && left === 0), `${cli} auth logout exit ${r.code}; plain-text token lines of ${f.host} left in ${f.cfg}: ${left}; ${firstLine(r.out + " " + r.err)}`);
}

function itemsFor(prefixes) {
  return dumpItems("kc").items.filter((i) => prefixes.some((p) => (i.svce ?? i.srvr ?? "").startsWith(p)));
}

async function pushCheck(cli, mode) {
  const f = FORGE[cli];
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const branch = `chore/account-check-mac-${stamp}`;
  if (!/^chore\/account-check-mac-\d{8}-\d{6}$/.test(branch)) throw new Error("branch name is not the account-check form");
  const dest = join(SPIKE, "work", `account-check-${cli}`);
  rmSync(dest, { recursive: true, force: true });
  const noPrompt = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "echo", SSH_ASKPASS: "echo", GIT_TRACE: "1" };
  const runs = (t) => t.split("\n").filter((l) => /run_command:.*auth git-credential/.test(l)).length;
  const osx = (t) => t.split("\n").filter((l) => /credential-osxkeychain/.test(l)).length;
  const msg = (t) => hideSecrets(t.split("\n").find((l) => l.trim() && !/^\d\d:\d\d:\d\d/.test(l)) ?? "", secrets);
  assertScratch(mode);
  await loadGate("git clone");
  const c = run(GIT, ["clone", "--quiet", f.repo, dest], { mode, env: noPrompt, timeout: 180_000 });
  add("git-clone", ok(c.code === 0 && existsSync(join(dest, ".git"))), `git clone exit ${c.code} of a private repository; helper runs seen: ${runs(c.err + c.out)}; credential-osxkeychain runs seen: ${osx(c.err + c.out)}; ${msg(c.err)}`, c.ms);
  if (c.code !== 0) return;
  const before = run(GIT, ["-C", dest, "rev-parse", "origin/HEAD"], { mode }).out.trim();
  const br = run(GIT, ["-C", dest, "checkout", "-q", "-b", branch], { mode });
  const file = `check-${stamp}.md`;
  writeFileSync(join(dest, file), `# Account check ${stamp}\n\nWritten by spike/mac/account-check.mjs (${cli} ${f.version}) on macOS. It checks that a push through the credential helper needs no prompt.\n`);
  run(GIT, ["-C", dest, "add", file], { mode });
  const cm = run(GIT, ["-C", dest, "-c", "user.name=account check", "-c", "user.email=account-check@invalid", "commit", "-q", "-m", `chore: account check ${stamp}`], { mode });
  add("git-commit", ok(br.code === 0 && cm.code === 0), `branch ${branch}, file ${file}; checkout exit ${br.code}, commit exit ${cm.code} ${firstLine(cm.err)}`);
  const cur = run(GIT, ["-C", dest, "rev-parse", "--abbrev-ref", "HEAD"], { mode }).out.trim();
  if (cur !== branch) throw new Error(`HEAD is '${cur}', not ${branch}; nothing is pushed`);
  assertScratch(mode);
  await loadGate("git push");
  const pu = run(GIT, ["-C", dest, "push", "origin", `HEAD:refs/heads/${branch}`], { mode, env: noPrompt, timeout: 180_000 });
  add("git-push", ok(pu.code === 0 && runs(pu.err + pu.out) >= 1 && osx(pu.err + pu.out) === 0), `git push origin HEAD:refs/heads/${branch} exit ${pu.code} with prompts disabled; helper runs seen: ${runs(pu.err + pu.out)}; credential-osxkeychain runs seen: ${osx(pu.err + pu.out)}; ${msg(pu.err)}`, pu.ms);
  if (pu.code === 0) {
    const ls = run(GIT, ["-C", dest, "ls-remote", "--heads", "origin", branch], { mode, env: noPrompt, timeout: 120_000 });
    const sha = ls.out.split(/\s+/)[0];
    const main = run(GIT, ["-C", dest, "ls-remote", "--heads", "origin", "main"], { mode, env: noPrompt, timeout: 120_000 }).out.split(/\s+/)[0];
    const mainBefore = run(GIT, ["-C", dest, "rev-parse", "origin/main"], { mode }).out.trim();
    add("remote-branch", ok(/^[0-9a-f]{40}$/.test(sha) && main === mainBefore), `origin has ${branch} at ${sha}; main is ${main} (was ${mainBefore}${before ? "" : ""})`);
    pushed.push({ cli, branch, sha, repo: f.repo });
  }
  const v2 = helperValues(f.host);
  const v1 = pushHelperBefore[cli];
  add("git-helper-config-after", ok(v2.length === 2 && v2[0] === "" && v2[1] === v1?.[1]), `the helper entries are unchanged after login and push: ${v2.length} values`);
  if (mode === "kc") {
    const ip = itemsFor([f.host]).filter((i) => i.cls === "inet");
    add(`${cli === "gh" ? "G8" : "L7"}:no-internet-password`, ok(ip.length === 0), `internet-password items for ${f.host} in the scratch keychain (attributes only): ${ip.length}`);
  }
  rmSync(dest, { recursive: true, force: true });
}
const pushed = [];
const pushHelperBefore = {};

// The token search: three forms of one token, over all of $SPIKE.
function tokenSearch(label, token) {
  secrets.push(token);
  const d = join(TMP, `canary-${randomBytes(6).toString("hex")}`);
  mkdirSync(d, { recursive: true });
  const canary = `canary-${randomBytes(16).toString("hex")}`;
  writeFileSync(join(d, "utf8.txt"), `x ${canary} y`);
  writeFileSync(join(d, "utf16.txt"), Buffer.from(`x ${canary} y`, "utf16le"));
  writeFileSync(join(d, "keyring.txt"), `-w go-keyring-base64:${Buffer.from(canary).toString("base64")}\n`);
  writeFileSync(join(d, "clean.txt"), "nothing here");
  const self = scan([d], canary);
  rmSync(d, { recursive: true, force: true });
  const names = self.hits.map((p) => p.split("/").pop()).sort();
  add(`S1:self-test:${label}`, ok(names.join() === "keyring.txt,utf16.txt,utf8.txt"), `planted string found in: ${names.join(", ")}`);
  const roots = removeNestedRoots([SPIKE]);
  const t = Date.now();
  const r = scan(roots, token);
  add(`S1:${label}`, ok(r.hits.length === 0), `token (${token.length} chars; UTF-8, UTF-16LE and go-keyring forms) searched in ${r.files} files, ${Math.round(r.bytes / 1048576)} MB, ${Math.round((Date.now() - t) / 1000)} s, no size limit; hits: ${r.hits.length}${r.hits.length ? " in " + r.hits.join("; ") : ""}; roots: ${roots.join("; ")}`);
  const sp = splitUnread(r.unread, [SPIKE]);
  if (sp.strict.length > 0) add(`S1:unread:${label}`, "FAIL", `${sp.strict.length} file(s) under ${SPIKE} could not be read: ${sp.strict.map((u) => `${u.path} [${u.reason}]`).join("; ")}`);
  if (sp.extra.length > 0) add(`S1:unread-extra:${label}`, "WARN", sp.extra.map((u) => `${u.path} [${u.reason}]`).join("; "));
}

// ---- gh ----
function storeChecks(cli, mode) {
  const f = FORGE[cli];
  if (cli === "gh") {
    const s = forge("gh", ["auth", "status", "--hostname", f.host, "--json", "hosts"], { mode });
    let source = null, acct = null, state = null;
    if (s.code === 0) {
      try {
        const e = [].concat(JSON.parse(s.out).hosts?.[f.host] ?? [])[0];
        if (e && e.tokenSource != null) source = String(e.tokenSource);
        acct = e?.login; state = e?.state;
      } catch { /* source stays null */ }
    }
    const fi = findings("gh");
    const verdict = ghTokenVerdict({ source, hostsTokens: fi.hosts, configTokens: fi.config });
    add("G3:token-source", ok(verdict.verified), `gh auth status --json hosts exit ${s.code}; tokenSource='${source}'; login=${acct}; state=${state}; ${verdict.reason}${source === null ? ": " + firstLine(s.err + s.out) : ""}`);
    const hy = join(f.cfg, "hosts.yml");
    add("G4:config-file-token", ok(fi.own === 0 && existsSync(hy)), `${hy} exists: ${existsSync(hy)}; keys: ${yamlKeys(hy).join(", ")}; non-empty oauth_token lines of ${f.host}: ${fi.hosts}; config.yml (legacy hosts: block): ${fi.config}`);
    if (fi.other.length) add("other-host-token", "FAIL", `plain-text token for another host in ${f.cfg}: ${fi.other.join(", ")}; it is not this login's token, so ${f.host} is not logged out`);
    add("G6:isolation", ok(!existsSync(join(homeOf(mode), ".config/gh/hosts.yml"))), `no hosts.yml in $HOME/.config/gh of the scratch home (GH_CONFIG_DIR ${f.cfg} was used)`);
    return { plain: verdict.plain, verified: verdict.verified };
  }
  const cfg = join(f.cfg, "config.yml");
  const fi = findings("glab");
  add("L3:config-file-token", ok(fi.own === 0 && existsSync(cfg)), `${cfg} exists: ${existsSync(cfg)}; keys: ${yamlKeys(cfg).join(", ")}; non-empty token lines of ${f.host}: ${fi.own}; use_keyring: ${readFileSync(cfg, "utf8").match(/use_keyring:\s*"?(\w+)"?/)?.[1] ?? "(unset)"}`);
  if (fi.other.length) add("other-host-token", "FAIL", `plain-text token for another host in ${f.cfg}: ${fi.other.join(", ")}`);
  const s = forge("glab", ["auth", "status", "--hostname", f.host], { mode });
  const verdict = glabTokenVerdict({ configTokens: fi.own, statusExit: s.code });
  add("L5:auth-status", ok(s.code === 0), `glab auth status --hostname ${f.host} exit ${s.code}; ${verdict.reason}${s.code !== 0 ? ": " + firstLine(s.err + s.out) : ""}`);
  const defaults = [join(homeOf(mode), ".config/glab-cli/config.yml"), join(homeOf(mode), "Library/Application Support/glab-cli/config.yml")].filter(existsSync);
  add("L6:isolation", ok(defaults.length === 0), `glab's default folders in the scratch home hold no config.yml (GLAB_CONFIG_DIR ${f.cfg} was used); found: ${defaults.length}`);
  return { plain: verdict.plain, verified: verdict.verified };
}

function storeEvidence(cli) {
  if (cli === "gh") {
    const it = itemsFor(["gh:"]);
    const names = it.map((i) => `${i.svce}/${JSON.stringify(i.acct)}`);
    const has = (acct) => it.some((i) => i.svce === "gh:github.com" && i.acct === acct);
    const refresh = it.some((i) => i.svce.startsWith("gh:_refreshable:"));
    add("G5:store-evidence", ok(it.some((i) => i.svce === "gh:github.com" && i.acct === "wayne930242") && has("")), `scratch keychain items (attributes only): ${names.join("; ")}; refreshable item: ${refresh}`);
  } else {
    const it = itemsFor(["glab:"]);
    const names = it.map((i) => `${i.svce}/${JSON.stringify(i.acct)}`);
    const probe = it.filter((i) => i.svce.startsWith("glab:__keyring_probe__"));
    add("L4:store-evidence", ok(it.some((i) => i.svce === "glab:gitlab.moldplan.app:token" && i.acct === "") && probe.length === 0), `scratch keychain items (attributes only): ${names.join("; ")}; leftover probe items: ${probe.length}`);
  }
}

function readSharedText(p) {
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

const roSnapshot = () => createHash("sha256").update(readFileSync(RO_KC)).digest("hex");

async function ghLogin(opts) {
  const mode = opts.noKeychain ? "ro" : "kc";
  resultName = opts.noKeychain ? "u1" : "g2-g8";
  const f = FORGE.gh;
  assertScratch(mode);
  mkdirSync(join(SPIKE, "logs"), { recursive: true });
  const v = forge("gh", ["--version"], { mode });
  add("launcher", ok(v.code === 0 && (v.out + v.err).includes(f.version)), `${launcher("gh")} --version -> ${firstLine(v.out)}`);
  pushHelperBefore.gh = helperValues(f.host);
  const roBefore = opts.noKeychain ? roSnapshot() : null;
  const outF = join(SPIKE, "logs", `gh-login-${mode}.out.txt`);
  const errF = join(SPIKE, "logs", `gh-login-${mode}.err.txt`);
  rmSync(outF, { force: true });
  rmSync(errF, { force: true });
  let plainLine = false;
  if (opts.reuseLogin) {
    // Resume after an interrupted run: the login already exists in the scratch keychain; run the checks that follow it.
    const st = forge("gh", ["auth", "status", "--hostname", f.host], { mode });
    add("login", ok(st.code === 0), `reused the gh login already in the scratch keychain (gh auth status exit ${st.code}); the interrupted run printed no plain-text warning`);
  } else {
    await loadGate("gh auth login");
    const t0 = Date.now();
    const outFd = openSync(outF, "w");
    const errFd = openSync(errF, "w");
    const child = spawn(launcher("gh"), ["auth", "login", "--hostname", f.host, "--git-protocol", "https", "--web"], { env: envFor(mode), stdio: ["ignore", outFd, errFd] });
    let exit = null;
    child.on("exit", (c) => { exit = c ?? 1; });
    let code = null;
    while (!code && Date.now() - t0 < 90_000 && exit === null) {
      await new Promise((r) => setTimeout(r, 500));
      const m = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(readSharedText(outF) + readSharedText(errF));
      if (m) code = m[1];
    }
    if (!code) {
      child.kill("SIGTERM");
      add("login:code-printed", "FAIL", `gh printed no one-time code within 90 s: ${firstLine(readSharedText(outF) + " " + readSharedText(errF))}`);
      return save();
    }
    if (opts.codeFile) writeFileSync(opts.codeFile, code);
    console.log(`GH CODE ${code}`);
    add("login:code-printed", "PASS", `gh printed a one-time code (length ${code.length}); written to ${opts.codeFile ?? "(no file)"}; waiting for the person to approve at https://github.com/login/device`, Date.now() - t0);
    const waitMs = 14 * 60_000;
    while (exit === null && Date.now() - t0 < waitMs) await new Promise((r) => setTimeout(r, 1000));
    if (exit === null) {
      child.kill("SIGTERM");
      add("login", "FAIL", "not approved within 14 minutes; gh login stopped", Date.now() - t0);
      return save();
    }
    const outTxt = readSharedText(outF) + "\n" + readSharedText(errF);
    const line = outTxt.split("\n").filter((l) => /Logged in|Authentication complete|error|failed|plain text/i.test(l)).slice(0, 3).join(" | ");
    plainLine = /saved in plain text/i.test(outTxt);
    add("login", ok(opts.noKeychain ? exit === 0 : exit === 0 && !plainLine), `gh auth login --hostname ${f.host} --git-protocol https --web exit ${exit}; ${hideSecrets(line, secrets)}; "saved in plain text" printed: ${plainLine}`, Date.now() - t0);
  }
  let token = null;
  const tk = forge("gh", ["auth", "token", "--hostname", f.host], { mode });
  if (tk.code === 0) token = tk.out.trim();
  if (token) secrets.push(token);
  const sc = storeChecks("gh", mode);
  if (!opts.noKeychain) storeEvidence("gh");
  if (opts.noKeychain) {
    // U1: the store is unavailable. The login must be refused: gh said "plain text", the verdict sees a token in a file, the check logs out.
    add("U1:plain-text-reported", ok(plainLine && sc.plain), `gh printed "saved in plain text": ${plainLine}; verdict plain: ${sc.plain}; token in hosts.yml (non-empty oauth_token lines): ${findings("gh").hosts}`);
    if (sc.plain) {
      console.log(`REFUSED: the credential store is unavailable, so the ${f.host} login is not kept in plain text (no --insecure-storage, ever).`);
      logout("gh", "plain-text", mode);
    }
    add("U1:store-unchanged", ok(roSnapshot() === roBefore), "the read-only keychain file is byte-for-byte what it was before the login");
  } else if (sc.plain) {
    add("plain-text-token", "FAIL", "the token is not in the credential store; logging the CLI out (no --insecure-storage, ever)");
    logout("gh", "plain-text", mode);
    return save();
  } else if (!opts.skipPush) {
    await pushCheck("gh", mode);
  }
  if (token && !opts.skipSearch) tokenSearch(opts.noKeychain ? "gh-U1-token" : "gh-G2-token", token);
  else if (!token) add("S1:token", "FAIL", "could not read the token from gh; nothing was searched");
  if (!opts.noKeychain) logout("gh", "requested", mode);
  else rmSync(FORGE.gh.cfg, { recursive: true, force: true });
  return save();
}

// ---- glab ----
function readAndDestroy(path) {
  let tok = null;
  try {
    tok = readFileSync(path, "utf8").trim();
  } finally {
    try { writeFileSync(path, Buffer.alloc(256)); } catch { /* removed next */ }
    rmSync(path, { force: true });
  }
  return tok;
}
async function glabLogin(mode, tok, label) {
  const f = FORGE.glab;
  await loadGate("glab auth login");
  assertScratch(mode);
  const t0 = Date.now();
  const r = forge("glab", ["auth", "login", "--hostname", f.host, "--git-protocol", "https", "--api-protocol", "https", "--stdin"], { mode, input: tok + "\n" });
  const text = r.out + " " + r.err;
  const warned = /keyring is unavailable|plaintext|plain text/i.test(text);
  add(`${label}:login`, ok(r.code === 0 && (mode === "ro" || !warned)), `glab auth login --hostname ${f.host} --git-protocol https --api-protocol https --stdin exit ${r.code}; keyring warning printed: ${warned}; ${firstLine(text)}`, Date.now() - t0);
  return { warned, text };
}

async function glabAll(opts) {
  resultName = "l1-l7-u2";
  const f = FORGE.glab;
  if (!opts.tokenFile || !existsSync(opts.tokenFile)) throw new Error(`token file not found: ${opts.tokenFile}`);
  let tok = readAndDestroy(opts.tokenFile);
  secrets.push(tok);
  add("L1:token-file-deleted", ok(!existsSync(opts.tokenFile)), `token file read, overwritten with zeros and removed: ${opts.tokenFile}`);
  let revoked = false;
  try {
    assertScratch("kc");
    const v = forge("glab", ["--version"]);
    add("launcher", ok(v.code === 0 && (v.out + v.err).includes(f.version)), `${launcher("glab")} --version -> ${firstLine(v.out)}`);
    pushHelperBefore.glab = helperValues(f.host);
    // L2-L6
    const lg = await glabLogin("kc", tok, "L2");
    const sc = storeChecks("glab", "kc");
    storeEvidence("glab");
    if (sc.plain || lg.warned) {
      add("plain-text-token", "FAIL", "the token is not in the credential store; logging the CLI out");
      logout("glab", "plain-text", "kc");
    } else if (!opts.skipPush) {
      await pushCheck("glab", "kc");
    }
    tokenSearch("glab-L2-token", tok);
    logout("glab", "requested", "kc");
    const left = itemsFor(["glab:"]).filter((i) => i.svce.startsWith("glab:gitlab.moldplan.app"));
    add("C1:glab-keychain-item-gone", ok(left.length === 0), `glab items for ${f.host} left in the scratch keychain after logout: ${left.length}`);
    rmSync(f.cfg, { recursive: true, force: true });
    // U2: the same token with no keychain at all. Held (--skip-u2): the store-unavailable keychain may raise a SecurityAgent dialog.
    if (!opts.skipU2) {
    assertScratch("ro");
    const roBefore = roSnapshot();
    const u2 = await glabLogin("ro", tok, "U2");
    const fi = findings("glab");
    const verdict = glabTokenVerdict({ configTokens: fi.own, statusExit: 0 });
    add("U2:plain-text-reported", ok(u2.warned && verdict.plain), `glab printed the keyring warning: ${u2.warned}; token lines in config.yml (non-empty token under hosts: ${f.host}:): ${fi.own}; verdict plain: ${verdict.plain}`);
    if (verdict.plain) {
      console.log(`REFUSED: the credential store is unavailable, so the ${f.host} login is not kept in plain text.`);
      logout("glab", "plain-text", "ro");
    }
    add("U2:store-unchanged", ok(roSnapshot() === roBefore), "the read-only keychain file is byte-for-byte what it was before the login");
    tokenSearch("glab-U2-token", tok);
    rmSync(f.cfg, { recursive: true, force: true });
    }
  } finally {
    // C1: revoke the token with itself, whatever happened above.
    try {
      const res = await fetch(`https://${f.host}/api/v4/personal_access_tokens/self`, { method: "DELETE", headers: { "PRIVATE-TOKEN": tok }, signal: AbortSignal.timeout(30_000) });
      revoked = res.status === 204;
      add("C1:revoke-token", ok(revoked), `DELETE https://${f.host}/api/v4/personal_access_tokens/self -> HTTP ${res.status}${revoked ? "" : " (the boss revokes it in the UI)"}`);
    } catch (e) {
      add("C1:revoke-token", "FAIL", `DELETE personal_access_tokens/self failed: ${e.message}; the boss revokes it in the UI`);
    }
    tok = null;
  }
  return save();
}

// ---- X1 ----
function sha(p) {
  return existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "(absent)";
}
function x1Snapshot() {
  // The user's own items: attributes only (no -w, no -g), files by SHA256. The real HOME is used here and only here, on purpose.
  const env = { HOME: REAL_HOME, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  const items = {};
  for (const [svc, acct] of [["gh:github.com", "wayne930242"], ["gh:github.com", ""], ["glab:gitlab.moldplan.app:token", ""], ["glab:gitlab.moldplan.app", ""], ["gh:_refreshable:github.com", ""]]) {
    const r = spawnSync(SECURITY, ["find-generic-password", "-s", svc, "-a", acct], { env, encoding: "utf8", timeout: 20_000 });
    const pick = (k) => new RegExp(`"${k}"<[a-z]+>=(?:"([^"]*)"|(\\S+))`).exec(r.stdout);
    const g = (k) => { const m = pick(k); return m ? (m[1] ?? m[2]) : null; };
    items[`${svc} / ${JSON.stringify(acct)}`] = r.status === 0 ? { found: true, mdat: g("mdat"), cdat: g("cdat"), acct: g("acct"), svce: g("svce") } : { found: false, exit: r.status };
  }
  const files = {};
  for (const p of [".config/gh/hosts.yml", ".config/gh/config.yml", ".config/glab-cli/config.yml", "Library/Application Support/glab-cli/config.yml"]) files[p] = sha(join(REAL_HOME, p));
  const plist = join(REAL_HOME, "Library/Preferences/com.apple.security.plist");
  files["Library/Preferences/com.apple.security.plist"] = sha(plist);
  const kcMtime = statSync(join(REAL_HOME, "Library/Keychains/login.keychain-db"), { throwIfNoEntry: false })?.mtimeMs ?? null;
  return { items, files, loginKeychainFileMtime: kcMtime };
}
function x1(which) {
  mkdirSync(KEEP, { recursive: true });
  const snap = x1Snapshot();
  writeFileSync(join(KEEP, `x1-${which}.json`), JSON.stringify(snap, null, 2));
  console.log(`X1 ${which}: ${Object.entries(snap.items).map(([k, v]) => `${k}=${v.found ? "found mdat " + v.mdat : "absent"}`).join("; ")}`);
  if (which === "after") {
    const b = JSON.parse(readFileSync(join(KEEP, "x1-before.json"), "utf8"));
    const same = JSON.stringify({ items: b.items, files: b.files }) === JSON.stringify({ items: snap.items, files: snap.files });
    resultName = "x1";
    add("X1", ok(same), `attributes (mdat, cdat, acct, svce) of the user's gh and glab keychain items and the SHA256 of ~/.config/gh/hosts.yml, config.yml, glab config.yml and the security plist are ${same ? "unchanged" : "CHANGED"} between before and after; the login keychain file's mtime is ${b.loginKeychainFileMtime === snap.loginKeychainFileMtime ? "unchanged" : "different (other apps write it too; not part of the verdict)"}`);
    return save();
  }
  return 0;
}

// ---- cleanup ----
function cleanup() {
  resultName = "c1";
  for (const cli of ["gh", "glab"]) if (existsSync(launcher(cli))) logout(cli, `cleanup-${cli}`, "kc");
  if (existsSync(KC_PATH)) {
    assertScratch("kc");
    const left = dumpItems("kc").items.filter((i) => /^(gh|glab):/.test(i.svce ?? ""));
    add("C1:kit-items-gone", ok(left.length === 0), `gh/glab items left in the scratch keychain: ${left.length}`);
    const d = sec(["delete-keychain", KC_PATH], "kc");
    add("C1:delete-keychain", ok(d.code === 0), `security delete-keychain exit ${d.code}`);
  }
  if (existsSync(RO_KC)) {
    chmodSync(dirname(RO_KC), 0o700);
    chmodSync(RO_KC, 0o600);
    assertScratch("ro", true);
    const d = sec(["delete-keychain", RO_KC], "ro");
    add("C1:delete-keychain-ro", ok(d.code === 0), `security delete-keychain (store-unavailable keychain) exit ${d.code}`);
  }
  return save();
}

// ---- main ----
function parse(argv) {
  const o = { cmd: argv[0], sub: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--login") o.login = true;
    else if (a === "--reuse-login") o.reuseLogin = true;
    else if (a === "--skip-u2") o.skipU2 = true;
    else if (a === "--skip-push") o.skipPush = true;
    else if (a === "--skip-search") o.skipSearch = true;
    else if (a === "--no-keychain") o.noKeychain = true;
    else if (a === "--token-file") o.tokenFile = resolve(argv[++i]);
    else if (a === "--code-file") o.codeFile = resolve(argv[++i]);
    else if (!a.startsWith("--")) o.sub = a;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

async function main() {
  const o = parse(process.argv.slice(2));
  for (const k of Object.keys(process.env)) if (/^(PI_|HERDR_)/.test(k)) delete process.env[k];
  let fails = 0;
  try {
    if (o.cmd === "probe") fails = await probe();
    else if (o.cmd === "setup") fails = setup();
    else if (o.cmd === "gh") fails = await ghLogin(o);
    else if (o.cmd === "glab") fails = await glabAll(o);
    else if (o.cmd === "cleanup") fails = cleanup();
    else if (o.cmd === "x1") fails = x1(o.sub);
    else throw new Error(`unknown command '${o.cmd}'`);
  } catch (e) {
    add("unexpected-error", "FAIL", e.message);
    save();
    fails = 1;
  }
  process.exit(fails > 0 ? 1 : 0);
}
main();
