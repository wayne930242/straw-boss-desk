import { readFileSync } from "node:fs";
import { createEngine } from "../../src/main/bootstrap/engine.ts";
import { testLayout, testPlatform, toolStage } from "./engine-fixture.ts";

// Test code: the engine run in a process of its own, so a test can kill it in the middle of a stage and then resume in the test process.
// Usage: node engine-child.ts <config.json>. The config holds the data root, the parsed stack, the secret patterns, the installs log, and the tools to install.

interface ChildConfig {
	root: string;
	stack: unknown;
	secretPatterns: unknown;
	installsLog: string;
	/** Tool names; each stage needs the one before it. */
	tools: string[];
}

const config = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as ChildConfig;

const engine = createEngine({
	emit: (event) => {
		if (event.type === "done" || event.type === "error") process.stdout.write(`${JSON.stringify(event)}\n`);
	},
	fetch: (url, init) => fetch(url, init),
	layout: testLayout(config.root),
	platform: testPlatform(),
	retryDelayMs: 0,
	stages: () => config.tools.map((tool, i) => toolStage(tool, { ...(i > 0 ? { needs: [config.tools[i - 1] as string] } : {}), installsLog: config.installsLog })),
});

await engine.handle({ type: "run", config: { root: config.root, stack: config.stack, secretPatterns: config.secretPatterns } });
