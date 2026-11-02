import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { run, type World } from "./e2e-light.ts";

// Test code only; never shipped. A GitHub-hosted Windows runner runs the tests as `runneradmin`, an administrator with an elevated token whose default DACL puts the
// Administrators group (BA) on every new folder as an explicit ACE. pi-straw-boss 0.51.0 protects its state folder with `icacls /inheritance:r /grant:r <user> SYSTEM` and then
// refuses to start (`up` exit 3, `acl`: "the folder grants BA, who is neither the owner nor SYSTEM") because that call does not remove an explicit grant to a third
// SID. A PM's app runs with a standard or split token, whose new folders carry the user and SYSTEM only, so the refusal was not seen on the VM. The e2e makes the state
// folder what the server wants before the first start; the product code does not touch that folder's ACL (spec: Build notes, task 8a, finding at the hosted runner).
export async function prepareStateFolder(world: World): Promise<void> {
	if (process.platform !== "win32") return;
	const dir = join(world.layout.agent, "straw-boss");
	mkdirSync(dir, { recursive: true });
	const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
	const icacls = join(system32, "icacls.exe");
	const user = process.env.USERNAME;
	if (!user) throw new Error("USERNAME is not set");
	const env = { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" };
	for (const args of [
		[dir, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`, "/grant:r", "*S-1-5-18:(OI)(CI)F"],
		[dir, "/remove:g", "*S-1-5-32-544"],
	]) {
		const r = await run(icacls, args, { env, timeoutMs: 60_000 });
		if (r.code !== 0) throw new Error(`icacls ${args.slice(1).join(" ")} failed: ${r.stderr || r.stdout}`);
	}
}
