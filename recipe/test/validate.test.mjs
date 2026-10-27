import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { KNOWN_FIELDS, MAX_RECIPE_BYTES, validateRecipe } from "../validate.mjs";

const recipeDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const readText = (...parts) => readFileSync(join(recipeDir, ...parts), "utf8");
const readJson = (...parts) => JSON.parse(readText(...parts));
const patterns = readJson("secret-patterns.json").patterns;
const fixtures = readJson("test", "secret-fixtures.json");
const join0 = (parts) => parts.join("");

const base = () => ({ recipe: 1, id: "team-a", name: "Team A", version: "1.0.0", forges: [{ kind: "github", host: "github.com" }] });
const withField = (extra) => ({ ...base(), ...extra });
const ruleOf = (result) => result.errors.map((e) => `${e.field}:${e.rule}`);

describe("examples", () => {
  for (const file of readdirSync(join(recipeDir, "examples")).filter((f) => f.endsWith(".strawboss.json"))) {
    it(`${file} is valid`, () => {
      const result = validateRecipe(readText("examples", file));
      assert.ok(result.ok, JSON.stringify(result.errors));
    });
  }

  it("fills the login and label defaults", () => {
    const result = validateRecipe(readText("examples", "team.strawboss.json"));
    assert.deepEqual(result.recipe.forges.map((f) => f.login), ["device", "token"]);
    assert.deepEqual(result.recipe.repos.map((r) => r.label), ["官網", "handbook"]);
  });

  const invalidDir = join(recipeDir, "examples", "invalid");
  for (const file of readdirSync(invalidDir)) {
    const rule = file.replace(".strawboss.json", "");
    it(`invalid/${file} is refused by ${rule}, naming no value`, () => {
      const text = readFileSync(join(invalidDir, file), "utf8");
      const result = validateRecipe(text);
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((e) => e.rule === rule), `expected rule ${rule}, got ${ruleOf(result)}`);
      assert.ok(!JSON.stringify(result.errors).includes("LEAKCHECK"), "an error repeated the offending value");
    });
  }
});

describe("unknown fields", () => {
  it("refuses a stray field at every level and names it", () => {
    const cases = [
      [withField({ token: "x" }), "(recipe).token"],
      [withField({ forges: [{ kind: "github", host: "github.com", password: "x" }] }), "forges[0].password"],
      [withField({ repos: [{ url: "https://github.com/a/b.git", folder: "b", pat: "x" }] }), "repos[0].pat"],
      [withField({ straw: { relay: "https://r.example.com", key: "x" } }), "straw.key"],
      [withField({ linear: { enabled: true, apiKey: "x" } }), "linear.apiKey"],
      [withField({ profile: { version: "1.0.0", integrity: "sha512-" + "A".repeat(86) + "==", extra: 1 } }), "profile.extra"],
      [withField({ packages: [{ name: "pkg", version: "1.0.0", integrity: "sha512-" + "A".repeat(86) + "==", url: "x" }] }), "packages[0].url"],
    ];
    for (const [recipe, field] of cases) {
      const result = validateRecipe(recipe);
      assert.equal(result.ok, false, field);
      assert.ok(result.errors.some((e) => e.rule === "unknown-field" && e.field === field), `${field}: ${ruleOf(result)}`);
    }
  });

  it("does not echo a key that looks like a secret", () => {
    const key = join0(["ghp", "_", "A1b2C3d4E5f6G7h8I9j0"]);
    const result = validateRecipe(withField({ [key]: "x" }));
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result.errors).includes(key));
  });
});

describe("URLs", () => {
  const cases = {
    "https://alice:pw@git.example.com/a.git": "url-userinfo",
    "https://alice@git.example.com/a.git": "url-userinfo",
    "https://git.example.com/a.git?x=1": "url-query",
    "https://git.example.com/a.git?": "url-query",
    "https://git.example.com/a.git#frag": "url-fragment",
    "http://git.example.com/a.git": "url-scheme",
    "ssh://git@git.example.com/a.git": "url-scheme",
    "git@git.example.com:a.git": "bad-format",
    "not a url": "bad-format",
  };
  for (const [url, rule] of Object.entries(cases)) {
    it(`relay ${url} -> ${rule}`, () => {
      const result = validateRecipe(withField({ straw: { relay: url } }));
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((e) => e.field === "straw.relay" && e.rule === rule), ruleOf(result).join());
      assert.ok(!JSON.stringify(result.errors).includes("alice"), "no value in the message");
    });
    it(`updateUrl ${url} -> ${rule}`, () => {
      const result = validateRecipe(withField({ updateUrl: url }));
      assert.ok(result.errors.some((e) => e.field === "updateUrl" && e.rule === rule));
    });
  }

  it("updateUrl must be a public host", () => {
    for (const host of ["localhost", "127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "169.254.169.254", "box.local", "[::1]"]) {
      const result = validateRecipe(withField({ updateUrl: `https://${host}/r.json` }));
      assert.ok(result.errors?.some((e) => e.rule === "url-host-not-allowed"), host);
    }
    assert.ok(validateRecipe(withField({ updateUrl: "https://raw.githubusercontent.com/o/r/main/r.json" })).ok);
  });

  it("a repository URL must be on a forge host", () => {
    const recipe = withField({ repos: [{ url: "https://gitlab.com/a/b.git", folder: "b" }] });
    assert.ok(ruleOf(validateRecipe(recipe)).includes("repos[0].url:url-host-not-allowed"));
    recipe.repos[0].url = "https://GITHUB.com/a/b.git";
    assert.ok(validateRecipe(recipe).ok, "host comparison ignores case");
    recipe.repos[0].url = "https://github.com:8443/a/b.git";
    assert.equal(validateRecipe(recipe).ok, false, "a port is not a listed host");
  });
});

