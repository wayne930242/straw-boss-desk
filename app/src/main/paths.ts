import { join } from "node:path";

// The app data root. Task 3 grows this module into the full layout with its checks; the skeleton needs only the root and Chromium's folder.

export interface RootInput {
	env: Readonly<Record<string, string | undefined>>;
	argv: readonly string[];
	platform: NodeJS.Platform;
	home: string;
}

/** `--root=<dir>` wins over `STRAW_BOSS_DESK_ROOT`, which wins over the platform default. Honored in every build. */
export function dataRoot({ env, argv, platform, home }: RootInput): string {
	const fromArg = argv.find((a) => a.startsWith("--root="))?.slice("--root=".length);
	const override = fromArg || env.STRAW_BOSS_DESK_ROOT;
	if (override) return override;
	if (platform === "win32") {
		const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
		return join(local, "straw-boss-desk");
	}
	if (platform === "darwin") return join(home, "Library", "Application Support", "straw-boss-desk");
	throw new Error(`unsupported platform ${platform}; set STRAW_BOSS_DESK_ROOT to run a development build`);
}

/** Chromium's profile and caches (`app.setPath("userData")`); nothing lands in the roaming %APPDATA%. */
export const electronDir = (root: string): string => join(root, "electron");
