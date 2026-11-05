import { closeSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { renameRetry } from "../bootstrap/fsutil.ts";

// A zip writer with no dependency (spec: Decisions, Archive extraction: the app has no archive library; `tar` is for extraction). Diagnostics are text files of a few megabytes at most, so each
// entry is deflated whole and written at once, and the archive is written to a temporary name and renamed when complete, so a half-written zip never carries the final name.
// No Zip64: an archive of more than 65534 entries or 4 GB is refused, which a folder of logs capped at five megabytes a file cannot reach.

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
/** General purpose bit 11: the names are UTF-8, so a CJK file name survives. */
const UTF8_FLAG = 0x0800;
const VERSION = 20;
const MAX_ENTRIES = 65_534;
const MAX_BYTES = 0xffff_ffff - 1024 * 1024;

export interface ZipEntry {
	/** The path inside the archive, with `/` separators and no leading `/` or `..`. */
	name: string;
	data: Buffer;
	/** The time stored with the entry; defaults to now. */
	mtime?: Date;
}

/** A zip entry name is relative, uses `/`, and climbs nowhere. */
export function checkEntryName(name: string): void {
	if (name === "" || name.startsWith("/") || name.includes("\\") || /^[A-Za-z]:/.test(name) || name.split("/").some((part) => part === ".." || part === "" || part === ".")) {
		throw new Error(`not a zip entry name: ${JSON.stringify(name)}`);
	}
	if (/[\u0000-\u001f]/.test(name)) throw new Error(`not a zip entry name: ${JSON.stringify(name)}`);
}

/** MS-DOS time and date words (two-second resolution, local time, years 1980 to 2107). */
export function dosTime(date: Date): { time: number; date: number } {
	const year = Math.min(2107, Math.max(1980, date.getFullYear()));
	return {
		time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
		date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
	};
}

interface Central {
	name: Buffer;
	method: number;
	crc: number;
	compressed: number;
	size: number;
	offset: number;
	time: number;
	date: number;
}

export class ZipWriter {
	readonly #path: string;
	readonly #tmp: string;
	readonly #fd: number;
	readonly #central: Central[] = [];
	readonly #names = new Set<string>();
	#offset = 0;
	#closed = false;

	constructor(path: string) {
		this.#path = path;
		this.#tmp = `${path}.${process.pid}.part`;
		mkdirSync(dirname(path), { recursive: true });
		this.#fd = openSync(this.#tmp, "w", 0o600);
	}

	#write(buffer: Buffer): void {
		let done = 0;
		while (done < buffer.length) done += writeSync(this.#fd, buffer, done, buffer.length - done);
		this.#offset += buffer.length;
		if (this.#offset > MAX_BYTES) throw new Error("the archive would be larger than 4 GB");
	}

	add(entry: ZipEntry): void {
		if (this.#closed) throw new Error("the archive is closed");
		checkEntryName(entry.name);
		if (this.#names.has(entry.name)) throw new Error(`the archive has ${entry.name} twice`);
		if (this.#central.length >= MAX_ENTRIES) throw new Error("the archive would have more than 65534 entries");
		this.#names.add(entry.name);
		const name = Buffer.from(entry.name, "utf8");
		const deflated = deflateRawSync(entry.data);
		// Stored when deflate does not help (an empty file, or data that is random already).
		const stored = deflated.length >= entry.data.length;
		const body = stored ? entry.data : deflated;
		const method = stored ? 0 : 8;
		const { time, date } = dosTime(entry.mtime ?? new Date());
		const crc = crc32(entry.data);
		const header = Buffer.alloc(30);
		header.writeUInt32LE(LOCAL, 0);
		header.writeUInt16LE(VERSION, 4);
		header.writeUInt16LE(UTF8_FLAG, 6);
		header.writeUInt16LE(method, 8);
		header.writeUInt16LE(time, 10);
		header.writeUInt16LE(date, 12);
		header.writeUInt32LE(crc, 14);
		header.writeUInt32LE(body.length, 18);
		header.writeUInt32LE(entry.data.length, 22);
		header.writeUInt16LE(name.length, 26);
		header.writeUInt16LE(0, 28);
		const offset = this.#offset;
		this.#write(header);
		this.#write(name);
		this.#write(body);
		this.#central.push({ name, method, crc, compressed: body.length, size: entry.data.length, offset, time, date });
	}

	/** Writes the central directory, closes the file and renames it to its final name. */
	finish(): void {
		if (this.#closed) throw new Error("the archive is closed");
		this.#closed = true;
		try {
			const start = this.#offset;
			for (const c of this.#central) {
				const record = Buffer.alloc(46);
				record.writeUInt32LE(CENTRAL, 0);
				record.writeUInt16LE(VERSION, 4);
				record.writeUInt16LE(VERSION, 6);
				record.writeUInt16LE(UTF8_FLAG, 8);
				record.writeUInt16LE(c.method, 10);
				record.writeUInt16LE(c.time, 12);
				record.writeUInt16LE(c.date, 14);
				record.writeUInt32LE(c.crc, 16);
				record.writeUInt32LE(c.compressed, 20);
				record.writeUInt32LE(c.size, 24);
				record.writeUInt16LE(c.name.length, 28);
				record.writeUInt32LE(c.offset, 42);
				this.#write(record);
				this.#write(c.name);
			}
			const size = this.#offset - start;
			const end = Buffer.alloc(22);
			end.writeUInt32LE(END, 0);
			end.writeUInt16LE(this.#central.length, 8);
			end.writeUInt16LE(this.#central.length, 10);
			end.writeUInt32LE(size, 12);
			end.writeUInt32LE(start, 16);
			this.#write(end);
			closeSync(this.#fd);
			// Antivirus or the indexer may still hold a file that was just written (Windows): the rename waits a moment, as every other atomic write of the app does.
			renameRetry(this.#tmp, this.#path);
		} catch (error) {
			this.abort();
			throw error;
		}
	}

	/** Drops the half-written file. */
	abort(): void {
		this.#closed = true;
		try {
			closeSync(this.#fd);
		} catch {
			// closed already
		}
		rmSync(this.#tmp, { force: true });
	}
}
