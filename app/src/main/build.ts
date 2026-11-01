// The two build kinds. Only SBD_BUILD=release makes the shipped product; any other build is a development build with its own name,
// so its macOS Keychain item ("<product> Safe Storage") and its application id never collide with an installed app on the same machine.

export type BuildKind = "dev" | "release";

export interface BuildIdentity {
	kind: BuildKind;
	productName: string;
	appId: string;
}

const RELEASE: BuildIdentity = { kind: "release", productName: "Straw Boss Desk", appId: "tw.wayneh.straw-boss-desk" };
const DEV: BuildIdentity = { kind: "dev", productName: "Straw Boss Desk Dev", appId: "tw.wayneh.straw-boss-desk.dev" };

export function buildIdentity(env: Readonly<Record<string, string | undefined>>): BuildIdentity {
	return env.SBD_BUILD === "release" ? RELEASE : DEV;
}

/** The identity a running app derives from its own product name (package.json `productName`, set by the build script). */
export function identityFromProductName(productName: string): BuildIdentity {
	return productName === RELEASE.productName ? RELEASE : DEV;
}
