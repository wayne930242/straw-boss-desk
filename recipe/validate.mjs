// Recipe validator (team profile spec, section 5). Dependency-free so the shell can import it.
//
// validateRecipe(input) takes the file's text or an already parsed value and returns
// { ok: true, recipe } or { ok: false, errors }. Each error is { field, rule, message }.
// An error names the field and the rule it broke, never the value: a recipe may have been
// pasted with a credential, and the message ends up in logs and on screen.
import secretPatterns from "./secret-patterns.json" with { type: "json" };

export const RECIPE_VERSION = 1;
export const MAX_RECIPE_BYTES = 256 * 1024;
export const PROFILE_PACKAGE = "straw-boss-desk-profile";

const MAX_DEPTH = 8;
const SECRETS = secretPatterns.patterns.map((p) => ({ id: p.id, regex: new RegExp(p.regex, p.flags ?? "") }));

const TOP_FIELDS = ["recipe", "id", "name", "version", "updateUrl", "profile", "forges", "repos", "straw", "linear", "instructions", "packages"];
const FIELDS = {
  profile: ["version", "integrity"],
  forge: ["kind", "host", "login"],
  repo: ["url", "folder", "defaultBranch", "label"],
  straw: ["relay"],
  linear: ["enabled"],
  package: ["name", "version", "integrity"],
};

const ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
// A field name is echoed in an error only when it reads like a short field name; a longer or odder key could be a credential.
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
const RESERVED_WINDOWS = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const FORBIDDEN_FOLDER_CHARS = /[\u0000-\u001f<>:"/\\|?*]/;
// C0 controls except tab, line feed and carriage return; format characters (bidi controls, zero-width
// characters, joiners) except U+200D, which emoji sequences need; the tag block U+E0000-E007F; and every
// other Default_Ignorable_Code_Point (Hangul fillers, variation selectors, ...) except a single U+FE0E or
// U+FE0F right after a base character, which emoji need. The trust screen shows these fields in full,
// so none may carry text the PM cannot see.
// eslint-disable-next-line no-control-regex
const HIDDEN_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|(?!\u200d)\p{Cf}|[\u{E0000}-\u{E007F}]/u;
const IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;

function hasHiddenChars(text) {
  if (HIDDEN_CHARS.test(text)) return true;
  let previousIgnorable = true; // nothing before the first character, so a selector there has no base
  for (const ch of text) {
    const ignorable = IGNORABLE.test(ch);
    if (ignorable) {
      const cp = ch.codePointAt(0);
      const selectorAfterBase = (cp === 0xfe0e || cp === 0xfe0f) && !previousIgnorable;
      if (cp !== 0x200d && !selectorAfterBase) return true;
    }
    previousIgnorable = ignorable;
  }
  return false;
}

const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const length = (s) => [...s].length;

/** A key is safe to show when it reads like a field name and matches no credential shape. */
function displayKey(key) {
  return SAFE_KEY.test(key) && !secretIdsIn(key).length ? key : "(unknown field)";
}

/** The text and its percent-decoded forms, so `ghp%5F...` in a URL is seen as `ghp_...`. */
function decodedForms(text) {
  const forms = [text];
  let current = text;
  for (let i = 0; i < 3 && current.includes("%"); i++) {
    const next = current.replace(/%([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (next === current) break;
    forms.push(next);
    current = next;
  }
  return forms;
}

function secretIdsIn(text) {
  const forms = decodedForms(text);
  return SECRETS.filter((p) => forms.some((form) => p.regex.test(form))).map((p) => p.id);
}

/** The ids found in the raw JSON text and in each of its string literals decoded, so `ghp\u005f...` is seen as `ghp_...`. */
function secretIdsInRawText(text) {
  const ids = new Set(secretIdsIn(text));
  for (const [literal] of text.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    if (!literal.includes("\\")) continue; // an unescaped literal is already part of the raw text
    let decoded;
    try {
      decoded = JSON.parse(literal);
    } catch {
      continue; // not a valid literal; the parser reports the file
    }
    for (const id of secretIdsIn(decoded)) ids.add(id);
  }
  return [...ids];
}

const JSON_TOKEN = /\s+|"(?:[^"\\]|\\.)*"|[{}[\],:]|[^\s"{}[\],:]+/y;

/** Paths of the keys that repeat within one object, found in valid JSON text. A repeated key keeps only its last value in the parsed data. */
function duplicateKeyPaths(text) {
  const found = [];
  const stack = []; // { kind: "object" | "array", path, keys, expectKey, keyPath, index }
  let pos = 0;
  JSON_TOKEN.lastIndex = 0;
  while (pos < text.length) {
    JSON_TOKEN.lastIndex = pos;
    const match = JSON_TOKEN.exec(text);
    if (!match) break;
    const token = match[0];
    pos = JSON_TOKEN.lastIndex;
    if (/^\s/.test(token)) continue;
    const top = stack[stack.length - 1];
    if (token === "{" || token === "[") {
      let path = "(recipe)";
      if (top?.kind === "object") path = top.keyPath;
      else if (top?.kind === "array") path = `${top.path}[${top.index}]`;
      stack.push(token === "{" ? { kind: "object", path, keys: new Set(), expectKey: true } : { kind: "array", path, index: 0 });
    } else if (token === "}" || token === "]") {
      stack.pop();
    } else if (token === ",") {
      if (top?.kind === "object") top.expectKey = true;
      else if (top?.kind === "array") top.index++;
    } else if (token[0] === '"' && top?.kind === "object" && top.expectKey) {
      let key;
      try {
        key = JSON.parse(token);
      } catch {
        return found;
      }
      top.keyPath = `${top.path}.${displayKey(key)}`;
      if (top.keys.has(key)) found.push(top.keyPath);
      top.keys.add(key);
      top.expectKey = false;
    }
  }
  return found;
}

class Errors {
  list = [];
  add(field, rule, message) {
    this.list.push({ field, rule, message: `${field}: ${message}` });
  }
}

/** Reject any key or string value shaped like a known credential. Runs before anything else is read. */
function scanForSecrets(value, field, errors, depth = 0) {
  if (depth > MAX_DEPTH) {
    errors.add(field, "too-deep", "nested too deeply");
    return;
  }
  if (typeof value === "string") {
    for (const id of secretIdsIn(value)) errors.add(field, "secret-pattern", `looks like a credential (${id}); a recipe must not carry one`);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => scanForSecrets(item, `${field}[${i}]`, errors, depth + 1));
  } else if (isRecord(value)) {
    for (const key of Object.keys(value)) {
      const child = `${field}.${displayKey(key)}`;
      for (const id of secretIdsIn(key)) errors.add(child, "secret-pattern", `a field name looks like a credential (${id}); a recipe must not carry one`);
      scanForSecrets(value[key], child, errors, depth + 1);
    }
  }
}

