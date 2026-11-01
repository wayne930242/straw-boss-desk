import { gzipSync, crc32 } from "node:zlib";

// Test code: archive writers, so a test builds a tar.gz or a zip (including a hostile one) the same way on every OS, with no `tar` or `zip` of the
// machine involved. The program under test reads them with the system `tar`.

export interface TarEntry {
	name: string;
	/** File content (default empty). */
	data?: string | Buffer;
	/** `file` (default), `dir`, `symlink`, or `hardlink`. */
	type?: "file" | "dir" | "symlink" | "hardlink";
	/** The link target of a symlink or hardlink. */
	link?: string;
	mode?: number;
}

const TYPEFLAG = { file: "0", dir: "5", symlink: "2", hardlink: "1" } as const;

function field(text: string, length: number): Buffer {
	const out = Buffer.alloc(length);
	out.write(text, 0, length, "utf8");
	return out;
}

const octal = (value: number, length: number): string => `${value.toString(8).padStart(length - 1, "0")}\0`;

function tarHeader(entry: TarEntry, size: number): Buffer {
	const type = entry.type ?? "file";
	const name = type === "dir" && !entry.name.endsWith("/") ? `${entry.name}/` : entry.name;
	if (Buffer.byteLength(name) > 100) throw new Error(`tar test names must fit 100 bytes: ${name}`);
	const header = Buffer.alloc(512);
	field(name, 100).copy(header, 0);
	field(octal(entry.mode ?? (type === "dir" ? 0o755 : 0o644), 8), 8).copy(header, 100);
	field(octal(0, 8), 8).copy(header, 108);
	field(octal(0, 8), 8).copy(header, 116);
	field(octal(size, 12), 12).copy(header, 124);
	field(octal(1_700_000_000, 12), 12).copy(header, 136);
	header.fill(0x20, 148, 156);
	header.write(TYPEFLAG[type], 156, "ascii");
	if (entry.link !== undefined) field(entry.link, 100).copy(header, 157);
	header.write("ustar\0", 257, "ascii");
	header.write("00", 263, "ascii");
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
	return header;
}

/** An uncompressed ustar archive. */
export function tar(entries: readonly TarEntry[]): Buffer {
	const parts: Buffer[] = [];
	for (const entry of entries) {
		const data = entry.type === undefined || entry.type === "file" ? Buffer.from(entry.data ?? "") : Buffer.alloc(0);
		parts.push(tarHeader(entry, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
	}
	parts.push(Buffer.alloc(1024));
	return Buffer.concat(parts);
}

export const tarGz = (entries: readonly TarEntry[]): Buffer => gzipSync(tar(entries));

/** A zip of stored (uncompressed) files, names as UTF-8. */
export function zip(entries: readonly { name: string; data: string | Buffer }[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const data = Buffer.from(entry.data);
		const crc = crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6);
		local.writeUInt16LE(0, 8);
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(0x21, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(local, name, data);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(0x031e, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(0, 10);
		central.writeUInt16LE(0, 12);
		central.writeUInt16LE(0x21, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(((0o100755 << 16) >>> 0), 38);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);
		offset += 30 + name.length + data.length;
	}
	const centralBytes = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralBytes.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, centralBytes, end]);
}
