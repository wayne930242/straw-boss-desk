/** What `src/preload/shell.cts` exposes to the shell view. */
interface SbdShell {
	readonly locale: "en" | "zh-TW";
	readonly productName: string;
	readonly build: "dev" | "release";
}

interface Window {
	readonly sbdShell?: SbdShell;
}
