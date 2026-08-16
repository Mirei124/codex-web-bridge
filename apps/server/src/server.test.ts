import { afterEach, describe, expect, it } from "vitest";
import { Storage } from "@cwb/storage";
import type { AppConfig } from "@cwb/config";
import { hashPassword } from "./auth.js";
import { buildServer } from "./server.js";
import type { FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
import type { RuntimeManager } from "./runtime-manager.js";
let app: FastifyInstance | undefined;
let storage: Storage | undefined;
afterEach(async () => {
  await app?.close();
  storage?.close();
});
async function setup() {
  storage = new Storage(":memory:");
  app = await buildServer(
    {
      version: 1,
      bindHost: "127.0.0.1",
      port: 3210,
      publicOrigin: "https://bridge.example",
      passwordHash: await hashPassword("correct horse battery staple"),
      sessionSecret: "x".repeat(32),
      trustedProxy: "127.0.0.1",
    },
    storage,
  );
}
describe("HTTP boundary", () => {
  it("authenticates directly over HTTP and rejects spoofed proxy metadata", async () => {
    storage = new Storage(":memory:");
    app = await buildServer(
      {
        version: 1,
        bindHost: "127.0.0.1",
        port: 3210,
        publicOrigin: "http://127.0.0.1:3210",
        passwordHash: await hashPassword("correct horse battery staple"),
        sessionSecret: "x".repeat(32),
        trustedProxy: "127.0.0.1",
      },
      storage,
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: "http://127.0.0.1:3210" },
      payload: { password: "correct horse battery staple" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers["set-cookie"]).not.toContain("Secure");
    const spoofed = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "x-forwarded-proto": "http" },
      payload: { password: "correct horse battery staple" },
    });
    expect(spoofed.statusCode).toBe(404);
    expect(spoofed.body).toBe("");
  });
  it("accepts equivalent localhost and IPv4 loopback origins on the configured port", async () => {
    storage = new Storage(":memory:");
    app = await buildServer(
      {
        version: 1,
        bindHost: "127.0.0.1",
        port: 3210,
        publicOrigin: "http://localhost:3210",
        passwordHash: await hashPassword("correct horse battery staple"),
        sessionSecret: "x".repeat(32),
        trustedProxy: "127.0.0.1",
      },
      storage,
    );
    const loopback = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: "127.0.0.1:3210", origin: "http://127.0.0.1:3210" },
      payload: { password: "correct horse battery staple" },
    });
    expect(loopback.statusCode).toBe(200);
    const wrongPort = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: "127.0.0.1:9999", origin: "http://127.0.0.1:9999" },
      payload: { password: "correct horse battery staple" },
    });
    expect(wrongPort.statusCode).toBe(403);
    const nonLoopback = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: "bridge.attacker.test:3210", origin: "http://bridge.attacker.test:3210" },
      payload: { password: "correct horse battery staple" },
    });
    expect(nonLoopback.statusCode).toBe(403);
  });
  it("accepts the browser's actual HTTP origin only in all-interface danger mode", async () => {
    storage = new Storage(":memory:");
    app = await buildServer(
      {
        version: 1,
        bindHost: "0.0.0.0",
        port: 3210,
        publicOrigin: "http://127.0.0.1:3210",
        passwordHash: await hashPassword("correct horse battery staple"),
        sessionSecret: "x".repeat(32),
        trustedProxy: "127.0.0.1",
      },
      storage,
    );
    const accepted = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: "192.0.2.10:3210", origin: "http://192.0.2.10:3210" },
      payload: { password: "correct horse battery staple" },
    });
    expect(accepted.statusCode).toBe(200);
    const crossOrigin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: "192.0.2.10:3210", origin: "http://evil.example" },
      payload: { password: "correct horse battery staple" },
    });
    expect(crossOrigin.statusCode).toBe(403);
  });
  it("authenticates through the local HTTPS proxy and protects mutations with CSRF", async () => {
    await setup();
    const login = await app!.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "x-forwarded-proto": "https", origin: "https://bridge.example" },
      payload: { password: "correct horse battery staple" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers["set-cookie"]).toContain("Secure");
    const csrf = login.json().csrfToken;
    const cookie = login.cookies[0]!.name + "=" + login.cookies[0]!.value;
    const logout = await app!.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { "x-forwarded-proto": "https", origin: "https://bridge.example", cookie, "x-csrf-token": csrf },
    });
    expect(logout.statusCode).toBe(204);
  });
});

