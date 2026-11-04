import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
			// The one runtime dependency is the shell updater (task 13); it ships inside the asar with its own dependencies.
			assert.deepEqual(meta.dependencies, { "electron-updater": (JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies["electron-updater"] });
			assert.ok(readAsarFile(join(packaged.resources, "app.asar"), "node_modules/electron-updater/package.json").length > 0, "electron-updater is in the package");
		});

		// electron-builder writes resources/app-update.yml only for the dmg, zip and NSIS targets, never for a `--dir` pack; the publish arguments themselves are asserted in build.test.ts,
		// and the guarded Windows install fixture proves the installed copy. Here a file that is present must be the GitHub feed, and the development build must have none.
		it(kind === "release" ? "has no update feed other than GitHub's" : "carries no update feed of its own: the tests set one at run time", () => {
			const file = join(packaged.resources, "app-update.yml");
			if (kind === "dev") return assert.equal(existsSync(file), false);
			if (!existsSync(file)) return;
			const text = readFileSync(file, "utf8");
			assert.match(text, /^provider: github$/m);
			assert.match(text, /^owner: wayne930242$/m);
			assert.match(text, /^repo: straw-boss-desk$/m);
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
