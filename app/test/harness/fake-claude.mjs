// A stand-in for the `claude` executable of the Agent SDK, for the e2e (task 11). Test code only: the development build runs it where `SBD_TEST_CLAUDE_CMD` names it, so the Claude sign-in is proved
// with no account and no browser. The leading arguments are `--out <folder>`; the rest is what the app runs: `auth status --json`, `auth login`, `auth logout`.
//   login: prints the address and the request for a code the way the real CLI does, reads one line from standard input, and signs in unless the line is WRONG-CODE;
//   status: `{"loggedIn":true|false}` from the state file in the app's own CLAUDE_CONFIG_DIR;
//   logout: signs out.
// What it saw (its arguments, the config folder, the line it read) goes to files in the --out folder, which lies outside the app's root, so a test can prove where a code went and where it did not.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const at = args.indexOf("--out");
const out = at >= 0 ? args[at + 1] : null;
const rest = at >= 0 ? args.slice(at + 2) : args;
const config = process.env.CLAUDE_CONFIG_DIR ?? "";
if (out !== null) {
	mkdirSync(out, { recursive: true });
	appendFileSync(join(out, "calls.jsonl"), `${JSON.stringify({ argv: rest, config, secureStorageDir: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? null })}\n`);
}
const stateFile = join(config || out || ".", "standin-state.json");
const signedIn = () => existsSync(stateFile) && JSON.parse(readFileSync(stateFile, "utf8")).loggedIn === true;
const setSignedIn = (value) => {
	mkdirSync(join(stateFile, ".."), { recursive: true });
	writeFileSync(stateFile, JSON.stringify({ loggedIn: value }));
};

const [group, verb] = rest;
if (group === "auth" && verb === "status") {
	process.stdout.write(`${JSON.stringify({ loggedIn: signedIn(), authMethod: "claude.ai" })}\n`);
} else if (group === "auth" && verb === "logout") {
	setSignedIn(false);
	process.stdout.write("Logged out\n");
} else if (group === "auth" && verb === "login") {
	process.stdout.write("Opening browser to sign in…\nIf the browser did not open, visit: https://claude.ai/oauth/authorize?code=true&client_id=stand-in\n");
	process.stdout.write("Paste code here if prompted > ");
	let buffer = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		buffer += chunk;
		const end = buffer.indexOf("\n");
		if (end < 0) return;
		const code = buffer.slice(0, end).trim();
		if (out !== null) writeFileSync(join(out, "code.txt"), code);
		if (code === "WRONG-CODE") {
			process.stderr.write("Invalid code. Please try again.\n");
			process.exit(1);
		}
		setSignedIn(true);
		process.stdout.write("\nLogin successful.\n");
		process.exit(0);
	});
	// A login nobody completes ends by itself, so a test that forgot it leaves nothing behind.
	setTimeout(() => process.exit(2), 10 * 60_000).unref?.();
} else {
	process.stderr.write(`stand-in claude: unexpected ${rest.join(" ")}\n`);
	process.exit(64);
}