it("updates public settings without exposing internal secrets", async () => {
  storage = new Storage(":memory:");
  const config = {
    version: 1 as const,
    bindHost: "127.0.0.1" as const,
    port: 3210,
    publicOrigin: "https://bridge.example",
    passwordHash: await hashPassword("correct horse battery staple"),
    sessionSecret: "x".repeat(32),
    trustedProxy: "127.0.0.1" as const,
  };
  let saved: AppConfig | undefined;
  app = await buildServer(config, storage, {
    webRoot: false,
    settingsSaver: async (next) => {
      saved = next;
    },
  });
  const base = { "x-forwarded-proto": "https", origin: "https://bridge.example" };
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: base,
    payload: { password: "correct horse battery staple" },
  });
  const cookie = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`,
    headers = { ...base, cookie, "x-csrf-token": login.json().csrfToken };
  const before = await app.inject({ method: "GET", url: "/api/settings", headers: { ...base, cookie } });
  expect(before.json()).not.toHaveProperty("passwordHash");
  expect(before.json()).not.toHaveProperty("sessionSecret");
  const invalidOrigin = await app.inject({
    method: "PUT",
    url: "/api/settings",
    headers,
    payload: { bindHost: "127.0.0.1", port: 3210, publicOrigin: "https://new.example/dashboard" },
  });
  expect(invalidOrigin.statusCode).toBe(400);
  const updated = await app.inject({
    method: "PUT",
    url: "/api/settings",
    headers,
    payload: { bindHost: "0.0.0.0", port: 4321, publicOrigin: "https://new.example", newPassword: "new-password-123" },
  });
  expect(updated.statusCode).toBe(200);
  expect(updated.json()).toMatchObject({
    bindHost: "0.0.0.0",
    port: 4321,
    publicOrigin: "https://new.example",
    restartRequired: true,
  });
  expect(saved).toMatchObject({ bindHost: "0.0.0.0", port: 4321, publicOrigin: "https://new.example" });
  expect(saved!.passwordHash).not.toBe(config.passwordHash);
  expect((await app.inject({ method: "GET", url: "/api/settings", headers: { ...base, cookie } })).statusCode).toBe(
    401,
  );
});

class FakeRuntime implements RuntimeManager {
  events = new EventEmitter();
  calls: string[] = [];
  resolutions: Array<{ requestId: string | number; value: unknown }> = [];
  failExit = false;
  historicalThreads: Array<{ id: string; title?: string; cwd?: string; updatedAt?: string }> = [];
  directoryExists = true;
  directoryChecks: Array<{ cwd: string; create: boolean }> = [];
  async ensureWorkingDirectory(_host: unknown, cwd: string, create: boolean) {
    this.directoryChecks.push({ cwd, create });
    return this.directoryExists || create;
  }
  async create() {
    this.calls.push("create");
    return "codex-1";
  }
  async resume() {
    this.calls.push("resume");
  }
  async reconnect(_host: unknown, thread: { remotePort?: number }) {
    this.calls.push(`reconnect:${thread.remotePort}`);
  }
  async detach(threadId: string) {
    this.calls.push(`detach:${threadId}`);
  }
  async exit(_thread: unknown, host?: { id: string }) {
    this.calls.push(`exit:${host?.id}`);
    if (this.failExit) throw new Error("tmux stop failed");
  }
  async send() {
    this.calls.push("send");
    return "turn-1";
  }
  async interrupt() {
    this.calls.push("interrupt");
  }
  async resolve(_thread: unknown, requestId: string | number, value: unknown) {
    this.calls.push("resolve");
    this.resolutions.push({ requestId, value });
  }
  async prepareTerminal() {
    this.calls.push("prepareTerminal");
  }
  async terminalInput() {
    this.calls.push("input");
  }
  async terminalSnapshot() {
    return { ansi: "\u001b[31mred\u001b[0m", cols: 80, rows: 24 };
  }
  async close() {}
  async terminalSeed() {
    return "\u001b[31mseed\u001b[0m";
  }
  async listHistorical() {
    return this.historicalThreads;
  }
  setHostPassword(hostId: string, password?: string) {
    this.calls.push(`password:${hostId}:${password ?? "cleared"}`);
  }
}
it("deletes only hosts without bridge-managed threads", async () => {
  storage = new Storage(":memory:");
  storage.upsertHost({
    id: "host",
    name: "A",
    hostname: "a",
    port: 22,
    username: "u",
    hostKeySha256: "key",
    identityFile: "",
    createdAt: 1,
  });
  storage.createThread({
    id: "thread",
    hostId: "host",
    tmuxSession: "tmux",
    workingDirectory: "/work",
    title: "t",
    status: "exited",
    createdAt: 1,
    updatedAt: 1,
  });
  const runtime = new FakeRuntime();
  app = await buildServer(
    {
      version: 1,
      bindHost: "127.0.0.1",
      port: 3210,
      publicOrigin: "https://bridge.example",
      passwordHash: await hashPassword("correct horse battery staple"),
      sessionSecret: "x".repeat(32),
      trustedProxy: "127.0.0.1",
    },
    storage,
    { runtime, webRoot: false },
  );
  const base = { "x-forwarded-proto": "https", origin: "https://bridge.example" },
    login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: base,
      payload: { password: "correct horse battery staple" },
    }),
    headers = {
      ...base,
      cookie: `${login.cookies[0]!.name}=${login.cookies[0]!.value}`,
      "x-csrf-token": login.json().csrfToken,
    };
  expect((await app.inject({ method: "DELETE", url: "/api/hosts/host", headers })).statusCode).toBe(409);
  storage.deleteThread("thread");
  expect((await app.inject({ method: "DELETE", url: "/api/hosts/host", headers })).statusCode).toBe(204);
  expect(storage.host("host")).toBeUndefined();
  expect(runtime.calls).toContain("password:host:cleared");
  expect((await app.inject({ method: "DELETE", url: "/api/hosts/host", headers })).statusCode).toBe(404);
});
it("wires authenticated thread operations to the runtime", async () => {
  storage = new Storage(":memory:");
  storage.upsertHost({
    id: "host",
    name: "A",
    hostname: "a",
    port: 22,
    username: "u",
    hostKeySha256: "key",
    identityFile: "/key",
    createdAt: 1,
  });
  const runtime = new FakeRuntime(),
    emitted: any[] = [];
  app = await buildServer(
    {
      version: 1,
      bindHost: "127.0.0.1",
      port: 3210,
      publicOrigin: "https://bridge.example",
      passwordHash: await hashPassword("correct horse battery staple"),
      sessionSecret: "x".repeat(32),
      trustedProxy: "127.0.0.1",
    },
    storage,
    { runtime, webRoot: false, eventSink: (event) => emitted.push(event) },
  );
  const base = { "x-forwarded-proto": "https", origin: "https://bridge.example" };
  const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: base,
      payload: { password: "correct horse battery staple" },
    }),
    csrf = login.json().csrfToken,
    cookie = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`,
    headers = { ...base, cookie, "x-csrf-token": csrf };
  const hosts = await app.inject({ method: "GET", url: "/api/hosts", headers: { ...base, cookie } });
  expect(hosts.json()[0]).toMatchObject({
    id: "host",
    hostname: "a",
    port: 22,
    username: "u",
    hostKeySha256: "key",
    identityFile: "/key",
  });
  const customTitle = await app.inject({
    method: "POST",
    url: "/api/threads",
    headers,
    payload: { hostId: "host", cwd: "/work", title: "custom" },
  });
  expect(customTitle.statusCode).toBe(400);
  const invalidProxy = await app.inject({
    method: "POST",
    url: "/api/threads",
    headers,
    payload: { hostId: "host", cwd: "/work", proxy: "file:///tmp/socket" },
  });
  expect(invalidProxy.statusCode).toBe(400);
  const invalidPath = await app.inject({
    method: "POST",
    url: "/api/threads",
    headers,
    payload: { hostId: "host", cwd: "/work", prependPath: "relative/bin" },
  });
  expect(invalidPath.statusCode).toBe(400);
  runtime.directoryExists = false;
  const missingDirectory = await app.inject({
    method: "POST",
    url: "/api/threads",
    headers,
    payload: { hostId: "host", cwd: "/missing" },
  });
  expect(missingDirectory.statusCode).toBe(409);
  expect(missingDirectory.json()).toMatchObject({ code: "WORKING_DIRECTORY_NOT_FOUND" });
  expect(storage.threads()).toHaveLength(0);
  const created = await app.inject({
    method: "POST",
    url: "/api/threads",
    headers,
    payload: {
      hostId: "host",
      cwd: "/work",
      proxy: "http://proxy.example:8080",
      prependPath: "/thread/bin",
      createDirectory: true,
    },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().id;
  expect(created.json()).toMatchObject({
    title: `Codex thread ${id.slice(0, 8)}`,
    proxy: "http://proxy.example:8080",
    prependPath: "/thread/bin",
  });
  expect(storage.thread(id)).toMatchObject({ proxy: "http://proxy.example:8080", prependPath: "/thread/bin" });
  expect(runtime.directoryChecks).toContainEqual({ cwd: "/work", create: true });
  const sent = await app.inject({
    method: "POST",
    url: `/api/threads/${id}/messages`,
    headers,
    payload: { text: "hi" },
  });
  expect(sent.statusCode).toBe(200);
  expect(sent.json()).toEqual({ turnId: "turn-1" });
  expect((await app.inject({ method: "POST", url: `/api/threads/${id}/interrupt`, headers })).statusCode).toBe(204);
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/api/threads/${id}/terminal/takeover`,
        headers,
        payload: { enabled: true },
      })
    ).statusCode,
  ).toBe(204);
  expect(
    (await app.inject({ method: "POST", url: `/api/threads/${id}/terminal/input`, headers, payload: { data: "x" } }))
      .statusCode,
  ).toBe(204);
  const snapshot = await app.inject({
    method: "GET",
    url: `/api/threads/${id}/terminal/screenshot`,
    headers: { ...base, cookie },
  });
  expect(snapshot.statusCode).toBe(200);
  expect(snapshot.json()).toMatchObject({ ansi: "\u001b[31mred\u001b[0m", cols: 80, rows: 24 });
  expect((await app.inject({ method: "POST", url: `/api/threads/${id}/exit`, headers })).statusCode).toBe(204);
  const restored = await app.inject({ method: "POST", url: `/api/threads/${id}/resume`, headers });
  expect(restored.statusCode).toBe(200);
  expect(restored.json()).toMatchObject({
    id,
    status: "idle",
    proxy: "http://proxy.example:8080",
    prependPath: "/thread/bin",
  });
  runtime.events.emit("event", {
    type: "codex",
    threadId: id,
    payload: { method: "model/rerouted", params: { fromModel: "gpt-old", toModel: "gpt-new" } },
  });
  runtime.events.emit("event", {
    type: "codex",
    threadId: id,
    payload: { method: "model/rerouted", params: { fromModel: "gpt-old", toModel: "gpt-new" } },
  });
  expect(emitted.filter((event) => event.type === "thread.model.updated")).toEqual([
    { type: "thread.model.updated", threadId: id, model: "gpt-new" },
  ]);
  expect((await app.inject({ method: "DELETE", url: `/api/threads/${id}`, headers })).statusCode).toBe(204);
  expect(storage.thread(id)).toBeUndefined();
  expect(runtime.calls).toEqual(
    expect.arrayContaining(["create", "send", "interrupt", "input", "exit:host", "resume", `detach:${id}`]),
  );
});
it("keeps a thread active when the remote tmux cannot be stopped", async () => {
  storage = new Storage(":memory:");
  storage.upsertHost({
    id: "host",
    name: "A",
    hostname: "a",
    port: 22,
    username: "u",
    hostKeySha256: "key",
    identityFile: "/key",
    createdAt: 1,
  });
  storage.createThread({
    id: "thread",
    hostId: "host",
    codexThreadId: "codex",
    tmuxSession: "cwb-thread",
    remotePort: 45678,
    workingDirectory: "/work",
    title: "thread",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });
  const runtime = new FakeRuntime();
  runtime.failExit = true;
  app = await buildServer(
    {
      version: 1,
      bindHost: "127.0.0.1",
      port: 3210,
      publicOrigin: "https://bridge.example",
      passwordHash: await hashPassword("correct horse battery staple"),
      sessionSecret: "x".repeat(32),
      trustedProxy: "127.0.0.1",
    },
    storage,
    { runtime, webRoot: false },
  );
  const base = { "x-forwarded-proto": "https", origin: "https://bridge.example" },
    login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: base,
      payload: { password: "correct horse battery staple" },
    }),
    cookie = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`,
    csrf = login.json().csrfToken;
  const result = await app.inject({
    method: "POST",
    url: "/api/threads/thread/exit",
    headers: { ...base, cookie, "x-csrf-token": csrf },
  });
  expect(result.statusCode).toBe(500);
  expect(storage.thread("thread")?.status).toBe("idle");
});
it("reconnects a persisted active thread on its original remote port", async () => {
  storage = new Storage(":memory:");
  storage.upsertHost({
    id: "host",
    name: "A",
    hostname: "a",
    port: 22,
    username: "u",
    hostKeySha256: "key",
    identityFile: "/key",
    createdAt: 1,
  });
  storage.createThread({
    id: "thread",
    hostId: "host",
    codexThreadId: "codex",
    tmuxSession: "cwb-thread",
    remotePort: 45678,
    workingDirectory: "/work",
    title: "thread",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });
  const runtime = new FakeRuntime();
  app = await buildServer(
    {
      version: 1,
      bindHost: "127.0.0.1",
      port: 3210,
      publicOrigin: "https://bridge.example",
      passwordHash: await hashPassword("correct horse battery staple"),
      sessionSecret: "x".repeat(32),
      trustedProxy: "127.0.0.1",
    },
    storage,
    { runtime, webRoot: false },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(runtime.calls).toContain("reconnect:45678");
});
it("expires pending RPC callbacks when the runtime connection generation changes", async () => {
  storage = new Storage(":memory:");
  storage.upsertHost({
    id: "host",
    name: "A",
    hostname: "a",
    port: 22,
    username: "u",
    hostKeySha256: "key",
    identityFile: "/key",
    createdAt: 1,
  });
  storage.createThread({
    id: "thread",
    hostId: "host",
    codexThreadId: "codex",
    tmuxSession: "cwb-thread",
    remotePort: 45678,
    workingDirectory: "/work",
    title: "thread",
    status: "waiting",
    createdAt: 1,
    updatedAt: 1,
  });
  storage.putPending({
    id: "bridge-request",
    threadId: "thread",
    payload: "{}",
    rpcId: "7",
    method: "item/tool/requestUserInput",
    params: "{}",
    createdAt: 1,
  });
  const runtime = new FakeRuntime();
  app = await buildServer(
    {
      version: 1,
      bindHost: "127.0.0.1",
      port: 3210,
      publicOrigin: "https://bridge.example",
      passwordHash: await hashPassword("correct horse battery staple"),
      sessionSecret: "x".repeat(32),
      trustedProxy: "127.0.0.1",
    },
    storage,
    { runtime, webRoot: false },
  );
  runtime.events.emit("connectionGenerationChanged", { threadId: "thread" });
  expect(storage.pending("thread")).toHaveLength(0);
  const base = { "x-forwarded-proto": "https", origin: "https://bridge.example" },
    login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: base,
      payload: { password: "correct horse battery staple" },
    }),
    cookie = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`,
    csrf = login.json().csrfToken;
  const stale = await app.inject({
    method: "POST",
    url: "/api/threads/thread/requests/bridge-request",
    headers: { ...base, cookie, "x-csrf-token": csrf },
    payload: { answers: { question: { answers: ["old"] } } },
  });
  expect(stale.statusCode).toBe(409);
  expect(runtime.calls).not.toContain("resolve");
});

it("maps session-scoped approval responses to Codex RPC results", async () => {
  storage = new Storage(":memory:");
  storage.upsertHost({
    id: "host",
    name: "A",
    hostname: "a",
    port: 22,
    username: "u",
    hostKeySha256: "key",
    identityFile: "/key",
    createdAt: 1,
  });
  storage.createThread({
    id: "thread",
    hostId: "host",
    codexThreadId: "codex",
    tmuxSession: "cwb-thread",
    remotePort: 45678,
    workingDirectory: "/work",
    title: "thread",
    status: "waiting",
    createdAt: 1,
    updatedAt: 1,
  });
  storage.putPending({
    id: "permissions",
    threadId: "thread",
    payload: "{}",
    rpcId: '"rpc-permissions"',
    method: "item/permissions/requestApproval",
    params: JSON.stringify({ permissions: { "run:pnpm test": true } }),
    createdAt: 1,
  });
  storage.putPending({
    id: "command",
    threadId: "thread",
    payload: "{}",
    rpcId: '"rpc-command"',
    method: "item/commandExecution/requestApproval",
    params: "{}",
    createdAt: 2,
  });
  const runtime = new FakeRuntime();
  app = await buildServer(
    {
      version: 1,
      bindHost: "127.0.0.1",
      port: 3210,
      publicOrigin: "https://bridge.example",
      passwordHash: await hashPassword("correct horse battery staple"),
      sessionSecret: "x".repeat(32),
      trustedProxy: "127.0.0.1",
    },
    storage,
    { runtime, webRoot: false },
  );
  const base = { "x-forwarded-proto": "https", origin: "https://bridge.example" },
    login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: base,
      payload: { password: "correct horse battery staple" },
    }),
    cookie = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`,
    csrf = login.json().csrfToken,
    headers = { ...base, cookie, "x-csrf-token": csrf };
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/threads/thread/requests/permissions",
        headers,
        payload: { approved: true, scope: "session" },
      })
    ).statusCode,
  ).toBe(204);
  expect(storage.thread("thread")?.status).toBe("waiting");
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/threads/thread/requests/command",
        headers,
        payload: { approved: true, scope: "session" },
      })
    ).statusCode,
  ).toBe(204);
  expect(storage.thread("thread")?.status).toBe("running");
  expect(runtime.resolutions).toEqual([
    {
      requestId: "rpc-permissions",
      value: { permissions: { "run:pnpm test": true }, scope: "session" },
    },
    { requestId: "rpc-command", value: { decision: "acceptForSession" } },
  ]);
});

