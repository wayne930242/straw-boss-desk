// Spike installer for the team profile (docs/specs/2026-10-27-team-profile.md, section 7): copies the profile in `profile/` and the
// test recipe's additions into a pi agent directory without ever overwriting a file the PM changed.
//
// usage: node team-profile.mjs <install|verify|use-team|skills-only> [options]
//   --root <dir>        folder that holds profile/ and recipe/ (default: the kit folder, else the repository root)
//   --agent-dir <dir>   the pi agent directory (default: $PI_CODING_AGENT_DIR)
//   --recipe <file>     a recipe to validate and apply (optional)
//   --pins <file>       pins.json; its package names are the reserved names a recipe may not list
//   --file <relpath>    use-team: the file to switch to the team version (repeatable)
// Prints one JSON line. Exit 0 on success, 1 on any failure (an invalid recipe prints its errors and installs nothing).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const STATE_DIR = ".straw-boss-profile";
const MANIFEST = "manifest.json";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const posix = (p) => p.split(sep).join("/");
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** UTF-8, no BOM, LF line endings: what every managed file is written as. */
export function normalizeText(text) {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(posix(relative(base, full)));
  }
  return out;
}

/** [path, value] pairs of an object's leaves; arrays and scalars are leaves. */
export function leaves(obj, prefix = []) {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (isPlain(v) && Object.keys(v).length > 0) out.push(...leaves(v, [...prefix, k]));
    else out.push([[...prefix, k], v]);
  }
  return out;
}

const getPath = (obj, path) => path.reduce((o, k) => (isPlain(o) && k in o ? o[k] : undefined), obj);
function setPath(obj, path, value) {
  let o = obj;
  for (const k of path.slice(0, -1)) {
    if (!isPlain(o[k])) o[k] = {};
    o = o[k];
  }
  o[path[path.length - 1]] = value;
}

function readJsonOr(path, fallback) {
  if (!existsSync(path)) return fallback;
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${error.message.split("\n")[0]}); fix or remove it, nothing was changed`);
  }
}

/** What the profile package ships: managed files as {relpath: Buffer}, plus the two config objects. */
export function loadProfile(profileDir) {
  const pkg = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
  const files = new Map();
  for (const rel of ["AGENTS.md"]) files.set(rel, readFileSync(join(profileDir, rel), "utf8"));
  for (const sub of ["rules", "skills"]) {
    if (!existsSync(join(profileDir, sub))) continue;
    for (const rel of walk(join(profileDir, sub), profileDir)) files.set(rel, readFileSync(join(profileDir, rel), "utf8"));
  }
  return {
    name: pkg.name,
    version: pkg.version,
    files,
    settings: JSON.parse(readFileSync(join(profileDir, "config", "settings.json"), "utf8")),
    herdr: JSON.parse(readFileSync(join(profileDir, "config", "herdr-agents.json"), "utf8")),
  };
}

/** AGENTS.md plus the recipe's team block, the text the installer records and protects. */
export function composeAgents(base, recipe) {
  let text = normalizeText(base);
  if (!text.endsWith("\n")) text += "\n";
  if (recipe?.instructions) text += `\n## Team: ${recipe.name}\n\n${normalizeText(recipe.instructions).replace(/\n+$/, "")}\n`;
  return text;
}

/**
 * Installs (or, with dryRun, only plans) the profile into agentDir.
 * Returns { changes, notices, ... }: `changes` are writes made (or that would be), `notices` are things kept for the PM.
 */
