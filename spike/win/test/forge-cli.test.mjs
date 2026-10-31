// node --test spike/win/test/forge-cli.test.mjs   (also runs in the Windows VM, where the POSIX launcher goes through Git's own sh)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  FORGES,
  UNSET,
  cmdLauncher,
  configValue,
  gitConfigBlock,
  helperCommand,
  installGitConfig,
  launcherFiles,
  parseForge,
  shLauncher,
  verifyGitConfig,
  verifyLaunchers,
  writeLaunchers,
} from "../lib/forge-cli.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const GH = parseForge("github:github.com");
const GL = parseForge("gitlab:gitlab.moldplan.app");
const both = [GH, GL];
const isWindows = process.platform === "win32";
const sh = isWindows ? process.env.SBD_SH : "/bin/sh";

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "forge-cli-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** An app root with a space and CJK characters in it, like C:\Users\測試PM\AppData\Local\straw-boss-desk. */
function appRoot(name = "測試PM app") {
  const root = join(tmp, name);
  mkdirSync(join(root, "tools"), { recursive: true });
  return { root, tools: join(root, "tools") };
}

/** A stand-in for the pinned binary: prints what a real one would be able to see. The real file is `gh`, or `gh.exe` on Windows (a copy of node there). */
function fakeBinary({ tools, cli }) {
  const dir = join(tools, cli, "bin");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, isWindows ? `${cli}.exe` : cli);
  if (isWindows) {
    writeFileSync(path, readFileSync(process.execPath));
    writeFileSync(join(dir, "dump.js"), 'console.log(Object.entries(process.env).map(([k, v]) => k + "=" + v).join("\\n")); console.log("ARGC:" + process.argv.length);\n');
  } else {
    writeFileSync(path, '#!/bin/sh\nprintf "ARGS:"; for a in "$@"; do printf "[%s]" "$a"; done; echo\nenv | sort\nif [ ! -t 0 ]; then printf "STDIN:"; cat; fi\n');
    chmodSync(path, 0o755);
  }
  return path;
}

describe("pins", () => {
  const pins = JSON.parse(readFileSync(join(here, "..", "pins.json"), "utf8"));
  for (const cli of ["gh", "glab"]) {
    it(`${cli}: every Windows entry has a 64-digit SHA256 and a file name that matches its URL and the version`, () => {
      const p = pins.binaries[cli];
      assert.match(p.version, /^\d+\.\d+\.\d+$/);
      for (const arch of ["x64", "arm64"]) {
        assert.match(p[arch].sha256, /^[0-9a-f]{64}$/);
        assert.ok(p[arch].url.endsWith("/" + p[arch].file), `${cli} ${arch}: url ends with file`);
        assert.ok(p[arch].file.includes(`_${p.version}_`), `${cli} ${arch}: file names the version`);
        assert.match(p[arch].file, /windows_(amd64|arm64)\.zip$/);
      }
      assert.notEqual(p.x64.sha256, p.arm64.sha256);
    });
  }
  it("pins the versions the spec names", () => {
    assert.equal(pins.binaries.gh.version, "2.103.3");
    assert.equal(pins.binaries.glab.version, "1.124.0");
  });
});

describe("parseForge", () => {
  it("accepts the two kinds with a plain host, lower-cased", () => {
    assert.deepEqual(parseForge("github:GitHub.com"), { kind: "github", host: "github.com" });
    assert.deepEqual(parseForge("gitlab:gitlab.moldplan.app"), { kind: "gitlab", host: "gitlab.moldplan.app" });
    assert.deepEqual(parseForge("gitlab:git.example.org:8443"), { kind: "gitlab", host: "git.example.org:8443" });
  });
  it("refuses anything that could put text into the Git configuration", () => {
    for (const bad of ["gitea:x.com", "github:", "github:a b.com", "github:a.com\n[core]", 'github:a".com', "github:a.com/path", "github:https://a.com", "github:-a.com", "gitlab:a..com"]) {
      assert.throws(() => parseForge(bad), undefined, bad);
    }
  });
});

