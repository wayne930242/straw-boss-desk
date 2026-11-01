import { buildIdentity, type BuildIdentity } from "../src/main/build.ts";

export interface PackPlan {
	identity: BuildIdentity;
	/** Where electron-builder writes, relative to `app/`: one folder per build kind, so a dev and a release build never overwrite each other. */
	outputDir: string;
	/** The `-c.<key>=<value>` overrides on top of electron-builder.json, whose own values are the development ones. */
	configArgs: string[];
}

export function packPlan(env: Readonly<Record<string, string | undefined>>): PackPlan {
	const identity = buildIdentity(env);
	const outputDir = `out/${identity.kind}`;
	return {
		identity,
		outputDir,
		configArgs: [
			`-c.productName=${identity.productName}`,
			`-c.appId=${identity.appId}`,
			// The running app reads its own product name from the package.json inside the asar.
			`-c.extraMetadata.productName=${identity.productName}`,
			`-c.directories.output=${outputDir}`,
		],
	};
}
