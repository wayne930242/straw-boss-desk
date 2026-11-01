// Fixtures that write to the user's registry on Windows: a scratch key under HKCU\Software (the type, entries, and removal rules of UserPath), and the
// real HKCU\Environment (one add and remove that must return the value byte for byte). Hosted runner only: locally they skip with a named reason.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createWinLocate, createWinUserPath } from "../../src/main/platform/win.ts";
import type { CommandRunner } from "../../src/main/platform/types.ts";
import { defineFixture, type FixtureIO } from "./hosted.ts";

const system32 = (file: string): string => `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\${file}`;

async function reg(io: FixtureIO, args: string[]): Promise<{ code: number | null; stdout: string }> {
	const r = await io.run(system32("reg.exe"), args, { timeoutMs: 20_000 });
	return { code: r.code, stdout: r.stdout };
}

const seed = async (io: FixtureIO, sub: string, kind: "REG_EXPAND_SZ" | "REG_SZ", value: string): Promise<void> => {
	const r = await reg(io, ["add", `HKCU\\${sub}`, "/v", "Path", "/t", kind, "/d", value, "/f"]);
	assert.equal(r.code, 0, `seeding the scratch key exited ${r.code}`);
};

export const userPathScratchKey = defineFixture({
	name: "UserPath against a scratch registry key: type and %VAR% entries kept, only the exact entry removed, an emptied value deleted",
	platforms: ["win32"],
	async body(io: FixtureIO): Promise<void> {
		const sub = `Software\\StrawBossDeskTest-${randomBytes(5).toString("hex")}`;
		const run: CommandRunner = (file, args, options) => io.run(file, args, options);
		const userPath = createWinUserPath({ run, locate: createWinLocate(), key: sub, broadcast: false });
		const shims = "C:\\Users\\測試PM\\AppData\\Local\\sbd 測試\\tools\\shims";
		const original = "%USERPROFILE%\\bin;C:\\Tools\\;%SystemRoot%\\system32;C:\\Users\\測試PM\\bin";
		try {
			await seed(io, sub, "REG_EXPAND_SZ", original);
			assert.deepEqual(await userPath.read(), { kind: "ExpandString", value: original }, "the value is read unexpanded, with its type");

			assert.deepEqual(await userPath.ensureFirst(shims), { changed: true });
			assert.deepEqual(await userPath.read(), { kind: "ExpandString", value: `${shims};${original}` }, "added first; type and every other entry as written");
			assert.deepEqual(await userPath.ensureFirst(shims), { changed: false });
			assert.deepEqual(await userPath.ensureFirst(`${shims.toUpperCase()}\\`), { changed: false }, "case and a trailing backslash do not make another entry");

			assert.deepEqual(await userPath.remove(shims), { changed: true });
			assert.deepEqual(await userPath.read(), { kind: "ExpandString", value: original }, "removed again: the value is what it was");
			assert.deepEqual(await userPath.remove(shims), { changed: false });

			assert.deepEqual(await userPath.remove("c:\\tools"), { changed: true });
			assert.deepEqual(await userPath.read(), { kind: "ExpandString", value: "%USERPROFILE%\\bin;%SystemRoot%\\system32;C:\\Users\\測試PM\\bin" }, "only the exact entry went, whatever its case or trailing backslash");
			assert.deepEqual(await userPath.remove("%USERPROFILE%\\bin"), { changed: true });
			assert.deepEqual(await userPath.read(), { kind: "ExpandString", value: "%SystemRoot%\\system32;C:\\Users\\測試PM\\bin" }, "a %VAR% entry is its own text, never expanded");

			// A REG_SZ value stays REG_SZ.
			await seed(io, sub, "REG_SZ", "C:\\a;C:\\b");
			await userPath.ensureFirst(shims);
			assert.deepEqual(await userPath.read(), { kind: "String", value: `${shims};C:\\a;C:\\b` });
			await userPath.remove(shims);
			assert.deepEqual(await userPath.read(), { kind: "String", value: "C:\\a;C:\\b" });

			// The only entry: removing it deletes the value, and adding to a missing value creates a REG_EXPAND_SZ one.
			await reg(io, ["delete", `HKCU\\${sub}`, "/v", "Path", "/f"]);
			assert.equal(await userPath.read(), null);
			assert.deepEqual(await userPath.ensureFirst(shims), { changed: true });
			assert.deepEqual(await userPath.read(), { kind: "ExpandString", value: shims });
			assert.deepEqual(await userPath.remove(shims), { changed: true });
			assert.equal(await userPath.read(), null, "the value is gone, not left empty");
		} finally {
			await reg(io, ["delete", `HKCU\\${sub}`, "/f"]);
		}
	},
});

export const hkcuEnvironment = defineFixture({
	name: "UserPath on the real HKCU\\Environment: one add and one remove return the value byte for byte",
	platforms: ["win32"],
	async body(io: FixtureIO): Promise<void> {
		const run: CommandRunner = (file, args, options) => io.run(file, args, options);
		const userPath = createWinUserPath({ run, locate: createWinLocate() });
		const entry = `C:\\sbd-test-${randomBytes(5).toString("hex")}\\tools\\shims`;
		const raw = async () => {
			const r = await reg(io, ["query", "HKCU\\Environment", "/v", "Path"]);
			return r.code === 0 ? r.stdout : "absent";
		};
		const before = { api: await userPath.read(), raw: await raw() };
		try {
			assert.deepEqual(await userPath.ensureFirst(entry), { changed: true });
			const during = await userPath.read();
			assert.ok(during !== null && during.value.split(";")[0] === entry, "the entry is first");
			assert.equal(during.kind, before.api?.kind ?? "ExpandString", "the type is kept");
		} finally {
			await userPath.remove(entry);
		}
		assert.deepEqual(await userPath.read(), before.api, "the same value and type as before");
		assert.equal(await raw(), before.raw, "and the same bytes as reg.exe sees them");
	},
});
