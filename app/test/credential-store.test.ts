import { fixtureTest } from "./harness/hosted.ts";
import { credentialListing, credentialProbe } from "./harness/store-fixtures.ts";

// The real stores. A GitHub-hosted runner uses its own keychain or Credential Manager; a local macOS run uses a scratch HOME with its own keychain
// (the harness checks the search list first); a local Windows run skips, with the reason in the test's name.
fixtureTest(credentialListing);
fixtureTest(credentialProbe);