function checkObject(value, field, allowed, errors) {
  if (!isRecord(value)) {
    errors.add(field, "wrong-type", "must be an object");
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.add(`${field}.${displayKey(key)}`, "unknown-field", "is not a field a recipe may have");
  }
  return true;
}

function requireString(obj, key, field, errors, { max, min = 1 } = {}) {
  const value = obj[key];
  const at = field ? `${field}.${key}` : key;
  if (value === undefined) {
    errors.add(at, "missing-field", "is required");
    return undefined;
  }
  if (typeof value !== "string") {
    errors.add(at, "wrong-type", "must be a string");
    return undefined;
  }
  if (length(value) < min) {
    errors.add(at, "bad-format", "must not be empty");
    return undefined;
  }
  if (max !== undefined && length(value) > max) {
    errors.add(at, "too-long", `must be at most ${max} characters`);
    return undefined;
  }
  return value;
}

function optionalString(obj, key, field, errors, opts) {
  return obj[key] === undefined ? undefined : requireString(obj, key, field, errors, opts);
}

function checkPattern(value, regex, at, errors, what) {
  if (value === undefined) return false;
  if (!regex.test(value)) {
    errors.add(at, "bad-format", `must be ${what}`);
    return false;
  }
  return true;
}

// Lexical only: a name that resolves to a private address (127.0.0.1.nip.io) passes. The fetcher
// must check the address it connects to and every redirect (spec section 5, Delivery).
const LOCAL_SUFFIXES = [".localhost", ".localdomain", ".local", ".lan", ".home.arpa", ".internal"];

function privateOrLocalHost(hostname) {
  if (hostname.startsWith("[")) return true; // an IPv6 literal is never a public recipe host
  if (hostname.endsWith(".")) return true; // `localhost.` and `intranet.` are the same hosts with a root dot
  if (!hostname.includes(".")) return true; // localhost, intranet, and every other single-label name
  if (LOCAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!v4) return false;
  const [a, b, c] = [Number(v4[1]), Number(v4[2]), Number(v4[3])];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 || // this host, private, loopback, multicast, reserved and broadcast
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments, 192.0.0.0/24
   
    (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))
  );
}

