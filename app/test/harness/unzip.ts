// A minimal zip reader for the tests: the central directory, then each entry inflated and its CRC checked. Test code only; the app writes zips and never reads them.
import { readFileSync } from "node:fs";
import { crc32, inflateRawSync } from "node:zlib";

export interface ZipFile {
	name: string;
	data: Buffer;
}

export function readZip(file: string): ZipFile[] {
	const buf = readFileSync(file);
	let end = buf.length - 22;
	while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
	if (end < 0) throw new Error("no end of central directory");
	const count = buf.readUInt16LE(end + 10);
	let pos = buf.readUInt32LE(end + 16);
	const out: ZipFile[] = [];
	for (let i = 0; i < count; i++) {
		if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error("bad central header");
		const method = buf.readUInt16LE(pos + 10);
		const crc = buf.readUInt32LE(pos + 16);
		const compressed = buf.readUInt32LE(pos + 20);
		const size = buf.readUInt32LE(pos + 24);
		const nameLen = buf.readUInt16LE(pos + 28);
		const extraLen = buf.readUInt16LE(pos + 30);
		const commentLen = buf.readUInt16LE(pos + 32);
		const offset = buf.readUInt32LE(pos + 42);
		const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);
		if (buf.readUInt32LE(offset) !== 0x04034b50) throw new Error("bad local header");
		const localName = buf.readUInt16LE(offset + 26);
		const localExtra = buf.readUInt16LE(offset + 28);
		const start = offset + 30 + localName + localExtra;
		const body = buf.subarray(start, start + compressed);
		const data = method === 0 ? Buffer.from(body) : inflateRawSync(body);
		if (data.length !== size) throw new Error(`${name}: size ${data.length} is not ${size}`);
		if (crc32(data) !== crc) throw new Error(`${name}: bad CRC`);
		out.push({ name, data });
		pos += 46 + nameLen + extraLen + commentLen;
	}
	return out;
}
