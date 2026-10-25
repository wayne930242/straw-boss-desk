// Non-ASCII and long-path behaviour of Node on this machine, under a root folder.
// usage: node pathcheck.mjs <root dir>
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const root = resolve(process.argv[2]);
const zh = "\u4e2d\u6587\u5c08\u6848"; // 中文專案
const res = { homedir: homedir(), homedirNonAscii: /[^\u0000-\u007f]/.test(homedir()), root, zh: {}, longPath: {} };

const attempt = (fn) => { try { return { ok: true, value: fn() }; } catch (e) { return { ok: false, code: e.code, message: e.message.slice(0, 200) }; } };

const dir = join(root, zh);
res.zh.mkdir = attempt(() => (mkdirSync(dir, { recursive: true }), dir));
res.zh.write = attempt(() => (writeFileSync(join(dir, `${zh}.txt`), "\u4e2d\u6587 content"), true));
res.zh.read = attempt(() => readFileSync(join(dir, `${zh}.txt`), "utf8"));
res.zh.list = attempt(() => readdirSync(dir));

// ~330 characters of path, past MAX_PATH (260).
const segs = Array(14).fill("long-directory-name-abcdefghij");
const longDir = join(root, "long", ...segs);
res.longPath.length = longDir.length;
res.longPath.mkdir = attempt(() => (mkdirSync(longDir, { recursive: true }), true));
res.longPath.write = attempt(() => (writeFileSync(join(longDir, "f.txt"), "x"), true));
res.longPath.read = attempt(() => readFileSync(join(longDir, "f.txt"), "utf8"));
res.longPath.cleanup = attempt(() => (rmSync(join(root, "long"), { recursive: true, force: true }), !existsSync(join(root, "long"))));

console.log(JSON.stringify(res));
