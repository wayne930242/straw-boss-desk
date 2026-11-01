import type { CommandRunner, Platform } from "./types.ts";
import { createMac } from "./mac.ts";
import { createWin } from "./win.ts";

export * from "./types.ts";

export interface PlatformOptions {
	platform?: NodeJS.Platform;
	/** Replaces the process runner, for a test or to point calls at a scratch HOME. */
	run?: CommandRunner;
	log?: (line: string) => void;
}

/** The four platform concerns for this OS. Anything but Windows and macOS fails here, not later inside a stage. */
export function createPlatform(options: PlatformOptions = {}): Platform {
	const platform = options.platform ?? process.platform;
	const rest = { ...(options.run ? { run: options.run } : {}), ...(options.log ? { log: options.log } : {}) };
	if (platform === "win32") return createWin(rest);
	if (platform === "darwin") return createMac(rest);
	throw new Error(`unsupported platform ${platform}`);
}
