import type { Recipe } from "../../../../recipe/validate.d.mts";
import type { RecipeChange } from "../../shared/recipe-update.ts";
import type { RepoSpec } from "../projects/runner.ts";

// What an update changes, item by item (team-profile section 5, "Trust: show before applying": "for an update, only what changes"). Pure: two validated recipes in, the change list out. The same
// two recipes also say whether the install step must run (`needsInstall`) and what the projects step does (`repoSpecs`).

const hostOf = (url: string): string => {
	try {
		return new URL(url).host;
	} catch {
		return "";
	}
};

const updateHost = (recipe: Recipe): string | null => (recipe.updateUrl === undefined ? null : hostOf(recipe.updateUrl));

/** `after` against `before`; `before` null is no recipe at all (the "I have no recipe" choice), so everything `after` has is new. `toolVersion` gives the version `stack.json` pins for a tool. */
export function recipeChanges(before: Recipe | null, after: Recipe, toolVersion: (name: string) => string | null): RecipeChange[] {
	const out: RecipeChange[] = [];
	if (before === null || before.name !== after.name) out.push({ kind: "name", from: before?.name ?? "", to: after.name });
	if (before === null || before.version !== after.version) out.push({ kind: "version", from: before?.version ?? "", to: after.version });
	const key = (f: { kind: string; host: string }): string => `${f.kind}:${f.host}`;
	const oldForges = new Map((before?.forges ?? []).map((f) => [key(f), f]));
	const newForges = new Map(after.forges.map((f) => [key(f), f]));
	for (const [k, f] of newForges) if (!oldForges.has(k)) out.push({ kind: "forge-added", forge: f.kind, host: f.host });
	for (const [k, f] of oldForges) if (!newForges.has(k)) out.push({ kind: "forge-removed", forge: f.kind, host: f.host });

	const oldRepos = new Map((before?.repos ?? []).map((r) => [r.folder, r]));
	const newRepos = new Map((after.repos ?? []).map((r) => [r.folder, r]));
	for (const [folder, r] of newRepos) {
		const was = oldRepos.get(folder);
		if (was === undefined) {
			out.push({ kind: "repo-added", folder, host: hostOf(r.url), label: r.label, defaultBranch: r.defaultBranch ?? null });
			continue;
		}
		if (was.url !== r.url) out.push({ kind: "repo-url", folder, host: hostOf(r.url) });
		if ((was.defaultBranch ?? null) !== (r.defaultBranch ?? null)) out.push({ kind: "repo-branch", folder, from: was.defaultBranch ?? null, to: r.defaultBranch ?? null });
		if (was.label !== r.label) out.push({ kind: "repo-label", folder, from: was.label, to: r.label });
	}
	for (const folder of oldRepos.keys()) if (!newRepos.has(folder)) out.push({ kind: "repo-removed", folder });

	const relayBefore = before?.straw?.relay ?? null;
	const relayAfter = after.straw?.relay ?? null;
	if (relayBefore !== relayAfter) out.push({ kind: "relay", from: relayBefore, to: relayAfter });
	const linearBefore = before?.linear?.enabled === true;
	const linearAfter = after.linear?.enabled === true;
	if (linearBefore !== linearAfter) out.push({ kind: "linear", to: linearAfter });

	const toolsBefore = new Set(before?.tools ?? []);
	const toolsAfter = new Set(after.tools ?? []);
	for (const name of toolsAfter) if (!toolsBefore.has(name)) out.push({ kind: "tool-added", name, version: toolVersion(name) });
	for (const name of toolsBefore) if (!toolsAfter.has(name)) out.push({ kind: "tool-removed", name });

	const profileBefore = before?.profile?.version ?? null;
	const profileAfter = after.profile?.version ?? null;
	if (profileBefore !== profileAfter || before?.profile?.integrity !== after.profile?.integrity) out.push({ kind: "profile", from: profileBefore, to: profileAfter });

	const pkgBefore = new Map((before?.packages ?? []).map((p) => [p.name, p]));
	const pkgAfter = new Map((after.packages ?? []).map((p) => [p.name, p]));
	for (const [name, p] of pkgAfter) {
		const was = pkgBefore.get(name);
		if (was === undefined) out.push({ kind: "package-added", name, version: p.version });
		else if (was.version !== p.version || was.integrity !== p.integrity) out.push({ kind: "package-changed", name, from: was.version, to: p.version });
	}
	for (const name of pkgBefore.keys()) if (!pkgAfter.has(name)) out.push({ kind: "package-removed", name });

	if ((before?.instructions ?? "") !== (after.instructions ?? "")) out.push({ kind: "instructions", text: after.instructions === undefined || after.instructions === "" ? null : after.instructions });
	const hostBefore = before === null ? null : updateHost(before);
	const hostAfter = updateHost(after);
	if (hostBefore !== hostAfter) out.push({ kind: "update-host", from: hostBefore, to: hostAfter });
	return out;
}

/** Whether applying `after` over `before` needs an engine run: the forges (the CLIs), the tools, the packages, the profile pin, the relay and the instructions are written by stages. */
export function needsInstall(before: Recipe | null, after: Recipe): boolean {
	const part = (r: Recipe | null): string =>
		JSON.stringify({
			forges: (r?.forges ?? []).map((f) => `${f.kind}:${f.host}`).sort(),
			tools: [...(r?.tools ?? [])].sort(),
			packages: (r?.packages ?? []).map((p) => `${p.name}@${p.version}:${p.integrity}`).sort(),
			profile: r?.profile ?? null,
			relay: r?.straw?.relay ?? null,
			instructions: r?.instructions ?? "",
			// The recipe's identity is part of what the installer records (`## Team: <name>`, its manifest).
			id: r?.id ?? null,
			name: r?.name ?? null,
			version: r?.version ?? null,
		});
	return part(before) !== part(after);
}

/** The repositories of a recipe as the projects step takes them. */
export const repoSpecs = (recipe: Recipe | null): RepoSpec[] => (recipe?.repos ?? []).map((r) => ({ url: r.url, folder: r.folder, label: r.label, ...(r.defaultBranch !== undefined ? { defaultBranch: r.defaultBranch } : {}) }));