it("publishes MCP URL elicitations as pending approval requests", async () => {
  storage = new Storage(":memory:");
  storage.upsertHost({
    id: "host",
    name: "A",
    hostname: "a",
    port: 22,
    username: "u",
    hostKeySha256: "key",
    identityFile: "/key",
    createdAt: 1,
  });
  storage.createThread({
    id: "thread",
    hostId: "host",
    codexThreadId: "codex",
    tmuxSession: "cwb-thread",
    remotePort: 45678,
    workingDirectory: "/work",
    title: "thread",
    status: "running",
    createdAt: 1,
    updatedAt: 1,
  });
  const runtime = new FakeRuntime();
  const events: unknown[] = [];
  app = await buildServer(
    {
      version: 1,
      bindHost: "127.0.0.1",
      port: 3210,
      publicOrigin: "https://bridge.example",
      passwordHash: await hashPassword("correct horse battery staple"),
      sessionSecret: "x".repeat(32),
      trustedProxy: "127.0.0.1",
    },
    storage,
    { runtime, webRoot: false, eventSink: (event) => events.push(event) },
  );
  runtime.events.emit("event", {
    threadId: "thread",
    type: "codex",
    payload: {
      id: "rpc-mcp-url",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "codex",
        turnId: "turn",
        serverName: "github",
        mode: "url",
        message: "Authorize GitHub MCP",
        url: "https://github.com/login/oauth/authorize",
        elicitationId: "elicit-1",
        _meta: null,
      },
    },
  });
  const pending = storage.pending("thread");
  expect(pending).toHaveLength(1);
  expect(JSON.parse(pending[0]!.payload)).toMatchObject({
    kind: "approval",
    title: "MCP authorization: github",
    detail: expect.stringContaining("Authorize GitHub MCP"),
    command: "https://github.com/login/oauth/authorize",
  });
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "request.created",
      threadId: "thread",
      request: expect.objectContaining({ kind: "approval", title: "MCP authorization: github" }),
    }),
  );
});

