import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BUILD_KINDS, locatePackaged, readAsarFile, readFuses } from "./harness/packaged.ts";

// Reads the packaged binaries in out/dev and out/release without launching them. A kind that was not packed is skipped with a named reason,
// and fails when SBD_REQUIRE_PACKAGED=1 (CI packs both before it runs these).
const required = process.env.SBD_REQUIRE_PACKAGED === "1";

for (const kind of BUILD_KINDS) {
	const packaged = locatePackaged(kind);
	if (!packaged) {
		const reason = `no packaged ${kind} build in app/out/${kind} (run npm run pack -- --dir${kind === "release" ? " with SBD_BUILD=release" : ""})`;
		if (required) it(`packaged ${kind} build exists`, () => assert.fail(reason));
		else it(`packaged ${kind} build`, { skip: reason }, () => {});
		continue;
	}

	describe(`packaged ${kind} build`, () => {
		it("has RunAsNode and EnableNodeOptionsEnvironmentVariable off, read from the binary", async () => {
			const fuses = await readFuses(packaged.bundle);
			assert.equal(fuses.RunAsNode, "DISABLE");
			assert.equal(fuses.EnableNodeOptionsEnvironmentVariable, "DISABLE");
			// The Playwright driver needs the inspect arguments; the spec keeps them on until signing.
			assert.equal(fuses.EnableNodeCliInspectArguments, "ENABLE");
		});

		it("reports the product name of its build kind from its own package.json", () => {
			const meta = JSON.parse(readAsarFile(join(packaged.resources, "app.asar"), "package.json").toString("utf8")) as Record<string, unknown>;
			assert.equal(meta.productName, kind === "release" ? "Straw Boss Desk" : "Straw Boss Desk Dev");
			assert.equal(packaged.productName, meta.productName);
			assert.equal(meta.main, "dist/main/index.js");
			assert.equal(meta.dependencies, undefined);
		});

		it("ships the compiled app and its shell page", () => {
			const asar = join(packaged.resources, "app.asar");
			for (const file of ["dist/main/index.js", "dist/preload/shell.cjs", "dist/preload/gui.cjs", "dist/renderer/wizard.html", "dist/renderer/wizard.js", "dist/renderer/wizard.css", "dist/renderer/desk.css", "dist/renderer/desk-tokens.css", "dist/renderer/settings.html", "dist/renderer/settings.js", "dist/renderer/settings.css", "dist/assets/recipe/validate.mjs", "dist/assets/recipe/secret-patterns.json", "dist/assets/stack.json", "dist/renderer/screen.html", "dist/renderer/screen.js", "dist/renderer/screen.css", "dist/renderer/i18n/zh-TW.js", "dist/assets/secret-patterns.json"]) {
				assert.ok(readAsarFile(asar, file).length > 0, file);
			}
		});

		it("tells macOS why it wants the camera (Straw Link's QR join), in the Info.plist", { skip: process.platform === "darwin" ? false : "macOS only" }, () => {
			const r = spawnSync("plutil", ["-extract", "NSCameraUsageDescription", "raw", join(packaged.bundle, "Contents", "Info.plist")], { encoding: "utf8" });
			assert.equal(r.status, 0, r.stderr);
			assert.match(r.stdout, /camera/i);
		});

		it("is ad-hoc signed and verifies on macOS", { skip: process.platform === "darwin" ? false : "macOS only" }, () => {
			const r = spawnSync("codesign", ["--verify", "--deep", "--strict", packaged.bundle], { encoding: "utf8" });
			assert.equal(r.status, 0, r.stderr);
		});
	});
}
