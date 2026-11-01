// Finds a packaged build in app/out/<kind> and reads what the tests assert about it without launching it.
import { getCurrentFuseWire, FuseState, FuseV1Options, pathToFuseFile } from "@electron/fuses";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildIdentity, type BuildKind } from "../../src/main/build.ts";

export const appRoot = join(import.meta.dirname, "..", "..");
export const BUILD_KINDS: readonly BuildKind[] = ["dev", "release"];

export interface Packaged {
	kind: BuildKind;
	productName: string;
	/** The `.app` bundle on macOS, the executable on Windows: what the fuse reader takes. */
	bundle: string;
	executable: string;
	/** The folder holding `resources/app.asar` (macOS: `<bundle>/Contents`). */
	resources: string;
}

export function locatePackaged(kind: BuildKind, platform: NodeJS.Platform = process.platform): Packaged | undefined {
	const productName = buildIdentity({ SBD_BUILD: kind }).productName;
	const out = join(appRoot, "out", kind);
	if (!existsSync(out)) return undefined;
	if (platform === "darwin") {
		const dir = readdirSync(out).find((d) => /^mac(-arm64|-universal)?$/.test(d));
		if (!dir) return undefined;
		const bundle = join(out, dir, `${productName}.app`);
		if (!existsSync(bundle)) return undefined;
		return { kind, productName, bundle, executable: join(bundle, "Contents", "MacOS", productName), resources: join(bundle, "Contents", "Resources") };
	}
	if (platform === "win32") {
		const dir = join(out, "win-unpacked");
		const executable = join(dir, `${productName}.exe`);
		if (!existsSync(executable)) return undefined;
		return { kind, productName, bundle: executable, executable, resources: join(dir, "resources") };
	}
	throw new Error(`no packaged layout for ${platform}`);
}

export type FuseName = keyof typeof FuseV1Options;

/** The fuse wire of the packaged binary, by fuse name ("RunAsNode": "DISABLE"); read from the binary, not from the build config. */
export async function readFuses(bundle: string): Promise<Record<string, string>> {
	const wire = await getCurrentFuseWire(pathToFuseFile(bundle));
	const out: Record<string, string> = {};
	for (const [name, index] of Object.entries(FuseV1Options)) {
		if (typeof index !== "number") continue;
		const state = (wire as unknown as Record<number, number>)[index];
		out[name] = state === undefined ? "ABSENT" : String(FuseState[state as FuseState]);
	}
	return out;
}

/** One file from an asar archive (header: 4, header size, payload size, JSON length, JSON; file data follows the header). */
export function readAsarFile(asarPath: string, file: string): Buffer {
	const buf = readFileSync(asarPath);
	const headerSize = buf.readUInt32LE(4);
	const jsonLength = buf.readUInt32LE(12);
	const header = JSON.parse(buf.toString("utf8", 16, 16 + jsonLength)) as AsarDir;
	let node: AsarNode = header;
	for (const part of file.split("/")) {
		const next: AsarNode | undefined = "files" in node ? node.files[part] : undefined;
		if (!next) throw new Error(`${file} is not in ${asarPath}`);
		node = next;
	}
	if (!("offset" in node)) throw new Error(`${file} in ${asarPath} is not a packed file`);
	const start = 8 + headerSize + Number(node.offset);
	return buf.subarray(start, start + node.size);
}

type AsarNode = AsarDir | AsarFile;
interface AsarDir { files: Record<string, AsarNode> }
interface AsarFile { size: number; offset: string }
