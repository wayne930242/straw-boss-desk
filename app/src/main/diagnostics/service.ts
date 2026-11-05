import { join } from "node:path";
import type { CollectState, DiagnosticsAction, DiagnosticsView, RepairState, StatusState } from "../../shared/computer.ts";
import type { Layout } from "../paths.ts";
import type { RuntimeEvent } from "../runtime/log.ts";
import { collectDiagnostics, type Redact } from "./collect.ts";
import { statusFields } from "./status.ts";

// Settings' Diagnostics section (spec: Settings, Diagnostics): the stack's status (one `cli.mjs status`, on a button), **Open logs folder**, **Collect diagnostics** and **Repair**. It knows no
// Electron: the status call, the folder opener, the downloads folder and the repair come in as dependencies, so every rule here runs under plain Node.

export interface DiagnosticsDeps {
	layout: Layout;
	redactor: Redact;
	/** `Supervisor.cliStatus`: the raw output of one `cli.mjs status`, or why it was not run. */
	status(): Promise<{ ok: true; stdout: string } | { ok: false; reason: "not-installed" | "package" | "busy" | "failed"; detail: string }>;
	/** The folder the zip goes to (the PM's Downloads). */
	downloads(): string;
	/** The lines of `diagnostics.txt`: the app, its build, the platform. */
	facts(): Record<string, string>;
	/** Opens a folder in the file manager; resolves to an error text, or "" (`shell.openPath`). */
	openPath(path: string): Promise<string>;
	/** Shows a file in its folder (`shell.showItemInFolder`). */
	reveal(file: string): void;
	/** Repair: the engine runs again with the stack stopped (`WizardController.repair`), and a stack that was not running is started after. */
	repair(): Promise<{ ok: boolean; detail: string }>;
	/** Windows: `bash` in a pane would be WSL's (the same sentence as the banner). */
	wslBash(): string | null;
	log: RuntimeEvent;
	now?: () => Date;
}

const two = (n: number): string => String(n).padStart(2, "0");

/** `straw-boss-diagnostics-20261105-143012.zip`, from local time. */
export const zipName = (now: Date): string => `straw-boss-diagnostics-${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}.zip`;

export class DiagnosticsService {
	readonly #d: DiagnosticsDeps;
	readonly #listeners = new Set<() => void>();
	#status: StatusState = { phase: "idle" };
	#collect: CollectState = { phase: "idle" };
	#repair: RepairState = { phase: "idle" };

	constructor(deps: DiagnosticsDeps) {
		this.#d = deps;
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(): void {
		for (const l of this.#listeners) l();
	}

	view(): DiagnosticsView {
		return { status: this.#status, collect: this.#collect, repair: this.#repair, logsDir: this.#d.layout.logs, wslBash: this.#d.wslBash() };
	}

	async act(action: DiagnosticsAction): Promise<void> {
		switch (action.type) {
			case "diagnostics-status":
				return this.readStatus();
			case "diagnostics-open-logs":
				return this.openLogs();
			case "diagnostics-collect":
				return this.collect();
			case "diagnostics-reveal":
				if (this.#collect.phase === "done") this.#d.reveal(this.#collect.file);
				return;
			case "diagnostics-repair":
				return this.repair();
		}
	}

	async readStatus(): Promise<void> {
		if (this.#status.phase === "reading") return;
		this.#status = { phase: "reading" };
		this.#emit();
		try {
			const answer = await this.#d.status();
			if (!answer.ok) this.#status = { phase: "failed", reason: answer.reason, detail: answer.detail };
			else {
				const fields = statusFields(answer.stdout);
				this.#status = fields === null ? { phase: "failed", reason: "failed", detail: "the status is not JSON" } : { phase: "ok", fields, at: (this.#d.now?.() ?? new Date()).toISOString() };
			}
		} catch (error) {
			this.#status = { phase: "failed", reason: "failed", detail: this.#d.redactor.redact(firstLine((error as Error).message)) };
		}
		this.#emit();
	}

	async openLogs(): Promise<void> {
		const problem = await this.#d.openPath(this.#d.layout.logs);
		if (problem !== "") this.#d.log({ event: "open-logs-failed", detail: this.#d.redactor.redact(firstLine(problem)) });
	}

	async collect(): Promise<void> {
		if (this.#collect.phase === "working") return;
		this.#collect = { phase: "working" };
		this.#emit();
		// The listing and the zip are synchronous file work: yield first, so the page shows "working" before the main process is busy.
		await new Promise<void>((resolve) => setImmediate(resolve));
		try {
			const now = this.#d.now?.() ?? new Date();
			const file = join(this.#d.downloads(), zipName(now));
			const result = collectDiagnostics({ layout: this.#d.layout, redactor: this.#d.redactor, file, facts: this.#d.facts(), now: () => now });
			this.#collect = { phase: "done", file: result.file, files: result.names.length, skipped: result.skipped.length };
			this.#d.log({ event: "diagnostics-collected", files: result.names.length, skipped: result.skipped.length });
			this.#d.reveal(result.file);
		} catch (error) {
			const detail = this.#d.redactor.redact(firstLine((error as Error).message));
			this.#collect = { phase: "failed", detail };
			this.#d.log({ event: "diagnostics-failed", detail });
		}
		this.#emit();
	}

	async repair(): Promise<void> {
		if (this.#repair.phase === "working") return;
		this.#repair = { phase: "working" };
		this.#emit();
		try {
			const outcome = await this.#d.repair();
			this.#repair = outcome.ok ? { phase: "done" } : { phase: "failed", detail: this.#d.redactor.redact(outcome.detail) };
		} catch (error) {
			this.#repair = { phase: "failed", detail: this.#d.redactor.redact(firstLine((error as Error).message)) };
		}
		// The stack is back (or not): the status read before is stale now.
		if (this.#status.phase === "ok") this.#status = { phase: "idle" };
		this.#emit();
	}
}

const firstLine = (text: string): string => text.split(/\r?\n/)[0]?.slice(0, 400) ?? "";
