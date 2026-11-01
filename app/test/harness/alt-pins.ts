// Test code: other released versions of gh and bun, for the anchors that change a pin (task 5): the new version installs beside the old one. SHA256 values
// are from the releases' own checksum files (gh_2.103.2_checksums.txt; bun-v1.2.22 SHASUMS256.txt). The same asset shapes as stack.json.
import type { PlatformKey } from "../../src/main/bootstrap/stack.ts";

interface Pin { version: string; url: string; sha256: string; file: string }

const gh = (file: string, sha256: string): Pin => ({ version: "2.103.2", url: `https://github.com/cli/cli/releases/download/v2.103.2/${file}`, sha256, file });
const bun = (file: string, sha256: string): Pin => ({ version: "1.2.22", url: `https://github.com/oven-sh/bun/releases/download/bun-v1.2.22/${file}`, sha256, file });

export const ALT_GH_VERSION = "2.103.2";
export const ALT_BUN_VERSION = "1.2.22";

export const ALT_GH: Record<PlatformKey, Pin> = {
	"win32-x64": gh("gh_2.103.2_windows_amd64.zip", "fef9fcdd8fdabd0501ab8b3d99eac976f504ab55d01bef9e8ef428a5d900ddda"),
	"darwin-arm64": gh("gh_2.103.2_macOS_arm64.zip", "5416000f5d17580a187339e0c4068a01ca5c87f7d4fe6ca64933696f967bc418"),
	"darwin-x64": gh("gh_2.103.2_macOS_amd64.zip", "2dc7f1fc4761f96732995f6e4f4c6b4d705f2635da4126620c8b30eaa67b9c98"),
};

export const ALT_BUN: Record<PlatformKey, Pin> = {
	"win32-x64": bun("bun-windows-x64-baseline.zip", "c44de73dc21c7140a8e15883c28abed60612196faaec9a60c275534280a49f59"),
	"darwin-arm64": bun("bun-darwin-aarch64.zip", "eb8c7e09cbea572414a0a367848e1acbf05294a946a594405a014b1fb3b3fc76"),
	"darwin-x64": bun("bun-darwin-x64-baseline.zip", "e7c1a0b61b6466c6da2a725b3c51864fa050a262d2489f1a109f27364c743272"),
};

/** `stack` with gh and/or bun pinned to the other release, for every platform key. */
export function altStack<T extends { tools: Record<string, any>; optionalTools: Record<string, any> }>(stack: T, which: { gh?: boolean; bun?: boolean }): T {
	const copy = structuredClone(stack);
	if (which.gh) copy.tools.gh = { ...copy.tools.gh, assets: Object.fromEntries(Object.entries(ALT_GH)) };
	if (which.bun) copy.optionalTools.bun = { ...copy.optionalTools.bun, assets: Object.fromEntries(Object.entries(ALT_BUN)) };
	return copy;
}
