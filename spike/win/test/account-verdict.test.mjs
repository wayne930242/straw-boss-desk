// node --test spike/win/test/account-verdict.test.mjs
// Offline tests of the decisions the account checks make (the port of account-check-test.ps1). The fixtures hold fake token text only.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ghTokenVerdict, glabTokenVerdict, gitValueList, hostTokenFindings, removeNestedRoots, splitUnread, yamlEntries,
} from "../lib/account-verdict.mjs";

const gh = (text, host = "github.com", prefix = []) => hostTokenFindings(yamlEntries(text), { host, key: "oauth_token", prefix });
const glab = (text, host = "gitlab.example.org") => hostTokenFindings(yamlEntries(text), { host, key: "token", prefix: ["hosts"], directOnly: true });

const ghKeyring = "github.com:\n    git_protocol: https\n    users:\n        someone:\n    user: someone\n";
const ghPlain = "github.com:\n    oauth_token: fake_token_value_1\n    user: someone\n";
const ghNested = 'github.com:\n    users:\n        someone:\n            oauth_token: "fake_token_value_2"\n';
const ghEmpty = "github.com:\n    oauth_token:\n";
const ghOther = "github.com:\n    git_protocol: https\n    users:\n        someone:\n    user: someone\nghe.example.org:\n    oauth_token: fake_token_value_4\n    user: other\n";
const ghBoth = "ghe.example.org:\n    oauth_token: fake_token_value_5\ngithub.com:\n    users:\n        someone:\n            oauth_token: fake_token_value_6\n";
const ghAlias = "git_protocol: https\naliases:\n    token: auth token\n    oauth_token: auth token\nprompt: enabled\n";
const ghLegacy = "git_protocol: https\nhosts:\n    github.com:\n        oauth_token: fake_token_value_7\n    other.example.org:\n        oauth_token: fake_token_value_8\naliases:\n    token: auth token\n";
const glabPlain = "hosts:\n  gitlab.example.org:\n    token: fake_token_value_3 # note\n    api_host: gitlab.example.org\n";
const glabNull = "hosts:\n  gitlab.example.org:\n    token: !!null\n";
const glabNone = "hosts:\n  gitlab.example.org:\n    api_host: gitlab.example.org\n";
const glabOther = "git_protocol: https\nhosts:\n  gitlab.example.org:\n    api_host: gitlab.example.org\n    user: me\n  gitlab.other.net:\n    token: fake_token_value_9\n";
const glabAlias = "aliases:\n  token: auth status\nhosts:\n  gitlab.example.org:\n    api_host: gitlab.example.org\nlast: x\ntoken: fake_token_value_10\n";
const glabPort = 'hosts:\n  "gitlab.example.org:8443":\n    token: fake_token_value_11\n  gitlab.example.org:\n    api_host: x\n';
const glabNested = "hosts:\n  gitlab.example.org:\n    custom_headers:\n      token: fake_token_value_12\n";

describe("token lines: only the checked host's own block is evidence", () => {
  it("gh keyring file has none", () => assert.deepEqual(gh(ghKeyring), { own: 0, other: [] }));
  it("gh plain text is found for the host", () => assert.deepEqual(gh(ghPlain), { own: 1, other: [] }));
  it("gh nested under users and quoted is found", () => assert.equal(gh(ghNested).own, 1));
  it("gh empty value is not a token", () => assert.equal(gh(ghEmpty).own, 0));
  it("gh another host carrying a token is other, not own", () => assert.deepEqual(gh(ghOther), { own: 0, other: ["ghe.example.org"] }));
  it("gh both hosts: the host has 1, the other host is named", () => assert.deepEqual(gh(ghBoth), { own: 1, other: ["ghe.example.org"] }));
  it("gh asking for the other host finds its own token", () => assert.deepEqual(gh(ghOther, "ghe.example.org"), { own: 1, other: [] }));
  it("gh host names compare without case", () => assert.equal(gh(ghPlain, "GitHub.COM").own, 1));
  it("gh config.yml with an alias named token is no evidence for anyone", () => assert.deepEqual(gh(ghAlias, "github.com", ["hosts"]), { own: 0, other: [] }));
  it("gh legacy config.yml hosts: block counts for its host; the alias does not", () => {
    assert.deepEqual(gh(ghLegacy, "github.com", ["hosts"]), { own: 1, other: ["other.example.org"] });
  });
  it("glab plain text with a comment is found", () => assert.equal(glab(glabPlain).own, 1));
  it("glab !!null is not a token", () => assert.equal(glab(glabNull).own, 0));
  it("glab without a token line has none", () => assert.deepEqual(glab(glabNone), { own: 0, other: [] }));
  it("glab another host carrying a token is other", () => assert.deepEqual(glab(glabOther), { own: 0, other: ["gitlab.other.net"] }));
  it("glab an alias named token and a top-level token are no evidence", () => assert.deepEqual(glab(glabAlias), { own: 0, other: [] }));
  it("glab a quoted host:port entry is another host", () => assert.deepEqual(glab(glabPort), { own: 0, other: ["gitlab.example.org:8443"] }));
  it("glab a token below a deeper key is not the host token", () => assert.equal(glab(glabNested).own, 0));
  it("never a value, only counts and host names", () => {
    assert.ok(!/fake_token_value/.test(JSON.stringify([gh(ghPlain), gh(ghOther)])));
  });
});

