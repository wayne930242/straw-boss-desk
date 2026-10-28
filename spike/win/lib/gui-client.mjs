// Test client for the HTTP surface pi-straw-boss already serves. It implements no straw-boss logic:
// it reads gui.json (port, token, csrf), sends the same requests the page sends, and prints JSON.
// The first argument is a gui.json file, the slot folder that holds it (SB_DIR, as start.ps1 prints it), or `auto`: the kit's state\start.json names the folder
// (`sbDir`; SBD_ROOT or %LOCALAPPDATA%\straw-boss-desk is the kit root). The token rotates on every restart, so the file is read again on every run.
//
//   node gui-client.mjs <gui.json | SB_DIR | auto> page
//   node gui-client.mjs <gui.json> net
//   node gui-client.mjs <gui.json> dirs '{"path":"C:\\Users\\x"}'
//   node gui-client.mjs <gui.json> open-base '{"dir":"C:\\Users\\x\\play","label":"chk"}'
//   node gui-client.mjs <gui.json> mirror '{"key":"<session key>","waitMs":15000}'   (key omitted: the first controllable session)
import { readFileSync, statSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";

const [target, cmd, rawArgs] = process.argv.slice(2);
const args = rawArgs ? JSON.parse(rawArgs) : {};
const readJson = (file) => JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
function guiPathOf(arg) {
	let dir = arg;
	if (arg === "auto") {
		const root = process.env.SBD_ROOT ?? join(process.env.LOCALAPPDATA ?? "", "straw-boss-desk");
		dir = readJson(join(root, "state", "start.json")).sbDir;
		if (!dir) throw new Error("state\\start.json has no sbDir: run start.ps1 first");
	}
	return statSync(dir).isDirectory() ? join(dir, "gui.json") : dir;
}
const rec = readJson(guiPathOf(target));
const origin = `http://127.0.0.1:${rec.port}`;
const base = `/${rec.token}`;

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

function call(method, path, json, extra = {}) {
	return new Promise((done) => {
		const body = json === undefined ? undefined : JSON.stringify(json);
		const headers = { host: `127.0.0.1:${rec.port}`, ...extra };
		if (method === "POST") Object.assign(headers, { origin, "content-type": "application/json", "x-sb-csrf": rec.csrf ?? "", "content-length": Buffer.byteLength(body ?? "{}") });
		const req = request({ host: "127.0.0.1", port: rec.port, path: `${base}${path}`, method, headers, agent: false, timeout: 60000 }, (res) => {
			let text = "";
			res.setEncoding("utf8").on("data", (c) => (text += c)).on("end", () => {
				let parsed;
				try { parsed = JSON.parse(text); } catch { parsed = undefined; }
				done({ status: res.statusCode, body: parsed, text: parsed === undefined ? text.slice(0, 300) : undefined, bytes: text.length });
			});
		});
		req.on("error", (e) => done({ status: 0, error: e.message })).on("timeout", () => (req.destroy(), done({ status: 0, error: "timeout" })));
		req.end(method === "POST" ? (body ?? "{}") : undefined);
	});
}

// One server-sent-events stream: calls onEvent(name, data) until it returns true or the time is up.
function stream(path, onEvent, ms) {
	return new Promise((done) => {
		let buf = "", finished = false;
		const end = (why) => { if (finished) return; finished = true; req.destroy(); done(why); };
		const req = request({ host: "127.0.0.1", port: rec.port, path: `${base}${path}`, method: "GET", headers: { host: `127.0.0.1:${rec.port}`, accept: "text/event-stream" }, agent: false }, (res) => {
			if (res.statusCode !== 200) return end(`status ${res.statusCode}`);
			res.setEncoding("utf8").on("data", (chunk) => {
				buf += chunk;
				let i;
				while ((i = buf.indexOf("\n\n")) >= 0) {
					const frame = buf.slice(0, i); buf = buf.slice(i + 2);
					let name = "message", data = "";
					for (const line of frame.split("\n")) {
						if (line.startsWith("event: ")) name = line.slice(7);
						else if (line.startsWith("data: ")) data += line.slice(6);
					}
					let parsed = data; try { parsed = JSON.parse(data); } catch { /* ping has no body */ }
					if (onEvent(name, parsed)) return end("done");
				}
			});
			res.on("end", () => end("closed"));
		});
		req.on("error", (e) => end(`error ${e.message}`));
		setTimeout(() => end("timeout"), ms);
		req.end();
	});
}

const flatUnits = (net) => (net?.bases ?? []).flatMap((b) => [
	...(b.tower ? [{ base: b.label, role: "tower", key: b.tower.key, name: b.tower.name, control: b.tower.control }] : []),
	...b.tabs.flatMap((t) => t.units.map((u) => ({ base: b.label, role: u.role, key: u.key, name: u.name, control: u.control }))),
	...(b.outside ?? []).map((u) => ({ base: b.label, role: "outside", key: u.key, name: u.name, control: u.control })),
]);

if (cmd === "page") {
	const r = await call("GET", "/");
	out({ status: r.status, bytes: r.bytes, ok: r.status === 200 });
} else if (cmd === "dirs") {
	out(await call("POST", "/api/dirs", args));
} else if (cmd === "open-base") {
	out(await call("POST", "/api/open/base", args));
} else if (cmd === "net") {
	let net;
	await stream("/events", (name, data) => (name === "message" && data && typeof data === "object" ? ((net = data), true) : false), args.waitMs ?? 15000);
	out({ bases: (net?.bases ?? []).length, units: flatUnits(net) });
} else if (cmd === "mirror") {
	let streamId, net, key = args.key, attached, frames = [], problem;
	let asked = false;
	const why = await stream("/events", (name, data) => {
		if (name === "hello") streamId = data.stream;
		else if (name === "message" && data && typeof data === "object") net = data;
		else if (name === "mirror" && data.key === key) { frames.push(data); if (data.rows !== undefined && data.set?.length) return true; }
		if (!asked && streamId && net) {
			asked = true;
			key ??= flatUnits(net).find((u) => u.control)?.key;
			if (!key) { problem = "no controllable session on the net"; return true; }
			call("POST", `/api/sessions/${encodeURIComponent(key)}/mirror`, { stream: streamId, on: true }).then((r) => { attached = r; if (r.status !== 200) problem = `mirror attach ${r.status}: ${JSON.stringify(r.body)}`; });
		}
		return Boolean(problem);
	}, args.waitMs ?? 20000);
	const first = frames.find((f) => f.set?.length);
	out({ stream: why, key, attached, problem, frames: frames.length, rows: first?.rows, cols: first?.cols, nonEmptyRows: first ? first.set.filter(([, t]) => t.trim()).length : 0, sample: first ? first.set.filter(([, t]) => t.trim()).slice(0, 5).map(([, t]) => t.replace(/\x1b\[[0-9;:]*m/g, "").slice(0, 120)) : [] });
} else {
	out({ error: `unknown command ${cmd}` });
	process.exit(2);
}