it("maps MCP elicitation responses to Codex RPC results", async () => {
  storage = new Storage(":memory:");
  storage.upsertHost({
    id: "host",
    name: "A",
    hostname: "a",
    port: 22,
    username: "u",
    hostKeySha256: "key",
    identityFile: "/key",
    createdAt: 1,
  });
  storage.createThread({
    id: "thread",
    hostId: "host",
    codexThreadId: "codex",
    tmuxSession: "cwb-thread",
    remotePort: 45678,
    workingDirectory: "/work",
    title: "thread",
    status: "waiting",
    createdAt: 1,
    updatedAt: 1,
  });
  storage.putPending({
    id: "mcp-form",
    threadId: "thread",
    payload: "{}",
    rpcId: '"rpc-mcp-form"',
    method: "mcpServer/elicitation/request",
    params: JSON.stringify({
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: {
          repository: { type: "string" },
          private: { type: "boolean" },
        },
      },
    }),
    createdAt: 1,
  });
  const runtime = new FakeRuntime();
  app = await buildServer(
    {
      version: 1,
      bindHost: "127.0.0.1",
      port: 3210,
      publicOrigin: "https://bridge.example",
      passwordHash: await hashPassword("correct horse battery staple"),
      sessionSecret: "x".repeat(32),
      trustedProxy: "127.0.0.1",
    },
    storage,
    { runtime, webRoot: false },
  );
  const base = { "x-forwarded-proto": "https", origin: "https://bridge.example" },
    login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: base,
      payload: { password: "correct horse battery staple" },
    }),
    headers = {
      ...base,
      cookie: `${login.cookies[0]!.name}=${login.cookies[0]!.value}`,
      "x-csrf-token": login.json().csrfToken,
    };
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/threads/thread/requests/mcp-form",
        headers,
        payload: {
          answers: {
            repository: { answers: ["codex-web-bridge"] },
            private: { answers: ["true"] },
          },
        },
      })
    ).statusCode,
  ).toBe(204);
  expect(runtime.resolutions).toEqual([
    {
      requestId: "rpc-mcp-form",
      value: {
        action: "accept",
        content: { repository: "codex-web-bridge", private: true },
        _meta: null,
      },
    },
  ]);
});

