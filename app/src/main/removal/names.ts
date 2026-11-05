import { createHash } from "node:crypto";

// The two macOS Keychain items **Remove all data** deletes by name (spec: Secrets, Uninstall and data; invariant "macOS Safe Storage"). Both names are computed, never typed: a string constant for
// the product would let a development build delete the shipped app's item.

/**
 * Chromium's Keychain item for `safeStorage`: "`<product>` Safe Storage", named after the running build's product name, not the data root (spec: Decisions, Development builds). A development
 * build's item is `Straw Boss Desk Dev Safe Storage`, so a local run never names the shipped product's `Straw Boss Desk Safe Storage`.
 */
export const safeStorageItem = (productName: string): string => {
	if (productName.trim() === "") throw new Error("the product name is empty, so the Safe Storage item cannot be named");
	return `${productName} Safe Storage`;
};

/**
 * Claude Code's Keychain item for the app's own `CLAUDE_CONFIG_DIR`: `Claude Code-credentials-<first 8 hex of sha256(config dir)>` (Claude Code 2.1.309, read from its binary; spec: Secrets). It
 * carries the hash of the app's private folder, so it cannot be the PM's own `Claude Code-credentials` item or the item of another folder.
 */
export const claudeItem = (configDir: string): string => `Claude Code-credentials-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
