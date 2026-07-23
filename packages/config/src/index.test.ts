import { describe, expect, it } from "vitest";
import { parseConfig } from "./index.js";

describe("config", () => {
  it("accepts local HTTP and proxied HTTPS origins", () => {
    expect(parseConfig({ version: 1, publicOrigin: "http://127.0.0.1:3210", passwordHash: "x", sessionSecret: "x".repeat(32) }).bindHost).toBe("127.0.0.1");
    expect(parseConfig({ version: 1, publicOrigin: "https://example.com", passwordHash: "x", sessionSecret: "x".repeat(32) }).publicOrigin).toBe("https://example.com");
  });
  it("only permits loopback or an explicitly persisted all-interface bind", () => {
    expect(parseConfig({ version: 1, bindHost: "0.0.0.0", publicOrigin: "http://example.com", passwordHash: "x", sessionSecret: "x".repeat(32) }).bindHost).toBe("0.0.0.0");
    expect(() => parseConfig({ version: 1, bindHost: "192.0.2.1", publicOrigin: "http://example.com", passwordHash: "x", sessionSecret: "x".repeat(32) })).toThrow();
  });
  it("migrates the legacy localhost HTTPS origin to local HTTP with the configured port", () => {
    expect(parseConfig({
      version: 1,
      port: 4321,
      publicOrigin: "https://localhost",
      passwordHash: "x",
      sessionSecret: "x".repeat(32),
    }).publicOrigin).toBe("http://localhost:4321");
  });
});
