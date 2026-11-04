import { fixtureTest } from "./harness/hosted.ts";
import { foreignEntries } from "./harness/forge-fixtures.ts";

// Task 10 against the real stores, no CLI: a foreign entry stops the step before a code or a token field, Sign out leaves it unchanged, and a foreign write over an owned entry makes it left.
// A hosted runner uses its own keychain or Credential Manager; a local macOS run uses a scratch HOME with its own keychain; a local Windows run skips.
fixtureTest(foreignEntries);
