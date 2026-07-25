import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlRequestError, controlRequest } from "./control-client.js";

let directory: string | undefined;
let server: Server | undefined;

async function listen(
  handler: (request: Record<string, unknown>, reply: (value: unknown) => void) => void,
): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), "cwb-control-client-"));
  const socketPath = join(directory, "control.sock");
  server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      handler(request, (value) => socket.write(`${JSON.stringify(value)}\n`));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  return socketPath;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
  server = undefined;
  directory = undefined;
});

describe("daemon control transport", () => {
  it("sends one versioned newline-delimited request and returns its result", async () => {
    let received: Record<string, unknown> | undefined;
    const socketPath = await listen((request, reply) => {
      received = request;
      reply({ version: 1, id: request.id, ok: true, result: { hosts: [] } });
    });

    await expect(controlRequest(socketPath, "host.list", {})).resolves.toEqual({ hosts: [] });
    expect(received).toMatchObject({ version: 1, method: "host.list", params: {} });
    expect(received?.id).toEqual(expect.any(String));
  });

  it("forwards ordered stream events and resolves only on done", async () => {
    const events: unknown[] = [];
    const socketPath = await listen((request, reply) => {
      reply({ version: 1, id: request.id, event: { type: "snapshot" } });
      reply({ version: 1, id: request.id, event: { type: "message.delta", delta: "你好" } });
      reply({ version: 1, id: request.id, done: true, result: { reason: "idle" } });
    });

    await expect(
      controlRequest(
        socketPath,
        "thread.watch",
        { id: "t" },
        {
          stream: true,
          onEvent: (event) => events.push(event),
        },
      ),
    ).resolves.toEqual({ reason: "idle" });
    expect(events).toEqual([{ type: "snapshot" }, { type: "message.delta", delta: "你好" }]);
  });

  it("preserves daemon error codes and details for stable stderr/exit mapping", async () => {
    const socketPath = await listen((request, reply) => {
      reply({
        version: 1,
        id: request.id,
        error: { code: "not_found", message: "thread not found", details: { id: "missing" }, retryable: false },
      });
    });

    const error = await controlRequest(socketPath, "thread.get", { id: "missing" }).catch((value) => value);
    expect(error).toBeInstanceOf(ControlRequestError);
    expect((error as ControlRequestError).controlError).toEqual({
      code: "not_found",
      message: "thread not found",
      details: { id: "missing" },
      retryable: false,
    });
  });

  it.each([
    [
      "invalid JSON",
      (_request: Record<string, unknown>, reply: (value: unknown) => void) => reply("not-json"),
      "protocol_error",
    ],
    [
      "wrong protocol version",
      (request: Record<string, unknown>, reply: (value: unknown) => void) =>
        reply({ version: 2, id: request.id, ok: true }),
      "protocol_error",
    ],
    [
      "wrong request id",
      (_request: Record<string, unknown>, reply: (value: unknown) => void) =>
        reply({ version: 1, id: "other", ok: true }),
      "protocol_error",
    ],
  ])("does not fall back when daemon returns %s", async (_label, handler, expectedCode) => {
    const socketPath = await listen(handler);
    const error = await controlRequest(socketPath, "host.list", {}).catch((value) => value);
    expect(error).toBeInstanceOf(ControlRequestError);
    expect((error as ControlRequestError).controlError.code).toBe(expectedCode);
  });

  it("reports a missing daemon socket as a retryable structured error", async () => {
    directory = await mkdtemp(join(tmpdir(), "cwb-control-client-"));
    const error = await controlRequest(join(directory, "missing.sock"), "host.list", {}).catch((value) => value);
    expect(error).toBeInstanceOf(ControlRequestError);
    expect((error as ControlRequestError).controlError).toMatchObject({
      code: "daemon_unavailable",
      message: "daemon is not running",
      retryable: true,
    });
  });

  it("times out a silent daemon without switching to public HTTP", async () => {
    const socketPath = await listen(() => undefined);
    const error = await controlRequest(socketPath, "thread.wait", { id: "t" }, { timeoutMs: 10 }).catch(
      (value) => value,
    );
    expect(error).toBeInstanceOf(ControlRequestError);
    expect((error as ControlRequestError).controlError).toMatchObject({ code: "timeout", retryable: true });
  });
});