/** Check one URL field; returns the parsed URL (use its `href`, the normalized form), or undefined after recording why it was refused. */
function checkUrl(value, at, errors, { publicHost = false } = {}) {
  if (value === undefined) return undefined;
  if (/[\s\u0000-\u001f]/.test(value)) {
    errors.add(at, "bad-format", "must be a URL without spaces");
    return undefined;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    errors.add(at, "bad-format", "must be a valid URL");
    return undefined;
  }
  let ok = true;
  if (url.protocol !== "https:") {
    errors.add(at, "url-scheme", "must use https");
    ok = false;
  }
  if (url.username !== "" || url.password !== "" || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(value)) {
    errors.add(at, "url-userinfo", "must not carry a user name or password");
    ok = false;
  }
  if (value.includes("?")) {
    errors.add(at, "url-query", "must not carry a query string");
    ok = false;
  }
  if (value.includes("#")) {
    errors.add(at, "url-fragment", "must not carry a fragment");
    ok = false;
  }
  if (url.hostname === "") {
    errors.add(at, "bad-format", "must have a host");
    ok = false;
  } else if (publicHost && privateOrLocalHost(url.hostname)) {
    errors.add(at, "url-host-not-allowed", "must be a public host");
    ok = false;
  }
  return ok ? url : undefined;
}

/** Returns the forge list with defaults filled and the set of its hosts. */
function validateForges(value, errors) {
  const hosts = new Set();
  const out = [];
  if (value === undefined) {
    errors.add("forges", "missing-field", "is required");
    return { forges: out, hosts };
  }
  if (!Array.isArray(value) || value.length === 0) {
    errors.add("forges", Array.isArray(value) ? "bad-format" : "wrong-type", "must be a non-empty array");
    return { forges: out, hosts };
  }
  value.forEach((forge, i) => {
    const at = `forges[${i}]`;
    if (!checkObject(forge, at, FIELDS.forge, errors)) return;
    const kind = requireString(forge, "kind", at, errors);
    if (kind !== undefined && kind !== "github" && kind !== "gitlab") errors.add(`${at}.kind`, "bad-format", 'must be "github" or "gitlab"');
    const host = requireString(forge, "host", at, errors, { max: 253 });
    const hostOk = checkPattern(host, HOSTNAME, `${at}.host`, errors, "a lowercase host name without scheme or port");
    if (kind === "github" && hostOk && host !== "github.com") errors.add(`${at}.host`, "forge-host", "must be github.com for kind github");
    if (kind === "gitlab" && hostOk && host === "github.com") errors.add(`${at}.host`, "forge-host", "must not be github.com for kind gitlab");
    if (hostOk) {
      if (hosts.has(host)) errors.add(`${at}.host`, "duplicate", "is already used by another forge");
      else hosts.add(host);
    }
    let login = forge.login;
    if (login === undefined) login = kind === "github" ? "device" : "token";
    else if (login !== "device" && login !== "token") {
      errors.add(`${at}.login`, "bad-format", 'must be "device" or "token"');
      login = undefined;
    } else if (kind === "github" && login === "token") {
      // A pasted classic token can carry scopes (workflow) that undo the profile's limits; no flow is defined yet.
      errors.add(`${at}.login`, "login-not-supported", 'github.com supports only "device" for now');
      login = undefined;
    }
    out.push({ kind, host, login });
  });
  return { forges: out, hosts };
}