describe("secret patterns", () => {
  it("every pattern has a positive and a near-miss fixture, and no fixture is orphaned", () => {
    assert.deepEqual(Object.keys(fixtures).filter((k) => !k.startsWith("_")).sort(), patterns.map((p) => p.id).sort());
    for (const p of patterns) {
      assert.ok(fixtures[p.id].positive.length >= 1, p.id);
      assert.ok(fixtures[p.id].nearMiss.length >= 1, p.id);
    }
  });

  const all = patterns.map((p) => ({ id: p.id, regex: new RegExp(p.regex, p.flags ?? "") }));
  for (const p of all) {
    it(`${p.id}: matches its positives and none of its near misses`, () => {
      for (const parts of fixtures[p.id].positive) assert.ok(p.regex.test(join0(parts)), `positive: ${parts[0]}…`);
      for (const parts of fixtures[p.id].nearMiss) assert.ok(!all.some((q) => q.regex.test(join0(parts))), `near miss matched: ${parts[0]}…`);
    });

    it(`${p.id}: a recipe holding the positive is refused, naming the field and not the value`, () => {
      for (const parts of fixtures[p.id].positive) {
        const secret = join0(parts);
        const result = validateRecipe(withField({ instructions: `Use ${secret} here.`, repos: [{ url: "https://github.com/a/b.git", folder: "b", label: secret }] }));
        assert.equal(result.ok, false);
        const found = result.errors.filter((e) => e.rule === "secret-pattern");
        assert.deepEqual(found.map((e) => e.field).sort(), ["(recipe).instructions", "(recipe).repos[0].label"]);
        assert.ok(found.every((e) => e.message.includes(p.id)));
        assert.ok(!JSON.stringify(result.errors).includes(secret));
      }
    });

    it(`${p.id}: near misses are accepted in free text`, () => {
      for (const parts of fixtures[p.id].nearMiss) {
        const result = validateRecipe(withField({ instructions: join0(parts) }));
        assert.ok(result.ok, `near miss refused: ${parts[0]}…: ${JSON.stringify(result.errors)}`);
      }
    });
  }

  it("a secret hides in no field: name, packages, nested arrays, and keys", () => {
    const secret = join0(fixtures["gitlab-personal-token"].positive[0]);
    const fields = [
      withField({ name: secret }),
      withField({ id: "x" + secret.toLowerCase() }),
      withField({ packages: [{ name: "p", version: "1.0.0", integrity: secret }] }),
      withField({ [secret]: 1 }),
    ];
    for (const recipe of fields) {
      const result = validateRecipe(recipe);
      assert.equal(result.ok, false);
      assert.ok(result.errors.every((e) => e.rule === "secret-pattern" && !e.message.includes(secret)));
    }
  });

  it("reports credentials before anything else", () => {
    const secret = join0(fixtures["github-classic-token"].positive[0]);
    const result = validateRecipe({ recipe: 1, name: secret, unknown: true });
    assert.ok(result.errors.every((e) => e.rule === "secret-pattern"));
  });
});

