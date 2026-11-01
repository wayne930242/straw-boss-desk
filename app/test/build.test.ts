import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildIdentity, identityFromProductName } from "../src/main/build.ts";
import { packPlan } from "../scripts/build-config.ts";

const appRoot = join(import.meta.dirname, "..");
const readJson = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(appRoot, name), "utf8"));

describe("SBD_BUILD", () => {
	it("makes the shipped product only for exactly `release`", () => {
		assert.deepEqual(buildIdentity({ SBD_BUILD: "release" }), { kind: "release", productName: "Straw Boss Desk", appId: "dev.straw-boss-desk" });
	});

	it("names every other build Straw Boss Desk Dev with the .dev application id", () => {
		for (const env of [{}, { SBD_BUILD: "" }, { SBD_BUILD: "dev" }, { SBD_BUILD: "Release" }, { SBD_BUILD: "release " }, { SBD_BUILD: "1" }]) {
			assert.deepEqual(buildIdentity(env), { kind: "dev", productName: "Straw Boss Desk Dev", appId: "dev.straw-boss-desk.dev" }, JSON.stringify(env));
		}
	});

	it("reads the identity back from a running app's product name", () => {
		assert.equal(identityFromProductName("Straw Boss Desk").kind, "release");
		assert.equal(identityFromProductName("Straw Boss Desk Dev").kind, "dev");
		assert.equal(identityFromProductName("anything else").kind, "dev");
	});

	it("passes the pack script the product name, application id, package.json name, and a per-kind output folder", () => {
		const dev = packPlan({});
		assert.equal(dev.outputDir, "out/dev");
		assert.deepEqual(dev.configArgs, [
			"-c.productName=Straw Boss Desk Dev", "-c.appId=dev.straw-boss-desk.dev", "-c.extraMetadata.productName=Straw Boss Desk Dev", "-c.directories.output=out/dev",
		]);
		const release = packPlan({ SBD_BUILD: "release" });
		assert.equal(release.outputDir, "out/release");
		assert.ok(release.configArgs.includes("-c.productName=Straw Boss Desk"));
		assert.ok(release.configArgs.includes("-c.appId=dev.straw-boss-desk"));
	});

	it("defaults the checked-in files to the development build, so a plain electron-builder run cannot make the shipped product", () => {
		const builder = readJson("electron-builder.json");
		assert.equal(builder.productName, "Straw Boss Desk Dev");
		assert.equal(builder.appId, "dev.straw-boss-desk.dev");
		assert.equal(readJson("package.json").productName, "Straw Boss Desk Dev");
	});
});
