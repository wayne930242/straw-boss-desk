// Token search of the account checks: finds a token's bytes in every file under some roots. No size limit: files are read in 4 MB chunks.
// Three forms are looked for: UTF-8, UTF-16LE, and go-keyring's stored form ("go-keyring-base64:" + base64), which is what a leak through the
// `security -i` channel would carry. A path that cannot be read is retried once and listed with a reason; links are not followed.
import { closeSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CHUNK = 4 * 1024 * 1024;

export function needlesFor(token) {
  return [
    Buffer.from(token, "utf8"),
    Buffer.from(token, "utf16le"),
    Buffer.from("go-keyring-base64:" + Buffer.from(token, "utf8").toString("base64"), "utf8"),
  ];
}

function fileHas(path, needles, stats) {
  const fd = openSync(path, "r");
  try {
    const max = Math.max(...needles.map((n) => n.length));
    const buf = Buffer.alloc(CHUNK + max);
    let carry = 0;
    for (;;) {
      const read = readSync(fd, buf, carry, CHUNK, null);
      if (read === 0) break;
      const len = carry + read;
      stats.bytes += read;
      const view = buf.subarray(0, len);
      if (needles.some((n) => view.includes(n))) {
        stats.files++;
        return true;
      }
      carry = Math.min(max - 1, len);
      buf.copy(buf, 0, len - carry, len);
    }
    stats.files++;
    return false;
  } finally {
    closeSync(fd);
  }
}

const why = (what, e) => `${what}: ${e.code ?? e.name} ${String(e.message).replace(/\s+/g, " ")}`;

/** Scan roots for token. Returns { hits, unread: [{path, reason}], files, bytes }. skipDirs are exact folder paths left out. */
export function scan(roots, token, { skipDirs = [] } = {}) {
  const needles = needlesFor(token);
  const stats = { files: 0, bytes: 0 };
  const hits = [];
  const skipped = [];
  const dirs = [...roots];
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (skipDirs.includes(d)) continue;
    let names;
    try {
      names = readdirSync(d, { withFileTypes: true });
    } catch (e) {
      skipped.push({ path: d, reason: why("list folder", e) });
      continue;
    }
    for (const ent of names) {
      const p = join(d, ent.name);
      let st;
      try {
        st = lstatSync(p);
      } catch (e) {
        skipped.push({ path: p, reason: why("open or read", e) });
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) dirs.push(p);
      else if (st.isFile()) {
        try {
          if (fileHas(p, needles, stats)) hits.push(p);
        } catch (e) {
          skipped.push({ path: p, reason: why("open or read", e) });
        }
      }
    }
  }
  // One more read of each unread file, for a file that was in use while a CLI ran; what reads now leaves the list.
  const unread = [];
  for (const u of skipped) {
    if (!u.reason.startsWith("open or read")) {
      unread.push(u);
      continue;
    }
    try {
      if (fileHas(u.path, needles, stats)) hits.push(u.path);
    } catch (e) {
      unread.push({ path: u.path, reason: why("open or read, again", e) });
    }
  }
  return { hits, unread, ...stats };
}

/** Replace every known secret, and anything shaped like a token, in text bound for a log. */
export function hideSecrets(text, secrets = []) {
  let t = String(text ?? "");
  for (const s of secrets) if (s && s.length >= 6) t = t.split(s).join("<token>");
  return t.replace(/(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{10,}|gl[a-z]{2,4}-[A-Za-z0-9_-]{20,})/g, "<token>");
}