/** The rules of git check-ref-format for a branch name, short of asking git. */
function validBranchName(name) {
  if (name === "@" || name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(name) || name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  return name.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

function validateRepos(value, forgeHosts, errors) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.add("repos", "wrong-type", "must be an array");
    return undefined;
  }
  const folders = new Set();
  return value.map((repo, i) => {
    const at = `repos[${i}]`;
    if (!checkObject(repo, at, FIELDS.repo, errors)) return undefined;
    const url = requireString(repo, "url", at, errors, { max: 2048 });
    const parsed = checkUrl(url, `${at}.url`, errors);
    if (parsed && forgeHosts.size > 0 && !forgeHosts.has(parsed.host)) errors.add(`${at}.url`, "url-host-not-allowed", "must be on a host listed in forges");
    const href = parsed?.href ?? url;
    const folder = requireString(repo, "folder", at, errors, { max: 64 });
    if (folder !== undefined) {
      const f = `${at}.folder`;
      if (hasHiddenChars(folder)) errors.add(f, "bad-format", "must not contain control or invisible characters");
      else if (FORBIDDEN_FOLDER_CHARS.test(folder) || folder === "." || folder === "..") errors.add(f, "bad-format", "must be a single folder name without separators or reserved characters");
      else if (/^\s|[\s.]$/.test(folder)) errors.add(f, "bad-format", "must not start with a space or end with a space or dot");
      else if (RESERVED_WINDOWS.test(folder)) errors.add(f, "reserved-name", "is a reserved Windows name");
      else if (folders.has(folder.toLowerCase())) errors.add(f, "duplicate", "is used by another repository");
      else folders.add(folder.toLowerCase());
    }
    const branch = optionalString(repo, "defaultBranch", at, errors, { max: 100 });
    if (branch !== undefined && (hasHiddenChars(branch) || /[\u0000-\u0020\u007f~^:?*[\\]|\.\.|@\{|\/\/|^[-/]|[/.]$|\.lock(\/|$)|\/\./.test(branch) || branch === "@")) {
      errors.add(`${at}.defaultBranch`, "bad-format", "must be a valid git branch name");
    }
    const label = optionalString(repo, "label", at, errors, { max: 60 });
    if (label !== undefined && hasHiddenChars(label)) errors.add(`${at}.label`, "bad-format", "must not contain control or invisible characters");
    return { url: href, folder, ...(branch !== undefined && { defaultBranch: branch }), label: label ?? folder };
  });
}

function validatePackages(value, errors, reserved) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.add("packages", "wrong-type", "must be an array");
    return undefined;
  }
  const names = new Set();
  return value.map((pkg, i) => {
    const at = `packages[${i}]`;
    if (!checkObject(pkg, at, FIELDS.package, errors)) return undefined;
    const name = requireString(pkg, "name", at, errors, { max: 214 });
    if (checkPattern(name, NPM_NAME, `${at}.name`, errors, "a valid npm package name")) {
      if (name === PROFILE_PACKAGE) errors.add(`${at}.name`, "duplicate", "is the official profile package, which a recipe cannot replace");
      else if (reserved.has(name)) errors.add(`${at}.name`, "reserved-package", "is a package the app installs itself, which a recipe cannot replace");
      else if (names.has(name)) errors.add(`${at}.name`, "duplicate", "is listed twice");
      else names.add(name);
    }
    const version = requireString(pkg, "version", at, errors, { max: 64 });
    checkPattern(version, SEMVER, `${at}.version`, errors, "an exact version such as 1.2.3");
    const integrity = requireString(pkg, "integrity", at, errors);
    checkPattern(integrity, INTEGRITY, `${at}.integrity`, errors, "a sha512 integrity string");
    return { name, version, integrity };
  });
}

function validateStructure(data, errors, reserved) {
  if (!checkObject(data, "(recipe)", TOP_FIELDS, errors)) return undefined;
  if (data.recipe === undefined) {
    errors.add("recipe", "missing-field", "is required");
    return undefined;
  }
  if (data.recipe !== RECIPE_VERSION) {
    if (typeof data.recipe === "number" && data.recipe > RECIPE_VERSION) errors.add("recipe", "unsupported-version", "this recipe needs a newer version of the app; update the app");
    else errors.add("recipe", "bad-format", `must be ${RECIPE_VERSION}`);
    return undefined;
  }
  const out = { recipe: RECIPE_VERSION };
  const id = requireString(data, "id", "", errors);
  checkPattern(id, ID, "id", errors, "2 to 41 characters of lowercase letters, digits, and hyphens, not starting with a hyphen");
  const name = requireString(data, "name", "", errors, { max: 60 });
  if (name !== undefined && hasHiddenChars(name)) errors.add("name", "bad-format", "must not contain control or invisible characters");
  const version = requireString(data, "version", "", errors, { max: 64 });
  checkPattern(version, SEMVER, "version", errors, "a semantic version such as 1.0.0");
  Object.assign(out, { id, name, version });

  const updateUrl = optionalString(data, "updateUrl", "", errors, { max: 2048 });
  const updateParsed = checkUrl(updateUrl, "updateUrl", errors, { publicHost: true });
  if (updateUrl !== undefined) out.updateUrl = updateParsed?.href ?? updateUrl;

  if (data.profile !== undefined && checkObject(data.profile, "profile", FIELDS.profile, errors)) {
    const pv = requireString(data.profile, "version", "profile", errors, { max: 64 });
    checkPattern(pv, SEMVER, "profile.version", errors, "an exact version such as 1.2.3");
    const pi = requireString(data.profile, "integrity", "profile", errors);
    checkPattern(pi, INTEGRITY, "profile.integrity", errors, "a sha512 integrity string");
    out.profile = { version: pv, integrity: pi };
  }

  const { forges, hosts } = validateForges(data.forges, errors);
  out.forges = forges;
  const repos = validateRepos(data.repos, hosts, errors);
  if (repos) out.repos = repos;

  if (data.straw !== undefined && checkObject(data.straw, "straw", FIELDS.straw, errors)) {
    const relay = optionalString(data.straw, "relay", "straw", errors, { max: 2048 });
    const relayParsed = checkUrl(relay, "straw.relay", errors);
    if (relay !== undefined) out.straw = { relay: relayParsed?.href ?? relay };
  }
  if (data.linear !== undefined && checkObject(data.linear, "linear", FIELDS.linear, errors)) {
    if (typeof data.linear.enabled !== "boolean") errors.add("linear.enabled", data.linear.enabled === undefined ? "missing-field" : "wrong-type", "must be true or false");
    else out.linear = { enabled: data.linear.enabled };
  }
  const instructions = optionalString(data, "instructions", "", errors, { max: 4000 });
  if (instructions !== undefined) {
    if (hasHiddenChars(instructions)) errors.add("instructions", "bad-format", "must not contain control or invisible characters");
    else if (/\r(?!\n)/.test(instructions)) errors.add("instructions", "bad-format", "must not contain a carriage return outside a CRLF line break");
    out.instructions = instructions;
  }
  const packages = validatePackages(data.packages, errors, reserved);
  if (packages) out.packages = packages;
  return out;
}

