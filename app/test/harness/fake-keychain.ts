import type { FixtureIO } from "./hosted.ts";

/** A keychain in memory that answers `security` the way the real one does for the three commands the smoke test uses. */
export function fakeKeychain(): FixtureIO & { commands: string[] } {
	const items = new Set<string>();
	const commands: string[] = [];
	const key = (args: readonly string[]) => `${args[args.indexOf("-a") + 1]}|${args[args.indexOf("-s") + 1]}`;
	return {
		commands,
		async run(command, args) {
			commands.push(`${command} ${String(args[0]).split("-")[0]}`);
			const k = key(args);
			switch (args[0]) {
				case "add-generic-password": items.add(k); return { code: 0, stdout: "", stderr: "" };
				case "find-generic-password":
					return items.has(k)
						? { code: 0, stdout: `keychain: "login.keychain-db"\n    "svce"<blob>="${args[args.indexOf("-s") + 1]}"\n`, stderr: "" }
						: { code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
				case "delete-generic-password": return items.delete(k) ? { code: 0, stdout: "", stderr: "" } : { code: 44, stdout: "", stderr: "" };
				default: throw new Error(`unexpected command ${args[0]}`);
			}
		},
		writeFile() { throw new Error("the smoke test writes no file"); },
		removeFile() { throw new Error("the smoke test removes no file"); },
	};
}
