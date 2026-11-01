// Pure decisions of the account checks (port of account-verdict.ps1), kept apart from every CLI call so they run offline on both platforms.
// The rule they enforce (team profile spec, section 4): a login is logged out only on positive evidence that its token is in plain text. A failed or
// unreadable status is "could not verify": the check fails, and the credential in the store stays.
import { existsSync, readFileSync } from "node:fs";

/**
 * The key/value lines of a YAML text with the keys above each of them. gh's and glab's files are plain block mappings, so the nesting is the indentation.
 * One entry per `key: value` line: { path (keys above, outermost first), key, value (quotes and trailing comment removed) }. Lists are not followed.
 */
export function yamlEntries(text) {
  const entries = [];
  const stack = [];
  for (const line of String(text).replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line) || /^\s*-(\s|$)/.test(line)) continue;
    const m = /^(\s*)(?:"([^"]*)"|'([^']*)'|(.+?))\s*:(?:\s+(.*))?$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    const key = m[2] ? m[2] : m[3] ? m[3] : m[4];
    let raw = m[5] ? String(m[5]) : "";
    raw = raw.replace(/(^|\s)#.*$/, "").trim().replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    entries.push({ path: stack.map((s) => s.key), key, value: raw });
    if (raw === "") stack.push({ indent, key });
  }
  return entries;
}

export function yamlEntriesOfFile(path) {
  return existsSync(path) ? yamlEntries(readFileSync(path, "utf8")) : [];
}

/** A non-empty value that is a token: not an empty string and not YAML's null spellings. */
export function isTokenValue(value) {
  return Boolean(value) && !["!!null", "null", "~"].includes(value);
}

/**
 * Non-empty token lines by whose they are. Only the host's own block is evidence for that host's login. Returns { own (count), other (names of the
 * other hosts that carry a token; '(no host)' for one with no host above it) }. Never the values.
 *   prefix      the keys above the host entries: [] for gh's hosts.yml, ['hosts'] for glab's config.yml and gh's legacy config.yml
 *   directOnly  the key must be a direct child of the host entry (glab); otherwise any depth below (gh nests it under users: <account>:)
 */
export function hostTokenFindings(entries, { host, key, prefix = [], directOnly = false }) {
  let own = 0;
  const other = new Set();
  for (const e of entries) {
    if (e.key !== key || !isTokenValue(e.value)) continue;
    const p = e.path;
    if (p.length < prefix.length) continue;
    if (!prefix.every((k, i) => p[i] === k)) continue;
    if (p.length === prefix.length) {
      other.add("(no host)");
      continue;
    }
    const h = p[prefix.length];
    if (h.toLowerCase() === host.toLowerCase()) {
      if (directOnly && p.length !== prefix.length + 1) continue;
      own++;
    } else other.add(h);
  }
  return { own, other: [...other] };
}

/** `git config --get-all` output as a list of values. Empty output is no value. */
export function gitValueList(text) {
  if (!text) return [];
  return text.replace(/\r?\n$/, "").split(/\r?\n/);
}

/**
 * gh's answer. source is the tokenSource gh reported (null: status failed or the field was missing or blank); hostsTokens and configTokens are the counts
 * of non-empty token lines. plain: positive evidence of plain text, log out. verified: the token is in the keyring.
 */
export function ghTokenVerdict({ source, hostsTokens, configTokens }) {
  const fileHit = hostsTokens + configTokens > 0;
  const src = source ?? "";
  if (src === "oauth_token" || /[\\/]/.test(src) || /\.ya?ml$/.test(src)) {
    return { plain: true, verified: false, reason: `gh reports the token source as '${src}' (a file), not the keyring` };
  }
  if (fileHit) {
    return { plain: true, verified: false, reason: `a non-empty token line is in hosts.yml (${hostsTokens}) or config.yml (${configTokens})` };
  }
  if (src.trim() === "") {
    return { plain: false, verified: false, reason: "could not verify: gh reported no tokenSource (status failed or the field is missing); this is not a plain-text verdict, so no logout" };
  }
  if (src === "keyring") return { plain: false, verified: true, reason: "tokenSource is 'keyring'" };
  return { plain: false, verified: false, reason: `tokenSource is '${src}', not the keyring, and no token is in a file; not a plain-text verdict, so no logout (an environment token wins over the login)` };
}

/** glab's answer. Only config.yml decides plain text; a failed `glab auth status` is "could not verify". */
export function glabTokenVerdict({ configTokens, statusExit }) {
  if (configTokens > 0) return { plain: true, verified: false, reason: `config.yml holds ${configTokens} non-empty token line(s)` };
  if (statusExit !== 0) {
    return { plain: false, verified: false, reason: `could not verify: glab auth status exited ${statusExit} (network, certificate, or token problem); this is not a plain-text verdict, so no logout` };
  }
  return { plain: false, verified: true, reason: "config.yml holds no token and glab auth status succeeded" };
}

/** A root that lies inside another root is covered by it; scanning both would read its files twice. */
export function removeNestedRoots(roots) {
  const seen = new Set();
  const norm = [];
  for (const r of roots.filter(Boolean).map((x) => x.replace(/[\\/]+$/, ""))) {
    if (!seen.has(r)) {
      seen.add(r);
      norm.push(r);
    }
  }
  return norm.filter((r) => !norm.some((o) => o !== r && r.startsWith(o + "/")));
}

/** Unread files split by whether they lie under a folder the spec names (an unread file there fails the search) or elsewhere (a warning). */
export function splitUnread(unread, strictRoots) {
  const roots = strictRoots.filter(Boolean).map((r) => r.replace(/[\\/]+$/, ""));
  const strict = [];
  const extra = [];
  for (const u of unread) {
    (roots.some((r) => u.path === r || u.path.startsWith(r + "/")) ? strict : extra).push(u);
  }
  return { strict, extra };
}
