// Test code: other released versions of gh and bun, for the anchors that change a pin (task 5): the new version installs beside the old one. SHA256 values
// are from the releases' own checksum files (gh_2.103.2_checksums.txt; bun-v1.2.22 SHASUMS256.txt). The same asset shapes as stack.json.
import type { PlatformKey } from "../../src/main/bootstrap/stack.ts";

interface Pin { version: string; url: string; sha256: string; file: string }

const gh = (file: string, sha256: string): Pin => ({ version: "2.103.2", url: `https://github.com/cli/cli/releases/download/v2.103.2/${file}`, sha256, file });
const bun = (file: string, sha256: string): Pin => ({ version: "1.2.22", url: `https://github.com/oven-sh/bun/releases/download/bun-v1.2.22/${file}`, sha256, file });

const node = (file: string, sha256: string): Pin => ({ version: "24.22.2", url: `https://nodejs.org/dist/v24.22.2/${file}`, sha256, file });
// Git for the update anchor (task 13): an earlier release of the same pins. The Windows hash is the SHA256 of the downloaded PortableGit; the macOS ones match the `.sha256` files of dugite-native v2.56.0-1.
const gitWin = (file: string, sha256: string): Pin => ({ version: "2.56.0.2", url: `https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/${file}`, sha256, file });
const gitMac = (file: string, sha256: string): Pin => ({ version: "2.56.0-1", url: `https://github.com/desktop/dugite-native/releases/download/v2.56.0-1/${file}`, sha256, file });

export const ALT_GH_VERSION = "2.103.2";
// A newer Node than stack.json's 24.22.1, so the Updates card's change list reads as an update (SA-T13-1); the other alternates are earlier releases.
export const ALT_NODE_VERSION = "24.22.2";
export const ALT_GIT_VERSION_WIN = "2.56.0.2";
export const ALT_GIT_VERSION_MAC = "2.56.0-1";
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

// SHA256 values from nodejs.org's SHASUMS256.txt of v24.22.2.
export const ALT_NODE: Record<PlatformKey, Pin> = {
	"win32-x64": node("node-v24.22.2-win-x64.zip", "ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2"),
	"darwin-arm64": node("node-v24.22.2-darwin-arm64.tar.gz", "aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a"),
	"darwin-x64": node("node-v24.22.2-darwin-x64.tar.gz", "d5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52"),
};

export const ALT_GIT: Record<PlatformKey, Pin> = {
	"win32-x64": gitWin("PortableGit-2.56.0.2-64-bit.7z.exe", "075e158ef8e1f0ab80b347e245405d3eca735c2dc88fd8e032e137d0ca61f61b"),
	"darwin-arm64": gitMac("dugite-native-v2.56.0-7ce66f8-macOS-arm64.tar.gz", "ab756ab9a15241f14b6c0a0386c704a998bb710a837ab35dc55d4747a90f2ca0"),
	"darwin-x64": gitMac("dugite-native-v2.56.0-7ce66f8-macOS-x64.tar.gz", "f294895790a98405b2900d55160945d4d0ce92492891aac4b95f2c7085220fa3"),
};

/** `stack` with gh and/or bun pinned to the other release, for every platform key. */
export function altStack<T extends { tools: Record<string, any>; optionalTools: Record<string, any> }>(stack: T, which: { gh?: boolean; bun?: boolean; node?: boolean; git?: boolean }): T {
	const copy = structuredClone(stack);
	if (which.gh) copy.tools.gh = { ...copy.tools.gh, assets: Object.fromEntries(Object.entries(ALT_GH)) };
	if (which.node) copy.tools.node = { ...copy.tools.node, assets: Object.fromEntries(Object.entries(ALT_NODE)) };
	if (which.git) copy.tools.git = { ...copy.tools.git, assets: Object.fromEntries(Object.entries(ALT_GIT)) };
	if (which.bun) copy.optionalTools.bun = { ...copy.optionalTools.bun, assets: Object.fromEntries(Object.entries(ALT_BUN)) };
	return copy;
}
