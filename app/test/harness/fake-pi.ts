import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packageDir } from "../../src/main/bootstrap/npm.ts";
import type { Layout } from "../../src/main/paths.ts";

// Test code: a stand-in for the pinned pi that does what the stages see of `pi install` and `pi remove` (a string entry in `<agent>/settings.json`'s
// `packages`, the package under `<agent>/npm/node_modules`, its entry in `<agent>/npm/package-lock.json`) without a network, so the failure paths of the
// profile and package stages can be driven: a failed install, a lock that records another tarball, a removal that fails. The real pi 1.4.0 runs in
// `e2e-light-profile.test.ts`.
//
// It reads its behavior from environment variables the test hands the stages through `options.npm.env`:
//   FAKE_PI_SOURCES     a folder holding `<name with / as __>@<version>/`, copied in as the package (without it the package is just a package.json)
//   FAKE_PI_LOCK        JSON {"name@version": "sha512-..."}: the integrity the lock records; a name missing from it gets no lock entry
//   FAKE_PI_LOG         a file the invocations are appended to, one line each
//   FAKE_PI_UNLISTED    JSON ["name", ...]: pi installs those but writes no entry for them in settings.json (so the skills-only listing cannot find them)
//   FAKE_PI_FAIL        JSON {"install": ["name", ...], "remove": ["name", ...]}: those fail with a network error and a held-file error
export const FAKE_PI_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const [command, source] = process.argv.slice(2);
const agent = process.env.PI_CODING_AGENT_DIR;
const log = (line) => process.env.FAKE_PI_LOG && fs.appendFileSync(process.env.FAKE_PI_LOG, line + "\\n");
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
if (command === "--version") { console.log("1.4.0"); process.exit(0); }
const m = /^npm:(.+)@([^@]+)$/.exec(source || "");
if (!["install", "remove"].includes(command) || !m) { console.error("usage: pi install|remove npm:<name>@<version>"); process.exit(2); }
const [, name, version] = m;
log(command + " " + source);
const fail = JSON.parse(process.env.FAKE_PI_FAIL || "{}");
if ((fail[command] || []).includes(name)) {
  if (command === "install") console.error("npm error code ETIMEDOUT\\nnpm error network request failed");
  else console.error("npm error code EBUSY\\nnpm error resource busy or locked");
  process.exit(1);
}
const settingsFile = path.join(agent, "settings.json");
const settings = readJson(settingsFile, {});
const identity = (e) => { const s = typeof e === "string" ? e : e && e.source; const x = /^npm:(.+)@[^@]+$/.exec(s || ""); return x ? x[1] : s; };
const packages = (Array.isArray(settings.packages) ? settings.packages : []).filter((e) => identity(e) !== name);
const dir = path.join(agent, "npm", "node_modules", ...name.split("/"));
const lockFile = path.join(agent, "npm", "package-lock.json");
const lock = readJson(lockFile, { name: "pi-extensions", lockfileVersion: 3, packages: {} });
const key = "node_modules/" + name;
if (command === "remove") {
  fs.rmSync(dir, { recursive: true, force: true });
  delete lock.packages[key];
  settings.packages = packages;
} else {
  fs.rmSync(dir, { recursive: true, force: true });
  const from = process.env.FAKE_PI_SOURCES && path.join(process.env.FAKE_PI_SOURCES, name.replace("/", "__") + "@" + version);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (from && fs.existsSync(from)) fs.cpSync(from, dir, { recursive: true });
  else { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version })); }
  const integrity = JSON.parse(process.env.FAKE_PI_LOCK || "{}")[name + "@" + version];
  delete lock.packages[key];
  if (integrity) lock.packages[key] = { version, resolved: "https://registry.npmjs.org/" + name + "/-/x-" + version + ".tgz", integrity };
  if (!JSON.parse(process.env.FAKE_PI_UNLISTED || "[]").includes(name)) packages.push("npm:" + name + "@" + version);
  settings.packages = packages;
}
fs.mkdirSync(path.dirname(lockFile), { recursive: true });
fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2));
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
console.log((command === "install" ? "Installed " : "Removed ") + source);
`;

/** Puts the stand-in where the stages look for pi: `<npm prefix>/.../@earendil-works/pi-coding-agent` with a `pi` bin entry. */
export function installFakePi(layout: Layout, name = "@earendil-works/pi-coding-agent", version = "1.4.0"): void {
	const dir = packageDir(layout, name);
	mkdirSync(join(dir, "dist"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, bin: { pi: "dist/cli.js" } }));
	writeFileSync(join(dir, "dist", "cli.js"), FAKE_PI_SCRIPT);
}
