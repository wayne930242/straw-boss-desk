import type { ShellFailure, ShellState } from "../shared/shell-state.ts";
import type { StartFailure } from "./runtime/failure.ts";
import type { BannerKind, Screen } from "./runtime/follow.ts";

// The supervisor's words become the shell page's state (`shared/shell-state.ts`). Only data crosses: the kind picks the catalog's sentence in the page, and the page never sees more of a
// failure than its kind, the masked first line the tool said, the pid of a leftover, and whether Repair is offered.

export function failureState(failure: StartFailure): ShellState {
	const shown: ShellFailure = {
		kind: failure.kind,
		reason: failure.reason,
		...(failure.unverifiedSb !== undefined ? { pid: failure.unverifiedSb } : {}),
		...(failure.leftovers !== undefined && failure.leftovers.length > 0 ? { leftovers: failure.leftovers.map((l) => ({ pid: l.pid, file: l.file })) } : {}),
		...(failure.offerRepair === true ? { offerRepair: true } : {}),
	};
	return { mode: "screen", screen: "failed", failure: shown };
}

export function screenState(screen: Screen): ShellState {
	return screen.kind === "failed" ? failureState(screen.failure) : { mode: "screen", screen: screen.kind };
}

export const bannerState = (kind: BannerKind | undefined): ShellState => (kind === undefined ? { mode: "none" } : { mode: "banner", banner: kind });
