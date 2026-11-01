import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { after, describe, it } from "node:test";
import { computeLayout, loadLayout, LayoutError, LAYOUT_RULE, recordIsCurrent, toolPathEntries, type AppPlatform, type CurrentTools, type LayoutRecord } from "../src/main/paths.ts";

/** A file system of known folders: `table` maps a path to its real path (a junction maps to another place); everything else does not exist. */
function fakeFs(table: Record<string, string>): (path: string) => string {
	return (path) => {
		const real = table[path];
		if (real === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
		return real;
	};
}
const idOf = (realRoot: string): string => createHash("sha256").update(realRoot).digest("hex").slice(0, 8);
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

describe("layout: Windows", () => {
	const home = "C:\\Users\\測試PM";
	it("keeps the agent folder in the root when the root lies inside home", () => {
		const root = `${home}\\AppData\\Local\\sbd 測試`;
		const layout = computeLayout({ root, home, platform: "win32", realpath: fakeFs({ [home]: home, [`${home}\\AppData\\Local`]: `${home}\\AppData\\Local` }) });
		assert.equal(layout.agent, `${root}\\agent`);
		assert.equal(layout.configHome, `${root}\\config`);
		assert.equal(layout.record.fallbackDir, null);
		assert.deepEqual(layout.record.reasons, []);
		assert.equal(layout.record.sidecarSocketBytes, null);
		assert.equal(layout.tools.shims, `${root}\\tools\\shims`);
		assert.equal(layout.state, `${root}\\state`);
	});

	it("moves the agent folder into home when a junction sends LOCALAPPDATA outside it, and leaves the rest", () => {
		const local = `${home}\\AppData\\Local`;
		const root = `${local}\\straw-boss-desk`;
		const realRoot = "D:\\Redirected\\Local\\straw-boss-desk";
		const layout = computeLayout({ root, home, platform: "win32", realpath: fakeFs({ [home]: home, [local]: "D:\\Redirected\\Local", [`${home}\\.straw-boss-desk`]: `${home}\\.straw-boss-desk` }) });
		const id = idOf(realRoot);
		assert.equal(layout.id, id);
		assert.equal(layout.agent, `${home}\\.straw-boss-desk\\${id}\\agent`);
		assert.equal(layout.record.fallbackDir, `${home}\\.straw-boss-desk\\${id}`);
		assert.equal(layout.configHome, `${root}\\config`, "only the agent folder moves");
		assert.equal(layout.claude, `${root}\\claude`);
		assert.match(layout.record.reasons.join("\n"), /agent folder .* outside the home/);
	});

	it("compares real paths without regard to case", () => {
		const root = `${home}\\AppData\\Local\\straw-boss-desk`;
		const layout = computeLayout({ root, home, platform: "win32", realpath: fakeFs({ [home]: home.toUpperCase(), [`${home}\\AppData\\Local`]: `${home}\\AppData\\Local` }) });
		assert.equal(layout.record.fallbackDir, null);
	});

	it("refuses a fallback folder that is itself outside home", () => {
		const local = `${home}\\AppData\\Local`;
		assert.throws(
			() => computeLayout({ root: `${local}\\straw-boss-desk`, home, platform: "win32", realpath: fakeFs({ [home]: home, [local]: "D:\\Redirected\\Local", [`${home}\\.straw-boss-desk`]: "E:\\Elsewhere\\.straw-boss-desk" }) }),
			(error: unknown) => error instanceof LayoutError && error.code === "fallback-outside-home",
		);
	});

	it("refuses a root that is not an absolute path", () => {
		assert.throws(() => computeLayout({ root: "sbd", home, platform: "win32", realpath: fakeFs({}) }), (e: unknown) => e instanceof LayoutError && e.code === "root-not-absolute");
	});
});

describe("layout: macOS", () => {
	const identity = (...paths: string[]) => fakeFs(Object.fromEntries(paths.map((p) => [p, p])));

	it("uses the default root and records the socket and sidecar lengths", () => {
		const home = "/Users/a";
		const root = `${home}/Library/Application Support/straw-boss-desk`;
		const layout = computeLayout({ root, home, platform: "darwin", realpath: identity(home, `${home}/Library`) });
		assert.equal(layout.configHome, `${root}/config`);
		assert.equal(layout.herdrSocket, `${root}/config/herdr/herdr.sock`);
		assert.equal(layout.record.herdrSocketBytes, 75 + "a".length, "75 bytes plus the user name (spec)");
		assert.equal(layout.record.sidecarSocketBytes, 97 + "a".length, "97 bytes plus the user name (spec)");
		assert.equal(layout.record.fallbackDir, null);
		assert.equal(layout.zdotdir, `${root}/config/zsh`);
		assert.equal(layout.agent, `${root}/agent`, "the agent rule is Windows-only; macOS keeps it in the root");
	});

	it("takes the ~/.straw-boss-desk/<id>/config fallback when the socket path would pass 100 bytes", () => {
		const user = "x".repeat(30);
		const home = `/Users/${user}`;
		const root = `${home}/Library/Application Support/straw-boss-desk`;
		assert.ok(bytes(`${root}/config/herdr/herdr.sock`) > 100, "the default socket is too long for this user");
		const layout = computeLayout({ root, home, platform: "darwin", realpath: identity(home, `${home}/Library`) });
		const id = idOf(root);
		assert.equal(layout.configHome, `${home}/.straw-boss-desk/${id}/config`);
		assert.equal(layout.herdrSocket, `${home}/.straw-boss-desk/${id}/config/herdr/herdr.sock`);
		assert.equal(layout.record.herdrSocketBytes, 57 + user.length, "57 bytes plus the user name (spec)");
		assert.ok(layout.record.herdrSocketBytes <= 100);
		assert.equal(layout.record.fallbackDir, `${home}/.straw-boss-desk/${id}`);
		assert.equal(layout.herdrConfig, `${layout.configHome}/herdr/config.toml`);
		assert.equal(layout.zdotdir, `${layout.configHome}/zsh`);
		assert.equal(layout.ghConfig, `${root}/config/gh`, "gh and glab stay where the launchers find them");
		assert.match(layout.record.reasons.join("\n"), /socket path was \d+ bytes/);
	});

	it("measures herdr-client.sock, which Herdr binds beside herdr.sock and which is 7 bytes longer (found by task 5's e2e)", () => {
		const home = "/Users/a";
		const filler = "r".repeat(95 - bytes(`${home}//config/herdr/herdr.sock`));
		const root = `${home}/${filler}`;
		assert.equal(bytes(`${root}/config/herdr/herdr.sock`), 95, "the main socket alone passes the old rule");
		assert.equal(bytes(`${root}/config/herdr/herdr-client.sock`), 102, "the client socket does not fit sun_path");
		const layout = computeLayout({ root, home, platform: "darwin", realpath: identity(home) });
		assert.equal(layout.configHome, `${home}/.straw-boss-desk/${idOf(root)}/config`);
		const fits = `${home}/${"r".repeat(93 - bytes(`${home}//config/herdr/herdr.sock`))}`;
		assert.equal(computeLayout({ root: fits, home, platform: "darwin", realpath: identity(home) }).configHome, `${fits}/config`, "a main socket of 93 bytes keeps the default");
	});

	it("gives two roots that both fall back two different fallback folders", () => {
		const home = `/Users/${"x".repeat(30)}`;
		const rootA = `${home}/sbd-development-root-number-one-a-longer-name`;
		const rootB = `${home}/sbd-development-root-number-two-a-longer-name`;
		for (const r of [rootA, rootB]) assert.ok(bytes(`${r}/config/herdr/herdr.sock`) > 100);
		const a = computeLayout({ root: rootA, home, platform: "darwin", realpath: identity(home) });
		const b = computeLayout({ root: rootB, home, platform: "darwin", realpath: identity(home) });
		assert.notEqual(a.record.fallbackDir, b.record.fallbackDir);
		assert.notEqual(a.herdrSocket, b.herdrSocket);
		assert.notEqual(a.id, b.id);
	});

	it("derives the id from the real path of the root, so two spellings of one root agree", () => {
		const home = "/Users/a";
		const viaLink = computeLayout({ root: "/tmp/link/straw-boss-desk", home, platform: "darwin", realpath: fakeFs({ [home]: home, "/tmp/link": "/private/var/real" }) });
		const direct = computeLayout({ root: "/private/var/real/straw-boss-desk", home, platform: "darwin", realpath: fakeFs({ [home]: home, "/private/var/real": "/private/var/real" }) });
		assert.equal(viaLink.id, direct.id);
		assert.equal(viaLink.record.realRoot, "/private/var/real/straw-boss-desk");
	});

	it("fails with a named error when even the fallback is too long", () => {
		const home = `/Users/${"x".repeat(60)}`;
		const root = `${home}/Library/Application Support/straw-boss-desk`;
		assert.throws(() => computeLayout({ root, home, platform: "darwin", realpath: identity(home) }), (e: unknown) => e instanceof LayoutError && e.code === "socket-too-long");
	});
});

describe("layout: the user-name boundaries of the socket rule (T5-F010)", () => {
	const identity = (...paths: string[]) => fakeFs(Object.fromEntries(paths.map((p) => [p, p])));
	const layoutFor = (userBytes: number) => {
		const home = `/Users/${"u".repeat(userBytes)}`;
		const root = `${home}/Library/Application Support/straw-boss-desk`;
		return { home, root, layout: () => computeLayout({ root, home, platform: "darwin", realpath: identity(home, `${home}/Library`) }) };
	};

	it("the default root holds for a user name of 18 bytes (client socket 100) and falls back at 19 (101)", () => {
		const eighteen = layoutFor(18);
		assert.equal(bytes(`${eighteen.root}/config/herdr/herdr-client.sock`), 100);
		assert.equal(eighteen.layout().configHome, `${eighteen.root}/config`);
		const nineteen = layoutFor(19);
		assert.equal(bytes(`${nineteen.root}/config/herdr/herdr-client.sock`), 101);
		assert.equal(nineteen.layout().configHome, `${nineteen.home}/.straw-boss-desk/${idOf(nineteen.root)}/config`);
	});

	it("the fallback holds for a user name of 36 bytes (client socket 100) and fails with socket-too-long at 37 (101)", () => {
		const thirtySix = layoutFor(36);
		const kept = thirtySix.layout();
		assert.equal(kept.configHome, `${thirtySix.home}/.straw-boss-desk/${idOf(thirtySix.root)}/config`);
		assert.equal(bytes(`${kept.configHome}/herdr/herdr-client.sock`), 100);
		assert.throws(() => layoutFor(37).layout(), (e: unknown) => e instanceof LayoutError && e.code === "socket-too-long");
	});

	it("a record from an older rule is not current, and neither is a darwin record whose config home passes the limit", () => {
		const record: LayoutRecord = layoutFor(19).layout().record;
		const taskThree = { ...record, rule: 1, configHome: `${layoutFor(19).root}/config` };
		assert.equal(recordIsCurrent(record), true);
		assert.equal(recordIsCurrent({ ...taskThree, rule: LAYOUT_RULE }), false, "the config home is too long for the client socket");
		assert.equal(recordIsCurrent(taskThree), false, "an older rule");
		const { rule: _dropped, ...legacy } = taskThree;
		assert.equal(recordIsCurrent(legacy as unknown as LayoutRecord), false, "a record with no rule at all");
	});

	it("loads a record written under the old rule by computing the layout again and writing the new record", { skip: process.platform !== "darwin" && "the record is written on this machine's file system with macOS paths" }, () => {
		const parent = realpathSync.native(mkdtempSync(join("/tmp", "sbdl-")));
		try {
			const user = "u".repeat(8); // the scratch parent is long, so the default root already passes the limit
			const home = join(parent, user);
			const root = join(home, "Library", "Application Support", "straw-boss-desk");
			mkdirSync(join(root, "state"), { recursive: true });
			const fresh = computeLayout({ root, home, platform: "darwin" });
			const old = { ...fresh.record, rule: undefined, configHome: join(root, "config"), herdrSocket: join(root, "config", "herdr", "herdr.sock") };
			writeFileSync(join(root, "state", "layout.json"), JSON.stringify(old));
			const loaded = loadLayout({ root, home, platform: "darwin" });
			assert.equal(loaded.record.rule, LAYOUT_RULE);
			assert.notEqual(loaded.configHome, join(root, "config"), "the old record's config home was not reused");
			assert.equal(JSON.parse(readFileSync(join(root, "state", "layout.json"), "utf8")).rule, LAYOUT_RULE);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});
});

describe("tool folders", () => {
	const current: CurrentTools = { node: "24.22.1", git: "2.56.0", herdr: "0.9.5" };
	it("lists the PATH folders in the spec's order on Windows", () => {
		const root = "C:\\r";
		const layout = computeLayout({ root, home: "C:\\h", platform: "win32", realpath: fakeFs({ "C:\\h": "C:\\h", "C:\\r": "C:\\r\\.." }) });
		assert.deepEqual(toolPathEntries(layout, current).map((e) => win32.relative(root, e)), [
			"tools\\bin", "tools\\node\\24.22.1", "tools\\npm", "tools\\git\\2.56.0\\cmd", "tools\\git\\2.56.0\\bin", "tools\\herdr\\0.9.5",
		]);
	});
	it("lists them on macOS", () => {
		const root = "/r";
		const layout = computeLayout({ root, home: "/h", platform: "darwin", realpath: fakeFs({ "/h": "/h", "/r": "/r" }) });
		assert.deepEqual(toolPathEntries(layout, current).map((e) => posix.relative(root, e)), [
			"tools/bin", "tools/node/24.22.1/bin", "tools/npm/bin", "tools/git/2.56.0/bin", "tools/herdr/0.9.5",
		]);
	});
});

describe("layout on this machine's file system", () => {
	const scratch: string[] = [];
	after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });
	const platform: AppPlatform = process.platform === "win32" ? "win32" : "darwin";
	// A short parent on macOS: a runner's $TMPDIR is long enough to push Herdr's socket path past its limit, which is the fallback's job to catch, not this test's.
	const parentDir = process.platform === "win32" ? tmpdir() : "/tmp";
	const made = (): string => {
		// `.native`: the plain call keeps a runner's 8.3 short names (RUNNER~1), which the layout (rightly) resolves.
		const dir = realpathSync.native(mkdtempSync(join(parentDir, "sbd-")));
		scratch.push(dir);
		return dir;
	};

	it("takes a root with a space and CJK characters, writes state/layout.json once, and reads it back without computing again", () => {
		const home = join(made(), "h 測試");
		const root = join(home, "AppData", "Local", "sbd 測試");
		mkdirSync(join(home, "AppData", "Local"), { recursive: true });
		const first = loadLayout({ root, home, platform });
		assert.equal(first.root, root);
		assert.ok(first.agent.startsWith(root) || first.record.fallbackDir !== null);
		assert.ok(first.record.herdrSocketBytes <= 100 || platform === "win32");
		const file = join(root, "state", "layout.json");
		assert.ok(existsSync(file));
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), first.record, "the record round-trips, CJK path included");
		const notCalled = () => { throw new Error("computed the layout again"); };
		const second = loadLayout({ root, home, platform, realpath: notCalled });
		assert.deepEqual(second, first);
	});

	it("replaces a record written for another home", () => {
		const parent = made();
		const root = join(parent, "root");
		const homeA = join(parent, "homeA");
		const homeB = join(parent, "homeB");
		mkdirSync(homeA);
		mkdirSync(homeB);
		const a = loadLayout({ root, home: homeA, platform });
		const b = loadLayout({ root, home: homeB, platform });
		assert.equal(b.record.home, homeB);
		assert.notEqual(a.record.home, b.record.home);
		assert.equal(JSON.parse(readFileSync(join(root, "state", "layout.json"), "utf8")).home, homeB);
	});

	it("ignores a damaged record and writes a fresh one", () => {
		const parent = made();
		const root = join(parent, "root");
		mkdirSync(join(root, "state"), { recursive: true });
		mkdirSync(join(parent, "h"));
		rmSync(join(root, "state", "layout.json"), { force: true });
		const first = loadLayout({ root, home: join(parent, "h"), platform });
		rmSync(join(root, "state", "layout.json"));
		mkdirSync(join(root, "state"), { recursive: true });
		const second = loadLayout({ root, home: join(parent, "h"), platform });
		assert.deepEqual(second.record, first.record);
	});

	it("on Windows, a junction that points a LOCALAPPDATA-like folder outside home moves the agent folder", { skip: process.platform !== "win32" && "needs a Windows junction (the unit case above covers the rule everywhere)" }, () => {
		const parent = made();
		const home = join(parent, "home 測試");
		const outside = join(parent, "outside");
		mkdirSync(join(home, "AppData"), { recursive: true });
		mkdirSync(outside);
		const local = join(home, "AppData", "Local");
		symlinkSync(outside, local, "junction");
		const root = join(local, "straw-boss-desk");
		const layout = loadLayout({ root, home, platform: "win32" });
		assert.equal(layout.record.realRoot, join(outside, "straw-boss-desk"));
		assert.equal(layout.agent, join(home, ".straw-boss-desk", layout.id, "agent"));
		assert.ok(layout.record.fallbackDir !== null);
		// A root that really lies inside home keeps its agent folder.
		const inside = join(home, "inside", "straw-boss-desk");
		assert.equal(computeLayout({ root: inside, home, platform: "win32" }).agent, join(inside, "agent"));
	});
});