describe("launcher text", () => {
  it("cmd: CRLF lines, ASCII only, private config folder, the four variables, CI and GITLAB_CI removed, the pinned binary run with the arguments", () => {
    for (const kind of ["github", "gitlab"]) {
      const f = FORGES[kind];
      const text = cmdLauncher(kind);
      assert.ok(text.startsWith("@echo off\r\n"));
      assert.ok(!/[^\x00-\x7f]/.test(text), "no characters outside ASCII: the file is read in the OEM code page");
      assert.ok(!/(?<!\r)\n/.test(text), "every line ends in CRLF");
      assert.ok(text.includes(`set "${f.configEnv}=%SBD_APP_ROOT%\\config\\${f.configDir}"`));
      for (const [k, v] of f.env) assert.ok(text.includes(`set "${k}=${v}"`), k);
      for (const k of UNSET) assert.ok(text.includes(`set "${k}="`), `unsets ${k}`);
      assert.ok(text.includes(`"%~dp0..\\${f.cli}\\bin\\${f.cli}.exe" %*`));
      assert.ok(text.includes("setlocal") && text.trimEnd().endsWith("exit /b %ERRORLEVEL%"));
      assert.ok(text.includes('for %%I in ("%~dp0..\\..") do set "SBD_APP_ROOT=%%~fI"'));
    }
  });
  it("cmd: the exact variables the spec names", () => {
    const gh = cmdLauncher("github");
    const glab = cmdLauncher("gitlab");
    assert.ok(gh.includes('set "GH_CONFIG_DIR=') && gh.includes('set "GH_PROMPT_DISABLED=1"') && gh.includes('set "GH_NO_UPDATE_NOTIFIER=1"'));
    assert.ok(glab.includes('set "GLAB_CONFIG_DIR=') && glab.includes('set "GLAB_NO_PROMPT=1"') && glab.includes('set "GLAB_CHECK_UPDATE=false"'));
  });
  it("sh: LF lines, a shebang, exported variables, an exec of the pinned binary", () => {
    const text = shLauncher("github", "win32");
    assert.ok(text.startsWith("#!/bin/sh\n") && !text.includes("\r"));
    assert.ok(text.includes("export GH_CONFIG_DIR GH_PROMPT_DISABLED GH_NO_UPDATE_NOTIFIER"));
    assert.ok(text.includes("unset CI GITLAB_CI"));
    assert.ok(text.includes('exec "$d/../gh/bin/gh.exe" "$@"'));
    assert.ok(shLauncher("gitlab", "darwin").includes('exec "$d/../glab/bin/glab" "$@"'));
  });
  it("a Windows kit gets both flavours of each CLI, macOS only the script", () => {
    assert.deepEqual(Object.keys(launcherFiles(both, "win32")).sort(), ["gh", "gh.cmd", "glab", "glab.cmd"]);
    assert.deepEqual(Object.keys(launcherFiles(both, "darwin")).sort(), ["gh", "glab"]);
  });
  it("one CLI serves one host", () => {
    assert.throws(() => launcherFiles([GH, parseForge("github:ghe.example.org")]), /twice/);
  });
});

