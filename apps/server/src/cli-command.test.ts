import { describe, expect, it } from "vitest";
import { helpText, parseBusinessCommand, UsageError } from "./cli-command.js";

describe("LLM-oriented CLI command parsing", () => {
  it("returns focused help for command groups and concrete subcommands", () => {
    expect(helpText(["host", "--help"])).toContain("host list");
    expect(helpText(["host", "--help"])).not.toContain("thread create");
    expect(helpText(["host", "add", "--help"])).toMatch(/^Usage: codex-web-bridge host add/);
    expect(helpText(["host", "add", "--help"])).not.toContain("host list");
    expect(helpText(["start", "--help"])).toMatch(/^Usage: codex-web-bridge start/);
  });

  it("parses the primary SSH target form with optional in-memory password and host-key acceptance", () => {
    expect(parseBusinessCommand([
      "host", "add", "codex@machine-a.example:2222", "--id", "machine-a", "--name", "Machine A",
      "--password-stdin", "--accept-host-key",
    ])).toMatchObject({
      method: "host.upsert",
      params: {
        id: "machine-a", name: "Machine A", hostname: "machine-a.example", port: 2222,
        username: "codex", passwordStdin: true, acceptHostKey: true,
      },
    });
  });

  it("parses bracketed IPv6 SSH targets", () => {
    expect(parseBusinessCommand(["host", "add", "u@[2001:db8::1]:2200", "--id", "v6", "--name", "IPv6"]))
      .toMatchObject({ params: { username: "u", hostname: "2001:db8::1", port: 2200 } });
  });

  it("derives a stable ID and name when only USER@HOST is supplied", () => {
    expect(parseBusinessCommand(["host", "add", "codex@Machine-A.Example"]))
      .toMatchObject({ params: { id: "codex-machine-a-example-22", name: "Machine-A.Example", username: "codex", port: 22 } });
  });

  it("derives different IDs for different SSH users and ports", () => {
    expect(parseBusinessCommand(["host", "add", "root@machine-a:2222"]).params.id).toBe("root-machine-a-2222");
    expect(parseBusinessCommand(["host", "add", "codex@machine-a:22"]).params.id).toBe("codex-machine-a-22");
  });

  it("supports explicit password clearing and rejects conflicting password input", () => {
    expect(parseBusinessCommand(["host", "add", "codex@machine-a", "--clear-password"]))
      .toMatchObject({ params: { clearPassword: true } });
    expect(() => parseBusinessCommand(["host", "add", "codex@machine-a", "--clear-password", "--password-stdin"]))
      .toThrow(/cannot be combined/);
  });

  it.each([
    [["host", "list"], "host.list", {}],
    [["host", "get", "machine-a"], "host.get", { hostId: "machine-a" }],
    [["host", "codex-threads", "machine-a"], "host.codexThreads", { hostId: "machine-a" }],
    [["thread", "list"], "thread.list", {}],
    [["thread", "get", "thread-1"], "thread.get", { threadId: "thread-1" }],
    [["thread", "exit", "thread-1"], "thread.exit", { threadId: "thread-1" }],
    [["thread", "interrupt", "thread-1"], "thread.interrupt", { threadId: "thread-1" }],
    [["request", "list", "thread-1"], "request.list", { threadId: "thread-1" }],
    [["request", "get", "thread-1", "request-1"], "request.get", { threadId: "thread-1", requestId: "request-1" }],
    [["request", "approve", "thread-1", "request-1"], "request.approve", { threadId: "thread-1", requestId: "request-1" }],
    [["request", "decline", "thread-1", "request-1"], "request.decline", { threadId: "thread-1", requestId: "request-1" }],
    [["terminal", "takeover", "thread-1"], "terminal.takeover", { threadId: "thread-1" }],
    [["terminal", "release", "thread-1"], "terminal.release", { threadId: "thread-1" }],
  ])("maps %j to %s", (argv, method, params) => {
    expect(parseBusinessCommand(argv)).toMatchObject({ method, params, stream: false, json: false });
  });

  it("maps host upsert flags and applies only the documented port default", () => {
    expect(parseBusinessCommand([
      "host", "upsert", "--id", "machine-a", "--name", "Machine A",
      "--hostname", "a.example", "--username", "codex",
      "--host-key", `SHA256:${"A".repeat(43)}`, "--identity-file", "/keys/a",
    ])).toMatchObject({
      method: "host.upsert",
      params: {
        id: "machine-a", name: "Machine A", hostname: "a.example", port: 22,
        username: "codex", hostKeySha256: `SHA256:${"A".repeat(43)}`, identityFile: "/keys/a",
      },
    });
  });

  it.each([
    [["host", "upsert", "--input-json", "{\"id\":\"a\"}"], "host.upsert", { inputJson: "{\"id\":\"a\"}" }],
    [["host", "upsert", "--input-file", "-"], "host.upsert", { inputFile: "-" }],
    [["request", "resolve", "thread-1", "request-1", "--input-json", "{\"approved\":true}"], "request.resolve", {
      threadId: "thread-1", requestId: "request-1", inputJson: "{\"approved\":true}",
    }],
    [["request", "answer", "thread-1", "request-1", "--input-file", "answers.json"], "request.answer", {
      threadId: "thread-1", requestId: "request-1", inputFile: "answers.json",
    }],
  ])("preserves structured input source for %j", (argv, method, params) => {
    expect(parseBusinessCommand(argv)).toMatchObject({ method, params });
  });

  it.each([
    [["thread", "create", "--host", "machine-a", "--cwd", "/work"], "thread.create", {
      hostId: "machine-a", cwd: "/work",
    }],
    [["thread", "resume", "--host", "machine-a", "--codex-thread", "codex-1", "--cwd", "/work"], "thread.resume", {
      hostId: "machine-a", codexThreadId: "codex-1", cwd: "/work",
    }],
    [["thread", "send", "thread-1", "--text", "line 1\nline 2"], "thread.send", {
      threadId: "thread-1", text: "line 1\nline 2", textFile: undefined,
    }],
    [["thread", "send", "thread-1", "--text-file", "-"], "thread.send", {
      threadId: "thread-1", text: undefined, textFile: "-",
    }],
    [["terminal", "input", "thread-1", "--data", "\u001b[A"], "terminal.input", {
      threadId: "thread-1", data: "\u001b[A", dataFile: undefined,
    }],
    [["terminal", "input", "thread-1", "--data-file", "-"], "terminal.input", {
      threadId: "thread-1", data: undefined, dataFile: "-",
    }],
  ])("maps mutation %j without altering payloads", (argv, method, params) => {
    expect(parseBusinessCommand(argv)).toMatchObject({ method, params });
  });

  it.each([
    [["thread", "wait", "thread-1", "--timeout", "1200"], "thread.wait", false],
    [["thread", "watch", "thread-1", "--timeout", "1200"], "thread.watch", true],
    [["terminal", "watch", "thread-1", "--timeout", "1200"], "terminal.watch", true],
  ])("maps wait/watch streaming semantics for %j", (argv, method, stream) => {
    expect(parseBusinessCommand(argv)).toMatchObject({ method, params: { threadId: "thread-1" }, stream, timeoutMs: 1200 });
  });

  it("keeps screenshot bytes out of structured stdout", () => {
    expect(parseBusinessCommand(["terminal", "screenshot", "thread-1", "--output", "/tmp/pane.png"])).toMatchObject({
      method: "terminal.screenshot",
      params: { threadId: "thread-1" },
      output: "/tmp/pane.png",
      stream: false,
    });
  });

  it("accepts --json in any argument position without changing the method mapping", () => {
    expect(parseBusinessCommand(["--json", "thread", "list"])).toMatchObject({
      method: "thread.list", json: true,
    });
  });

  it.each([
    [["host", "list", "--unknown", "x"], /unknown option/],
    [["host", "get"], /exactly one host ID/],
    [["thread", "create", "--host", "a"], /missing required option --cwd/],
    [["thread", "create", "--host", "a", "--cwd", "/work", "--title", "custom"], /unknown option/],
    [["thread", "send", "t"], /exactly one of --text or --text-file/],
    [["thread", "send", "t", "--text", "x", "--text-file", "x.txt"], /exactly one of --text or --text-file/],
    [["host", "upsert", "--input-json", "{}", "--input-file", "host.json"], /mutually exclusive/],
    [["request", "resolve", "t", "r"], /provide --input-json or --input-file/],
    [["terminal", "screenshot", "t"], /missing required option --output/],
    [["terminal", "input", "t", "--data", "x", "--data-file", "x.bin"], /exactly one of --data or --data-file/],
    [["thread", "watch", "t", "--timeout", "0"], /outside its allowed range/],
    [["host", "upsert", "--id", "a", "--name", "A", "--hostname", "a", "--port", "22x",
      "--username", "u", "--host-key", "SHA256:x", "--identity-file", "/key"], /must be an integer/],
  ])("rejects ambiguous or invalid invocation %j", (argv, message) => {
    expect(() => parseBusinessCommand(argv)).toThrowError(UsageError);
    expect(() => parseBusinessCommand(argv)).toThrow(message);
  });
});
