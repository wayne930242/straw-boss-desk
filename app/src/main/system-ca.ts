import { join } from "node:path";
import { writeFileAtomic } from "./bootstrap/fsutil.ts";
import { systemEnv, type EnvLike } from "./env.ts";
import type { Layout } from "./paths.ts";
import type { CommandRunner } from "./platform/types.ts";

// The OS certificate store as a file (spec: Network, the `claude` finding). Node 24 reads the OS store itself when `NODE_USE_SYSTEM_CA=1` is set
// (`tls.getCACertificates("system")`), and npm and pi do. The Agent SDK's bundled `claude` is a separate native program: when it does not honour that
// variable, this file stands in for it. The private Node writes the store's certificates to `<root>/config/system-ca.pem` at each start, and the
// constructed environment names the file in `NODE_EXTRA_CA_CERTS` unless the app's own environment already sets that variable.

export const SYSTEM_CA_FILE = "system-ca.pem";

export const systemCaPath = (layout: Layout, fileName: string = SYSTEM_CA_FILE): string => join(layout.root, "config", fileName);

/** What the private Node prints: the store's certificates as a JSON array of PEM strings. */
const LIST_SCRIPT = "process.stdout.write(JSON.stringify(require('node:tls').getCACertificates('system')))";

export interface SystemCaResult {
	path: string;
	/** How many certificates the OS store gave. */
	count: number;
}

/**
 * Writes the OS store's certificates to the file (atomically; the file is replaced at each call) and returns how many there were. Throws when the private
 * Node cannot list them or the store is empty, so a start never names a file that does not hold them.
 */
export async function writeSystemCaFile(options: { layout: Layout; nodeBinary: string; run: CommandRunner; appEnv: EnvLike; fileName?: string }): Promise<SystemCaResult> {
	const { layout, nodeBinary, run, appEnv } = options;
	const result = await run(nodeBinary, ["-e", LIST_SCRIPT], { env: systemEnv(layout.platform, appEnv), replaceEnv: true, timeoutMs: 60_000 });
	if (result.code !== 0) throw new Error(`the private Node could not list the OS certificate store (exit ${result.code}): ${result.stderr.trim().split(/\r?\n/)[0] ?? ""}`);
	let list: unknown;
	try {
		list = JSON.parse(result.stdout);
	} catch {
		throw new Error("the private Node's list of the OS certificate store is not JSON");
	}
	if (!Array.isArray(list) || !list.every((c) => typeof c === "string")) throw new Error("the private Node's list of the OS certificate store is not a list of certificates");
	if (list.length === 0) throw new Error("the OS certificate store gave no certificate");
	const path = systemCaPath(layout, options.fileName);
	writeFileAtomic(path, `${list.map((pem) => pem.trim()).join("\n")}\n`);
	return { path, count: list.length };
}

/** `NODE_EXTRA_CA_CERTS` for a child: the file, unless the app's environment already names one (which then passes through unchanged). */
export const extraCaEnv = (layout: Layout, appEnv: EnvLike, fileName: string = SYSTEM_CA_FILE): Record<string, string> =>
	appEnv.NODE_EXTRA_CA_CERTS !== undefined && appEnv.NODE_EXTRA_CA_CERTS !== "" ? {} : { NODE_EXTRA_CA_CERTS: systemCaPath(layout, fileName) };