describe("the POSIX launcher at run time", { skip: isWindows && !process.env.SBD_SH ? "needs SBD_SH (Git's sh.exe) on Windows" : false }, () => {
  const run = (launcher, args, env, input) =>
    spawnSync(sh, [launcher, ...args], { encoding: "utf8", input, env: { PATH: process.env.PATH, HOME: tmp, ...env } });
  const envOf = (out) => Object.fromEntries(out.split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

  for (const [kind, cli] of [["github", "gh"], ["gitlab", "glab"]]) {
    it(`${cli}: sets the config folder under the app root and the no-prompt variables, removes CI and GITLAB_CI, keeps the arguments and standard input`, () => {
      const { root, tools } = appRoot();
      const forges = [parseForge(kind === "github" ? "github:github.com" : "gitlab:gitlab.moldplan.app")];
      writeLaunchers({ tools, forges, platform: isWindows ? "win32" : "darwin" });
      fakeBinary({ tools, cli });
      const args = isWindows ? [join(tools, cli, "bin", "dump.js"), "x y"] : ["auth", "login", "--hostname", "x y", "--stdin"];
      const r = run(join(tools, "bin", cli), args, { CI: "true", GITLAB_CI: "true", KEEP: "yes" }, "secret-on-stdin\n");
      assert.equal(r.status, 0, r.stderr);
      const env = envOf(r.stdout);
      const f = FORGES[kind];
      assert.equal(env[f.configEnv].replace(/\\/g, "/"), `${root.split("\\").join("/")}/config/${f.configDir}`);
      for (const [k, v] of f.env) assert.equal(env[k], v, k);
      assert.equal(env.CI, undefined, "CI is removed");
      assert.equal(env.GITLAB_CI, undefined, "GITLAB_CI is removed");
      assert.equal(env.KEEP, "yes", "other variables pass through");
      if (!isWindows) {
        assert.ok(r.stdout.includes("ARGS:[auth][login][--hostname][x y][--stdin]"));
        assert.ok(r.stdout.includes("STDIN:secret-on-stdin"));
      }
    });
  }

  for (const [kind, cli] of [["github", "gh"], ["gitlab", "glab"]]) {
    it(`${cli}.cmd: the same, run by cmd.exe from a folder with CJK characters and a space (Windows only)`, { skip: !isWindows }, () => {
      const { root, tools } = appRoot();
      writeLaunchers({ tools, forges: [parseForge(kind === "github" ? "github:github.com" : "gitlab:gitlab.moldplan.app")], platform: "win32" });
      fakeBinary({ tools, cli });
      const line = `""${join(tools, "bin", `${cli}.cmd`)}" "${join(tools, cli, "bin", "dump.js")}" "x y""`;
      const r = spawnSync(process.env.ComSpec, ["/d", "/s", "/c", line], { encoding: "utf8", windowsVerbatimArguments: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CI: "true", GITLAB_CI: "true", KEEP: "yes" } });
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const env = envOf(r.stdout.replace(/\r/g, ""));
      const f = FORGES[kind];
      assert.equal(env[f.configEnv], `${root}\\config\\${f.configDir}`);
      for (const [k, v] of f.env) assert.equal(env[k], v, k);
      assert.equal(env.CI, undefined);
      assert.equal(env.GITLAB_CI, undefined);
      assert.equal(env.KEEP, "yes");
      assert.ok(r.stdout.includes("ARGC:4"), "the binary got its two arguments");
    });
  }

  it("works when started through PATH from another folder, and not only by its full path", { skip: isWindows }, () => {
    const { tools } = appRoot();
    writeLaunchers({ tools, forges: [GH], platform: "darwin" });
    fakeBinary({ tools, cli: "gh" });
    const r = spawnSync("gh", ["--version"], { encoding: "utf8", cwd: tmp, env: { PATH: `${join(tools, "bin")}:${process.env.PATH}`, CI: "1" } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(envOf(r.stdout).CI, undefined);
  });

  it("passes the exit status of the binary on", () => {
    const { tools } = appRoot();
    writeLaunchers({ tools, forges: [GH], platform: isWindows ? "win32" : "darwin" });
    if (!isWindows) {
      const bin = join(tools, "gh", "bin", "gh");
      mkdirSync(dirname(bin), { recursive: true });
      writeFileSync(bin, "#!/bin/sh\nexit 7\n");
      chmodSync(bin, 0o755);
      assert.equal(run(join(tools, "bin", "gh"), [], {}).status, 7);
    }
  });
});

describe("credential helpers in the private Git configuration", () => {
  const tools = "/Users/x/Library/Application Support/straw-boss-desk/tools";

  it("writes the empty helper first, then the launcher, for each host (exact text)", () => {
    assert.equal(
      gitConfigBlock({ tools, forges: both }),
      [
        "# >>> straw-boss forge credential helpers (written by the kit; edit by running it again)",
        '[credential "https://github.com"]',
        "\thelper =",
        `\thelper = !'${tools}/bin/gh' auth git-credential`,
        '[credential "https://gitlab.moldplan.app"]',
        "\thelper =",
        `\thelper = !'${tools}/bin/glab' auth git-credential`,
        "# <<< straw-boss forge credential helpers",
        "",
      ].join("\n"),
    );
  });

  it("quotes only what needs it", () => {
    assert.equal(configValue("!'/a b/gh' auth git-credential"), "!'/a b/gh' auth git-credential");
    assert.equal(configValue("a;b"), '"a;b"');
    assert.equal(configValue("a#b"), '"a#b"');
    assert.equal(configValue('a"b'), '"a\\"b"');
    assert.equal(configValue("a\\b"), '"a\\\\b"');
  });

  it("turns a Windows path into forward slashes and single-quotes it for sh", { skip: !isWindows }, () => {
    assert.equal(helperCommand("C:\\Users\\測試PM\\AppData\\Local\\straw-boss-desk\\tools\\bin\\gh"), "!'C:/Users/測試PM/AppData/Local/straw-boss-desk/tools/bin/gh' auth git-credential");
  });

  // The strongest check available on any machine: let Git itself read the file, then let sh run what Git would run.
  for (const dirName of ["測試PM app", "plain", "it's #1; \"quoted\" 測試", "back\\slash"]) {
    if (isWindows && /[\\"]/.test(dirName)) continue; // not valid in a Windows file name
    it(`Git reads the block back as an empty helper and the launcher command; sh runs it (folder '${dirName}')`, () => {
      const { tools: t } = appRoot(dirName);
      const file = join(tmp, "gitconfig");
      installGitConfig({ file, tools: t, forges: both });
      const git = (args) => spawnSync("git", ["config", "--file", file, ...args], { encoding: "utf8" });
      for (const [host, cli] of [["github.com", "gh"], ["gitlab.moldplan.app", "glab"]]) {
        const r = git(["--get-all", `credential.https://${host}.helper`]);
        assert.equal(r.status, 0, r.stderr);
        const values = r.stdout.split("\n").slice(0, -1);
        assert.equal(values.length, 2, r.stdout);
        assert.equal(values[0], "", "the empty entry comes first");
        assert.ok(values[1].startsWith("!'"));
        assert.ok(values[1].endsWith("/bin/" + cli + "' auth git-credential") || values[1].includes("'\\''"), values[1]);
        if (!isWindows) {
          // Run it as Git does: sh -c "<command without the !> get", with a launcher that echoes its arguments.
          mkdirSync(join(t, "bin"), { recursive: true });
          writeFileSync(join(t, "bin", cli), '#!/bin/sh\necho "got:$*"\n');
          chmodSync(join(t, "bin", cli), 0o755);
          const ran = spawnSync("/bin/sh", ["-c", `${values[1].slice(1)} get`], { encoding: "utf8" });
          assert.equal(ran.stdout.trim(), "got:auth git-credential get", `${ran.stderr}`);
        }
      }
    });
  }

  it("is idempotent, keeps the user's lines, and moves the block behind a general helper written later", () => {
    const { tools: t } = appRoot();
    const file = join(tmp, "gitconfig");
    writeFileSync(file, "[user]\n\tname = Spike PM\n[credential]\n\thelper = manager\n");
    installGitConfig({ file, tools: t, forges: both });
    installGitConfig({ file, tools: t, forges: both });
    let text = readFileSync(file, "utf8");
    assert.equal(text.split(">>> straw-boss").length - 1, 1);
    assert.ok(text.startsWith("[user]\n\tname = Spike PM\n[credential]\n\thelper = manager\n# >>>"));
    assert.deepEqual(verifyGitConfig({ file, tools: t, forges: both }), []);
    // the git stage runs later and appends a general section after the block
    writeFileSync(file, text + "[credential]\n\thelper = manager\n");
    assert.equal(verifyGitConfig({ file, tools: t, forges: both }).length, 1);
    installGitConfig({ file, tools: t, forges: both });
    text = readFileSync(file, "utf8");
    assert.ok(text.endsWith("# <<< straw-boss forge credential helpers\n"));
    assert.equal(text.split("helper = manager").length - 1, 2);
    assert.deepEqual(verifyGitConfig({ file, tools: t, forges: both }), []);
  });

  it("reads CRLF and a BOM, writes UTF-8 with LF and no BOM, and replaces a block for other hosts", () => {
    const { tools: t } = appRoot();
    const file = join(tmp, "gitconfig");
    writeFileSync(file, "\uFEFF[user]\r\n\tname = 測試\r\n");
    installGitConfig({ file, tools: t, forges: [GH] });
    installGitConfig({ file, tools: t, forges: both });
    const bytes = readFileSync(file);
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = bytes.toString("utf8");
    assert.ok(!text.includes("\r") && text.includes("name = 測試"));
    assert.ok(text.includes("gitlab.moldplan.app") && text.split("github.com").length === 2);
  });

  it("refuses a block that lost its end line instead of cutting the file", () => {
    const { tools: t } = appRoot();
    const file = join(tmp, "gitconfig");
    installGitConfig({ file, tools: t, forges: both });
    const broken = readFileSync(file, "utf8").replace(/# <<<.*\n/, "");
    writeFileSync(file, broken);
    assert.throws(() => installGitConfig({ file, tools: t, forges: both }), /no end line/);
    assert.equal(readFileSync(file, "utf8"), broken);
  });
});

describe("verify and the command line", () => {
  it("verify-launchers finds a missing, an edited, and an intact launcher", () => {
    const { tools } = appRoot();
    const platform = isWindows ? "win32" : "darwin";
    assert.ok(verifyLaunchers({ tools, forges: both, platform }).length > 0);
    writeLaunchers({ tools, forges: both, platform });
    assert.deepEqual(verifyLaunchers({ tools, forges: both, platform }), []);
    writeFileSync(join(tools, "bin", "gh"), "#!/bin/sh\nexec evil\n");
    assert.deepEqual(verifyLaunchers({ tools, forges: both, platform }), ["gh differs from what the kit writes"]);
  });

  it("the command line prints one JSON line and fails on a bad forge", () => {
    const { tools } = appRoot();
    const file = join(tmp, "gitconfig");
    const cli = (args) => spawnSync(process.execPath, [join(here, "..", "lib", "forge-cli.mjs"), ...args], { encoding: "utf8" });
    const ok = cli(["launchers", "--tools", tools, "--forge", "github:github.com", "--platform", "darwin"]);
    assert.equal(ok.status, 0);
    assert.deepEqual(JSON.parse(ok.stdout), { ok: true, written: ["gh"] });
    const cfg = cli(["git-config", "--tools", tools, "--file", file, "--forge", "github:github.com"]);
    assert.equal(cfg.status, 0, cfg.stdout);
    assert.equal(JSON.parse(cli(["verify-git-config", "--tools", tools, "--file", file, "--forge", "github:github.com"]).stdout).ok, true);
    const bad = cli(["launchers", "--tools", tools, "--forge", "github:a b"]);
    assert.equal(bad.status, 1);
    assert.equal(JSON.parse(bad.stdout).ok, false);
  });
});
