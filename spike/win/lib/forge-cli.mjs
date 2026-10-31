// Spike for the code-host CLIs (docs/specs/2026-10-27-team-profile.md, section 4): the launchers in tools/bin, and the credential helpers in the
// kit's private Git configuration. The downloads and their SHA256 check stay in bootstrap.ps1 (Save-Download).
//
// usage: node forge-cli.mjs <launchers|verify-launchers|git-config|verify-git-config> [options]
//   --tools <dir>       the tools folder (launchers go to <tools>/bin; the root is the folder above it)
//   --platform <p>      win32 (default on Windows) or darwin: which launcher flavour(s) and binary names
//   --forge <k:host>    a forge, repeatable: github:github.com, gitlab:gitlab.moldplan.app
//   --file <path>       git-config, verify-git-config: the private Git configuration (GIT_CONFIG_GLOBAL)
// Prints one JSON line. Exit 0 on success, 1 on any failure.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** What differs per code host. The config folder sits beside the other app configuration (config/), named as the CLI names it by default. */
export const FORGES = {
  github: {
    cli: "gh",
    configEnv: "GH_CONFIG_DIR",
    configDir: "gh",
    env: [["GH_PROMPT_DISABLED", "1"], ["GH_NO_UPDATE_NOTIFIER", "1"]],
  },
  gitlab: {
    cli: "glab",
    configEnv: "GLAB_CONFIG_DIR",
    configDir: "glab-cli",
    env: [["GLAB_NO_PROMPT", "1"], ["GLAB_CHECK_UPDATE", "false"]],
  },
};

/** glab writes its token to plain text when either is set (spec, Isolation), and gh behaves differently on CI as well. */
export const UNSET = ["CI", "GITLAB_CI"];

const BEGIN = "# >>> straw-boss forge credential helpers (written by the kit; edit by running it again)";
const END = "# <<< straw-boss forge credential helpers";

const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(:[0-9]{1,5})?$/;

export function parseForge(spec) {
  const m = /^(github|gitlab):(.+)$/.exec(String(spec));
  if (!m) throw new Error(`forge '${spec}' must look like github:github.com or gitlab:<host>`);
  if (!HOST_RE.test(m[2])) throw new Error(`forge host '${m[2]}' is not a plain host name`);
  return { kind: m[1], host: m[2].toLowerCase() };
}

function uniqueForges(forges) {
  const seen = new Set();
  for (const f of forges) {
    if (!FORGES[f.kind]) throw new Error(`unknown forge kind '${f.kind}'`);
    if (seen.has(f.kind)) throw new Error(`forge kind '${f.kind}' is listed twice; one CLI serves one host here`);
    seen.add(f.kind);
  }
  return forges;
}

const exeName = (cli, platform) => (platform === "win32" ? `${cli}.exe` : cli);

/**
 * The batch launcher. The config folder is found from the launcher's own place (<root>\tools\bin), so no path with the user's name is baked into a file that
 * cmd reads in the OEM code page. CI and GITLAB_CI are removed for this process only.
 */
export function cmdLauncher(kind) {
  const f = FORGES[kind];
  const lines = [
    "@echo off",
    `rem straw-boss-desk launcher for ${f.cli}: private configuration folder, no prompts, no update checks, CI variables removed.`,
    "setlocal",
    'for %%I in ("%~dp0..\\..") do set "SBD_APP_ROOT=%%~fI"',
    `set "${f.configEnv}=%SBD_APP_ROOT%\\config\\${f.configDir}"`,
    ...f.env.map(([k, v]) => `set "${k}=${v}"`),
    ...UNSET.map((k) => `set "${k}="`),
    `"%~dp0..\\${f.cli}\\bin\\${exeName(f.cli, "win32")}" %*`,
    "exit /b %ERRORLEVEL%",
  ];
  return lines.join("\r\n") + "\r\n";
}

/**
 * The POSIX launcher, for Git Bash (and for macOS later). It uses shell built-ins only: Git runs a helper through sh with whatever PATH it has, and
 * dirname or cygpath may not be on it. Under MSYS `pwd -W` gives the mixed Windows path (C:/Users/...), which is what the pinned native binary needs
 * in its environment variable; elsewhere `pwd -W` fails and plain `pwd` is used.
 */
export function shLauncher(kind, platform = "win32") {
  const f = FORGES[kind];
  const lines = [
    "#!/bin/sh",
    `# straw-boss-desk launcher for ${f.cli}: private configuration folder, no prompts, no update checks, CI variables removed.`,
    'case $0 in */*) d=${0%/*} ;; *) d=. ;; esac',
    'd=$(cd "$d" && { pwd -W 2>/dev/null || pwd; }) || exit 1',
    'root=$(cd "$d/../.." && { pwd -W 2>/dev/null || pwd; }) || exit 1',
    `${f.configEnv}="$root/config/${f.configDir}"`,
    ...f.env.map(([k, v]) => `${k}=${v}`),
    `export ${[f.configEnv, ...f.env.map(([k]) => k)].join(" ")}`,
    `unset ${UNSET.join(" ")}`,
    `exec "$d/../${f.cli}/bin/${exeName(f.cli, platform)}" "$@"`,
  ];
  return lines.join("\n") + "\n";
}