/**
 * @param {unknown} input the recipe file's text, or its parsed JSON
 * @param {{ reservedPackages: Iterable<string> }} options `reservedPackages` is required: the package names in
 *   stack.json, which the shell passes in so a recipe cannot replace or switch off one of them. Pass `[]` for none.
 *   A missing option or a string throws a TypeError.
 * @returns {{ ok: true, recipe: object } | { ok: false, errors: { field: string, rule: string, message: string }[] }}
 */
export function validateRecipe(input, options) {
  const reservedPackages = options?.reservedPackages;
  if (reservedPackages === undefined || reservedPackages === null) throw new TypeError("validateRecipe: options.reservedPackages is required (pass [] for none)");
  if (typeof reservedPackages === "string" || typeof reservedPackages[Symbol.iterator] !== "function") throw new TypeError("validateRecipe: options.reservedPackages must be an iterable of package names, not a string");
  const reserved = new Set(reservedPackages);
  for (const name of reserved) if (typeof name !== "string") throw new TypeError("validateRecipe: options.reservedPackages must contain only strings");
  const errors = new Errors();
  let data = input;
  if (typeof input === "string") {
    if (new TextEncoder().encode(input).length > MAX_RECIPE_BYTES) {
      errors.add("(file)", "too-large", `must be at most ${MAX_RECIPE_BYTES / 1024} KB`);
      return { ok: false, errors: errors.list };
    }
    const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
    // A repeated key keeps only its last value in the parsed data, so a credential under the first
    // one would pass the scan below and still be saved with the file. Scan the raw text too, and
    // each string literal decoded, so `\u005f` cannot hide a character from the patterns.
    for (const id of secretIdsInRawText(text)) errors.add("(file)", "secret-pattern", `looks like a credential (${id}); a recipe must not carry one`);
    try {
      data = JSON.parse(text);
    } catch (error) {
      // The parser's own message quotes the text around the error, so only the position is kept.
      const at = /line (\d+) column (\d+)/.exec(String(error?.message));
      errors.add("(file)", "invalid-json", at ? `is not valid JSON (line ${at[1]}, column ${at[2]})` : "is not valid JSON");
      return { ok: false, errors: errors.list };
    }
    for (const path of duplicateKeyPaths(text)) errors.add(path, "duplicate-key", "is given more than once");
  }
  scanForSecrets(data, "(recipe)", errors);
  if (errors.list.length > 0) return { ok: false, errors: errors.list };
  const recipe = validateStructure(data, errors, reserved);
  if (errors.list.length > 0 || recipe === undefined) return { ok: false, errors: errors.list };
  return { ok: true, recipe };
}

/** Names of the fields the validator accepts, for the schema consistency test. */
export const KNOWN_FIELDS = { recipe: TOP_FIELDS, ...FIELDS };
