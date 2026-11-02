/** What `src/preload/shell.cts` exposes to the shell view. */
interface SbdShell {
	readonly locale: "en" | "zh-TW";
	readonly productName: string;
	readonly build: "dev" | "release";
	/** The state main wants the runtime page (`screen.html`) to show now. */
	state(): Promise<import("../shared/shell-state.ts").ShellState>;
	/** Calls the listener with each new state main sends. */
	onState(listener: (state: import("../shared/shell-state.ts").ShellState) => void): void;
	/** The page's one request: Start and Try again are the same. */
	act(action: import("../shared/shell-state.ts").ShellAction): void;
}

interface Window {
	readonly sbdShell?: SbdShell;
}
