// What a pinned install says when npm's registry is down or its cached package list is old (VM 2026-10-30). Run through 10-npm-stale.sh.
// A stand-in registry (../win/lib/npm-stale-fixture.mjs) serves pi-straw-boss; nothing leaves this machine and nothing outside $SPIKE/npm-stale is written.
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { runNpm, seedCache, startRegistry } from "../win/lib/npm-stale-fixture.mjs";

const spike = process.env.SPIKE;
if (!spike || !spike.startsWith("/")) { console.error("SPIKE must be an absolute path"); process.exit(1); }
const root = join(spike, "npm-stale");
const npmSh = new URL("./_npm.sh", import.meta.url).pathname;
const PKG = "pi-straw-boss";
const SENTENCE = `The npm registry could not be reached or is out of date, so ${PKG}@0.48.0 was not installed.`;

let bad = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"} ${name} - ${detail}`); if (!ok) bad = 1; };
const tail = (text) => text.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 300);

function sandbox(name) {
  const dir = join(root, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "home"), { recursive: true });
  return {
    dir,
    cache: join(dir, "cache"),
    prefix: join(dir, "prefix"),
    env: {
      PATH: process.env.PATH, HOME: join(dir, "home"), TMPDIR: process.env.TMPDIR || "/tmp",
      npm_config_userconfig: join(dir, "npmrc"), npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false",
      npm_config_fetch_retries: "0", npm_config_cache: join(dir, "cache"), npm_config_prefix: join(dir, "prefix"),
    },
  };
}

// The helper the install script uses: `pinned <name@version> <command...>` from _npm.sh.
function pinned(what, command, env) {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-c", '. "$1"; shift; pinned "$@"', "_", npmSh, what, ...command], { env });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
  });
}

mkdirSync(root, { recursive: true });

// 1. The old behavior, for the record: the registry has 0.48.0, npm trusts its 5-minute-old copy that lacks it, and says the version does not exist.
{
  const sb = sandbox("reachable-old-copy");
  const registry = await startRegistry({ pkg: PKG, versions: ["0.46.0"] });
  const reg = { ...sb.env, npm_config_registry: registry.url };
  await runNpm(["install", "--dry-run", `${PKG}@0.46.0`], reg);
  registry.setVersions(["0.46.0", "0.48.0"]);
  const plain = await runNpm(["install", "--dry-run", `${PKG}@0.48.0`], reg);
  check("old-copy-without-prefer-online", plain.code !== 0 && /ETARGET|No matching version/.test(plain.out), `plain npm install: exit ${plain.code}, ${tail(plain.out)}`);
  const fresh = await pinned(`${PKG}@0.48.0`, ["npm", "install", "--dry-run", `${PKG}@0.48.0`], reg);
  check("old-copy-with-prefer-online", fresh.code === 0 && !fresh.out.includes(SENTENCE), `pinned install: exit ${fresh.code}, ${tail(fresh.out)}`);
  await registry.close();
}

// 2. The registry does not answer and the copy lacks the version (the VM case): npm says E404 or ETARGET; the helper says what that means.
{
  const sb = sandbox("down-old-copy");
  const url = await seedCache({ port: 0, cacheDir: sb.cache, pkg: PKG, version: "0.46.0", env: sb.env });
  const reg = { ...sb.env, npm_config_registry: url };
  const plain = await runNpm(["view", `${PKG}@0.48.0`, "dist.integrity"], reg);
  check("down-old-copy-plain-npm", plain.code !== 0 && /E404|ETARGET|No match/.test(plain.out) && !/ECONNREFUSED|ETIMEDOUT/.test(plain.out), `plain npm view says: ${tail(plain.out)}`);
  const view = await pinned(`${PKG}@0.48.0`, ["npm", "view", `${PKG}@0.48.0`, "dist.integrity"], reg);
  check("down-old-copy-lookup", view.code !== 0 && view.out.includes(SENTENCE), `pinned lookup: exit ${view.code}, sentence ${view.out.includes(SENTENCE) ? "present" : "missing"}`);
  const install = await pinned(`${PKG}@0.48.0`, ["npm", "install", "-g", `${PKG}@0.48.0`], reg);
  check("down-old-copy-install", install.code !== 0 && install.out.includes(SENTENCE), `pinned install: exit ${install.code}, sentence ${install.out.includes(SENTENCE) ? "present" : "missing"}`);
  check("no-version-fallback", !existsSync(join(sb.prefix, "lib", "node_modules", PKG)), `nothing installed under ${sb.prefix.replace(spike, "$SPIKE")}`);
}

// 3. The registry does not answer and npm has no copy: a network error, which gets the sentence too.
{
  const sb = sandbox("down-empty-cache");
  const dead = await startRegistry({ pkg: PKG, versions: ["0.46.0"] });
  const url = dead.url;
  await dead.close();
  const run = await pinned(`${PKG}@0.48.0`, ["npm", "view", `${PKG}@0.48.0`, "dist.integrity"], { ...sb.env, npm_config_registry: url });
  check("down-empty-cache", run.code !== 0 && /ECONNREFUSED|ETIMEDOUT|FETCH_ERROR/.test(run.out) && run.out.includes(SENTENCE), `exit ${run.code}, ${tail(run.out)}`);
}

// 4. A failure that is not the registry's gets no registry sentence and keeps its exit code.
{
  const sb = sandbox("other-failure");
  const run = await pinned(`${PKG}@0.48.0`, ["sh", "-c", "echo 'EACCES: permission denied, mkdir /usr/lib/x' >&2; exit 3"], sb.env);
  check("other-failure", run.code === 3 && !run.out.includes("registry could not be reached"), `exit ${run.code}, ${tail(run.out)}`);
}

process.exit(bad);
