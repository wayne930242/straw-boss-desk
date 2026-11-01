import { fixtureTest } from "./harness/hosted.ts";
import { hkcuEnvironment, userPathScratchKey } from "./harness/registry-fixtures.ts";

// Registry writes: a GitHub-hosted Windows runner only. Anywhere else the tests skip with the fixture's name and the failing signal.
fixtureTest(userPathScratchKey);
fixtureTest(hkcuEnvironment);