describe("fields", () => {
  const bad = (extra, field, rule) => {
    const result = validateRecipe(withField(extra));
    assert.equal(result.ok, false, `${field} should be refused`);
    assert.ok(result.errors.some((e) => e.field === field && e.rule === rule), `${field}/${rule}: ${ruleOf(result)}`);
  };

  it("requires recipe, id, name, version, forges", () => {
    for (const key of ["recipe", "id", "name", "version", "forges"]) {
      const recipe = base();
      delete recipe[key];
      const result = validateRecipe(recipe);
      assert.ok(result.errors.some((e) => e.rule === "missing-field" && e.field === key), key);
    }
  });

  it("asks to update the app for a newer schema, and refuses other numbers", () => {
    bad({ recipe: 2 }, "recipe", "unsupported-version");
    bad({ recipe: 0 }, "recipe", "bad-format");
    bad({ recipe: "1" }, "recipe", "bad-format");
  });

  it("checks id, name, version", () => {
    for (const id of ["A", "a", "-ab", "a b", "a".repeat(42), "ab_c"]) bad({ id }, "id", "bad-format");
    bad({ name: "n".repeat(61) }, "name", "too-long");
    bad({ name: "" }, "name", "bad-format");
    bad({ name: 5 }, "name", "wrong-type");
    for (const version of ["1", "1.0", "v1.0.0", "01.0.0", "1.0.0.0", "^1.0.0"]) bad({ version }, "version", "bad-format");
    assert.ok(validateRecipe(withField({ id: "ab", version: "1.2.3-rc.1+build.5", name: "n".repeat(60) })).ok);
  });

  it("checks forges", () => {
    bad({ forges: [] }, "forges", "bad-format");
    bad({ forges: "github" }, "forges", "wrong-type");
    bad({ forges: [{ kind: "bitbucket", host: "bitbucket.org" }] }, "forges[0].kind", "bad-format");
    bad({ forges: [{ kind: "github", host: "git.example.com" }] }, "forges[0].host", "forge-host");
    bad({ forges: [{ kind: "gitlab", host: "github.com" }] }, "forges[0].host", "forge-host");
    bad({ forges: [{ kind: "gitlab", host: "https://gitlab.example.com" }] }, "forges[0].host", "bad-format");
    bad({ forges: [{ kind: "gitlab", host: "gitlab.example.com:8443" }] }, "forges[0].host", "bad-format");
    bad({ forges: [{ kind: "gitlab", host: "GitLab.example.com" }] }, "forges[0].host", "bad-format");
    bad({ forges: [{ kind: "gitlab", host: "g.example.com", login: "password" }] }, "forges[0].login", "bad-format");
    bad({ forges: [{ kind: "gitlab", host: "g.example.com" }, { kind: "gitlab", host: "g.example.com" }] }, "forges[1].host", "duplicate");
    const ok = validateRecipe(withField({ forges: [{ kind: "github", host: "github.com" }, { kind: "gitlab", host: "g.example.com" }] }));
    assert.deepEqual(ok.recipe.forges.map((f) => f.login), ["device", "token"]);
  });

  it("checks repo folders", () => {
    const repo = (folder) => ({ repos: [{ url: "https://github.com/a/b.git", folder }] });
    for (const folder of ["..", ".", "a/b", "a\\b", "a:b", "a*", "a?", 'a"b', "a<b", "a|b", "a\nb", " a", "a ", "a.", ""]) {
      const result = validateRecipe(withField(repo(folder)));
      assert.equal(result.ok, false, JSON.stringify(folder));
    }
    for (const folder of ["CON", "con", "nul", "Aux", "PRN", "COM1", "lpt9", "con.txt"]) bad(repo(folder), "repos[0].folder", "reserved-name");
    for (const folder of ["COM0", "console", "官網", "my docs", "a.b", "文件 說明"]) assert.ok(validateRecipe(withField(repo(folder))).ok, folder);
    bad({ repos: [{ url: "https://github.com/a/b.git", folder: "x".repeat(65) }] }, "repos[0].folder", "too-long");
    bad({ repos: [{ url: "https://github.com/a/b.git", folder: "x" }, { url: "https://github.com/a/c.git", folder: "X" }] }, "repos[1].folder", "duplicate");
  });

  it("checks default branch names", () => {
    const repo = (defaultBranch) => ({ repos: [{ url: "https://github.com/a/b.git", folder: "b", defaultBranch }] });
    for (const name of ["main", "develop", "release/2026.10", "feature/a-b_c", "v1.0", "é"]) assert.ok(validateRecipe(withField(repo(name))).ok, name);
    for (const name of ["", "a b", "-a", "/a", "a/", "a..b", "a@{b", "@", "a~", "a^", "a:b", "a?", "a*", "a[", "a\\b", "a.lock", "a/.b", "a//b", "a."]) {
      assert.equal(validateRecipe(withField(repo(name))).ok, false, JSON.stringify(name));
    }
  });

  it("checks linear, instructions, packages, and profile", () => {
    bad({ linear: {} }, "linear.enabled", "missing-field");
    bad({ linear: { enabled: "yes" } }, "linear.enabled", "wrong-type");
    bad({ instructions: "x".repeat(4001) }, "instructions", "too-long");
    assert.ok(validateRecipe(withField({ instructions: "字".repeat(4000) })).ok, "length counts characters");
    bad({ instructions: "a\u0000b" }, "instructions", "bad-format");
    assert.ok(validateRecipe(withField({ instructions: "- a\n\t- b\r\n" })).ok);
    const integrity = "sha512-" + "A".repeat(86) + "==";
    assert.ok(validateRecipe(withField({ packages: [{ name: "@scope/pkg", version: "1.0.0", integrity }], profile: { version: "1.0.1", integrity } })).ok);
    bad({ packages: [{ name: "pkg", version: "^1.0.0", integrity }] }, "packages[0].version", "bad-format");
    bad({ packages: [{ name: "Pkg", version: "1.0.0", integrity }] }, "packages[0].name", "bad-format");
    bad({ packages: [{ name: "pkg", version: "1.0.0", integrity: "sha1-abc" }] }, "packages[0].integrity", "bad-format");
    bad({ packages: [{ name: "pkg", version: "1.0.0", integrity }, { name: "pkg", version: "1.0.1", integrity }] }, "packages[1].name", "duplicate");
    bad({ packages: [{ name: "straw-boss-desk-profile", version: "1.0.0", integrity }] }, "packages[0].name", "duplicate");
    bad({ profile: { version: "1.0.0" } }, "profile.integrity", "missing-field");
    bad({ profile: { version: "latest", integrity } }, "profile.version", "bad-format");
  });
});

