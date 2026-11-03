import type { Recipe } from "../../../../recipe/validate.d.mts";
import type { PlatformKey, Stack } from "../bootstrap/stack.ts";
import type { TrustModel } from "../../shared/wizard.ts";

// **Trust: show before applying** (team-profile section 5): everything the recipe will do, in plain data, before anything is installed, cloned, or written. The page words it.

/** True when semver `a` is older than `b` by major, minor, patch (a prerelease tag is ignored: the comparison only flags an older profile). */
export function olderVersion(a: string, b: string): boolean {
	const nums = (v: string): number[] => v.split(/[-+]/)[0]?.split(".").map((n) => Number.parseInt(n, 10) || 0) ?? [];
	const x = nums(a);
	const y = nums(b);
	for (let i = 0; i < 3; i++) {
		if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
	}
	return false;
}

export interface TrustInput {
	recipe: Recipe;
	stack: Stack;
	key: PlatformKey;
	fileName: string;
	sha256: string;
}

export function trustModelOf({ recipe, stack, key, fileName, sha256 }: TrustInput): TrustModel {
	return {
		name: recipe.name,
		version: recipe.version,
		source: fileName,
		sha256,
		forges: recipe.forges.map((f) => ({ kind: f.kind, host: f.host, cli: f.kind === "github" ? ("gh" as const) : ("glab" as const) })),
		repos: (recipe.repos ?? []).map((r) => ({ url: r.url, host: new URL(r.url).host, folder: r.folder, label: r.label ?? r.folder, defaultBranch: r.defaultBranch ?? null })),
		relay: recipe.straw?.relay ?? null,
		tools: (recipe.tools ?? []).map((name) => ({ name, version: stack.optionalTools[name]?.assets[key]?.version ?? null })),
		profile: recipe.profile === undefined ? null : { version: recipe.profile.version, olderThanDefault: olderVersion(recipe.profile.version, stack.profile.version) },
		instructions: recipe.instructions === undefined || recipe.instructions === "" ? null : recipe.instructions,
		packages: (recipe.packages ?? []).map((p) => ({ name: p.name, version: p.version })),
		linear: recipe.linear?.enabled === true,
	};
}
