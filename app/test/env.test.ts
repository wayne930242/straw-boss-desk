import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { buildEnv, firstProxyEntry, LOOPBACK, NEVER_CARRY, PASS_THROUGH, resolveOsProxy } from "../src/main/env.ts";
import { computeLayout, type AppPlatform, type CurrentTools, type Layout } from "../src/main/paths.ts";

const current: CurrentTools = { node: "24.22.1", git: "2.56.0", herdr: "0.9.5" };
const hostPlatform: AppPlatform = process.platform === "win32" ? "win32" : "darwin";
const scratch: string[] = [];
after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

function hostLayout(): Layout {
	const parent = realpathSync(mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "sbd-env-")));
	scratch.push(parent);
	const home = join(parent, "h 測試");
	mkdirSync(home);
	return computeLayout({ root: join(home, "sbd 測試"), home, platform: hostPlatform });
}

function fakeLayout(platform: AppPlatform): Layout {
	const home = platform === "win32" ? "C:\\h" : "/h";
	const root = platform === "win32" ? "C:\\h\\data" : "/h/data";
	return computeLayout({ root, home, platform, realpath: (p) => { if (p === home) return p; throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } });
}

/** Every variable the spec says a child never carries, plus the launchers' unset list. */
const forbidden = (): Record<string, string> => ({
	...Object.fromEntries(NEVER_CARRY.map((n) => [n, "leaked"])),
	PI_SUBAGENT_ID: "leaked", PI_SUBAGENT_PARENT: "leaked", GH_CONFIG_DIR: "/leak", XDG_CONFIG_HOME: "/leak", PI_CODING_AGENT_DIR: "/leak",
});

const proxyVariables = (): Record<string, string> => ({
	HTTP_PROXY: "http://proxy-a:1", HTTPS_PROXY: "http://proxy-b:2", ALL_PROXY: "http://proxy-c:3", NO_PROXY: "internal.example",
	NODE_EXTRA_CA_CERTS: "/certs/extra.pem", SSL_CERT_FILE: "/certs/file.pem", SSL_CERT_DIR: "/certs/dir", GIT_SSL_CAINFO: "/certs/git.pem",
});

