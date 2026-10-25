// Builds unsigned NSIS x64 installers 0.0.1 and 0.0.2 from macOS and assembles ../out/feed (both installers + latest.yml of the newest).
// usage: node scripts/build-installers.mjs [feed-url]     (default http://192.168.64.1:8099/)
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const proto = resolve(import.meta.dirname, "..");
const out = resolve(proto, "..", "out");
const feedUrl = process.argv[2] ?? "http://192.168.64.1:8099/";
const versions = ["0.0.1", "0.0.2"];
if (!out.endsWith(join("spike", "win", "out"))) throw new Error(`unexpected output dir ${out}`);

function run(cmd, args) {
	const r = spawnSync(cmd, args, { cwd: proto, stdio: "inherit", env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" } });
	if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
}

run("npx", ["tsc", "-p", "tsconfig.json"]);
run("node", ["scripts/copy-assets.mjs"]);
mkdirSync(out, { recursive: true });
// The feed URL is baked into app-update.yml at build time; the app can still override it at runtime (config.json, --feed-url, SBD_FEED_URL).
const config = JSON.parse(readFileSync(join(proto, "electron-builder.json"), "utf8"));
config.publish = [{ provider: "generic", url: feedUrl }];
const generated = join(out, "electron-builder.generated.json");
writeFileSync(generated, JSON.stringify(config, null, 2));
for (const v of versions) {
	const dir = join(out, v);
	rmSync(dir, { recursive: true, force: true });
	run("npx", ["electron-builder", "--win", "nsis", "--x64", "--publish", "never", "--config", generated,
		`-c.extraMetadata.version=${v}`, `-c.directories.output=${dir}`]);
}
const feed = join(out, "feed");
rmSync(feed, { recursive: true, force: true });
mkdirSync(feed, { recursive: true });
for (const v of versions) {
	const names = readdirSync(join(out, v)).filter((f) => f.endsWith(".exe") || f.endsWith(".blockmap"));
	if (!names.some((f) => f.endsWith(".exe"))) throw new Error(`no installer built for ${v}`);
	for (const f of names) copyFileSync(join(out, v, f), join(feed, f));
}
const yml = join(out, versions.at(-1), "latest.yml");
if (!existsSync(yml)) throw new Error("latest.yml missing");
copyFileSync(yml, join(feed, "latest.yml"));
console.log("feed ready:", readdirSync(feed).join(", "));
