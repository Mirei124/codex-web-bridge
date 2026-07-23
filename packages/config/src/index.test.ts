import { describe, expect, it } from "vitest";
import { parseConfig } from "./index.js";

describe("config", () => {
  it("rejects a public HTTP origin", () => {
    expect(() => parseConfig({ version: 1, publicOrigin: "http://example.com", passwordHash: "x", sessionSecret: "x".repeat(32) })).toThrow(/HTTPS/);
  });
  it("forces a loopback bind", () => {
    expect(() => parseConfig({ version: 1, bindHost: "0.0.0.0", publicOrigin: "https://example.com", passwordHash: "x", sessionSecret: "x".repeat(32) })).toThrow();
  });
});