describe("gh verdict: logout only on positive evidence", () => {
  const v = (source, hostsTokens = 0, configTokens = 0) => ghTokenVerdict({ source, hostsTokens, configTokens });
  it("keyring, no file token -> verified", () => assert.ok(v("keyring").verified && !v("keyring").plain));
  for (const [name, source] of [["null", null], ["empty", ""], ["blank", "   "]]) {
    it(`${name} tokenSource -> could not verify, no logout`, () => {
      assert.ok(!v(source).verified && !v(source).plain && /could not verify/.test(v(source).reason));
    });
  }
  it("oauth_token -> plain", () => assert.ok(v("oauth_token").plain));
  it("a file path as source -> plain", () => assert.ok(v("/x/hosts.yml").plain && v("C:\\x\\hosts.yml").plain));
  it("token in hosts.yml -> plain even when gh says keyring", () => assert.ok(v("keyring", 1).plain));
  it("token in config.yml -> plain", () => assert.ok(v("keyring", 0, 1).plain));
  it("status failed but a token is in a file -> plain", () => assert.ok(v(null, 1).plain));
  for (const s of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"]) {
    it(`${s} -> fails, no logout`, () => assert.ok(!v(s).verified && !v(s).plain));
  }
  it("a token in a real fixture decides it", () => assert.ok(ghTokenVerdict({ source: "keyring", hostsTokens: gh(ghPlain).own, configTokens: 0 }).plain));
});

describe("glab verdict: only config.yml decides plain text", () => {
  it("no file token, status ok -> verified", () => {
    const v = glabTokenVerdict({ configTokens: 0, statusExit: 0 });
    assert.ok(v.verified && !v.plain);
  });
  for (const code of [1, 2, -1]) {
    it(`status failed (exit ${code}) -> could not verify, no logout`, () => {
      const v = glabTokenVerdict({ configTokens: 0, statusExit: code });
      assert.ok(!v.verified && !v.plain && /could not verify/.test(v.reason));
    });
  }
  it("token in config.yml -> plain, with status ok or failed", () => {
    assert.ok(glabTokenVerdict({ configTokens: 1, statusExit: 0 }).plain);
    assert.ok(glabTokenVerdict({ configTokens: 1, statusExit: 1 }).plain);
  });
  it("a token in a real fixture decides it", () => assert.ok(glabTokenVerdict({ configTokens: glab(glabPlain).own, statusExit: 0 }).plain));
});

describe("unread files and roots", () => {
  const app = "/tmp/sbd-macacct";
  const strictRoots = [app, "/Users/x/sbd-kit"];
  const un = (path, reason = "open or read: EBUSY in use") => ({ path, reason });
  it("files under the spec folders and the root itself fail; a folder that only shares the prefix, and extra places, warn", () => {
    const sp = splitUnread([un(`${app}/logs/locked.log`), un(`${app}/tools/downloads/node.zip`), un(app), un("/Users/x/sbd-kit-old/a.bin"), un("/var/folders/t/nsj.tmp/System.dll"), un("/Users/x/.config/z", "list folder: EACCES")], strictRoots);
    assert.equal(sp.strict.length, 3);
    assert.equal(sp.extra.length, 3);
    assert.match(sp.extra[2].reason, /EACCES/);
  });
  it("root comparison ignores case when asked (Windows paths)", () => {
    assert.equal(splitUnread([un("/Users/X/Kit/a.bin")], ["/users/x/kit"], true).strict.length, 1);
    assert.equal(splitUnread([un("/Users/X/Kit/a.bin")], ["/users/x/kit"], false).strict.length, 0);
    assert.deepEqual(removeNestedRoots(["/A/b", "/a/B/c"], true), ["/A/b"]);
  });
  it("nothing unread is nothing to report", () => assert.deepEqual(splitUnread([], strictRoots), { strict: [], extra: [] }));
  it("a root inside another is dropped, a sibling that shares the prefix is kept", () => {
    const nr = removeNestedRoots(["/a/b", "/a", "/a/b/c/", "/d/x", "/a/", "/ab"]);
    assert.deepEqual(nr.sort(), ["/a", "/ab", "/d/x"]);
  });
});

describe("git config --get-all output", () => {
  it("empty or null output is no value", () => {
    assert.equal(gitValueList("").length, 0);
    assert.equal(gitValueList(null).length, 0);
  });
  it("a single empty line is one empty value", () => assert.deepEqual(gitValueList("\n"), [""]));
  it("the empty entry then the command", () => {
    const two = gitValueList("\n!'/x/bin/gh' auth git-credential\n");
    assert.equal(two.length, 2);
    assert.equal(two[0], "");
    assert.ok(two[1].startsWith("!"));
  });
  it("CRLF lines", () => {
    const crlf = gitValueList("\r\n!'/x/bin/gh' auth git-credential\r\n");
    assert.ok(crlf.length === 2 && crlf[0] === "" && !crlf[1].endsWith("\r"));
  });
});

describe("case-insensitive like the .ps1", () => {
  it("Null, NULL and !!Null are not tokens", () => {
    for (const v of ["Null", "NULL", "!!Null", "~"]) assert.equal(glab(`hosts:\n  gitlab.example.org:\n    token: ${v}\n`).own, 0, v);
  });
  it("key, prefix and source spellings in other case still count", () => {
    assert.equal(gh("github.com:\n    OAUTH_TOKEN: fake_token_value_20\n").own, 1);
    assert.equal(gh("Hosts:\n    github.com:\n        oauth_token: fake_token_value_21\n", "github.com", ["hosts"]).own, 1);
    assert.ok(ghTokenVerdict({ source: "OAuth_Token", hostsTokens: 0, configTokens: 0 }).plain);
    assert.ok(ghTokenVerdict({ source: "Keyring", hostsTokens: 0, configTokens: 0 }).verified);
  });
});
