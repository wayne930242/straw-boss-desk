import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { currentLocale, pickLocale } from "../src/shared/locale.ts";

describe("pickLocale", () => {
	it("takes English for English tags and for nothing", () => {
		assert.equal(pickLocale(["en-US"]), "en");
		assert.equal(pickLocale(["en_GB"]), "en");
		assert.equal(pickLocale([]), "en");
		assert.equal(pickLocale(["fr-FR", "de"]), "en");
	});

	it("takes Traditional Chinese for every Traditional tag", () => {
		for (const tag of ["zh-TW", "zh_TW", "zh-Hant", "zh-Hant-TW", "zh-HK", "zh-MO", "zh", "ZH-tw"]) assert.equal(pickLocale([tag]), "zh-TW", tag);
	});

	it("skips Simplified Chinese to the next language", () => {
		for (const tag of ["zh-CN", "zh-Hans", "zh-Hans-CN", "zh-SG"]) {
			assert.equal(pickLocale([tag]), "en", tag);
			assert.equal(pickLocale([tag, "zh-TW"]), "zh-TW", tag);
		}
	});

	it("follows the order of the list", () => {
		assert.equal(pickLocale(["en-US", "zh-TW"]), "en");
		assert.equal(pickLocale(["fr", "zh-TW", "en"]), "zh-TW");
	});
});

describe("currentLocale (T9-F003)", () => {
	it("asks main instead of trusting the language the window opened with", async () => {
		assert.equal(await currentLocale({ locale: "zh-TW", getLocale: async () => "en" }), "en");
		assert.equal(await currentLocale({ locale: "en", getLocale: async () => "zh-TW" }), "zh-TW");
	});

	it("falls back to the argument when main does not answer or answers something else", async () => {
		assert.equal(await currentLocale({ locale: "zh-TW", getLocale: () => Promise.reject(new Error("gone")) }), "zh-TW");
		assert.equal(await currentLocale({ locale: "en", getLocale: async () => "fr" as never }), "en");
	});
});
