import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dialogTitle, externalLink, guiOriginOf, guiPortOf, isGuiUrl, permissionAllowed } from "../src/main/page-security.ts";
import { credUrl } from "./harness/cred-url.ts";

// The allow rule of **Window and page security** (task 8b anchor): every listed case, as the pure function the wiring calls. The e2e test checks only that the wiring calls it.

const GUI_PORT = 41234;

describe("the preview-link allow rule", () => {
	it("opens localhost, 127.0.0.1 and [::1] on 8080 and on 8100, with the parsed href", () => {
		for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
			for (const port of [8080, 8090, 8100]) {
				const raw = `http://${host}:${port}/`;
				assert.deepEqual(externalLink(raw, GUI_PORT), { open: true, href: raw }, raw);
			}
		}
	});

	it("passes the parsed href, not the text it was given", () => {
		assert.deepEqual(externalLink("HTTP://LOCALHOST:8080/a b?x=1#y", GUI_PORT), { open: true, href: "http://localhost:8080/a%20b?x=1#y" });
	});

	it("refuses a port outside the range, and no port", () => {
		assert.deepEqual(externalLink("http://localhost:8079/", GUI_PORT), { open: false, reason: "port" });
		assert.deepEqual(externalLink("http://127.0.0.1:8101/", GUI_PORT), { open: false, reason: "port" });
		assert.deepEqual(externalLink("http://[::1]:8101/", GUI_PORT), { open: false, reason: "port" });
		assert.deepEqual(externalLink("http://localhost/", GUI_PORT), { open: false, reason: "port" });
		assert.deepEqual(externalLink("http://localhost:80/", GUI_PORT), { open: false, reason: "port" }, "an explicit default port reads as none");
		assert.deepEqual(externalLink("http://localhost:0/", GUI_PORT), { open: false, reason: "port" });
	});

	it("refuses a user name or password, built at run time", () => {
		assert.deepEqual(externalLink(credUrl("http://user<c>pw@localhost:8080/"), GUI_PORT), { open: false, reason: "credentials" });
		assert.deepEqual(externalLink("http://localhost@evil.test:8080/", GUI_PORT), { open: false, reason: "credentials" });
		assert.deepEqual(externalLink(credUrl("https://user<c>pw@example.com/"), GUI_PORT), { open: false, reason: "credentials" }, "also on https");
	});

	it("refuses every other host", () => {
		for (const raw of ["http://localhost.evil.test:8080/", "http://localhost.:8080/", "http://0.0.0.0:8080/", "http://192.168.1.5:8080/", "http://example.com:8080/", "http://[::2]:8080/", "http://127.0.0.2:8080/"]) {
			assert.deepEqual(externalLink(raw, GUI_PORT), { open: false, reason: "host" }, raw);
		}
	});

	it("refuses every other scheme and text that is not a URL", () => {
		for (const raw of ["ftp://localhost:8080/", "file:///etc/hosts", "javascript:alert(1)", "data:text/html,x", "ws://localhost:8080/", "mailto:a@b.c"]) {
			assert.deepEqual(externalLink(raw, GUI_PORT), { open: false, reason: "scheme" }, raw);
		}
		for (const raw of ["", "not a url", "localhost:8080", "//localhost:8080/"]) assert.equal(externalLink(raw, GUI_PORT).open, false, raw);
	});

	it("refuses the GUI's own listener on all three loopback hosts, even when its port lies in the range", () => {
		for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
			assert.deepEqual(externalLink(`http://${host}:8085/`, 8085), { open: false, reason: "gui-origin" }, host);
			assert.equal(externalLink(`http://${host}:8086/`, 8085).open, true, `${host}: another port in the range still opens`);
		}
		assert.equal(externalLink("http://localhost:8085/", null).open, true, "with no GUI loaded nothing is the GUI");
	});

	it("still opens https links, and reads the GUI port off an address", () => {
		assert.deepEqual(externalLink("https://example.com/a?b=1", GUI_PORT), { open: true, href: "https://example.com/a?b=1" });
		assert.equal(externalLink("https://127.0.0.1:8085/", 8085).open, true, "https on the GUI's port is not the GUI, which speaks http");
		assert.equal(guiPortOf("http://127.0.0.1:41234/abc/"), 41234);
		assert.equal(guiPortOf(null), null);
		assert.equal(guiPortOf("nope"), null);
	});
});

describe("the GUI's origin", () => {
	it("is an http URL on 127.0.0.1 with a port, and nothing else", () => {
		assert.equal(guiOriginOf("http://127.0.0.1:41234/token/"), "http://127.0.0.1:41234");
		for (const raw of ["http://localhost:41234/", "https://127.0.0.1:41234/", "http://127.0.0.1/", "file:///x", "nope"]) assert.equal(guiOriginOf(raw), null, raw);
	});

	it("tells its own pages from every other", () => {
		const origin = "http://127.0.0.1:41234";
		assert.equal(isGuiUrl("http://127.0.0.1:41234/abc/w/1", origin), true);
		for (const raw of ["http://127.0.0.1:41235/", "http://localhost:41234/", "https://127.0.0.1:41234/", "file:///x", "nope"]) assert.equal(isGuiUrl(raw, origin), false, raw);
		assert.equal(isGuiUrl("http://127.0.0.1:41234/", null), false);
	});
});

describe("permissions", () => {
	const origin = "http://127.0.0.1:41234";
	it("grants the camera to the GUI origin and nothing else", () => {
		assert.equal(permissionAllowed("media", `${origin}/abc/`, ["video"], origin), true);
		assert.equal(permissionAllowed("media", `${origin}/abc/`, ["video", "audio"], origin), false, "the microphone is refused");
		assert.equal(permissionAllowed("media", `${origin}/abc/`, ["audio"], origin), false);
		assert.equal(permissionAllowed("media", `${origin}/abc/`, undefined, origin), false);
		assert.equal(permissionAllowed("media", `${origin}/abc/`, [], origin), false);
		assert.equal(permissionAllowed("media", "file:///app/screen.html", ["video"], origin), false, "the shell page gets none");
		assert.equal(permissionAllowed("media", "https://example.com/", ["video"], origin), false);
		for (const permission of ["geolocation", "notifications", "clipboard-read", "midi", "openExternal", "fullscreen", "pointerLock", "display-capture"]) {
			assert.equal(permissionAllowed(permission, `${origin}/abc/`, ["video"], origin), false, permission);
		}
		assert.equal(permissionAllowed("media", `${origin}/abc/`, ["video"], null), false, "no GUI loaded");
	});
});

describe("the dialog's title", () => {
	it("keeps a plain title, cuts a long one, strips control characters, and drops what is not text", () => {
		assert.equal(dialogTitle("Choose a folder"), "Choose a folder");
		assert.equal(dialogTitle("a\u0000b\nc"), "a b c");
		assert.equal(dialogTitle("x".repeat(500))?.length, 200);
		assert.equal(dialogTitle("   "), undefined);
		for (const raw of [undefined, null, 5, {}, ["a"]]) assert.equal(dialogTitle(raw), undefined);
	});
});