export function install({ profile, agentDir, recipe = null, dryRun = false }) {
  const stateDir = join(agentDir, STATE_DIR);
  const manifestPath = join(stateDir, MANIFEST);
  const old = readJsonOr(manifestPath, { version: 1, files: {}, keys: {} });
  const next = { version: 1, profile: { name: profile.name, version: profile.version }, recipe: recipe ? { id: recipe.id, version: recipe.version } : null, files: {}, keys: {} };
  const changes = [];
  const notices = [];
  const writes = []; // [absolute path, string]
  const removes = [];

  const shipped = new Map(profile.files);
  shipped.set("AGENTS.md", composeAgents(profile.files.get("AGENTS.md"), recipe));

  // ---- copied files ----
  for (const [rel, raw] of shipped) {
    const text = normalizeText(raw);
    const hash = sha256(Buffer.from(text, "utf8"));
    const path = join(agentDir, rel);
    const recorded = old.files[rel];
    if (!existsSync(path)) {
      writes.push([path, text]);
      changes.push({ kind: "file-written", file: rel });
      next.files[rel] = hash;
      continue;
    }
    const current = sha256(readFileSync(path));
    if (current === hash) {
      next.files[rel] = hash;
      if (recorded !== hash) changes.push({ kind: "file-recorded", file: rel });
    } else if (recorded !== undefined && current === recorded) {
      writes.push([path, text]);
      changes.push({ kind: "file-replaced", file: rel });
      next.files[rel] = hash;
    } else {
      // Changed by the PM, or the spike's file with no record: keep it, put the team version aside.
      const pending = join(stateDir, "pending", profile.version, rel);
      if (!existsSync(pending) || sha256(readFileSync(pending)) !== hash) {
        writes.push([pending, text]);
        changes.push({ kind: "pending-written", file: rel });
      }
      notices.push({ kind: "file-kept", file: rel, reason: recorded === undefined ? "no-record" : "edited", pending: posix(join(STATE_DIR, "pending", profile.version, rel)) });
      if (recorded !== undefined) next.files[rel] = recorded;
    }
  }

  // ---- files the profile no longer ships ----
  for (const [rel, recorded] of Object.entries(old.files)) {
    if (shipped.has(rel)) continue;
    const path = join(agentDir, rel);
    if (!existsSync(path)) continue;
    if (sha256(readFileSync(path)) === recorded) {
      removes.push(path);
      changes.push({ kind: "file-removed", file: rel });
    } else {
      notices.push({ kind: "dropped-file-kept", file: rel });
      next.files[rel] = recorded;
    }
  }

  // ---- merged JSON keys ----
  const targets = [
    ["settings.json", leaves(profile.settings)],
    ["herdr-agents/config.json", leaves(profile.herdr)],
  ];
  if (recipe?.straw?.relay) targets.push(["straw-boss/config.json", [[["link", "relay"], recipe.straw.relay]]]);
  for (const [rel, entries] of targets) {
    const path = join(agentDir, ...rel.split("/"));
    const doc = readJsonOr(path, {});
    if (!isPlain(doc)) throw new Error(`${path} is not a JSON object; nothing was changed`);
    const recordedKeys = old.keys[rel] ?? {};
    const keysNext = {};
    let touched = false;
    for (const [keyPath, value] of entries) {
      const key = keyPath.join(".");
      const current = getPath(doc, keyPath);
      const recorded = recordedKeys[key];
      if (current === undefined) {
        setPath(doc, keyPath, value);
        touched = true;
        changes.push({ kind: "key-set", file: rel, key });
        keysNext[key] = value;
      } else if (same(current, value)) {
        keysNext[key] = value;
        if (!same(recorded, value)) changes.push({ kind: "key-recorded", file: rel, key });
      } else if (recorded !== undefined && same(current, recorded)) {
        setPath(doc, keyPath, value);
        touched = true;
        changes.push({ kind: "key-replaced", file: rel, key });
        keysNext[key] = value;
      } else {
        notices.push({ kind: "key-kept", file: rel, key });
        if (recorded !== undefined) keysNext[key] = recorded;
      }
    }
    // keys recorded earlier that this version no longer ships stay as they are
    for (const [key, value] of Object.entries(recordedKeys)) if (!(key in keysNext) && !entries.some(([p]) => p.join(".") === key)) keysNext[key] = value;
    if (touched) writes.push([path, JSON.stringify(doc, null, 2) + "\n"]);
    if (Object.keys(keysNext).length > 0) next.keys[rel] = keysNext;
  }

  // ---- manifest ----
  const sortObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, isPlain(o[k]) ? sortObj(o[k]) : o[k]]));
  const manifestText = JSON.stringify(sortObj(next), null, 2) + "\n";
  const manifestChanged = !existsSync(manifestPath) || readFileSync(manifestPath, "utf8") !== manifestText;
  if (manifestChanged) writes.push([manifestPath, manifestText]);

  if (!dryRun) {
    for (const [path, text] of writes) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, "utf8");
    }
    for (const path of removes) rmSync(path, { force: true });
  }
  return { changes, notices, manifestChanged, profileVersion: profile.version };
}

