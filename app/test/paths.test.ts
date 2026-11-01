import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { dataRoot, electronDir } from "../src/main/paths.ts";

describe("dataRoot", () => {
	it("defaults per platform", () => {
		assert.equal(dataRoot({ env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, argv: [], platform: "win32", home: "C:\\Users\\a" }), join("C:\\Users\\a\\AppData\\Local", "straw-boss-desk"));
		assert.equal(dataRoot({ env: {}, argv: [], platform: "darwin", home: "/Users/a" }), join("/Users/a", "Library", "Application Support", "straw-boss-desk"));
	});

	it("honors STRAW_BOSS_DESK_ROOT and --root= in every build, the argument first", () => {
		const base = { platform: "darwin" as const, home: "/Users/a" };
		assert.equal(dataRoot({ ...base, env: { STRAW_BOSS_DESK_ROOT: "/tmp/sbd 測試" }, argv: [] }), "/tmp/sbd 測試");
		assert.equal(dataRoot({ ...base, env: { STRAW_BOSS_DESK_ROOT: "/tmp/a" }, argv: ["--root=/tmp/b"] }), "/tmp/b");
		assert.equal(dataRoot({ ...base, env: { STRAW_BOSS_DESK_ROOT: "" }, argv: [] }), join("/Users/a", "Library", "Application Support", "straw-boss-desk"));
	});

	it("falls back to the profile's AppData when LOCALAPPDATA is not set", () => {
		assert.equal(dataRoot({ env: {}, argv: [], platform: "win32", home: "C:\\Users\\a" }), join("C:\\Users\\a", "AppData", "Local", "straw-boss-desk"));
	});

	it("refuses a platform it does not support instead of guessing a folder", () => {
		assert.throws(() => dataRoot({ env: {}, argv: [], platform: "linux", home: "/home/a" }), /unsupported platform linux/);
		assert.equal(dataRoot({ env: { STRAW_BOSS_DESK_ROOT: "/tmp/x" }, argv: [], platform: "linux", home: "/home/a" }), "/tmp/x");
	});

	it("keeps Chromium's profile inside the root", () => {
		assert.equal(electronDir("/r/sbd 測試"), join("/r/sbd 測試", "electron"));
	});
});
