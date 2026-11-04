// The code-host steps of the wizard e2e (task 10): seeded foreign store entries, foreign writes, and reads of the store, all through the guard. Test code only. The rig refuses to exist
// anywhere but on a GitHub-hosted runner; on macOS it works in the scratch keychain of the world's own HOME, which is the keychain the launched app uses (it gets the same HOME), so the
// runner's real login keychain is never touched. On Windows it is the runner's Credential Manager, which is ephemeral.
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { CredentialStore, StoreEntry } from "../../src/main/platform/types.ts";
import { hostedCase, type FixtureIO } from "./hosted.ts";
import { realIO } from "./hosted.ts";
import { createScratchKeychain, type ScratchKeychain } from "./scratch-keychain.ts";
import { seederFor, storeFor, type Seeder } from "./store-fixtures.ts";

export interface ForgeRig {
	seeder: Seeder;
	store: CredentialStore;
	/** Every secret this rig wrote: a dummy per entry, so a log search can look for them too. */
	dummies: string[];
	/** The store as it stands for one entry: its secret and modification time (null when there is none). Dummy entries only. */
	snapshot(name: string, account: string): Promise<{ secret: string | null; modified: string | null }>;
	/** A fresh dummy secret that no real login can have. */
	dummy(label: string): string;
	list(names: string[]): Promise<StoreEntry[]>;
	dispose(): Promise<void>;
}

export async function openForgeRig(world: { home: string }): Promise<ForgeRig> {
	const gate = hostedCase("forge e2e store rig");
	if (!gate.run) throw new Error(gate.reason);
	const platform = process.platform;
	let scratch: ScratchKeychain | null = null;
	let io: FixtureIO = realIO;
	if (platform === "darwin") {
		mkdirSync(world.home, { recursive: true });
		scratch = await createScratchKeychain({ home: world.home });
		io = scratch.io;
	}
	const seeder = seederFor(platform, io);
	const store = storeFor(io, platform);
	const dummies: string[] = [];
	const nonce = randomBytes(4).toString("hex");
	return {
		seeder,
		store,
		dummies,
		dummy(label) {
			const value = `sbd-dummy-${label}-${nonce}-${randomBytes(3).toString("hex")}`;
			dummies.push(value);
			return value;
		},
		async snapshot(name, account) {
			const entry = (await store.list([name])).find((e) => e.account === account);
			return { secret: entry === undefined ? null : await seeder.read(name, account), modified: entry?.modified ?? null };
		},
		list: (names) => store.list(names),
		async dispose() {
			if (scratch !== null) await scratch.dispose();
		},
	};
}