describe("input handling", () => {
  it("rejects text that is not JSON without echoing it", () => {
    const result = validateRecipe('{ "recipe": 1, "name": "LEAKCHECK123" oops }');
    assert.deepEqual(result.errors.map((e) => e.rule), ["invalid-json"]);
    assert.ok(!JSON.stringify(result.errors).includes("LEAKCHECK"));
  });

  it("accepts a BOM, and non-object roots are refused", () => {
    assert.ok(validateRecipe("\ufeff" + JSON.stringify(base())).ok);
    for (const root of ["[]", "null", "5", '"x"']) assert.equal(validateRecipe(root).ok, false, root);
  });

  it("refuses a file over the size limit", () => {
    const result = validateRecipe(JSON.stringify(withField({ instructions: "x".repeat(MAX_RECIPE_BYTES) })));
    assert.deepEqual(result.errors.map((e) => e.rule), ["too-large"]);
  });

  it("refuses deep nesting instead of recursing without bound", () => {
    let deep = {};
    for (let i = 0; i < 50; i++) deep = { a: deep };
    const result = validateRecipe(withField({ straw: deep }));
    assert.ok(result.errors.some((e) => e.rule === "too-deep"));
  });

  it("is not fooled by a __proto__ key", () => {
    const result = validateRecipe('{ "recipe": 1, "id": "ab", "name": "n", "version": "1.0.0", "forges": [{"kind":"github","host":"github.com"}], "__proto__": {"x":1} }');
    assert.ok(result.errors.some((e) => e.rule === "unknown-field"));
    assert.equal({}.x, undefined);
  });

  it("returns a normalized copy, not the input", () => {
    const input = base();
    const result = validateRecipe(input);
    assert.notEqual(result.recipe, input);
    assert.equal(input.forges[0].login, undefined, "the input is untouched");
  });
});

describe("schema", () => {
  const schema = readJson("recipe.schema.json");

  it("is closed at every object level and lists the validator's fields", () => {
    const objects = [
      ["recipe", schema],
      ["forge", schema.properties.forges.items],
      ["repo", schema.properties.repos.items],
      ["straw", schema.properties.straw],
      ["linear", schema.properties.linear],
      ["package", schema.properties.packages.items],
      ["profile", schema.properties.profile],
    ];
    for (const [name, node] of objects) {
      assert.equal(node.additionalProperties, false, name);
      assert.deepEqual(Object.keys(node.properties).sort(), [...KNOWN_FIELDS[name]].sort(), name);
    }
  });

  it("requires the fields the validator requires", () => {
    assert.deepEqual([...schema.required].sort(), ["forges", "id", "name", "recipe", "version"]);
  });

  it("agrees with the validator on the examples' field shapes", () => {
    assert.equal(schema.properties.recipe.const, 1);
    assert.equal(new RegExp(schema.properties.id.pattern).test("waydo-pm"), true);
    assert.equal(new RegExp(schema.$defs.hostname.pattern).test("gitlab.waydo.example"), true);
    assert.equal(new RegExp(schema.$defs.httpsUrl.pattern).test("https://raw.githubusercontent.com/waydo/recipes/main/waydo-pm.json"), true);
    assert.equal(new RegExp(schema.$defs.httpsUrl.pattern).test("https://user:pw@host/x"), false);
    assert.equal(new RegExp(schema.$defs.httpsUrl.pattern).test("https://host/x?q=1"), false);
    assert.equal(new RegExp(schema.$defs.httpsUrl.pattern).test("http://host/x"), false);
  });
});