it("uses discovered history cwd when resuming without an explicit cwd and limits history results to six", async () => {
  storage = new Storage(":memory:");
  storage.upsertHost({
    id: "host",
    name: "A",
    hostname: "a",
    port: 22,
    username: "u",
    hostKeySha256: "key",
    identityFile: "/key",
    createdAt: 1,
  });
  const runtime = new FakeRuntime();
  runtime.historicalThreads = Array.from({ length: 8 }, (_, index) => ({
    id: `codex-${index}`,
    title: `Thread ${index}`,
    cwd: `/work/${index}`,
  }));
  app = await buildServer(
    {
      version: 1,
      bindHost: "127.0.0.1",
      port: 3210,
      publicOrigin: "https://bridge.example",
      passwordHash: await hashPassword("correct horse battery staple"),
      sessionSecret: "x".repeat(32),
      trustedProxy: "127.0.0.1",
    },
    storage,
    { runtime, webRoot: false },
  );
  const base = { "x-forwarded-proto": "https", origin: "https://bridge.example" };
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: base,
    payload: { password: "correct horse battery staple" },
  });
  const headers = {
    ...base,
    cookie: `${login.cookies[0]!.name}=${login.cookies[0]!.value}`,
    "x-csrf-token": login.json().csrfToken,
  };
  const history = await app.inject({ method: "GET", url: "/api/hosts/host/codex-threads", headers });
  expect(history.statusCode).toBe(200);
  expect(history.json()).toHaveLength(6);
  const resumed = await app.inject({
    method: "POST",
    url: "/api/threads/resume",
    headers,
    payload: { hostId: "host", codexThreadId: "codex-3" },
  });
  expect(resumed.statusCode).toBe(201);
  expect(resumed.json()).toMatchObject({ codexThreadId: "codex-3", cwd: "/work/3", status: "idle" });
});

