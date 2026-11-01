// Failure categories and their plain sentences (spec: Bootstrap engine, Logs and failures). The UI shows the sentence with Retry and Details;
// `params` carries what the zh-TW catalog needs to say the same thing.

export type FailureCategory = "network" | "integrity" | "registry" | "disk" | "locked" | "other";

export interface FailureParams {
	/** network: the host that could not be reached. */
	host?: string;
	/** integrity: the tool whose download did not match. */
	tool?: string;
	/** registry: `<name>@<version>`. */
	what?: string;
	/** other: the stage that failed. */
	stage?: string;
}

/** Whether the engine tries a category again by itself, once, after the retry delay. Integrity is never retried: the bytes will not change. */
export const RETRIED_ONCE: Readonly<Record<FailureCategory, boolean>> = {
	network: true,
	integrity: false,
	registry: true,
	disk: false,
	locked: true,
	other: false,
};

export function failureSentence(category: FailureCategory, params: FailureParams): string {
	switch (category) {
		case "network":
			return `Could not reach ${params.host ?? "the server"}. Check the network and try again.`;
		case "integrity":
			return `The download of ${params.tool ?? "a tool"} did not match its published checksum, so nothing was installed.`;
		case "registry":
			return `The npm registry could not be reached or is out of date, so ${params.what ?? "a package"} was not installed. Check the network and try again; nothing was installed in its place.`;
		case "disk":
			return "There is not enough free space on the disk.";
		case "locked":
			return "A file was in use (often antivirus scanning it).";
		case "other":
			return `${params.stage ?? "A step"} failed.`;
	}
}

/** A failure of a stage with its category. `message` is the technical detail for the log; `sentence` is what the PM reads. */
export class StageError extends Error {
	readonly category: FailureCategory;
	readonly params: FailureParams;

	constructor(category: FailureCategory, params: FailureParams, detail: string, options?: { cause?: unknown }) {
		super(detail, options);
		this.name = "StageError";
		this.category = category;
		this.params = params;
	}

	get sentence(): string {
		return failureSentence(this.category, this.params);
	}
}

const NETWORK_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ECONNABORTED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ETIMEDOUT",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EPIPE",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_SOCKET",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
]);
const LOCKED_CODES = new Set(["EBUSY", "EPERM", "EACCES", "EMFILE", "ENFILE", "ETXTBSY", "ENOTEMPTY"]);
const DISK_CODES = new Set(["ENOSPC", "EDQUOT"]);

function codeOf(error: unknown): string | undefined {
	for (let e: unknown = error, depth = 0; e instanceof Error && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
		const code = (e as NodeJS.ErrnoException).code;
		if (typeof code === "string") return code;
	}
	return undefined;
}

/** Turns anything a stage threw into a `StageError`: its own category when it already has one, else one chosen by the error code. */
export function classifyError(error: unknown, stage: string): StageError {
	if (error instanceof StageError) return error;
	const detail = error instanceof Error ? error.message : String(error);
	const code = codeOf(error);
	if (code !== undefined && DISK_CODES.has(code)) return new StageError("disk", {}, detail, { cause: error });
	if (code !== undefined && NETWORK_CODES.has(code)) return new StageError("network", { host: "the server" }, detail, { cause: error });
	if (code !== undefined && LOCKED_CODES.has(code)) return new StageError("locked", {}, detail, { cause: error });
	return new StageError("other", { stage }, detail, { cause: error });
}
