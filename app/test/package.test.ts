import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const appRoot = join(import.meta.dirname, "..");
const readJson = (name: string) => JSON.parse(readFileSync(join(appRoot, name), "utf8")) as Record<string, any>;
const pkg = readJson("package.json");

describe("package.json", () => {
	it("pins the toolchain the spec names", () => {
		assert.equal(pkg.devDependencies.electron, "45.0.0");
		assert.equal(pkg.devDependencies.typescript, "7.0.2");
		assert.equal(pkg.devDependencies["electron-builder"], "26.18.0");
		assert.match(pkg.devDependencies["playwright-core"], /^\d+\.\d+\.\d+$/);
	});

	it("pins every dependency to an exact version", () => {
		for (const group of ["dependencies", "devDependencies"]) {
			for (const [name, version] of Object.entries<string>(pkg[group] ?? {})) assert.match(version, /^\d+\.\d+\.\d+$/, `${group}.${name}`);
		}
	});

	it("has no runtime dependency besides electron-updater", () => {
		const allowed = new Set(["electron-updater"]);
		for (const name of Object.keys(pkg.dependencies ?? {})) assert.ok(allowed.has(name), `${name} is a runtime dependency`);
	});

	it("is an ES module whose main is the compiled entry", () => {
		assert.equal(pkg.type, "module");
		assert.equal(pkg.main, "dist/main/index.js");
	});
});

describe("electron-builder.json", () => {
	const builder = readJson("electron-builder.json");

	it("turns RunAsNode and the NODE_OPTIONS variable off and keeps the inspect arguments on", () => {
		assert.deepEqual(builder.electronFuses, { runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: true });
	});

	it("builds a per-user NSIS installer that never asks for elevation", () => {
		assert.equal(builder.nsis.perMachine, false);
		assert.equal(builder.nsis.allowElevation, false);
	});

	it("packs only the compiled app", () => {
		assert.deepEqual(builder.files, ["dist/**/*", "package.json"]);
	});

	it("ad-hoc signs the macOS app, which Apple Silicon needs to run it", () => {
		assert.equal(builder.mac.identity, "-");
		assert.equal(builder.mac.hardenedRuntime, false);
	});
});
