// The signing half of the update channel (spec: Updater, The key). One Ed25519 key signs stack.json as a detached signature over the file's exact bytes (`stack.json.sig`, the 64 signature bytes
// as base64 text), and installers and dmgs through a manifest that names the kind, the version, the file name and the file's SHA512 (`<file>.manifest` signed in `<file>.manifest.sig`); the app
// verifies both against its built-in public key list (app/src/main/update/verify.ts).
//
// The private key is never read from a file of the repository and never written anywhere: it comes in as a string, either a JWK (JSON) or the base64 of its PKCS8 DER. A PEM is refused,
// so no `.pem` file is ever needed.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

/** The key object of `text` (a JWK or base64 PKCS8 DER), or throws a message that never contains the key. */
export function parsePrivateKey(text) {
  const value = String(text ?? "").trim();
  if (value === "") throw new Error("no signing key given");
  if (value.includes("-----BEGIN")) throw new Error("a PEM key is not accepted: pass a JWK or the base64 of the PKCS8 DER");
  let key;
  try {
    key = value.startsWith("{") ? createPrivateKey({ key: JSON.parse(value), format: "jwk" }) : createPrivateKey({ key: Buffer.from(value, "base64"), format: "der", type: "pkcs8" });
  } catch {
    throw new Error("the signing key is neither a JWK nor the base64 of a PKCS8 DER key");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`the signing key is ${key.asymmetricKeyType}, not ed25519`);
  return key;
}

/** The public half as the base64 of its SPKI DER: the form the app's key list takes. */
export const publicKeyOf = (privateKey) => createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64");

/** The detached signature of `bytes`: 64 bytes as base64 text with a final newline. */
export const signBytes = (bytes, privateKey) => `${sign(null, bytes, privateKey).toString("base64")}\n`;

/** True when `signatureText` is a valid signature of `bytes` under the base64 SPKI public key. */
export function checkSignature(bytes, signatureText, publicKeyBase64) {
  const key = createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" });
  const signature = Buffer.from(String(signatureText).trim(), "base64");
  return signature.length === 64 && verify(null, bytes, key, signature);
}

/** The first line of a manifest (the app's `MANIFEST_HEADER`). */
export const MANIFEST_HEADER = "straw-boss-desk-update/1";

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
export const isVersion = (text) => typeof text === "string" && VERSION.test(text);

/** The manifest text of a shell file (an installer or a dmg): the exact lines the app parses and verifies. Throws on a version or a file name the app would refuse. */
export function shellManifest(bytes, fileName, version) {
  if (!isVersion(version)) throw new Error(`${JSON.stringify(String(version).slice(0, 40))} is not a version`);
  if (fileName === "" || fileName.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(fileName) || fileName === "." || fileName === "..") throw new Error(`${JSON.stringify(fileName)} is not a plain file name`);
  return `${MANIFEST_HEADER}\nkind: shell\nversion: ${version}\nfile: ${fileName}\nsha512: ${createHash("sha512").update(bytes).digest("base64")}\n`;
}