it("allows in-place resume for reconnect-failed threads", async () => {
  storage = new Storage(":memory:");
  storage.upsertHost({
    id: "host",
    name: "A",
    hostname: "a",
    port: 22,
    username: "u",
    hostKeySha256: "key",
    identityFile: "/key",
    createdAt: 1,
  });
  storage.createThread({
    id: "thread",
    hostId: "host",
    codexThreadId: "codex-1",
    tmuxSession: "cwb-thread",
    remotePort: 45678,
    workingDirectory: "/work",
    title: "Reconnect failed",
    status: "error",
    lastError: "Unable to reconnect to the remote Codex runtime",
    lastErrorKind: "reconnect_failed",
    hasRollout: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  const runtime = new FakeRuntime();
  app = await buildServer(
    {
      version: 1,
      bindHost: "127.0.0.1",
      port: 3210,
      publicOrigin: "https://bridge.example",
      passwordHash: await hashPassword("correct horse battery staple"),
      sessionSecret: "x".repeat(32),
      trustedProxy: "127.0.0.1",
    },
    storage,
    { runtime, webRoot: false },
  );
  const base = { "x-forwarded-proto": "https", origin: "https://bridge.example" };
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: base,
    payload: { password: "correct horse battery staple" },
  });
  const headers = {
    ...base,
    cookie: `${login.cookies[0]!.name}=${login.cookies[0]!.value}`,
    "x-csrf-token": login.json().csrfToken,
  };
  const resumed = await app.inject({ method: "POST", url: "/api/threads/thread/resume", headers });
  expect(resumed.statusCode).toBe(200);
  expect(resumed.json()).toMatchObject({ id: "thread", status: "idle" });
  expect(runtime.calls).toContain("resume");
});
