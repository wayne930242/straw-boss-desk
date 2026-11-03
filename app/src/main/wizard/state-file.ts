import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../bootstrap/fsutil.ts";
import type { Layout } from "../paths.ts";
import { LOCALES, type Locale } from "../../shared/locale.ts";
import { WIZARD_STEPS, type Forge, type LaterItem, type WizardStep } from "../../shared/wizard.ts";

// `state/wizard.json` (spec: Resume): where the wizard is, so a quit, a crash, or a reboot opens it on the step where it stopped. It holds choices, never a secret: the language, the work
// folder, the recipe's file name, the code hosts of "I have no recipe", and the sign-ins put off. `runtime/config.ts` reads `workFolder` from it at every start.

export interface WizardFile {
	schema: 1;
	step: WizardStep;
	/** True once the PM pressed the last button: the wizard never shows again. */
	done: boolean;
	locale?: Locale;
	workFolder?: string;
	/** The accepted recipe's file name as the PM gave it, shown in the trust screen's source line. */
	recipeFile?: string;
	/** "I have no recipe": the code hosts the PM named. */
	noRecipeForges?: Forge[];
	later: LaterItem[];
	/** The forge the hosts step is at. */
	hostsIndex: number;
}

export const FRESH: WizardFile = { schema: 1, step: "welcome", done: false, later: [], hostsIndex: 0 };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): value is string => typeof value === "string" && value !== "";

function forgeOf(value: unknown): Forge | null {
	if (!isObject(value) || (value.kind !== "github" && value.kind !== "gitlab") || !str(value.host)) return null;
	return { kind: value.kind, host: value.host };
}

function laterOf(value: unknown): LaterItem | null {
	if (!isObject(value)) return null;
	if (value.item === "claude" || value.item === "linear") return { item: value.item };
	if ((value.item === "github" || value.item === "gitlab") && str(value.host)) return { item: value.item, host: value.host };
	return null;
}

/** The record in `text`, or null when it is not a wizard record. Unknown fields are dropped; a field of the wrong shape is dropped, not trusted. */
export function parseWizardFile(text: string): WizardFile | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isObject(parsed) || parsed.schema !== 1) return null;
	const known = (WIZARD_STEPS as readonly unknown[]).includes(parsed.step) ? (parsed.step as WizardStep) : "welcome";
	// The trust step cannot be resumed: the accepted recipe is held in memory until Apply and nothing is written before it, so a record at `trust` is read as the recipe step (T9-F001).
	const step: WizardStep = known === "trust" ? "recipe" : known;
	const file: WizardFile = {
		schema: 1,
		step,
		done: parsed.done === true,
		later: (Array.isArray(parsed.later) ? parsed.later : []).map(laterOf).filter((i): i is LaterItem => i !== null),
		hostsIndex: typeof parsed.hostsIndex === "number" && Number.isInteger(parsed.hostsIndex) && parsed.hostsIndex >= 0 ? parsed.hostsIndex : 0,
	};
	if ((LOCALES as readonly unknown[]).includes(parsed.locale)) file.locale = parsed.locale as Locale;
	if (str(parsed.workFolder)) file.workFolder = parsed.workFolder;
	if (str(parsed.recipeFile)) file.recipeFile = parsed.recipeFile;
	if (Array.isArray(parsed.noRecipeForges)) file.noRecipeForges = parsed.noRecipeForges.map(forgeOf).filter((f): f is Forge => f !== null);
	return file;
}

const fileOf = (layout: Layout): string => join(layout.state, "wizard.json");

/** The record, or null when there is none (a first run, or an install no wizard made). */
export function readWizardFile(layout: Layout): WizardFile | null {
	try {
		return parseWizardFile(readFileSync(fileOf(layout), "utf8"));
	} catch {
		return null;
	}
}

export function writeWizardFile(layout: Layout, file: WizardFile): void {
	writeFileAtomic(fileOf(layout), `${JSON.stringify(file, null, "\t")}\n`);
}
