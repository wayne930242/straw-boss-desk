import type { Stack } from "../stack.ts";
import type { Stage } from "../stage.ts";

/**
 * The stages of the install, in no particular order (the graph orders them by `needs`). Tasks 5 to 7 add the tool, pi, and profile stages here; the
 * engine core runs whatever this returns, and an empty list is a run that has nothing to do.
 */
export const allStages = (_stack: Stack): Stage[] => [];
