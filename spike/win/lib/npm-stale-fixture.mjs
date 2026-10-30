// A stand-in for registry.npmjs.org that serves the package list (packument) of one package, with the cache headers the real registry sends
// (cache-control: public, max-age=300, and an ETag). It reproduces VM 2026-10-30: npm answered from a cached package list that lacked a published
// version, so a pin that exists failed as "not found". The package files are not served, so use it with `npm view` and `npm install --dry-run`.
//
//   node npm-stale-fixture.mjs seed <port> <cacheDir> <package> <version>
//     Serves <package> with only <version>, lets `npm view` cache that list in <cacheDir>, then stops. After that, http://127.0.0.1:<port>/ refuses
//     connections and <cacheDir> holds the old list: run npm with --registry http://127.0.0.1:<port>/ --cache <cacheDir>.
//
// As a module: startRegistry() for a registry that stays up while a test runs, and seedCache().
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export function startRegistry({ pkg, versions, port = 0 }) {
  let current = [...versions];
  let boundPort = port;
  const fakeIntegrity = (v) => "sha512-" + createHash("sha512").update(`${pkg}@${v}`).digest("base64");
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "public, max-age=300");
    res.setHeader("etag", `"${current.join(",")}"`);
    if (req.headers["if-none-match"] === `"${current.join(",")}"`) { res.statusCode = 304; return res.end(); }
    if (decodeURIComponent(req.url) !== `/${pkg}`) { res.statusCode = 404; return res.end(JSON.stringify({ error: "Not found" })); }
    res.end(JSON.stringify({
      name: pkg,
      "dist-tags": { latest: current.at(-1) },
      versions: Object.fromEntries(current.map((v) => [v, {
        name: pkg, version: v,
        dist: { integrity: fakeIntegrity(v), tarball: `http://127.0.0.1:${boundPort}/${pkg}/-/${pkg}-${v}.tgz` },
      }])),
    }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      boundPort = server.address().port;
      resolve({
        port: boundPort,
        url: `http://127.0.0.1:${boundPort}/`,
        setVersions(next) { current = [...next]; },
        close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
      });
    });
  });
}

// npm's own script from the Node that runs this file (Windows keeps it beside node.exe, Linux and macOS under ../lib), so no PATH is needed
// and no shell: a .cmd shim would need shell: true, which Node 24 warns about.
function npmCli() {
  const dir = dirname(process.execPath);
  const found = [join(dir, "node_modules", "npm", "bin", "npm-cli.js"), join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")].find(existsSync);
  if (!found) throw new Error(`no npm next to ${process.execPath}`);
  return found;
}

export function runNpm(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [npmCli(), ...args], { env });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
    child.on("error", (e) => resolve({ code: 127, out: String(e) }));
  });
}

// Leaves `cacheDir` holding the package list of `pkg` with only `version`, and the registry at `port` down.
export async function seedCache({ port, cacheDir, pkg, version, env }) {
  const registry = await startRegistry({ pkg, versions: [version], port });
  const seeded = await runNpm(["view", `${pkg}@${version}`, "dist.integrity", "--registry", registry.url, "--cache", cacheDir], env);
  await registry.close();
  if (seeded.code !== 0) throw new Error(`seeding failed: ${seeded.out}`);
  return registry.url;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, port, cacheDir, pkg, version] = process.argv.slice(2);
  if (mode !== "seed" || !version) {
    console.error("usage: node npm-stale-fixture.mjs seed <port> <cacheDir> <package> <version>");
    process.exit(2);
  }
  const url = await seedCache({ port: Number(port), cacheDir, pkg, version, env: { ...process.env, npm_config_fetch_retries: "0" } });
  console.log(`seeded ${cacheDir} with ${pkg}@${version}; ${url} is down`);
}
