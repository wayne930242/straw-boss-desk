// Comparing the address a recipe names with the `origin` a folder already has (spec: team-profile section 5, "What the wizard does with it", step 2): a folder is reused only when its `origin`
// is the same URL. The comparison is gentle about spellings of one address (a trailing `.git` or `/`, the host's case, user info) and strict about everything else, since reusing the wrong
// repository is the harm.

/** `host/path` of an address without user info, port 443, `.git`, trailing slashes; the host in lower case. Null when the text is no address Git would use. */
export function addressKey(text: string): string | null {
	const trimmed = text.trim();
	if (trimmed === "") return null;
	let host: string;
	let path: string;
	const scp = /^(?:[^@/:\s]+@)?([^/:\s]+):(?!\/\/)(.+)$/.exec(trimmed);
	if (scp !== null && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
		host = scp[1] as string;
		path = scp[2] as string;
	} else {
		let url: URL;
		try {
			url = new URL(trimmed);
		} catch {
			return null;
		}
		if (url.hostname === "") return null;
		host = url.port === "" || url.port === "443" ? url.hostname : `${url.hostname}:${url.port}`;
		path = url.pathname;
	}
	const cleaned = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
	return cleaned === "" ? null : `${host.toLowerCase()}/${cleaned}`;
}

/** True when both texts name one repository address. An address that cannot be read never matches. */
export function sameOrigin(a: string, b: string): boolean {
	const x = addressKey(a);
	return x !== null && x === addressKey(b);
}

/** An address as it may be shown under **Details**: no user info, no query, no fragment. */
export function plainOrigin(text: string): string {
	try {
		const url = new URL(text.trim());
		return `${url.protocol}//${url.host}${url.pathname}`;
	} catch {
		return text.replace(/\/\/[^/@\s]*@/, "//").slice(0, 200);
	}
}
