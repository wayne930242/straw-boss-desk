import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";

// Test code: a throw-away certificate authority and one server certificate for 127.0.0.1, built in memory with `node:crypto` and a few lines of DER, so
// no `openssl` and no file is involved. Task 6's TLS checks use it: the stand-in HTTPS server answers with the leaf, and a hosted-only fixture
// (`system-ca.ts`) puts the CA's DER bytes in the runner's OS certificate store. Nothing in this file touches a store or writes a file.

type Bytes = Buffer;

const lengthOf = (n: number): Bytes => {
	if (n < 0x80) return Buffer.from([n]);
	if (n < 0x100) return Buffer.from([0x81, n]);
	return Buffer.from([0x82, n >> 8, n & 0xff]);
};
const tlv = (tag: number, ...parts: Bytes[]): Bytes => {
	const body = Buffer.concat(parts);
	return Buffer.concat([Buffer.from([tag]), lengthOf(body.length), body]);
};
const seq = (...parts: Bytes[]): Bytes => tlv(0x30, ...parts);
const set = (...parts: Bytes[]): Bytes => tlv(0x31, ...parts);
const octets = (bytes: Bytes): Bytes => tlv(0x04, bytes);
const bits = (bytes: Bytes, unused = 0): Bytes => tlv(0x03, Buffer.from([unused]), bytes);
const explicit = (n: number, ...parts: Bytes[]): Bytes => tlv(0xa0 + n, ...parts);
const utf8 = (text: string): Bytes => tlv(0x0c, Buffer.from(text, "utf8"));
const TRUE = tlv(0x01, Buffer.from([0xff]));
const integer = (value: Bytes): Bytes => {
	// A leading zero keeps a high bit from reading as a negative number.
	const body = value[0] !== undefined && value[0] >= 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value;
	return tlv(0x02, body);
};
const oid = (dotted: string): Bytes => {
	const parts = dotted.split(".").map(Number);
	const first = (parts[0] as number) * 40 + (parts[1] as number);
	const body: number[] = [first];
	for (const part of parts.slice(2)) {
		const groups: number[] = [part & 0x7f];
		for (let rest = part >> 7; rest > 0; rest >>= 7) groups.unshift((rest & 0x7f) | 0x80);
		body.push(...groups);
	}
	return tlv(0x06, Buffer.from(body));
};
const utcTime = (date: Date): Bytes => tlv(0x17, Buffer.from(`${date.toISOString().slice(2, 19).replace(/[-:T]/g, "")}Z`, "ascii"));
const name = (cn: string): Bytes => seq(set(seq(oid("2.5.4.3"), utf8(cn))));
const extension = (id: string, value: Bytes, critical: boolean): Bytes => seq(oid(id), ...(critical ? [TRUE] : []), octets(value));

const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));

const spkiOf = (key: KeyObject): Bytes => key.export({ type: "spki", format: "der" });
const keyId = (key: KeyObject): Bytes => createHash("sha1").update(spkiOf(key)).digest();

const pem = (label: string, der: Bytes): string => `-----BEGIN ${label}-----\n${(der.toString("base64").match(/.{1,64}/g) ?? []).join("\n")}\n-----END ${label}-----\n`;

interface Issued {
	der: Bytes;
	/** In memory only: the text a TLS option takes. */
	pem: string;
	cert: X509Certificate;
}

function issue(options: { subject: string; issuer: string; publicKey: KeyObject; signer: KeyObject; extensions: Bytes[]; days: number }): Issued {
	const notBefore = new Date(Date.now() - 3_600_000);
	const notAfter = new Date(Date.now() + options.days * 86_400_000);
	const tbs = seq(
		explicit(0, integer(Buffer.from([2]))),
		integer(randomBytes(16).fill(0x01, 0, 1)),
		ECDSA_SHA256,
		name(options.issuer),
		seq(utcTime(notBefore), utcTime(notAfter)),
		name(options.subject),
		spkiOf(options.publicKey),
		explicit(3, seq(...options.extensions)),
	);
	const signature = sign("sha256", tbs, { key: options.signer, dsaEncoding: "der" });
	const der = seq(tbs, ECDSA_SHA256, bits(signature));
	return { der, pem: pem("CERTIFICATE", der), cert: new X509Certificate(der) };
}

export interface TestCa {
	/** The common name of the CA, which a store removal names. */
	commonName: string;
	/** The CA certificate as DER: what `certutil` and `security` import (a `.cer` file, never `.pem`). */
	caDer: Bytes;
	caPem: string;
	/** A server certificate for `127.0.0.1` and `localhost`, signed by the CA, and its key, as text for a TLS server. */
	server: { certPem: string; keyPem: string; cert: X509Certificate };
	ca: X509Certificate;
}

/** A new CA and server certificate, valid from an hour ago for two days (macOS refuses a server certificate valid for more than 825 days). */
export function createTestCa(label = "test"): TestCa {
	const commonName = `Straw Boss Desk ${label} CA ${randomBytes(4).toString("hex")}`;
	const caKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const ca = issue({
		subject: commonName,
		issuer: commonName,
		publicKey: caKeys.publicKey,
		signer: caKeys.privateKey,
		days: 2,
		extensions: [
			extension("2.5.29.19", seq(TRUE), true),
			extension("2.5.29.15", bits(Buffer.from([0x06]), 1), true),
			extension("2.5.29.14", octets(keyId(caKeys.publicKey)), false),
		],
	});
	const serverKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const san = seq(tlv(0x82, Buffer.from("localhost", "ascii")), tlv(0x87, Buffer.from([127, 0, 0, 1])));
	const server = issue({
		subject: "127.0.0.1",
		issuer: commonName,
		publicKey: serverKeys.publicKey,
		signer: caKeys.privateKey,
		days: 2,
		extensions: [
			extension("2.5.29.19", seq(), true),
			extension("2.5.29.15", bits(Buffer.from([0x80]), 7), true),
			extension("2.5.29.37", seq(oid("1.3.6.1.5.5.7.3.1")), false),
			extension("2.5.29.17", san, false),
			extension("2.5.29.14", octets(keyId(serverKeys.publicKey)), false),
			extension("2.5.29.35", seq(tlv(0x80, keyId(caKeys.publicKey))), false),
		],
	});
	// Prove the chain before anyone relies on it.
	if (!server.cert.verify(caKeys.publicKey)) throw new Error("the test server certificate does not verify under the test CA");
	return {
		commonName,
		caDer: ca.der,
		caPem: ca.pem,
		server: { certPem: server.pem, keyPem: serverKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), cert: server.cert },
		ca: ca.cert,
	};
}
