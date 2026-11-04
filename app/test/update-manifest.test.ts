import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { parseStack } from "../src/main/bootstrap/stack.ts";
import { checkCandidate } from "../src/main/update/stack.ts";
import { isPlainFileName, manifestText, parseManifest, sha512Of, verifyShellFile } from "../src/main/update/verify.ts";

// The shell channel's signed manifest (R13-F002): what an installer's or a dmg's signature binds, and that a signature of one kind never verifies as the other. The keys exist for the run only.

const pair = (): { privateKey: KeyObject; publicKey: string } => {
	const made = generateKeyPairSync("ed25519");
	return { privateKey: made.privateKey, publicKey: made.publicKey.export({ type: "spki", format: "der" }).toString("base64") };
};
const A = pair();
const B = pair();
const sign = (bytes: Uint8Array, k: KeyObject = A.privateKey): string => `${cryptoSign(null, bytes, k).toString("base64")}\n`;

const FILE = Buffer.from("an installer");
const NAME = "Setup-0.0.2.exe";
const manifest = (over: Partial<Parameters<typeof manifestText>[0]> = {}): Buffer => Buffer.from(manifestText({ kind: "shell", version: "0.0.2", file: NAME, sha512: sha512Of(FILE), ...over }));
type Input = Parameters<typeof verifyShellFile>[0];
const verdict = (m: Buffer, over: Partial<Input> = {}, k: KeyObject = A.privateKey) =>
	verifyShellFile({ manifest: m, signature: sign(m, k), keys: [A.publicKey, B.publicKey], fileName: NAME, fileSha512: sha512Of(FILE), appVersion: "0.0.1", announcedVersion: "0.0.2", ...over });

describe("verifyShellFile: the order and the rules", () => {
	it("accepts a manifest signed by either key, for this file, at a version above the app's", () => {
		assert.deepEqual(verdict(manifest()), { ok: true, keyIndex: 0, version: "0.0.2" });
		assert.deepEqual(verdict(manifest(), {}, B.privateKey), { ok: true, keyIndex: 1, version: "0.0.2" });
	});

	it("verifies the manifest before it reads it: an unsigned or wrongly signed text is a bad signature, whatever it says", () => {
		const outsider = pair();
		assert.deepEqual(verdict(manifest(), {}, outsider.privateKey), { ok: false, reason: "bad-signature" });
		assert.deepEqual(verdict(Buffer.from("not a manifest"), {}, outsider.privateKey), { ok: false, reason: "bad-signature" });
		assert.deepEqual(verifyShellFile({ manifest: manifest(), signature: "junk", keys: [A.publicKey], fileName: NAME, fileSha512: sha512Of(FILE), appVersion: "0.0.1", announcedVersion: "0.0.2" }), { ok: false, reason: "malformed-signature" });
		assert.deepEqual(verifyShellFile({ manifest: manifest(), signature: sign(manifest()), keys: [], fileName: NAME, fileSha512: sha512Of(FILE), appVersion: "0.0.1", announcedVersion: "0.0.2" }), { ok: false, reason: "no-keys" });
	});

	it("requires the kind to be shell: a signed manifest of any other kind, or text that is no manifest, is refused", () => {
		assert.deepEqual(verdict(manifest({ kind: "stack" })), { ok: false, reason: "bad-manifest" });
		assert.deepEqual(verdict(Buffer.from("signed but not a manifest")), { ok: false, reason: "bad-manifest" });
		assert.deepEqual(verdict(Buffer.from(`${manifest().toString("utf8")}extra: line\n`)), { ok: false, reason: "bad-manifest" });
	});

	it("requires the version to be above the running app's: an older or equal signed version is refused, a pre-release is below its release", () => {
		assert.deepEqual(verdict(manifest({ version: "0.0.1" }), { announcedVersion: "0.0.1" }), { ok: false, reason: "not-newer" });
		assert.deepEqual(verdict(manifest({ version: "0.0.0" }), { announcedVersion: "0.0.0" }), { ok: false, reason: "not-newer" });
		assert.deepEqual(verdict(manifest({ version: "1.0.0-beta.1" }), { announcedVersion: "1.0.0-beta.1", appVersion: "1.0.0" }), { ok: false, reason: "not-newer" });
		assert.equal(verdict(manifest({ version: "1.0.0" }), { announcedVersion: "1.0.0", appVersion: "1.0.0-beta.1" }).ok, true);
	});

	it("takes the version from the signed text, never from latest.yml: an announced version that differs is refused", () => {
		assert.deepEqual(verdict(manifest({ version: "0.0.2" }), { announcedVersion: "9.9.9" }), { ok: false, reason: "bad-manifest" });
	});

	it("binds the file name and the SHA512", () => {
		assert.deepEqual(verdict(manifest(), { fileName: "Other.exe" }), { ok: false, reason: "bad-manifest" });
		assert.deepEqual(verdict(manifest(), { fileSha512: sha512Of(Buffer.from("another file")) }), { ok: false, reason: "hash-mismatch" });
	});
});

