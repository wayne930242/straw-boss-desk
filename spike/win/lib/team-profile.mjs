// Spike installer for the team profile (docs/specs/2026-10-27-team-profile.md, section 7): copies the profile in `profile/` and the
// test recipe's additions into a pi agent directory without ever overwriting a file the PM changed.
//
// usage: node team-profile.mjs <validate|install|verify|use-team|skills-only> [options]
//   --root <dir>        folder that holds profile/ and recipe/ (default: the kit folder, else the repository root)
//   --agent-dir <dir>   the pi agent directory (default: $PI_CODING_AGENT_DIR)
//   --recipe <file>     a recipe to validate and apply (optional)
//   --pins <file>       pins.json; its package names are the reserved names a recipe may not list
//   --file <relpath>    use-team: the file to switch to the team version (repeatable)
//   --only <name>       skills-only: just this recipe package
// Prints one JSON line. Exit 0 on success, 1 on any failure (an invalid recipe prints its errors and installs nothing).
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
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

const ABSENT = Symbol("absent");
const BLOCKED = Symbol("blocked");
/** The value at path, ABSENT when no such key exists, or BLOCKED when a parent on the way holds something that is not an object (the PM's own value). */
function lookup(obj, path) {
  let o = obj;
  for (const k of path) {
    if (!isPlain(o)) return BLOCKED;
    if (!Object.hasOwn(o, k)) return ABSENT;
    o = o[k];
  }
  return o;
}
function setPath(obj, path, value) {
  if (path.some((k) => k === "__proto__" || k === "constructor" || k === "prototype")) throw new Error(`refusing key ${shown(path.join("."))}; nothing was changed`);
  let o = obj;
  for (const k of path.slice(0, -1)) {
    if (!isPlain(o[k])) o[k] = {};
    o = o[k];
  }
  o[path[path.length - 1]] = value;
}

const shown = (v) => JSON.stringify(String(v).slice(0, 80));

/** A relative POSIX path that stays inside its folder: no `..`, no root, drive, UNC or stream (`:`), no backslash, no empty segment. */
export function safeRel(rel, what = "path") {
  const bad = (why) => {
    throw new Error(`refusing ${what} ${shown(rel)}: ${why}; nothing was changed`);
  };
  if (typeof rel !== "string" || rel === "") bad("it is empty");
  if (/[\u0000-\u001f]/.test(rel)) bad("it has a control character");
  if (rel.includes("\\")) bad("it has a backslash");
  if (rel.includes(":")) bad("it has a drive letter or stream marker");
  if (rel.startsWith("/")) bad("it is absolute");
  for (const seg of rel.split("/")) if (seg === "" || seg === "." || seg === "..") bad("it has an empty, '.' or '..' segment");
  return rel;
}

/** One folder name that goes into a path (the profile version). */
function safeSegment(value, what) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)) throw new Error(`refusing ${what} ${shown(value)}: not usable as a folder name; nothing was changed`);
  return value;
}

/**
 * The absolute path of rel under agentDir, after safeRel, a check that it resolves inside agentDir, and a check that no part of it that
 * exists is a symbolic link or junction (a link could point anywhere, and a dangling one would be written through).
 */
export function managedPath(agentDir, rel, what = "path") {
  safeRel(rel, what);
  const root = resolve(agentDir);
  const full = resolve(root, ...rel.split("/"));
  if (!full.startsWith(root + sep)) throw new Error(`refusing ${what} ${shown(rel)}: it resolves outside the agent folder; nothing was changed`);
  let walked = root;
  for (const seg of rel.split("/")) {
    walked = join(walked, seg);
    let st;
    try {
      st = lstatSync(walked);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") break;
      throw error;
    }
    if (st.isSymbolicLink()) throw new Error(`refusing ${what} ${shown(rel)}: ${shown(relative(root, walked))} is a symbolic link or junction; remove it or fix the folder, nothing was changed`);
  }
  return full;
}

