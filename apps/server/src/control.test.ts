import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Storage } from "@cwb/storage";
import type { AppConfig } from "@cwb/config";
import type { RuntimeManager } from "./runtime-manager.js";
import { hashPassword } from "./auth.js";
import { ControlServer } from "./control.js";
import { controlRequest } from "./control-client.js";
import { buildServer } from "./server.js";

class FakeRuntime implements RuntimeManager {
  readonly events = new EventEmitter();
  readonly terminalInputs: string[] = [];
  readonly resolutions: Array<{ requestId: string | number; value: unknown }> = [];
  async create() { return "codex-thread"; }
  async resume() {}
  async reconnect() {}
  async exit() {}
  async send() { return "turn-1"; }
  async interrupt() {}
  async resolve(_thread: unknown, requestId: string | number, value: unknown) { this.resolutions.push({ requestId, value }); }
  async terminalInput(_thread: unknown, data: string) { this.terminalInputs.push(data); }
  async terminalSeed() { return ""; }
  async screenshot() { return Buffer.from([137, 80, 78, 71]); }
  async close() {}
  async listHistorical() { return [{ id: "historical" }]; }
}

const config: AppConfig = {
  version: 1,
  bindHost: "127.0.0.1",
  port: 3210,
  publicOrigin: "https://bridge.example",
  passwordHash: await hashPassword("test-password"),
  sessionSecret: "x".repeat(32),
  trustedProxy: "127.0.0.1",
};

let directory: string | undefined;
let storage: Storage | undefined;
let control: ControlServer | undefined;
let app: Awaited<ReturnType<typeof buildServer>> | undefined;

afterEach(async () => {
  await control?.close();
  await app?.close();
  storage?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  storage = undefined;
  control = undefined;
  app = undefined;
});

async function setup() {
  directory = await mkdtemp(join(tmpdir(), "cwb-control-"));
  storage = new Storage(":memory:");
  let sink: ControlServer | undefined;
  const runtime = new FakeRuntime();
  app = await buildServer(config, storage, { runtime, webRoot: false, eventSink: event => sink?.publish(event) });
  control = new ControlServer(join(directory, "control.sock"), config, storage, app);
  sink = control;
  await control.listen();
  return { socketPath: join(directory, "control.sock"), runtime };
}

function request(socketPath: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    socket.once("connect", () => socket.write(`${JSON.stringify({ version: 1, id: "request-1", method, params })}\n`));
    socket.on("data", chunk => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    socket.once("error", reject);
  });
}