describe("the manifest's text", () => {
	it("parses only the exact form it writes", () => {
		const good = manifest();
		assert.deepEqual(parseManifest(good), { kind: "shell", version: "0.0.2", file: NAME, sha512: sha512Of(FILE) });
		const text = good.toString("utf8");
		for (const bad of [
			text.replace("\n", "\r\n"),
			text.trimEnd(),
			text.replace("kind: shell", "kind:shell"),
			text.replace("version: 0.0.2", "version: soon"),
			text.replace(NAME, "../x.exe"),
			text.replace(sha512Of(FILE), "short"),
			text.replace(/^straw-boss-desk-update\/1/, "straw-boss-desk-update/2"),
			text.replace("kind: shell\nversion: 0.0.2", "version: 0.0.2\nkind: shell"),
			"",
		]) assert.equal(parseManifest(Buffer.from(bad)), null, JSON.stringify(bad.slice(0, 60)));
	});

	it("takes a plain file name only", () => {
		for (const ok of ["a.exe", "Straw Boss Desk-0.0.2-arm64.dmg", "名稱.dmg"]) assert.equal(isPlainFileName(ok), true, ok);
		for (const bad of ["", ".", "..", "a/b", "a\\b", "../x", "x\u0000.dmg", "a\nb", "a".repeat(256)]) assert.equal(isPlainFileName(bad), false, JSON.stringify(bad));
	});
});

describe("a signature of one kind is not a signature of the other", () => {
	const stackText = readFileSync(new URL("../../stack.json", import.meta.url), "utf8");
	const active = parseStack(JSON.parse(stackText));
	const newer = Buffer.from(`${JSON.stringify({ ...JSON.parse(stackText), generation: active.generation + 1 }, null, "\t")}\n`);

	it("a signed stack.json fails the installer check, whatever it is presented as", () => {
		const stackSignature = sign(newer);
		assert.deepEqual(verifyShellFile({ manifest: newer, signature: stackSignature, keys: [A.publicKey], fileName: NAME, fileSha512: sha512Of(FILE), appVersion: "0.0.1", announcedVersion: "0.0.2" }), { ok: false, reason: "bad-manifest" });
		// And its signature does not cover an installer manifest for the installer's own bytes either.
		assert.deepEqual(verifyShellFile({ manifest: manifest(), signature: stackSignature, keys: [A.publicKey], fileName: NAME, fileSha512: sha512Of(FILE), appVersion: "0.0.1", announcedVersion: "0.0.2" }), { ok: false, reason: "bad-signature" });
	});

	it("a signed installer manifest fails the stack check", () => {
		const m = manifest();
		const asStack = checkCandidate({ bytes: m, signature: sign(m), keys: [A.publicKey], shellVersion: "0.0.1", active, recipeTools: [] });
		assert.deepEqual(asStack, { kind: "refused", refusal: "invalid" });
		// The installer's own bytes, signed the old way, are not a stack either.
		assert.deepEqual(checkCandidate({ bytes: FILE, signature: sign(FILE), keys: [A.publicKey], shellVersion: "0.0.1", active, recipeTools: [] }), { kind: "refused", refusal: "invalid" });
		// The stack check still takes a stack signed over its bytes.
		assert.equal(checkCandidate({ bytes: newer, signature: sign(newer), keys: [A.publicKey], shellVersion: "0.0.1", active, recipeTools: [] }).kind, "newer");
	});
});

describe("sign-stack.mjs --shell-version writes what the app verifies", () => {
	const dirs: string[] = [];
	after(() => dirs.forEach(removeTree));
	const script = new URL("../../scripts/sign-stack.mjs", import.meta.url).pathname;
	const env = (key: KeyObject) => ({ PATH: process.env.PATH ?? "", SBD_SIGNING_KEY: key.export({ type: "pkcs8", format: "der" }).toString("base64") });

	it("signs an installer into a manifest and its signature that verifyShellFile accepts", () => {
		const dir = mkdtempSync(join(tmpdir(), "sbd-manifest-"));
		dirs.push(dir);
		const file = join(dir, NAME);
		writeFileSync(file, FILE);
		const r = spawnSync(process.execPath, [script, "--shell-version", "0.0.2", file], { env: env(A.privateKey), encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(readdirSync(dir).sort(), [NAME, `${NAME}.manifest`, `${NAME}.manifest.sig`], "no .sig over the installer's bytes, and no .pem");
		const m = readFileSync(`${file}.manifest`);
		assert.deepEqual(m, manifest(), "the script writes the app's text");
		assert.deepEqual(verifyShellFile({ manifest: m, signature: readFileSync(`${file}.manifest.sig`), keys: [A.publicKey], fileName: NAME, fileSha512: sha512Of(FILE), appVersion: "0.0.1", announcedVersion: "0.0.2" }), { ok: true, keyIndex: 0, version: "0.0.2" });
	});
});
