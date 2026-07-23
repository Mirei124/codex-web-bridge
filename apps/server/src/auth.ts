import { randomBytes, timingSafeEqual } from "node:crypto";
import { hash, verify, Algorithm } from "@node-rs/argon2";

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error("password must contain at least 12 characters");
  return hash(password, { algorithm: Algorithm.Argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
}

export async function verifyPassword(encoded: string, password: string): Promise<boolean> {
  return verify(encoded, password);
}

export function token(bytes = 32): string { return randomBytes(bytes).toString("base64url"); }

export function sameToken(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
