// Reads a window of an Electron/Chromium app started with --remote-debugging-port=<port> (which listens on 127.0.0.1 only), over CDP, with Node's built-in WebSocket.
// It prints one JSON line and never prints a URL's token: a page URL is reported as { origin, port, tokenHash } (the first 12 hex of the token's sha256), so a caller can
// compare it with the token in gui.json without either one appearing in a log.
//
//   node cdp-eval.mjs <port> list                     the pages: [{ kind, port, tokenHash, title }]
//   node cdp-eval.mjs <port> text                     the GUI page's body text (first 2000 characters) and its URL facts
//   node cdp-eval.mjs <port> click <element id>       clicks #id on the shell's own screen page (file:// status.html), e.g. the Start button
import { createHash } from "node:crypto";

const [port, cmd, arg] = process.argv.slice(2);
if (!port || !cmd) { console.log(JSON.stringify({ error: "usage: cdp-eval.mjs <port> list|text|click [id]" })); process.exit(2); }

const facts = (url) => {
	const m = /^http:\/\/127\.0\.0\.1:(\d+)\/([0-9a-f]{16,})\/?/.exec(url);
	if (m) return { kind: "gui", port: Number(m[1]), tokenHash: createHash("sha256").update(m[2]).digest("hex").slice(0, 12) };
	if (url.startsWith("file:")) return { kind: "shell-screen" };
	if (url.startsWith("data:")) return { kind: "banner" };
	return { kind: "other" };
};

const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((t) => t.type === "page");
const pages = targets.map((t) => ({ target: t, ...facts(t.url), title: t.title }));
if (cmd === "list") {
	console.log(JSON.stringify({ pages: pages.map(({ target, ...rest }) => rest) }));
	process.exit(0);
}

const want = cmd === "click" ? "shell-screen" : "gui";
const page = pages.find((p) => p.kind === want) ?? pages.find((p) => p.kind === "shell-screen");
if (!page) { console.log(JSON.stringify({ error: `no ${want} page`, pages: pages.map(({ target, ...rest }) => rest) })); process.exit(1); }

const expression = cmd === "click"
	? `(() => { const el = document.getElementById(${JSON.stringify(arg ?? "")}); if (!el) return 'no such element'; el.click(); return 'clicked'; })()`
	: "document.body ? document.body.innerText.slice(0, 2000) : ''";
const ws = new WebSocket(page.target.webSocketDebuggerUrl);
const result = await new Promise((resolve) => {
	const timer = setTimeout(() => resolve({ error: "timeout" }), 10_000);
	ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
	ws.onmessage = (e) => {
		let m;
		try { m = JSON.parse(String(e.data)); } catch { return; }
		if (m.id === 1) { clearTimeout(timer); resolve(m.result?.result ?? { error: JSON.stringify(m.error ?? m) }); }
	};
	ws.onerror = () => { clearTimeout(timer); resolve({ error: "websocket error" }); };
});
ws.close();
const { target, ...rest } = page;
console.log(JSON.stringify({ page: rest, value: result.value, error: result.error }));
process.exit(result.error ? 1 : 0);
