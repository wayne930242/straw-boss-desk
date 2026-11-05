export interface RecipeError {
  /** Path of the offending field, e.g. `repos[0].url`; never its value. */
  field: string;
  /** Stable rule id, e.g. `unknown-field`, `url-userinfo`, `secret-pattern`. */
  rule: string;
  message: string;
}

export interface Recipe {
  recipe: 1;
  id: string;
  name: string;
  version: string;
  updateUrl?: string;
  profile?: { version: string; integrity: string };
  forges: { kind: "github" | "gitlab"; host: string; login: "device" | "token" }[];
  repos?: { url: string; folder: string; defaultBranch?: string; label: string }[];
  straw?: { relay?: string };
  linear?: { enabled: boolean };
  instructions?: string;
  /** Optional tools the recipe turns on, each once, in the order written. */
  tools?: string[];
  packages?: { name: string; version: string; integrity: string }[];
}

export type RecipeResult = { ok: true; recipe: Recipe } | { ok: false; errors: RecipeError[] };

export const RECIPE_VERSION: 1;
export const MAX_RECIPE_BYTES: number;
export const PROFILE_PACKAGE: string;
/** The home base's folder name inside the work folder; `repos[].folder` may not be it (rule `reserved-folder`, compared without regard to case). */
export const HOME_BASE_FOLDER: string;
export const KNOWN_FIELDS: Record<string, string[]>;
export interface ValidateOptions {
  /** Package names the app installs itself (the names in stack.json); a recipe may not list them. Required: pass `[]` for none. A string or a missing option throws a TypeError. */
  reservedPackages: Iterable<string>;
  /** The names under `stack.json`'s `optionalTools`. When given, a `tools` entry outside it is refused with the rule `unknown-tool`; when omitted, only the shape of each entry is checked. `undefined` or `null` means the same as omitted; a string or another non-iterable throws a `TypeError`. */
  knownTools?: Iterable<string>;
}
export function validateRecipe(input: unknown, options: ValidateOptions): RecipeResult;
/** True when a URL host name (`URL.hostname`) is local or private by its name alone: `localhost`, a single-label or trailing-dot name, `.local` and its kin, an IPv6 literal, or a private, loopback, link-local, shared, protocol-assignment, benchmarking, multicast or reserved IPv4 address. The fetcher checks the resolved address as well. */
export function privateOrLocalHost(hostname: string): boolean;