describe("buildEnv", () => {
	it("sets the variables of the kit's Set-SbdEnv and the telemetry switches", () => {
		for (const platform of ["win32", "darwin"] as const) {
			const layout = fakeLayout(platform);
			const env = buildEnv({ layout, current, appEnv: {} });
			assert.equal(env.PI_CODING_AGENT_DIR, layout.agent);
			assert.equal(env.STRAW_BOSS_DESK, "1");
			assert.equal(env.STRAW_BOSS_DESK_ROOT, layout.root);
			assert.equal(env.XDG_CONFIG_HOME, layout.configHome);
			assert.equal(env.HERDR_CONFIG_PATH, layout.herdrConfig);
			assert.equal(env.HERDR_SOCKET_PATH, layout.herdrSocket);
			assert.equal(env.HERDR_DISABLE_SOUND, "1");
			assert.equal(env.CLAUDE_CONFIG_DIR, layout.claude);
			assert.equal(env.GIT_CONFIG_GLOBAL, layout.gitconfig);
			assert.equal(env.NPM_CONFIG_PREFIX, layout.tools.npm);
			assert.equal(env.NPM_CONFIG_CACHE, layout.tools.npmCache);
			assert.equal(env.NPM_CONFIG_PREFER_ONLINE, "true");
			for (const [name, value] of Object.entries({ PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", NPM_CONFIG_UPDATE_NOTIFIER: "false", NODE_USE_SYSTEM_CA: "1" })) {
				assert.equal(env[name], value, `${platform} ${name}`);
			}
			assert.equal(env.HERDR_BIN_PATH, platform === "win32" ? `${layout.root}\\tools\\herdr\\0.9.5\\herdr.exe` : `${layout.root}/tools/herdr/0.9.5/herdr`);
		}
	});

	it("puts tools/bin first on PATH, then Node, the npm prefix, Git, and Herdr, then the rest", () => {
		const mac = fakeLayout("darwin");
		const macEnv = buildEnv({ layout: mac, current, appEnv: { PATH: "/opt/homebrew/bin:/usr/bin" } });
		assert.deepEqual(macEnv.PATH?.split(":"), [
			`${mac.root}/tools/bin`, `${mac.root}/tools/node/24.22.1/bin`, `${mac.root}/tools/npm/bin`, `${mac.root}/tools/git/2.56.0/bin`, `${mac.root}/tools/herdr/0.9.5`,
			"/usr/bin", "/bin", "/usr/sbin", "/sbin",
		], "macOS takes the system folders, not the app's inherited PATH (a Finder-launched app has no Homebrew either)");
		const win = fakeLayout("win32");
		const winEnv = buildEnv({ layout: win, current, appEnv: { Path: `C:\\Windows\\System32;${win.tools.bin};C:\\Windows` } });
		assert.deepEqual(winEnv.PATH?.split(";"), [
			`${win.root}\\tools\\bin`, `${win.root}\\tools\\node\\24.22.1`, `${win.root}\\tools\\npm`, `${win.root}\\tools\\git\\2.56.0\\cmd`, `${win.root}\\tools\\git\\2.56.0\\bin`, `${win.root}\\tools\\herdr\\0.9.5`,
			"C:\\Windows\\System32", "C:\\Windows",
		], "Windows keeps the rest of the inherited PATH, once");
	});

	it("sets ZDOTDIR on macOS only", () => {
		const mac = fakeLayout("darwin");
		assert.equal(buildEnv({ layout: mac, current, appEnv: {} }).ZDOTDIR, `${mac.configHome}/zsh`);
		assert.equal(buildEnv({ layout: fakeLayout("win32"), current, appEnv: {} }).ZDOTDIR, undefined);
	});

	it("uses the fallback XDG_CONFIG_HOME for Herdr and the ZDOTDIR files when the layout fell back", () => {
		const home = `/Users/${"x".repeat(30)}`;
		const layout = computeLayout({ root: `${home}/Library/Application Support/straw-boss-desk`, home, platform: "darwin", realpath: (p) => { if (p === home) return p; throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } });
		const env = buildEnv({ layout, current, appEnv: {} });
		assert.equal(env.XDG_CONFIG_HOME, layout.configHome);
		assert.ok(layout.configHome.includes(".straw-boss-desk"));
		assert.equal(env.HERDR_SOCKET_PATH, `${layout.configHome}/herdr/herdr.sock`);
		assert.equal(env.ZDOTDIR, `${layout.configHome}/zsh`);
		assert.equal(env.STRAW_BOSS_DESK_ROOT, layout.root, "the root itself does not move");
	});

	it("adds the Linear key only when it is given", () => {
		const layout = fakeLayout("darwin");
		assert.equal(buildEnv({ layout, current, appEnv: {} }).LINEAR_API_KEY, undefined);
		assert.equal(buildEnv({ layout, current, appEnv: {}, linearApiKey: "lin_key" }).LINEAR_API_KEY, "lin_key");
	});

	it("refuses to carry a forbidden name, whatever the allow-list does", () => {
		// The second gate: a name in NEVER_CARRY is rejected when it reaches the finished map.
		const layout = fakeLayout("darwin");
		const env = buildEnv({ layout, current, appEnv: forbidden() });
		for (const name of NEVER_CARRY) assert.equal(env[name], undefined, name);
	});

	it("builds a child environment with none of the forbidden variables even when the test sets them all (checked in a real child process)", () => {
		const layout = hostLayout();
		const appEnv: Record<string, string | undefined> = { ...process.env, ...forbidden(), ...proxyVariables() };
		if (hostPlatform === "darwin") appEnv.https_proxy = "http://lower:9";
		const env = buildEnv({ layout, current, appEnv });
		const child = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], { env, encoding: "utf8" });
		assert.equal(child.status, 0, child.stderr);
		const seen = JSON.parse(child.stdout) as Record<string, string>;
		const names = Object.keys(seen);
		const has = (name: string) => names.some((n) => (hostPlatform === "win32" ? n.toLowerCase() === name.toLowerCase() : n === name));
		for (const name of NEVER_CARRY) assert.ok(!has(name), `${name} reached the child`);
		assert.ok(!names.some((n) => /^PI_SUBAGENT_/i.test(n)), "a PI_SUBAGENT_ variable reached the child");
		assert.ok(!names.some((n) => /^GH_CONFIG_DIR$/i.test(n)), "GH_CONFIG_DIR is the launchers' to set, not the app's");
		// What the app sets is the app's, not what the test's environment held.
		assert.equal(seen.XDG_CONFIG_HOME, layout.configHome);
		assert.equal(seen.PI_CODING_AGENT_DIR, layout.agent);
		for (const [name, value] of Object.entries({ PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", NPM_CONFIG_UPDATE_NOTIFIER: "false", NODE_USE_SYSTEM_CA: "1", STRAW_BOSS_DESK: "1" })) {
			assert.equal(seen[name], value, name);
		}
		assert.equal(seen.STRAW_BOSS_DESK_ROOT, layout.root, "a root with a space and CJK characters survives the environment block");
		assert.equal(seen.PATH?.split(delimiter)[0], layout.tools.bin);
		// Every proxy and CA variable the test set is passed through unchanged.
		for (const [name, value] of Object.entries(proxyVariables())) assert.equal(seen[name], value, `${name} was not passed through`);
		if (hostPlatform === "darwin") assert.equal(seen.https_proxy, "http://lower:9", "a lower-case name is passed through as set");
	});

	it("passes through only the names the spec lists", () => {
		const layout = fakeLayout("darwin");
		const env = buildEnv({ layout, current, appEnv: { ...proxyVariables(), SOME_OTHER: "x", NPM_TOKEN: "t" } });
		for (const name of PASS_THROUGH) assert.ok(env[name] !== undefined, name);
		assert.equal(env.SOME_OTHER, undefined);
		assert.equal(env.NPM_TOKEN, undefined, "an npm token in the author's shell is not the PM's");
	});
});

describe("the OS proxy setting", () => {
	const answers = (table: Record<string, string>) => async (url: string): Promise<string> => {
		const answer = table[new URL(url).hostname];
		if (answer === undefined) throw new Error(`no answer for ${url}`);
		return answer;
	};

	it("reads the first entry of a list answer", () => {
		assert.deepEqual(firstProxyEntry("PROXY 127.0.0.1:3128; PROXY 10.0.0.1:8080; DIRECT"), { kind: "proxy", hostPort: "127.0.0.1:3128" });
		assert.deepEqual(firstProxyEntry("HTTPS proxy.example:443"), { kind: "proxy", hostPort: "proxy.example:443" });
		assert.deepEqual(firstProxyEntry("DIRECT"), { kind: "direct" });
		assert.deepEqual(firstProxyEntry("SOCKS5 127.0.0.1:1080; DIRECT"), { kind: "other", text: "SOCKS5 127.0.0.1:1080" });
	});

	it("sets HTTPS_PROXY, HTTP_PROXY, and a NO_PROXY with the loopback names from a stubbed answer", async () => {
		const result = await resolveOsProxy({ resolve: answers({ "registry.npmjs.org": "PROXY 127.0.0.1:3128", "github.com": "PROXY 127.0.0.1:3128" }), forgeHosts: [], appEnv: {} });
		assert.deepEqual(result.env, { HTTPS_PROXY: "http://127.0.0.1:3128", HTTP_PROXY: "http://127.0.0.1:3128", NO_PROXY: LOOPBACK });
		assert.equal(LOOPBACK, "127.0.0.1,localhost,::1");
	});

	it("takes the first entry of a list answer and logs every answer", async () => {
		const list = "PROXY 127.0.0.1:3128; PROXY 10.0.0.1:8080; DIRECT";
		const result = await resolveOsProxy({ resolve: answers({ "registry.npmjs.org": list, "github.com": list }), forgeHosts: [], appEnv: {} });
		assert.equal(result.env.HTTPS_PROXY, "http://127.0.0.1:3128");
		assert.ok(result.log.some((line) => line.includes(list)), "the full answer is in the log");
	});

	it("adds a forge host the PAC file sends DIRECT to NO_PROXY beside the loopback names", async () => {
		const result = await resolveOsProxy({
			resolve: answers({ "registry.npmjs.org": "PROXY p:8080", "github.com": "PROXY p:8080", "gitlab.company.example": "DIRECT" }),
			forgeHosts: ["gitlab.company.example"],
			appEnv: {},
		});
		assert.equal(result.env.NO_PROXY, `${LOOPBACK},gitlab.company.example`);
		assert.equal(result.env.HTTPS_PROXY, "http://p:8080");
	});

	it("names a forge host with a port by its host name in NO_PROXY", async () => {
		const result = await resolveOsProxy({
			resolve: async (url) => (new URL(url).hostname === "git.corp.example" ? "DIRECT" : "PROXY p:8080"),
			forgeHosts: ["git.corp.example:8443"],
			appEnv: {},
		});
		assert.equal(result.env.NO_PROXY, `${LOOPBACK},git.corp.example`);
	});

	it("keeps a forge host that goes through the same proxy out of NO_PROXY", async () => {
		const result = await resolveOsProxy({ resolve: async () => "PROXY p:8080", forgeHosts: ["gitlab.com"], appEnv: {} });
		assert.equal(result.env.NO_PROXY, LOOPBACK);
	});

	it("sets nothing, and says why, for a DIRECT registry", async () => {
		const result = await resolveOsProxy({ resolve: async () => "DIRECT", forgeHosts: [], appEnv: {} });
		assert.deepEqual(result.env, {});
		assert.match(result.log.join("\n"), /DIRECT/);
	});

	it("sets nothing for a SOCKS answer, with every answer logged", async () => {
		const result = await resolveOsProxy({ resolve: answers({ "registry.npmjs.org": "SOCKS5 127.0.0.1:1080; DIRECT", "github.com": "SOCKS5 127.0.0.1:1080" }), forgeHosts: [], appEnv: {} });
		assert.deepEqual(result.env, {});
		assert.match(result.log.join("\n"), /SOCKS5 127\.0\.0\.1:1080; DIRECT/);
		assert.match(result.log.join("\n"), /npm cannot use/);
	});

	it("sets nothing when a host's proxy differs from the registry's", async () => {
		const result = await resolveOsProxy({
			resolve: answers({ "registry.npmjs.org": "PROXY a:8080", "github.com": "PROXY a:8080", "gitlab.company.example": "PROXY b:8080" }),
			forgeHosts: ["gitlab.company.example"],
			appEnv: {},
		});
		assert.deepEqual(result.env, {});
		assert.match(result.log.join("\n"), /gitlab\.company\.example would use a different proxy/);
		assert.match(result.log.join("\n"), /PROXY b:8080/, "the answer that differs is in the log");
	});

	it("sets nothing when the OS setting cannot be read", async () => {
		const result = await resolveOsProxy({ resolve: async () => { throw new Error("no session"); }, forgeHosts: [], appEnv: {} });
		assert.deepEqual(result.env, {});
		assert.match(result.log.join("\n"), /could not be read/);
	});

	it("keeps a proxy the app's environment names over the stub's answer", async () => {
		let asked = 0;
		const resolve = async () => { asked += 1; return "PROXY 127.0.0.1:3128"; };
		const proxy = await resolveOsProxy({ resolve, forgeHosts: [], appEnv: { HTTPS_PROXY: "http://mine:1" } });
		assert.deepEqual(proxy.env, {});
		assert.equal(asked, 0, "the OS setting is not even asked");
		const env = buildEnv({ layout: fakeLayout("darwin"), current, appEnv: { HTTPS_PROXY: "http://mine:1" }, proxy });
		assert.equal(env.HTTPS_PROXY, "http://mine:1");
		assert.equal(env.HTTP_PROXY, undefined);
		// A lower-case name counts too.
		assert.deepEqual((await resolveOsProxy({ resolve, forgeHosts: [], appEnv: { http_proxy: "http://mine:1" } })).env, {});
	});

	it("keeps the app's own NO_PROXY when the app names none of the proxies", async () => {
		const proxy = await resolveOsProxy({ resolve: async () => "PROXY p:8080", forgeHosts: [], appEnv: { NO_PROXY: "mine.example" } });
		const env = buildEnv({ layout: fakeLayout("darwin"), current, appEnv: { NO_PROXY: "mine.example" }, proxy });
		assert.equal(env.NO_PROXY, "mine.example");
		assert.equal(env.HTTPS_PROXY, "http://p:8080");
	});

	it("rejects a forge host that is not a host name", async () => {
		await assert.rejects(resolveOsProxy({ resolve: async () => "DIRECT", forgeHosts: ["not a host"], appEnv: {} }), /not a host name/);
	});
});

describe("a child npm goes through the OS proxy setting (a test-local CONNECT proxy)", () => {
	/** A CONNECT proxy on 127.0.0.1 that tunnels to the requested host and records what was asked for. */
	async function connectProxy(): Promise<{ port: number; connects: string[]; close(): Promise<void> }> {
		const connects: string[] = [];
		const sockets = new Set<Duplex>();
		const server = http.createServer((_, res) => { res.writeHead(405).end(); });
		server.on("connect", (req, client, head) => {
			connects.push(req.url ?? "");
			const [host, port] = (req.url ?? "").split(":");
			const upstream = net.connect(Number(port), host ?? "", () => {
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				upstream.write(head);
				upstream.pipe(client);
				client.pipe(upstream);
			});
			for (const s of [client, upstream]) { sockets.add(s); s.on("close", () => sockets.delete(s)); s.on("error", () => s.destroy()); }
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		return {
			port: (server.address() as net.AddressInfo).port,
			connects,
			close: () => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
		};
	}

	const npmCli = (): string => {
		const node = dirname(process.execPath);
		const candidates = [join(node, "node_modules", "npm", "bin", "npm-cli.js"), join(node, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
		const found = candidates.find((c) => existsSync(c));
		if (!found) throw new Error(`npm-cli.js not found beside ${process.execPath}; looked in ${candidates.join(", ")}`);
		return found;
	};

	const runNpm = (env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> =>
		new Promise((resolve) => {
			const child = spawn(process.execPath, [npmCli(), "view", "left-pad", "version"], { env, windowsHide: true });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (d) => { stdout += String(d); });
			child.stderr.on("data", (d) => { stderr += String(d); });
			const timer = setTimeout(() => child.kill(), 90_000);
			child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
		});

	it("runs `npm view <package> version` through the proxy the stubbed resolver names, with the loopback names in NO_PROXY", async () => {
		const proxy = await connectProxy();
		try {
			const layout = hostLayout();
			const resolve = async () => `PROXY 127.0.0.1:${proxy.port}`;
			const os = await resolveOsProxy({ resolve, forgeHosts: [], appEnv: {} });
			const env = buildEnv({ layout, current, appEnv: process.env, proxy: os });
			assert.equal(env.HTTPS_PROXY, `http://127.0.0.1:${proxy.port}`);
			assert.equal(env.NO_PROXY, LOOPBACK);
			const result = await runNpm(env);
			assert.equal(result.code, 0, `npm view failed: ${result.stderr.trim().slice(0, 400)}`);
			assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
			assert.ok(proxy.connects.some((c) => c.startsWith("registry.npmjs.org:")), `the proxy saw ${JSON.stringify(proxy.connects)}`);
		} finally {
			await proxy.close();
		}
	});

	it("does not use the stub's proxy when the app's environment names another", async () => {
		const proxy = await connectProxy();
		try {
			const layout = hostLayout();
			const os = await resolveOsProxy({ resolve: async () => `PROXY 127.0.0.1:${proxy.port}`, forgeHosts: [], appEnv: { HTTPS_PROXY: "http://127.0.0.1:9" } });
			const env = buildEnv({ layout, current, appEnv: { ...process.env, HTTPS_PROXY: "http://127.0.0.1:9" }, proxy: os });
			assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:9");
			assert.deepEqual(proxy.connects, []);
		} finally {
			await proxy.close();
		}
	});
});