describe("local control server", () => {
  it("creates a private socket and maps host/thread operations through the existing HTTPS-gated routes", async () => {
    const { socketPath } = await setup();
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    expect((await stat(directory!)).mode & 0o777).toBe(0o700);

    const host = { id: "host", name: "A", hostname: "a", port: 22, username: "codex", hostKeySha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", identityFile: "/key" };
    expect(await request(socketPath, "host.upsert", host)).toMatchObject({ ok: true, result: { id: "host" } });
    expect(await request(socketPath, "host.get", { hostId: "host" })).toMatchObject({ ok: true, result: { id: "host", hostname: "a" } });
    const created = await request(socketPath, "thread.create", { hostId: "host", cwd: "/work" });
    expect(created).toMatchObject({ ok: true, result: { codexThreadId: "codex-thread" } });
    expect(await request(socketPath, "thread.send", { threadId: created.result.id, text: "hello" })).toMatchObject({ ok: true, result: { turnId: "turn-1" } });

    const plainHttp = await app!.inject({ method: "GET", url: "/api/hosts" });
    expect(plainHttp.statusCode).toBe(404);
    expect(plainHttp.body).toBe("");
  });

  it("frames watched events with the request id and sends a terminal done frame", async () => {
    const { socketPath } = await setup();
    storage!.upsertHost({ id: "host", name: "A", hostname: "a", port: 22, username: "codex", hostKeySha256: "key", identityFile: "/key", createdAt: 1 });
    storage!.createThread({ id: "thread", hostId: "host", codexThreadId: "codex", tmuxSession: "tmux", remotePort: 20000, workingDirectory: "/work", title: "Thread", status: "running", createdAt: 1, updatedAt: 1 });

    const events: any[] = [];
    const watching = controlRequest(socketPath, "thread.watch", { threadId: "thread" }, {
      stream: true,
      onEvent: event => events.push(event),
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    storage!.updateThread("thread", { status: "exited", updatedAt: 2 });
    control!.publish({ type: "thread.updated", thread: { id: "thread", codexThreadId: "codex", hostId: "host", title: "Thread", cwd: "/work", status: "exited", updatedAt: new Date().toISOString() } });
    const result = await watching;
    expect(events).toEqual([
      expect.objectContaining({ type: "snapshot", thread: expect.objectContaining({ id: "thread" }) }),
      expect.objectContaining({ type: "thread.updated", thread: expect.objectContaining({ status: "exited" }) }),
    ]);
    expect(result).toMatchObject({ id: "thread", status: "exited", pendingRequests: [] });
  });

  it("subscribes before reading the snapshot and cannot lose a terminal update in that window", async () => {
    const { socketPath } = await setup();
    storage!.upsertHost({ id: "host", name: "A", hostname: "a", port: 22, username: "codex", hostKeySha256: "key", identityFile: "/key", createdAt: 1 });
    storage!.createThread({ id: "thread", hostId: "host", codexThreadId: "codex", tmuxSession: "tmux", remotePort: 20000, workingDirectory: "/work", title: "Thread", status: "running", createdAt: 1, updatedAt: 1 });
    storage!.putPending({ id: "question", threadId: "thread", payload: JSON.stringify({ kind: "questions", requestId: "question", title: "Input", questions: [] }), rpcId: "1", method: "item/tool/requestUserInput", params: "{}", createdAt: 1 });

    const originalInject = app!.inject.bind(app);
    let published = false;
    app!.inject = (async (options: any) => {
      const response = await originalInject(options);
      if (!published && options.method === "GET" && options.url === "/api/threads/thread") {
        published = true;
        storage!.updateThread("thread", { status: "waiting", updatedAt: 2 });
        control!.publish({ type: "thread.updated", thread: { id: "thread", codexThreadId: "codex", hostId: "host", title: "Thread", cwd: "/work", status: "waiting", updatedAt: new Date(2).toISOString() } });
      }
      return response;
    }) as typeof originalInject;

    const result = await controlRequest(socketPath, "thread.wait", { threadId: "thread" }, { timeoutMs: 1_000 });
    expect(result).toMatchObject({ id: "thread", status: "waiting", pendingRequests: [{ requestId: "question" }] });
  });

  it("does not finish wait from a stale idle snapshot when a running update was queued", async () => {
    const { socketPath } = await setup();
    storage!.upsertHost({ id: "host", name: "A", hostname: "a", port: 22, username: "codex", hostKeySha256: "key", identityFile: "/key", createdAt: 1 });
    storage!.createThread({ id: "thread", hostId: "host", codexThreadId: "codex", tmuxSession: "tmux", remotePort: 20000, workingDirectory: "/work", title: "Thread", status: "idle", createdAt: 1, updatedAt: 1 });

    const originalInject = app!.inject.bind(app);
    let published = false;
    app!.inject = (async (options: any) => {
      const response = await originalInject(options);
      if (!published && options.method === "GET" && options.url === "/api/threads/thread") {
        published = true;
        storage!.updateThread("thread", { status: "running", updatedAt: 2 });
        control!.publish({ type: "thread.updated", thread: { id: "thread", codexThreadId: "codex", hostId: "host", title: "Thread", cwd: "/work", status: "running", updatedAt: new Date(2).toISOString() } });
      }
      return response;
    }) as typeof originalInject;

    const waiting = controlRequest(socketPath, "thread.wait", { threadId: "thread" }, { timeoutMs: 1_000 });
    await new Promise(resolve => setTimeout(resolve, 20));
    storage!.updateThread("thread", { status: "waiting", updatedAt: 3 });
    control!.publish({ type: "thread.updated", thread: { id: "thread", codexThreadId: "codex", hostId: "host", title: "Thread", cwd: "/work", status: "waiting", updatedAt: new Date(3).toISOString() } });
    await expect(waiting).resolves.toMatchObject({ id: "thread", status: "waiting" });
  });

  it("ends terminal watch when the thread reaches a terminal status", async () => {
    const { socketPath } = await setup();
    storage!.upsertHost({ id: "host", name: "A", hostname: "a", port: 22, username: "codex", hostKeySha256: "key", identityFile: "/key", createdAt: 1 });
    storage!.createThread({ id: "thread", hostId: "host", codexThreadId: "codex", tmuxSession: "tmux", remotePort: 20000, workingDirectory: "/work", title: "Thread", status: "running", createdAt: 1, updatedAt: 1 });

    const events: unknown[] = [];
    const watching = controlRequest(socketPath, "terminal.watch", { threadId: "thread" }, { stream: true, timeoutMs: 1_000, onEvent: event => events.push(event) });
    await new Promise(resolve => setTimeout(resolve, 20));
    storage!.updateThread("thread", { status: "exited", updatedAt: 2 });
    control!.publish({ type: "thread.updated", thread: { id: "thread", codexThreadId: "codex", hostId: "host", title: "Thread", cwd: "/work", status: "exited", updatedAt: new Date(2).toISOString() } });
    await expect(watching).resolves.toMatchObject({ id: "thread", status: "exited" });
    expect(events).toEqual([expect.objectContaining({ type: "snapshot" })]);
  });

  it("maps multi-question answers and approval decisions to their pending RPCs", async () => {
    const { socketPath, runtime } = await setup();
    storage!.upsertHost({ id: "host", name: "A", hostname: "a", port: 22, username: "codex", hostKeySha256: "key", identityFile: "/key", createdAt: 1 });
    storage!.createThread({ id: "thread", hostId: "host", codexThreadId: "codex", tmuxSession: "tmux", remotePort: 20000, workingDirectory: "/work", title: "Thread", status: "waiting", createdAt: 1, updatedAt: 1 });
    storage!.putPending({ id: "questions", threadId: "thread", payload: JSON.stringify({ kind: "questions", requestId: "questions", title: "Input", questions: [] }), rpcId: "7", method: "item/tool/requestUserInput", params: "{}", createdAt: 1 });
    storage!.putPending({ id: "approval", threadId: "thread", payload: JSON.stringify({ kind: "approval", requestId: "approval", title: "Approval", detail: "command" }), rpcId: "\"rpc-8\"", method: "item/commandExecution/requestApproval", params: "{}", createdAt: 2 });
    const answers = { language: { answers: ["TypeScript"] }, mode: { answers: ["Plan", "Explain first"] } };

    expect(await request(socketPath, "request.answer", { threadId: "thread", requestId: "questions", answers })).toMatchObject({ ok: true });
    expect(await request(socketPath, "request.approve", { threadId: "thread", requestId: "approval" })).toMatchObject({ ok: true });
    expect(runtime.resolutions).toEqual([
      { requestId: 7, value: { answers } },
      { requestId: "rpc-8", value: { decision: "accept" } },
    ]);
    expect(storage!.pending("thread")).toEqual([]);
  });

  it("keeps one CLI lease across short-lived connections and releases it explicitly", async () => {
    const { socketPath, runtime } = await setup();
    storage!.upsertHost({ id: "host", name: "A", hostname: "a", port: 22, username: "codex", hostKeySha256: "key", identityFile: "/key", createdAt: 1 });
    storage!.createThread({ id: "thread", hostId: "host", codexThreadId: "codex", tmuxSession: "tmux", remotePort: 20000, workingDirectory: "/work", title: "Thread", status: "idle", createdAt: 1, updatedAt: 1 });

    expect(await request(socketPath, "terminal.input", { threadId: "thread", data: "blocked" }))
      .toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await request(socketPath, "terminal.takeover", { threadId: "thread" })).toMatchObject({ ok: true });
    expect(await request(socketPath, "terminal.input", { threadId: "thread", data: "accepted" })).toMatchObject({ ok: true });
    expect(runtime.terminalInputs).toEqual(["accepted"]);
    expect(await request(socketPath, "terminal.release", { threadId: "thread" })).toMatchObject({ ok: true });
    expect(await request(socketPath, "terminal.input", { threadId: "thread", data: "blocked-again" }))
      .toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("removes its socket and internal session on shutdown", async () => {
    const { socketPath } = await setup();
    expect((storage!.db.prepare("SELECT COUNT(*) AS count FROM login_sessions").get() as { count: number }).count).toBe(1);
    await control!.close();
    control = undefined;
    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((storage!.db.prepare("SELECT COUNT(*) AS count FROM login_sessions").get() as { count: number }).count).toBe(0);
  });

  it("does not leave its internal session behind when socket listen fails", async () => {
    directory = await mkdtemp(join(tmpdir(), "cwb-control-"));
    storage = new Storage(":memory:");
    app = await buildServer(config, storage, { runtime: new FakeRuntime(), webRoot: false });
    control = new ControlServer(join(directory, "s".repeat(120)), config, storage, app);
    await expect(control.listen()).rejects.toBeInstanceOf(Error);
    expect((storage.db.prepare("SELECT COUNT(*) AS count FROM login_sessions").get() as { count: number }).count).toBe(0);
    control = undefined;
  });

  it("does not unlink an active daemon control socket", async () => {
    const { socketPath } = await setup();
    const second = new ControlServer(socketPath, config, storage!, app!);
    await expect(second.listen()).rejects.toThrow("control socket is already active");
    expect(await request(socketPath, "host.list")).toMatchObject({ ok: true, result: [] });
  });
});