/** "Use the team version": the PM's copy is saved under backup/<timestamp>/, then the pending copy takes its place. */
export function useTeamVersion({ profile, agentDir, files, now = new Date() }) {
  const stateDir = join(agentDir, STATE_DIR);
  const manifestPath = join(stateDir, MANIFEST);
  const manifest = readJsonOr(manifestPath, null);
  if (!manifest) throw new Error("no manifest: nothing was installed here");
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const done = [];
  for (const rel of files) {
    const pending = join(stateDir, "pending", profile.version, rel);
    if (!existsSync(pending)) throw new Error(`no pending version of ${rel}`);
    const target = join(agentDir, rel);
    if (existsSync(target)) {
      const backup = join(stateDir, "backup", stamp, rel);
      mkdirSync(dirname(backup), { recursive: true });
      writeFileSync(backup, readFileSync(target));
    }
    mkdirSync(dirname(target), { recursive: true });
    const bytes = readFileSync(pending);
    writeFileSync(target, bytes);
    rmSync(pending, { force: true });
    manifest.files[rel] = sha256(bytes);
    done.push({ file: rel, backup: posix(join(STATE_DIR, "backup", stamp, rel)) });
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return done;
}

/** Lists a recipe package in settings.json as { source, extensions: [] }, so it adds skills but loads no code (spec section 5). */
export function markSkillsOnly({ agentDir, packages }) {
  const path = join(agentDir, "settings.json");
  const doc = readJsonOr(path, null);
  if (!doc) throw new Error("settings.json missing; install the profile first");
  const list = Array.isArray(doc.packages) ? doc.packages : [];
  const marked = [];
  for (const pkg of packages) {
    const source = `npm:${pkg.name}@${pkg.version}`;
    const i = list.findIndex((e) => (typeof e === "string" ? e : e?.source) === source);
    if (i < 0) throw new Error(`${source} is not listed in settings.json; install it first`);
    const entry = typeof list[i] === "string" ? { source } : { ...list[i] };
    entry.extensions = [];
    if (!same(list[i], entry)) {
      list[i] = entry;
      marked.push(source);
    }
  }
  doc.packages = list;
  if (marked.length > 0) writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", "utf8");
  return marked;
}

/** Reads and validates a recipe file; throws an Error whose message lists each failing field and rule (never a value). */
export async function loadRecipe({ recipePath, recipeDir, reservedPackages }) {
  const { validateRecipe } = await import(pathToFileURL(join(recipeDir, "validate.mjs")).href);
  const result = validateRecipe(readFileSync(recipePath, "utf8"), { reservedPackages });
  if (!result.ok) throw Object.assign(new Error("invalid recipe: " + result.errors.map((e) => `${e.field} [${e.rule}]`).join("; ")), { errors: result.errors });
  return result.recipe;
}

export function reservedFromPins(pinsPath) {
  const pins = JSON.parse(readFileSync(pinsPath, "utf8").replace(/^\uFEFF/, ""));
  return [...(pins.npmGlobal ?? []), ...(pins.piPackages ?? [])].map((p) => p.name);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, file: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].replace(/^--/, "");
    if (key === "file") opts.file.push(rest[i + 1]);
    else opts[key.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = rest[i + 1];
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  const root = opts.root ?? (existsSync(join(here, "..", "profile")) ? join(here, "..") : join(here, "..", "..", ".."));
  const agentDir = opts.agentDir ?? process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) throw new Error("--agent-dir or PI_CODING_AGENT_DIR is required");
  const profile = loadProfile(join(root, "profile"));
  let recipe = null;
  if (opts.recipe) recipe = await loadRecipe({ recipePath: opts.recipe, recipeDir: join(root, "recipe"), reservedPackages: opts.pins ? reservedFromPins(opts.pins) : [] });
  let out;
  if (opts.command === "install") out = install({ profile, agentDir, recipe });
  else if (opts.command === "verify") {
    out = install({ profile, agentDir, recipe, dryRun: true });
    out.verified = out.changes.length === 0 && !out.manifestChanged;
    if (!out.verified) process.exitCode = 1;
  } else if (opts.command === "use-team") out = { used: useTeamVersion({ profile, agentDir, files: opts.file }) };
  else if (opts.command === "skills-only") out = { marked: markSkillsOnly({ agentDir, packages: recipe?.packages ?? [] }) };
  else throw new Error(`unknown command '${opts.command}'`);
  if (recipe) out.recipe = { id: recipe.id, version: recipe.version, packages: recipe.packages ?? [] };
  console.log(JSON.stringify({ ok: true, ...out }));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.log(JSON.stringify({ ok: false, error: error.message, errors: error.errors }));
    process.exitCode = 1;
  });
}
