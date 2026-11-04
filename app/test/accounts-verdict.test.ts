import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ghFileFindings, ghTokenSource, ghTokenVerdict, glabFileFindings, glabTokenVerdict, hostTokenFindings, removeHostBlock, yamlEntries, yamlEntriesOfFile } from "../src/main/accounts/forge.ts";

// The verdict of the code-host screens (task 10): the kit's account-verdict cases (its nine fixtures among them) and the followup R3-F001 (keys and sections without case, the body of a multi-line
// value skipped). The fixtures hold fake token text only.

const tmp = mkdtempSync(join(tmpdir(), "sbd-verdict-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const gh = (text: string, host = "github.com", prefix: string[] = []) => hostTokenFindings(yamlEntries(text), { host, key: "oauth_token", prefix });
const glab = (text: string, host = "gitlab.example.org") => hostTokenFindings(yamlEntries(text), { host, key: "token", prefix: ["hosts"], directOnly: true });

const ghKeyring = "github.com:\n    git_protocol: https\n    users:\n        someone:\n    user: someone\n";
const ghPlain = "github.com:\n    oauth_token: fake_token_value_1\n    user: someone\n";
const ghNested = 'github.com:\n    users:\n        someone:\n            oauth_token: "fake_token_value_2"\n';
const ghEmpty = "github.com:\n    oauth_token:\n";
const ghOther = "github.com:\n    git_protocol: https\n    users:\n        someone:\n    user: someone\nghe.example.org:\n    oauth_token: fake_token_value_4\n    user: other\n";
const ghBoth = "ghe.example.org:\n    oauth_token: fake_token_value_5\ngithub.com:\n    users:\n        someone:\n            oauth_token: fake_token_value_6\n";
const ghAlias = "git_protocol: https\naliases:\n    token: auth token\n    oauth_token: auth token\nprompt: enabled\n";
const ghLegacy = "git_protocol: https\nhosts:\n    github.com:\n        oauth_token: fake_token_value_7\n    other.example.org:\n        oauth_token: fake_token_value_8\naliases:\n    token: auth token\n";
const glabNone = "hosts:\n  gitlab.example.org:\n    api_host: gitlab.example.org\n";
const glabPlain = "hosts:\n  gitlab.example.org:\n    token: fake_token_value_3 # note\n    api_host: gitlab.example.org\n";
const glabNull = "hosts:\n  gitlab.example.org:\n    token: !!null\n";
const glabOther = "git_protocol: https\nhosts:\n  gitlab.example.org:\n    api_host: gitlab.example.org\n    user: me\n  gitlab.other.net:\n    token: fake_token_value_9\n";
const glabAlias = "aliases:\n  token: auth status\nhosts:\n  gitlab.example.org:\n    api_host: gitlab.example.org\nlast: x\ntoken: fake_token_value_10\n";
const glabPort = 'hosts:\n  "gitlab.example.org:8443":\n    token: fake_token_value_11\n  gitlab.example.org:\n    api_host: x\n';
const glabNested = "hosts:\n  gitlab.example.org:\n    custom_headers:\n      token: fake_token_value_12\n";

describe("the kit's nine fixtures, as the verdict reads them", () => {
	it("gh keyring file: no token line", () => assert.deepEqual(gh(ghKeyring), { own: 0, other: [] }));
	it("gh plain text, top level: found", () => assert.deepEqual(gh(ghPlain), { own: 1, other: [] }));
	it("gh plain text, nested under users: found", () => assert.equal(gh(ghNested).own, 1));
	it("gh plain text, quoted: found", () => assert.equal(gh(ghNested).own, 1));
	it("gh empty value: not a token", () => assert.equal(gh(ghEmpty).own, 0));
	it("glab no token: none", () => assert.deepEqual(glab(glabNone), { own: 0, other: [] }));
	it("glab plain text: found", () => assert.equal(glab(glabPlain).own, 1));
	it("glab !!null: not a token", () => assert.equal(glab(glabNull).own, 0));
	it("glab token with a trailing comment: found", () => assert.equal(glab(glabPlain).own, 1));
	it("a missing file: no entries, so no token", () => {
		const missing = join(tmp, "nowhere", "hosts.yml");
		assert.deepEqual(yamlEntriesOfFile(missing), []);
		const files = ghFileFindings(join(tmp, "nowhere"), "github.com");
		assert.deepEqual([files.hosts.own, files.config.own, files.hostsFileExists], [0, 0, false]);
		assert.equal(glabFileFindings(join(tmp, "nowhere"), "gitlab.example.org").own, 0);
	});
});

describe("token lines: only the checked host's own block is evidence", () => {
	it("another host carrying a token is other, not own", () => assert.deepEqual(gh(ghOther), { own: 0, other: ["ghe.example.org"] }));
	it("both hosts: the host has 1, the other host is named", () => assert.deepEqual(gh(ghBoth), { own: 1, other: ["ghe.example.org"] }));
	it("asking for the other host finds its own token", () => assert.deepEqual(gh(ghOther, "ghe.example.org"), { own: 1, other: [] }));
	it("an alias named token in gh's config.yml is no evidence for anyone", () => assert.deepEqual(gh(ghAlias, "github.com", ["hosts"]), { own: 0, other: [] }));
	it("gh's legacy config.yml hosts: block counts for its host; the alias does not", () => assert.deepEqual(gh(ghLegacy, "github.com", ["hosts"]), { own: 1, other: ["other.example.org"] }));
	it("glab: another host carrying a token is other", () => assert.deepEqual(glab(glabOther), { own: 0, other: ["gitlab.other.net"] }));
	it("glab: an alias named token and a top-level token are no evidence", () => assert.deepEqual(glab(glabAlias), { own: 0, other: [] }));
	it("glab: a quoted host:port entry is another host", () => assert.deepEqual(glab(glabPort), { own: 0, other: ["gitlab.example.org:8443"] }));
	it("glab: a token below a deeper key is not the host token", () => assert.equal(glab(glabNested).own, 0));
	it("never a value, only counts and host names", () => assert.ok(!/fake_token_value/.test(JSON.stringify([gh(ghPlain), gh(ghOther)]))));
});

describe("R3-F001: keys and sections compare without case", () => {
	it("the host name, in either case", () => {
		assert.equal(gh(ghPlain, "GitHub.COM").own, 1);
		assert.equal(gh("GITHUB.COM:\n    oauth_token: fake_token_value_20\n").own, 1);
	});
	it("the token key, in any case", () => {
		assert.equal(gh("github.com:\n    OAUTH_TOKEN: fake_token_value_21\n").own, 1);
		assert.equal(glab("hosts:\n  gitlab.example.org:\n    Token: fake_token_value_22\n").own, 1);
	});
	it("the prefix section, in any case", () => {
		assert.equal(gh("Hosts:\n    github.com:\n        oauth_token: fake_token_value_23\n", "github.com", ["hosts"]).own, 1);
		assert.equal(glab("HOSTS:\n  gitlab.example.org:\n    token: fake_token_value_24\n").own, 1);
	});
	it("null spellings in any case are not tokens", () => {
		for (const v of ["Null", "NULL", "!!Null", "~"]) assert.equal(glab(`hosts:\n  gitlab.example.org:\n    token: ${v}\n`).own, 0, v);
	});
	it("a tokenSource spelled in another case still decides", () => {
		assert.equal(ghTokenVerdict({ source: "OAuth_Token", hostsTokens: 0, configTokens: 0 }).plain, true);
		assert.equal(ghTokenVerdict({ source: "Keyring", hostsTokens: 0, configTokens: 0 }).verified, true);
	});
});

describe("R3-F001: the body of a multi-line value is skipped", () => {
	it("a token key inside a literal block is no key", () => {
		const text = "github.com:\n    description: |\n        oauth_token: fake_token_value_30\n        more text\n    user: someone\n";
		assert.equal(gh(text).own, 0);
		assert.deepEqual(yamlEntries(text).map((e) => e.key), ["github.com", "description", "user"]);
	});
	it("a folded block and an indented plain continuation are skipped the same way", () => {
		assert.equal(gh("github.com:\n    note: >-\n        oauth_token: fake_token_value_31\n").own, 0);
		assert.equal(gh("github.com:\n    note: first line\n        oauth_token: fake_token_value_32\n").own, 0);
	});
	it("a blank line inside the body does not end it", () => {
		assert.equal(gh("github.com:\n    note: |\n        a\n\n        oauth_token: fake_token_value_33\n").own, 0);
	});
	it("the key after the body is read again, and a real token after it still counts", () => {
		assert.equal(gh("github.com:\n    note: |\n        text\n    oauth_token: fake_token_value_34\n").own, 1);
		assert.equal(glab("hosts:\n  gitlab.example.org:\n    comment: |\n      token: fake_token_value_35\n    api_host: x\n").own, 0);
	});
	it("a token whose own value is a block scalar is still a token", () => {
		assert.equal(gh("github.com:\n    oauth_token: |\n        fake_token_value_36\n").own, 1);
		assert.equal(glab("hosts:\n  gitlab.example.org:\n    token: >-\n      fake_token_value_37\n").own, 1);
	});
	it("a block at a deeper level does not hide the host's siblings", () => {
		const text = "github.com:\n    users:\n        someone:\n            note: |\n                text\n            oauth_token: fake_token_value_38\n";
		assert.equal(gh(text).own, 1);
	});
});

describe("gh verdict: logout only on positive evidence", () => {
	const v = (source: string | null, hostsTokens = 0, configTokens = 0) => ghTokenVerdict({ source, hostsTokens, configTokens });
	it("keyring, no file token -> verified", () => assert.ok(v("keyring").verified && !v("keyring").plain));
	for (const [name, source] of [["null", null], ["empty", ""], ["blank", "   "]] as const) {
		it(`${name} tokenSource -> could not verify, no removal`, () => assert.ok(!v(source).verified && !v(source).plain && /could not verify/.test(v(source).reason)));
	}
	it("oauth_token -> plain", () => assert.ok(v("oauth_token").plain));
	it("a file path as the source -> plain", () => assert.ok(v("/x/hosts.yml").plain && v("C:\\x\\hosts.yml").plain));
	it("a token in hosts.yml -> plain even when gh says keyring", () => assert.ok(v("keyring", 1).plain));
	it("a token in config.yml -> plain", () => assert.ok(v("keyring", 0, 1).plain));
	it("status failed but a token is in a file -> plain", () => assert.ok(v(null, 1).plain));
	for (const s of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"]) it(`${s} -> fails, no removal`, () => assert.ok(!v(s).verified && !v(s).plain));
	it("a token in a real fixture decides it", () => assert.ok(ghTokenVerdict({ source: "keyring", hostsTokens: gh(ghPlain).own, configTokens: 0 }).plain));
});

describe("glab verdict: only config.yml decides plain text", () => {
	it("no file token, status ok -> verified", () => {
		const v = glabTokenVerdict({ configTokens: 0, statusExit: 0 });
		assert.ok(v.verified && !v.plain);
	});
	for (const code of [1, 2, -1, null]) {
		it(`status failed (exit ${code}) -> could not verify, no removal`, () => {
			const v = glabTokenVerdict({ configTokens: 0, statusExit: code });
			assert.ok(!v.verified && !v.plain && /could not verify/.test(v.reason));
		});
	}
	it("a token in config.yml -> plain, with status ok or failed", () => {
		assert.ok(glabTokenVerdict({ configTokens: 1, statusExit: 0 }).plain);
		assert.ok(glabTokenVerdict({ configTokens: 1, statusExit: 1 }).plain);
	});
	it("a token in a real fixture decides it", () => assert.ok(glabTokenVerdict({ configTokens: glab(glabPlain).own, statusExit: 0 }).plain));
});

describe("the files the verdict reads", () => {
	it("counts a plain-text token in each file", () => {
		const gd = join(tmp, "gh2");
		const ld = join(tmp, "glab2");
		mkdirSync(gd, { recursive: true });
		mkdirSync(ld, { recursive: true });
		writeFileSync(join(gd, "hosts.yml"), ghPlain);
		writeFileSync(join(gd, "config.yml"), ghLegacy);
		writeFileSync(join(ld, "config.yml"), glabPlain);
		const files = ghFileFindings(gd, "github.com");
		assert.deepEqual([files.hosts.own, files.config.own, files.hostsFileExists], [1, 1, true]);
		assert.equal(glabFileFindings(ld, "gitlab.example.org").own, 1);
	});
});

describe("gh auth status --json hosts", () => {
	const json = (entry: unknown, host = "github.com") => JSON.stringify({ hosts: { [host]: entry } });
	it("takes the first account's tokenSource and login", () => {
		assert.deepEqual(ghTokenSource(json([{ tokenSource: "keyring", login: "someone" }]), "github.com"), { source: "keyring", login: "someone" });
	});
	it("matches the host without case", () => assert.equal(ghTokenSource(json([{ tokenSource: "keyring" }]), "GitHub.com").source, "keyring"));
	it("a missing or non-string field, a host that is not there, and text that is not JSON all give null", () => {
		assert.equal(ghTokenSource(json([{ login: "x" }]), "github.com").source, null);
		assert.equal(ghTokenSource(json([{ tokenSource: 7 }]), "github.com").source, null);
		assert.equal(ghTokenSource(json([{ tokenSource: "keyring" }], "other.example.org"), "github.com").source, null);
		assert.equal(ghTokenSource("not json", "github.com").source, null);
		assert.equal(ghTokenSource("[]", "github.com").source, null);
	});
});

describe("removing a host from the app's own file", () => {
	const hosts = "github.com:\n    git_protocol: https\n    users:\n        someone:\n    user: someone\nghe.example.org:\n    user: other\n";
	it("removes the host's block and keeps every other line", () => {
		const out = removeHostBlock(hosts, "github.com");
		assert.equal(out.removed, true);
		assert.equal(out.text, "ghe.example.org:\n    user: other\n");
	});
	it("compares the host without case, and removes only that host", () => {
		const out = removeHostBlock(hosts, "GHE.example.org");
		assert.equal(out.text, "github.com:\n    git_protocol: https\n    users:\n        someone:\n    user: someone\n");
	});
	it("under glab's hosts: section, and keeps the lines outside it", () => {
		const text = "git_protocol: https\nhosts:\n  gitlab.example.org:\n    api_host: gitlab.example.org\n    user: me\n  gitlab.other.net:\n    user: you\nlast: x\n";
		const out = removeHostBlock(text, "gitlab.example.org", ["hosts"]);
		assert.equal(out.text, "git_protocol: https\nhosts:\n  gitlab.other.net:\n    user: you\nlast: x\n");
		// A key with the host's name outside the prefix is not the host.
		assert.equal(removeHostBlock("gitlab.example.org: x\nhosts:\n  a: b\n", "gitlab.example.org", ["hosts"]).removed, false);
	});
	it("keeps CRLF line endings, and reports that nothing was there", () => {
		const crlf = "github.com:\r\n    user: a\r\nother.org:\r\n    user: b\r\n";
		assert.equal(removeHostBlock(crlf, "github.com").text, "other.org:\r\n    user: b\r\n");
		assert.deepEqual(removeHostBlock(hosts, "nothing.example.org"), { text: hosts, removed: false });
	});
});
