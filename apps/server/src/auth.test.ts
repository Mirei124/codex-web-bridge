import { describe, expect, it } from "vitest";
import { hashPassword, sameToken, verifyPassword } from "./auth.js";
describe("authentication", () => {
  it("uses a verifiable Argon2id hash", async () => {
    const encoded = await hashPassword("correct horse battery staple");
    expect(encoded).toContain("argon2id");
    expect(await verifyPassword(encoded, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(encoded, "wrong password")).toBe(false);
  });
  it("compares CSRF tokens", () => {
    expect(sameToken("abc", "abc")).toBe(true);
    expect(sameToken("abc", "abd")).toBe(false);
  });
});