/** A write that never leaves a partial file: a temp file in the same folder, renamed over the target. */
function writeAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.sbd-tmp-${process.pid}`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** SHA256 of a regular file; anything else (a folder, a device) is refused rather than read. */
function fileHash(path, rel) {
  if (!lstatSync(path).isFile()) throw new Error(`${shown(rel)} exists but is not a regular file; nothing was changed`);
  return sha256(readFileSync(path));
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
  safeSegment(pkg.version, "profile version");
  const files = new Map();
  for (const rel of ["AGENTS.md"]) files.set(rel, readFileSync(join(profileDir, rel), "utf8"));
  for (const sub of ["rules", "skills"]) {
    if (!existsSync(join(profileDir, sub))) continue;
    for (const rel of walk(join(profileDir, sub), profileDir)) files.set(safeRel(rel, "profile file"), readFileSync(join(profileDir, rel), "utf8"));
  }
  return {
    name: pkg.name,
    version: pkg.version,
    files,
    settings: JSON.parse(readFileSync(join(profileDir, "config", "settings.json"), "utf8")),
    herdr: JSON.parse(readFileSync(join(profileDir, "config", "herdr-agents.json"), "utf8")),
  };
}

export const TEAM_BEGIN = "<!-- straw-boss:team-block:begin -->";
export const TEAM_END = "<!-- straw-boss:team-block:end -->";

/**
 * Makes text from a recipe inert inside the team block: it can neither fake a block marker (`<!--` is escaped) nor pass for a section of the
 * profile (a heading or a rule line gets a backslash, so it reads as plain text, not Markdown structure).
 */
export function neutralize(text) {
  return normalizeText(text)
    .replaceAll("<!--", "&lt;!--")
    .replaceAll("-->", "--&gt;")
    .split("\n")
    .map((line) => (/^ {0,3}(#{1,6}(\s|$)|([-*_=])(\s*\3){2,}\s*$)/.test(line) ? line.replace(/^( {0,3})/, "$1\\") : line))
    .join("\n");
}

/** text with the region between the team markers (markers included) replaced by block, or removed when block is null; appended when there is no region. */
export function replaceTeamBlock(text, block) {
  const begin = text.indexOf(TEAM_BEGIN);
  if (begin < 0) return block ? `${text.replace(/\n*$/, "\n")}\n${block}` : text;
  const end = text.indexOf(TEAM_END, begin);
  if (end < 0) throw new Error("the team block has a begin marker but no end marker; nothing was changed");
  const before = text.slice(0, begin);
  const after = text.slice(end + TEAM_END.length).replace(/^\n/, "");
  if (block) return before + block + after;
  return before.replace(/\n+$/, "\n") + (after ? `\n${after}` : "");
}

/** AGENTS.md plus the recipe's team block between markers, the text the installer records and protects. */
export function composeAgents(base, recipe) {
  let text = replaceTeamBlock(normalizeText(base), null);
  if (!text.endsWith("\n")) text += "\n";
  if (recipe?.instructions) {
    const block = `${TEAM_BEGIN}\n## Team: ${neutralize(String(recipe.name)).replace(/\n/g, " ")}\n\n${neutralize(recipe.instructions).replace(/\n+$/, "")}\n${TEAM_END}\n`;
    text = replaceTeamBlock(text, block);
  }
  return text;
}

/**
 * Installs (or, with dryRun, only plans) the profile into agentDir.
 * Returns { changes, notices, ... }: `changes` are writes made (or that would be), `notices` are things kept for the PM.
 * Every path is checked while planning, so a refusal happens before the first write. Writes run in an order a crash can resume from: content files and
 * merged keys, then deletions, the manifest last (a rerun re-records what is already in place and finishes what is left).
 * afterStep is a test seam: called with a label after each write or deletion.
 */
