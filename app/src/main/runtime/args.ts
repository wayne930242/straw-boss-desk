// The command-line switches the lifecycle reads (spec: Uninstall and data, Stop). Electron passes its own switches and the app's through `process.argv` and, for a second
// instance, through the `commandLine` of `second-instance`; both are scanned the same way.

export const STOP_STACK_FLAG = "--stop-stack";

/** True when the arguments carry `--stop-stack` exactly (a value or a longer switch of that prefix does not count). */
export function hasStopStack(argv: readonly string[]): boolean {
	return argv.includes(STOP_STACK_FLAG);
}
