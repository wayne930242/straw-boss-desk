// Which button of a start failure is the primary one (SA-10). A failure screen has Try again and, for some kinds, Repair; when the sentence tells the PM to run Repair, that is the action
// to take, so it gets the accent and Try again does not. Plain data and no DOM, so the shell's runtime page and the wizard's start step share it and a test can read it.

/**
 * The start failure kinds whose sentence, in both catalogs, says "Run Repair" (「執行「修復」」). A test derives this list from the catalogs, so a sentence that starts to name Repair, or stops
 * naming it, cannot leave the list behind.
 */
export const REPAIR_NAMED_KINDS: readonly string[] = ["tool-missing", "engine-locked", "package-unsafe", "install-interrupted", "state-unreadable", "sb-unverified", "loader", "intercom"];

export const namesRepair = (kind: string): boolean => REPAIR_NAMED_KINDS.includes(kind);

/** Whether the screen shows Repair: the failure offers it, or its sentence tells the PM to run it (a button the sentence names must be there). */
export const showsRepair = (failure: { kind: string; offerRepair?: boolean }): boolean => failure.offerRepair === true || namesRepair(failure.kind);

/** The primary button: Repair when the sentence names it and it is shown, else Try again. */
export const primaryAction = (failure: { kind: string; offerRepair?: boolean }): "repair" | "retry" => (showsRepair(failure) && namesRepair(failure.kind) ? "repair" : "retry");
