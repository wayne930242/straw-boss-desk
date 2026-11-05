import { isIP } from "node:net";

// Whether an address may be dialled for a fetch the PM did not choose by hand (a recipe's `updateUrl`): only an address on the public internet. The recipe validator checks the host's
// name (`recipe/validate.mjs`, lexically); the fetcher checks what the name resolves to, because a public name can point at 127.0.0.1 or 10.0.0.5 (spec: team-profile section 5, `updateUrl`).

type Four = readonly [number, number, number, number];

function parseV4(text: string): Four | null {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
	if (m === null) return null;
	const parts = m.slice(1).map(Number);
	return parts.every((n) => n <= 255) ? [parts[0] as number, parts[1] as number, parts[2] as number, parts[3] as number] : null;
}

/** IPv4 addresses that are not on the public internet: this host, private, shared (CGNAT), loopback, link-local, protocol assignments, documentation, benchmarking, 6to4 relay, multicast, reserved and broadcast. */
function publicV4([a, b, c]: Four): boolean {
	if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
	if (a === 100 && b >= 64 && b <= 127) return false;
	if (a === 169 && b === 254) return false;
	if (a === 172 && b >= 16 && b <= 31) return false;
	if (a === 192 && b === 168) return false;
	if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
	if (a === 192 && b === 88 && c === 99) return false;
	if (a === 198 && (b === 18 || b === 19)) return false;
	if (a === 198 && b === 51 && c === 100) return false;
	if (a === 203 && b === 0 && c === 113) return false;
	return true;
}

/** The 16 bytes of an IPv6 address, or null for a text that is not one (a zone id, a bad group, a second `::`). A trailing dotted IPv4 part is read. */
function parseV6(text: string): number[] | null {
	if (text.includes("%") || text.includes("[")) return null;
	let head = text;
	const tailBytes: number[] = [];
	const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
	if (dotted !== null) {
		const four = parseV4(dotted[1] as string);
		if (four === null) return null;
		tailBytes.push(...four);
		head = `${text.slice(0, text.length - (dotted[1] as string).length)}0:0`;
	}
	const halves = head.split("::");
	if (halves.length > 2) return null;
	const groups = (s: string): number[] | null => {
		if (s === "") return [];
		const out: number[] = [];
		for (const g of s.split(":")) {
			if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
			out.push(Number.parseInt(g, 16));
		}
		return out;
	};
	const left = groups(halves[0] as string);
	const right = halves.length === 2 ? groups(halves[1] as string) : [];
	if (left === null || right === null) return null;
	let words: number[];
	if (halves.length === 2) {
		const missing = 8 - left.length - right.length;
		if (missing < 1) return null;
		words = [...left, ...Array<number>(missing).fill(0), ...right];
	} else {
		words = left;
	}
	if (words.length !== 8) return null;
	const bytes = words.flatMap((w) => [w >> 8, w & 0xff]);
	if (tailBytes.length === 4) {
		bytes[12] = tailBytes[0] as number;
		bytes[13] = tailBytes[1] as number;
		bytes[14] = tailBytes[2] as number;
		bytes[15] = tailBytes[3] as number;
	}
	return bytes;
}

function publicV6(bytes: readonly number[]): boolean {
	const b = (i: number): number => bytes[i] as number;
	const embedded = (at: number): Four => [b(at), b(at + 1), b(at + 2), b(at + 3)];
	const zeros = (from: number, to: number): boolean => bytes.slice(from, to).every((x) => x === 0);
	// ::, ::1 and every address with 96 zero bits first are unspecified, loopback or the long-deprecated IPv4-compatible form.
	if (zeros(0, 12)) return false;
	// IPv4-mapped (::ffff:a.b.c.d) is judged by the IPv4 address in it.
	if (zeros(0, 10) && b(10) === 0xff && b(11) === 0xff) return publicV4(embedded(12));
	// NAT64 (64:ff9b::/96) carries the IPv4 address it reaches; the local-use prefix 64:ff9b:1::/48 is never public.
	if (b(0) === 0x00 && b(1) === 0x64 && b(2) === 0xff && b(3) === 0x9b) return b(4) === 0 && b(5) === 0 && zeros(6, 12) ? publicV4(embedded(12)) : false;
	// 6to4 (2002::/16) carries one in bytes 2 to 5.
	if (b(0) === 0x20 && b(1) === 0x02) return publicV4(embedded(2));
	// Only global unicast, 2000::/3, can be on the public internet; inside it the IETF protocol block 2001::/23 (Teredo, ORCHID, benchmarking) and documentation 2001:db8::/32 are not.
	if ((b(0) & 0xe0) !== 0x20) return false;
	if (b(0) === 0x20 && b(1) === 0x01 && (b(2) & 0xfe) === 0x00) return false;
	if (b(0) === 0x20 && b(1) === 0x01 && b(2) === 0x0d && b(3) === 0xb8) return false;
	return true;
}

/** True when `address` (a dotted IPv4 or an IPv6 text) is on the public internet. Anything else, text that is no address included, is not. */
export function isPublicAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) {
		const four = parseV4(address);
		return four !== null && publicV4(four);
	}
	if (family === 6) {
		const bytes = parseV6(address);
		return bytes !== null && publicV6(bytes);
	}
	return false;
}
