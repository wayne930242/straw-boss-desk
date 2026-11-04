import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The pure decisions of the code-host verdict (spec: The code-host screens, **After either**), ported from the kit's `spike/win/lib/account-verdict.mjs` and `account-verdict.ps1`. The rule they
// enforce (team-profile section 4, **Where the token goes**): a login is removed only on positive evidence that its token is in plain text. A status that cannot be read is "could not verify":
// the step fails, and the login in the credential store stays. Nothing here runs a program; the callers pass in what the CLIs printed. Followup R3-F001: keys and sections compare without case,
// and the body of a multi-line value is skipped, so a `token:` line inside a block scalar is not read as a key.

export interface YamlEntry {
	/** The keys above this line, outermost first. */
	path: string[];
	key: string;
	/** The value with its quotes and a trailing comment removed; empty when the line opens a block. */
	value: string;
}

/**
 * The key/value lines of a YAML text with the keys above each of them. gh's and glab's files are plain block mappings, so the nesting is the indentation. One entry per `key: value` line.
 * Lists are not followed. Once a key has a value on its own line (`key: text`, `key: |`, `key: >-`), every following line indented deeper than that key is the rest of that value, not
 * a key of its own (R3-F001).
 */
export function yamlEntries(text: string): YamlEntry[] {
	const entries: YamlEntry[] = [];
	const stack: Array<{ indent: number; key: string }> = [];
	/** Set after a line that has a value: lines deeper than this are its continuation. */
	let bodyOf: number | null = null;
	for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
		if (/^\s*(#|$)/.test(line)) continue;
		const indent = /^\s*/.exec(line)?.[0].length ?? 0;
		if (bodyOf !== null) {
			if (indent > bodyOf) continue;
			bodyOf = null;
		}
		if (/^\s*-(\s|$)/.test(line)) continue;
		const m = /^(\s*)(?:"([^"]*)"|'([^']*)'|(.+?))\s*:(?:\s+(.*))?$/.exec(line);
		if (m === null) continue;
		const key = m[2] ? m[2] : m[3] ? m[3] : (m[4] ?? "");
		const raw = (m[5] ?? "").replace(/(^|\s)#.*$/, "").trim().replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");
		while (stack.length > 0 && (stack[stack.length - 1] as { indent: number }).indent >= indent) stack.pop();
		entries.push({ path: stack.map((s) => s.key), key, value: raw });
		if (raw === "") stack.push({ indent, key });
		else bodyOf = indent;
	}
	return entries;
}

export function yamlEntriesOfFile(path: string): YamlEntry[] {
	return existsSync(path) ? yamlEntries(readFileSync(path, "utf8")) : [];
}

/** A non-empty value that is a token: not an empty string and not YAML's null spellings. */
export const isTokenValue = (value: string): boolean => value !== "" && !["!!null", "null", "~"].includes(value.toLowerCase());

export interface HostTokenFindings {
	/** Non-empty token lines in the checked host's own block. */
	own: number;
	/** The other hosts that carry a token; `(no host)` for one with no host above it. Never a value. */
	other: string[];
}

export interface HostTokenQuery {
	host: string;
	/** `oauth_token` (gh) or `token` (glab). */
	key: string;
	/** The keys above the host entries: none for gh's `hosts.yml`, `["hosts"]` for glab's `config.yml` and gh's legacy `config.yml`. */
	prefix?: readonly string[];
	/** The key must be a direct child of the host entry (glab); otherwise any depth below (gh nests it under `users: <account>:`). */
	directOnly?: boolean;
}

/** Only the host's own block is evidence for that host's login; a `token` key anywhere else (an alias, another section, another host) is no evidence for it. */
export function hostTokenFindings(entries: readonly YamlEntry[], { host, key, prefix = [], directOnly = false }: HostTokenQuery): HostTokenFindings {
	let own = 0;
	const other = new Set<string>();
	for (const e of entries) {
		if (e.key.toLowerCase() !== key.toLowerCase() || !isTokenValue(e.value)) continue;
		const p = e.path;
		if (p.length < prefix.length) continue;
		if (!prefix.every((k, i) => (p[i] as string).toLowerCase() === k.toLowerCase())) continue;
		if (p.length === prefix.length) {
			other.add("(no host)");
			continue;
		}
		const h = p[prefix.length] as string;
		if (h.toLowerCase() === host.toLowerCase()) {
			if (directOnly && p.length !== prefix.length + 1) continue;
			own++;
		} else other.add(h);
	}
	return { own, other: [...other] };
}

export interface Verdict {
	/** Positive evidence of a plain-text token: remove the login. */
	plain: boolean;
	/** The token is in the credential store. */
	verified: boolean;
	reason: string;
}

/**
 * gh's answer. `source` is the `tokenSource` gh reported (null: the status failed or the field was missing or blank); `hostsTokens` and `configTokens` are the counts of non-empty token
 * lines in `hosts.yml` and `config.yml`.
 */
export function ghTokenVerdict({ source, hostsTokens, configTokens }: { source: string | null; hostsTokens: number; configTokens: number }): Verdict {
	const src = source ?? "";
	const lsrc = src.toLowerCase();
	if (lsrc === "oauth_token" || /[\\/]/.test(src) || /\.ya?ml$/.test(lsrc)) {
		return { plain: true, verified: false, reason: `gh reports the token source as '${src}' (a file), not the keyring` };
	}
	if (hostsTokens + configTokens > 0) {
		return { plain: true, verified: false, reason: `a non-empty token line is in hosts.yml (${hostsTokens}) or config.yml (${configTokens})` };
	}
	if (src.trim() === "") {
		return { plain: false, verified: false, reason: "could not verify: gh reported no tokenSource (status failed or the field is missing); this is not a plain-text verdict, so no logout" };
	}
	if (lsrc === "keyring") return { plain: false, verified: true, reason: "tokenSource is 'keyring'" };
	return { plain: false, verified: false, reason: `tokenSource is '${src}', not the keyring, and no token is in a file; not a plain-text verdict, so no logout (an environment token wins over the login)` };
}

/** glab's answer. Only `config.yml` decides plain text; a failed `glab auth status` is "could not verify". */
export function glabTokenVerdict({ configTokens, statusExit }: { configTokens: number; statusExit: number | null }): Verdict {
	if (configTokens > 0) return { plain: true, verified: false, reason: `config.yml holds ${configTokens} non-empty token line(s)` };
	if (statusExit !== 0) {
		return { plain: false, verified: false, reason: `could not verify: glab auth status exited ${statusExit} (network, certificate, or token problem); this is not a plain-text verdict, so no logout` };
	}
	return { plain: false, verified: true, reason: "config.yml holds no token and glab auth status succeeded" };
}

/** The `tokenSource` of the host's first account in `gh auth status --json hosts`; null when the output is not that JSON or the field is missing or not a string. */
export function ghTokenSource(statusJson: string, host: string): { source: string | null; login: string | null } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(statusJson);
	} catch {
		return { source: null, login: null };
	}
	const hosts = typeof parsed === "object" && parsed !== null ? (parsed as { hosts?: unknown }).hosts : undefined;
	if (typeof hosts !== "object" || hosts === null) return { source: null, login: null };
	const key = Object.keys(hosts).find((k) => k.toLowerCase() === host.toLowerCase());
	const list = key === undefined ? undefined : (hosts as Record<string, unknown>)[key];
	const first = Array.isArray(list) ? list[0] : list;
	if (typeof first !== "object" || first === null) return { source: null, login: null };
	const f = first as { tokenSource?: unknown; login?: unknown };
	return { source: typeof f.tokenSource === "string" ? f.tokenSource : null, login: typeof f.login === "string" ? f.login : null };
}

