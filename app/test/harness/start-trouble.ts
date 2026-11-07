// Test code only; never shipped. What to print when a start that a test waits for does not come up (task 15: the Windows runners' "timed out waiting for the GUI view" and "waiting for the
// stack", with `start.json` missing, in three e2e files): the shell's own logs first, since the stage logs sort before them and the message is cut at a fixed length, then the pages the
// window shows, the state folder, and the programs running from the tools folder. It reads and changes nothing.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication } from "playwright-core";
import { createPlatform } from "../../src/main/platform/index.ts";
import type { World } from "./e2e-light.ts";

/** The supervisor's log and the shell's own: what the app did at a start, which is what a start that went nowhere is explained by. */
export const OWN_LOGS: ReadonlySet<string> = new Set(["start.jsonl", "shell.jsonl"]);

/** The tail of every file in a folder, the app's own logs first and with more lines (40 of 520 characters), the others 14 of 360. */
export function logTailsOf(dir: string, lines = 14, width = 360): string[] {
	if (!existsSync(dir)) return [];
	return [...readdirSync(dir)]
		.sort((a, b) => Number(OWN_LOGS.has(b)) - Number(OWN_LOGS.has(a)) || a.localeCompare(b))
		.flatMap((name) => {
			const own = OWN_LOGS.has(name);
			try {
				return [`${name}: ${readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean).slice(own ? -40 : -lines).map((l) => l.slice(0, own ? 520 : width)).join(" | ")}`];
			} catch {
				return [];
			}
		});
}

/**
 * The text a failure carries: the logs (own first), the state folder, the programs running from `<root>/tools` and, when given, from another folder (an install folder), and the text of every
 * page the app has open. The whole is cut at `max` characters from the end, so what is dropped is the last of the stage logs.
 */
export async function startTrouble(world: World, options: { app?: ElectronApplication | undefined; alsoUnder?: string; max?: number } = {}): Promise<string> {
	const parts: string[] = [...logTailsOf(world.layout.logs)];
	parts.push(`state folder: ${existsSync(world.layout.state) ? readdirSync(world.layout.state).join(", ") : "(none)"}`);
	try {
		const processes = createPlatform().processes;
		const running = [...(await processes.listUnder(world.layout.tools.root)), ...(options.alsoUnder ? await processes.listUnder(options.alsoUnder) : [])];
		parts.push(`running from tools${options.alsoUnder ? " or the install folder" : ""}: ${running.map((p) => `${p.pid} ${p.executable?.split(/[\\/]/).pop() ?? "?"}`).join(", ") || "(none)"}`);
	} catch (error) {
		parts.push(`running programs: (unreadable: ${(error as Error).message.slice(0, 120)})`);
	}
	if (options.app) {
		try {
			for (const w of options.app.windows()) parts.push(`page ${w.url().slice(-40)}: ${(await w.locator("body").innerText({ timeout: 3000 }).catch(() => "(unreadable)")).replace(/\s+/g, " ").slice(0, 700)}`);
		} catch (error) {
			parts.push(`pages: (unreadable: ${(error as Error).message.slice(0, 120)})`);
		}
	}
	return parts.join(" ;; ").slice(0, options.max ?? 9000);
}