export function install({ profile, agentDir, recipe = null, dryRun = false, afterStep = null }) {
  safeSegment(profile.version, "profile version");
  const stateDir = join(agentDir, STATE_DIR);
  const manifestPath = managedPath(agentDir, `${STATE_DIR}/${MANIFEST}`, "manifest path");
  const old = readJsonOr(manifestPath, { version: 1, files: {}, keys: {} });
  if (!isPlain(old) || !isPlain(old.files ?? {}) || !isPlain(old.keys ?? {})) throw new Error(`${manifestPath} is not a manifest this installer wrote; fix or remove it, nothing was changed`);
  old.files ??= {};
  old.keys ??= {};
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
    const path = managedPath(agentDir, rel, "profile file");
    const recorded = old.files[rel];
    if (!existsSync(path)) {
      writes.push([path, text]);
      changes.push({ kind: "file-written", file: rel });
      next.files[rel] = hash;
      continue;
    }
    const current = fileHash(path, rel);
    if (current === hash) {
      next.files[rel] = hash;
      if (recorded !== hash) changes.push({ kind: "file-recorded", file: rel });
    } else if (recorded !== undefined && current === recorded) {
      writes.push([path, text]);
      changes.push({ kind: "file-replaced", file: rel });
      next.files[rel] = hash;
    } else {
      // Changed by the PM, or the spike's file with no record: keep it, put the team version aside.
      const pendingRel = `${STATE_DIR}/pending/${profile.version}/${rel}`;
      const pending = managedPath(agentDir, pendingRel, "pending path");
      if (!existsSync(pending) || fileHash(pending, pendingRel) !== hash) {
        writes.push([pending, text]);
        changes.push({ kind: "pending-written", file: rel });
      }
      notices.push({ kind: "file-kept", file: rel, reason: recorded === undefined ? "no-record" : "edited", pending: pendingRel });
      if (recorded !== undefined) next.files[rel] = recorded;
    }
  }

  // ---- files the profile no longer ships ----
  // The manifest is the only place these paths come from, and anything can have written it: each one is checked like any other path.
  for (const [rel, recorded] of Object.entries(old.files)) {
    const path = managedPath(agentDir, rel, "manifest path");
    if (shipped.has(rel)) continue;
    if (!existsSync(path)) continue;
    if (fileHash(path, rel) === recorded) {
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
    const path = managedPath(agentDir, rel, "config path");
    const doc = readJsonOr(path, {});
    if (!isPlain(doc)) throw new Error(`${path} is not a JSON object; nothing was changed`);
    const recordedKeys = isPlain(old.keys[rel]) ? old.keys[rel] : {};
    const keysNext = {};
    let touched = false;
    for (const [keyPath, value] of entries) {
      const key = keyPath.join(".");
      const current = lookup(doc, keyPath);
      const recorded = recordedKeys[key];
      if (current === ABSENT) {
        setPath(doc, keyPath, value);
        touched = true;
        changes.push({ kind: "key-set", file: rel, key });
        keysNext[key] = value;
      } else if (current !== BLOCKED && same(current, value)) {
        keysNext[key] = value;
        if (!same(recorded, value)) changes.push({ kind: "key-recorded", file: rel, key });
      } else if (current !== BLOCKED && recorded !== undefined && same(current, recorded)) {
        setPath(doc, keyPath, value);
        touched = true;
        changes.push({ kind: "key-replaced", file: rel, key });
        keysNext[key] = value;
      } else {
        // Changed by the PM, or a parent of the key holds a value of theirs that is not an object (a scalar or an array): never overwritten.
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

  if (!dryRun) {
    for (const [path, text] of writes) {
      writeAtomic(path, text);
      afterStep?.(`write ${relative(agentDir, path)}`);
    }
    for (const path of removes) {
      rmSync(path, { force: true });
      afterStep?.(`remove ${relative(agentDir, path)}`);
    }
    if (manifestChanged) {
      writeAtomic(manifestPath, manifestText);
      afterStep?.("write manifest");
    }
  }
  return { changes, notices, manifestChanged, profileVersion: profile.version };
}

/** "Use the team version": the PM's copy is saved under backup/<timestamp>/, then the pending copy takes its place. */
export function useTeamVersion({ profile, agentDir, files, now = new Date() }) {
  safeSegment(profile.version, "profile version");
  const manifestPath = managedPath(agentDir, `${STATE_DIR}/${MANIFEST}`, "manifest path");
  const manifest = readJsonOr(manifestPath, null);
  if (!manifest) throw new Error("no manifest: nothing was installed here");
  if (!isPlain(manifest.files)) throw new Error(`${manifestPath} is not a manifest this installer wrote; fix or remove it, nothing was changed`);
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  // Check every file before touching any of them.
  const plan = files.map((rel) => ({
    rel,
    target: managedPath(agentDir, rel, "--file"),
    pendingRel: `${STATE_DIR}/pending/${profile.version}/${rel}`,
    backupRel: `${STATE_DIR}/backup/${stamp}/${rel}`,
  }));
  for (const p of plan) {
    p.pending = managedPath(agentDir, p.pendingRel, "pending path");
    p.backup = managedPath(agentDir, p.backupRel, "backup path");
    if (!existsSync(p.pending)) throw new Error(`no pending version of ${p.rel}`);
  }
  const done = [];
  for (const p of plan) {
    if (existsSync(p.target)) writeAtomic(p.backup, readFileSync(p.target));
    const bytes = readFileSync(p.pending);
    writeAtomic(p.target, bytes);
    // The manifest records the new hash before the pending copy goes, so a crash in between leaves a state the next install sorts out.
    manifest.files[p.rel] = sha256(bytes);
    writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    rmSync(p.pending, { force: true });
    done.push({ file: p.rel, backup: posix(p.backupRel) });
  }
  return done;
}

/** Lists a recipe package in settings.json as { source, extensions: [] }, so it adds skills but loads no code (spec section 5). */
export function markSkillsOnly({ agentDir, packages }) {
  const path = managedPath(agentDir, "settings.json", "settings path");
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
  if (marked.length > 0) writeAtomic(path, JSON.stringify(doc, null, 2) + "\n");
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
  if (!agentDir && opts.command !== "validate") throw new Error("--agent-dir or PI_CODING_AGENT_DIR is required");
  const profile = loadProfile(join(root, "profile"));
  let recipe = null;
  if (opts.recipe) recipe = await loadRecipe({ recipePath: opts.recipe, recipeDir: join(root, "recipe"), reservedPackages: opts.pins ? reservedFromPins(opts.pins) : [] });
  let out;
  if (opts.command === "validate") out = { profileVersion: profile.version };
  else if (opts.command === "install") out = install({ profile, agentDir, recipe });
  else if (opts.command === "verify") {
    out = install({ profile, agentDir, recipe, dryRun: true });
    out.verified = out.changes.length === 0 && !out.manifestChanged;
    if (!out.verified) process.exitCode = 1;
  } else if (opts.command === "use-team") out = { used: useTeamVersion({ profile, agentDir, files: opts.file }) };
  else if (opts.command === "skills-only") out = { marked: markSkillsOnly({ agentDir, packages: (recipe?.packages ?? []).filter((p) => !opts.only || p.name === opts.only) }) };
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
