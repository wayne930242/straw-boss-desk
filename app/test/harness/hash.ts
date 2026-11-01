import { createHash } from "node:crypto";

export const sha256Hex = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