// ---- the files the verdict reads ------------------------------------------------------------------------------------------

/** gh's `hosts.yml` and `config.yml` token counts for `host` under the app's own configuration folder. */
export function ghFileFindings(ghConfigDir: string, host: string): { hosts: HostTokenFindings; config: HostTokenFindings; hostsFileExists: boolean } {
	const hostsFile = join(ghConfigDir, "hosts.yml");
	return {
		hosts: hostTokenFindings(yamlEntriesOfFile(hostsFile), { host, key: "oauth_token" }),
		// gh's legacy `config.yml` kept hosts under a `hosts:` key.
		config: hostTokenFindings(yamlEntriesOfFile(join(ghConfigDir, "config.yml")), { host, key: "oauth_token", prefix: ["hosts"] }),
		hostsFileExists: existsSync(hostsFile),
	};
}

/** glab's `config.yml` token count for `host`: a direct child of the host entry under `hosts:`. */
export function glabFileFindings(glabConfigDir: string, host: string): HostTokenFindings {
	return hostTokenFindings(yamlEntriesOfFile(join(glabConfigDir, "config.yml")), { host, key: "token", prefix: ["hosts"], directOnly: true });
}

// ---- removing a host from the app's own file ------------------------------------------------------------------------------

/**
 * `text` without the block of `host` (the host's line and every line indented deeper after it, and blank lines inside), found under `prefix` (none for gh's `hosts.yml`, `["hosts"]` for
 * glab's `config.yml`). Host names compare without case. The rest of the file is kept byte for byte, line endings included. `removed` says whether a block was there.
 */
export function removeHostBlock(text: string, host: string, prefix: readonly string[] = []): { text: string; removed: boolean } {
	const lines = text.split(/(?<=\n)/);
	const keep: string[] = [];
	const stack: Array<{ indent: number; key: string }> = [];
	let removing: number | null = null;
	let removed = false;
	for (const raw of lines) {
		const line = raw.replace(/\r?\n$/, "");
		const blank = /^\s*(#|$)/.test(line);
		const indent = /^\s*/.exec(line)?.[0].length ?? 0;
		if (removing !== null) {
			if (blank || indent > removing) continue;
			removing = null;
		}
		if (!blank) {
			const m = /^(\s*)(?:"([^"]*)"|'([^']*)'|(.+?))\s*:(?:\s+(.*))?$/.exec(line);
			if (m !== null) {
				const key = m[2] ? m[2] : m[3] ? m[3] : (m[4] ?? "");
				while (stack.length > 0 && (stack[stack.length - 1] as { indent: number }).indent >= indent) stack.pop();
				const above = stack.map((s) => s.key);
				const underPrefix = above.length === prefix.length && prefix.every((k, i) => (above[i] as string).toLowerCase() === k.toLowerCase());
				if (underPrefix && key.toLowerCase() === host.toLowerCase()) {
					removing = indent;
					removed = true;
					continue;
				}
				if ((m[5] ?? "").replace(/(^|\s)#.*$/, "").trim() === "") stack.push({ indent, key });
			}
		}
		keep.push(raw);
	}
	return { text: keep.join(""), removed };
}
