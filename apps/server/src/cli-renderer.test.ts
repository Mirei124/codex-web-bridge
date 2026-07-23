import { describe, expect, it } from "vitest";
import { humanEventMode, renderHuman, renderHumanError } from "./cli-renderer.js";

describe("CLI human renderer", () => {
  it("renders list commands as aligned Docker-style tables", () => {
    expect(renderHuman([
      { id: "a", name: "Machine A", address: "alice@example.test:22", status: "online" },
      { id: "long-id", name: "Build", address: "build.example.test:2222", status: "offline" },
    ], { method: "host.list" })).toBe([
      "ID       NAME       ADDRESS                  STATUS",
      "a        Machine A  alice@example.test:22    online",
      "long-id  Build      build.example.test:2222  offline",
    ].join("\n"));
    expect(renderHuman([], { method: "host.list" })).toBe("ID  NAME  ADDRESS  STATUS");
  });

  it("renders daemon results and generated credentials as prose", () => {
    expect(renderHuman(
      { state: "running", pid: 42, generatedPassword: "secret" },
      { method: "start" },
    )).toBe("Daemon started (PID 42).\nDashboard password: secret");
    expect(renderHuman({ state: "not_running" }, { method: "status" })).toBe("Daemon is not running.");
  });

  it("renders detail objects as readable key/value lines", () => {
    const rendered = renderHuman({ id: "thread-1", title: "Work", status: "waiting", hostId: "a", cwd: "/work" }, { method: "thread.get" });
    expect(rendered).toContain("ID                 thread-1");
    expect(rendered).toContain("Working directory  /work");
  });

  it("renders mutations from command context instead of dumping response objects", () => {
    expect(renderHuman({ completed: true }, { method: "thread.interrupt", params: { threadId: "thread-1" } }))
      .toBe("Thread thread-1 interrupted.");
    expect(renderHuman({ path: "/tmp/pane.png" }, { method: "terminal.screenshot", params: { threadId: "thread-1" } }))
      .toBe("Screenshot saved to /tmp/pane.png.");
  });

  it("renders streaming text without JSON decoration", () => {
    expect(renderHuman({ type: "message.delta", threadId: "t", messageId: "m", delta: "hello" }, { kind: "event" }))
      .toBe("hello");
    expect(renderHuman({ type: "terminal.data", threadId: "t", data: "\\x1b[2J" }, { kind: "event" }))
      .toBe("\\x1b[2J");
    expect(humanEventMode({ type: "message.delta", delta: "hello" }, "thread.watch")).toBe("raw");
    expect(humanEventMode({ type: "snapshot" }, "terminal.watch")).toBe("ignore");
    expect(humanEventMode({ type: "terminal.state" }, "terminal.watch")).toBe("stderr");
  });

  it("renders errors with their stable code", () => {
    expect(renderHumanError({ code: "not_found", message: "thread missing" }))
      .toBe("Error: thread missing (not_found)");
  });
});