/** Files of tools/bin for the given forges and platform: relative name -> text. */
export function launcherFiles(forges, platform = "win32") {
  const out = {};
  for (const { kind } of uniqueForges(forges)) {
    const cli = FORGES[kind].cli;
    out[cli] = shLauncher(kind, platform);
    if (platform === "win32") out[`${cli}.cmd`] = cmdLauncher(kind);
  }
  return out;
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { encoding: "utf8", mode: 0o755 });
  renameSync(tmp, path);
}

export function writeLaunchers({ tools, forges, platform }) {
  const bin = join(tools, "bin");
  const written = [];
  for (const [name, text] of Object.entries(launcherFiles(forges, platform))) {
    writeAtomic(join(bin, name), text);
    written.push(name);
  }
  return written;
}

export function verifyLaunchers({ tools, forges, platform }) {
  const bin = join(tools, "bin");
  const problems = [];
  for (const [name, text] of Object.entries(launcherFiles(forges, platform))) {
    const path = join(bin, name);
    if (!existsSync(path)) problems.push(`${name} is missing`);
    else if (readFileSync(path, "utf8") !== text) problems.push(`${name} differs from what the kit writes`);
  }
  return problems;
}

/** A git config value: quoted and escaped only when it has to be (backslash, double quote, # or ;, or edge whitespace). */
export function configValue(value) {
  if (/[\\"#;\n]/.test(value) || /^\s|\s$/.test(value)) return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  return value;
}

/** The path as Git and sh read it: forward slashes, absolute, never a drive-relative form. */
export function posixPath(p) {
  return resolve(p).split(sep).join("/");
}

/** `!'<path>' auth git-credential`: the path single-quoted for sh, so spaces and CJK characters pass; a single quote in it is closed, escaped, reopened. */
export function helperCommand(launcherPath) {
  return `!'${posixPath(launcherPath).replace(/'/g, "'\\''")}' auth git-credential`;
}

/**
 * The managed block of the private Git configuration. The empty `helper =` comes first for each host: it clears every helper set before it (the
 * general one the git stage sets, Git Credential Manager in the system file). The block must stay after every general [credential] setting, so
 * installGitConfig always puts it at the end of the file.
 */
export function gitConfigBlock({ tools, forges }) {
  const bin = join(tools, "bin");
  const lines = [BEGIN];
  for (const { kind, host } of uniqueForges(forges)) {
    lines.push(`[credential "https://${host}"]`);
    lines.push("\thelper =");
    lines.push(`\thelper = ${configValue(helperCommand(join(bin, FORGES[kind].cli)))}`);
  }
  lines.push(END);
  return lines.join("\n") + "\n";
}

function stripBlock(text) {
  const start = text.indexOf(BEGIN);
  if (start < 0) return text;
  const stop = text.indexOf(END, start);
  if (stop < 0) throw new Error("the forge block in the Git configuration has no end line; fix the file by hand");
  const after = text.indexOf("\n", stop);
  return text.slice(0, start) + (after < 0 ? "" : text.slice(after + 1));
}

const readUtf8 = (file) => (existsSync(file) ? readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n") : "");

export function installGitConfig({ file, tools, forges }) {
  let text = stripBlock(readUtf8(file));
  if (text !== "" && !text.endsWith("\n")) text += "\n";
  writeAtomic(file, text + gitConfigBlock({ tools, forges }));
}

export function verifyGitConfig({ file, tools, forges }) {
  const text = readUtf8(file);
  const block = gitConfigBlock({ tools, forges });
  if (!text.endsWith(block)) return ["the forge block is missing, differs, or is not the last thing in the file"];
  if (stripBlock(text).includes(BEGIN)) return ["the forge block is in the file twice"];
  return [];
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, forge: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].replace(/^--/, "");
    if (key === "forge") opts.forge.push(rest[i + 1]);
    else opts[key] = rest[i + 1];
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const forges = opts.forge.map(parseForge);
  if (forges.length === 0) throw new Error("at least one --forge is required");
  if (!opts.tools) throw new Error("--tools is required");
  const tools = resolve(opts.tools);
  const platform = opts.platform ?? (process.platform === "win32" ? "win32" : "darwin");
  let out;
  if (opts.command === "launchers") out = { written: writeLaunchers({ tools, forges, platform }) };
  else if (opts.command === "verify-launchers") out = { problems: verifyLaunchers({ tools, forges, platform }) };
  else if (opts.command === "git-config" || opts.command === "verify-git-config") {
    if (!opts.file) throw new Error("--file is required");
    if (opts.command === "git-config") {
      installGitConfig({ file: resolve(opts.file), tools, forges });
      out = { problems: verifyGitConfig({ file: resolve(opts.file), tools, forges }) };
    } else out = { problems: verifyGitConfig({ file: resolve(opts.file), tools, forges }) };
  } else throw new Error(`unknown command '${opts.command}'`);
  const ok = !out.problems || out.problems.length === 0;
  console.log(JSON.stringify({ ok, ...out }));
  if (!ok) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
