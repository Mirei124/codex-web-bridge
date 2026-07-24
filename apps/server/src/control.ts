import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import type { FastifyInstance, InjectOptions } from "fastify";
import {
  apiRoutes,
  controlMethods,
  serverEventThreadId,
  type ControlError,
  type ControlEvent,
  type ControlDone,
  type ControlRequest,
  type ControlResponse,
  type ServerEvent,
  type ThreadDetail,
} from "@cwb/protocol";
import { paths, type AppConfig } from "@cwb/config";
import type { Storage } from "@cwb/storage";
import { HostKeyError, internalHostKeyToken, verifyHostKey } from "./host-key.js";

interface ClientState {
  socket: Socket;
  buffer: string;
  sessionId: string;
  csrfToken: string;
  subscriptions: Map<string, Subscription>;
}

interface Subscription {
  id: string;
  mode: "thread" | "terminal" | "wait";
  ready: boolean;
  finishing: boolean;
  queued: ServerEvent[];
}

export class ControlServer {
  private readonly server: Server;
  private readonly clients = new Set<ClientState>();
  private readonly sessionId = randomUUID();
  private readonly csrfToken = randomUUID();

  constructor(
    private readonly socketPath: string,
    private readonly config: AppConfig,
    private readonly storage: Storage,
    private readonly app: FastifyInstance,
  ) {
    this.server = createServer(socket => this.connect(socket));
  }

  async listen(): Promise<void> {
    await mkdir(this.socketPath.slice(0, this.socketPath.lastIndexOf("/")), { recursive: true, mode: 0o700 });
    await chmod(this.socketPath.slice(0, this.socketPath.lastIndexOf("/")), 0o700);
    const lockPath = `${this.socketPath}.lock`;
    const lock = await acquireStartupLock(lockPath);
    let bound = false;
    try {
      try {
        const entry = await lstat(this.socketPath);
        if (!entry.isSocket()) throw new Error(`control path exists and is not a socket: ${this.socketPath}`);
        if (await socketAcceptsConnections(this.socketPath)) throw new Error(`control socket is already active: ${this.socketPath}`);
        await unlink(this.socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const now = Date.now();
      this.storage.createSession({ id: this.sessionId, csrfToken: this.csrfToken, createdAt: now, expiresAt: Number.MAX_SAFE_INTEGER });
      try {
        await new Promise<void>((resolve, reject) => {
          this.server.once("error", reject);
          this.server.listen(this.socketPath, () => {
            bound = true;
            this.server.off("error", reject);
            resolve();
          });
        });
        await chmod(this.socketPath, 0o600);
      } catch (error) {
        this.storage.deleteSession(this.sessionId);
        if (bound) {
          await new Promise<void>(resolve => this.server.close(() => resolve()));
          await unlink(this.socketPath).catch(() => undefined);
        }
        throw error;
      }
    } finally {
      await releaseStartupLock(lock, lockPath);
    }
  }

  publish(event: ServerEvent): void {
    const threadId = serverEventThreadId(event);
    if (!threadId) return;
    for (const client of this.clients) {
      const subscription = client.subscriptions.get(threadId);
      if (!subscription) continue;
      if (!subscription.ready) subscription.queued.push(event);
      else this.deliver(client, threadId, subscription, event);
    }
  }

  async close(): Promise<void> {
    if (this.storage.session(this.sessionId)) {
      await this.release({ sessionId: this.sessionId, csrfToken: this.csrfToken });
    }
    for (const client of this.clients) client.socket.destroy();
    if (this.server.listening) await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
    await unlink(this.socketPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  private connect(socket: Socket): void {
    const state: ClientState = {
      socket,
      buffer: "",
      sessionId: this.sessionId,
      csrfToken: this.csrfToken,
      subscriptions: new Map(),
    };
    this.clients.add(state);
    socket.setEncoding("utf8");
    socket.on("data", chunk => this.consume(state, String(chunk)));
    socket.on("close", () => {
      this.clients.delete(state);
    });
    socket.on("error", () => undefined);
  }

  private async release(state: Pick<ClientState, "sessionId" | "csrfToken">): Promise<void> {
    if (!this.storage.session(state.sessionId)) return;
    try {
      await this.inject(state, "POST", apiRoutes.logout);
    } catch {
      this.storage.deleteSession(state.sessionId);
    }
  }

  private consume(state: ClientState, chunk: string): void {
    state.buffer += chunk;
    if (Buffer.byteLength(state.buffer) > 1_048_576) {
      state.socket.destroy(new Error("control request is too large"));
      return;
    }
    let newline: number;
    while ((newline = state.buffer.indexOf("\n")) >= 0) {
      const line = state.buffer.slice(0, newline);
      state.buffer = state.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      void this.handle(state, line);
    }
  }

  private async handle(state: ClientState, line: string): Promise<void> {
    let request: ControlRequest;
    try {
      request = JSON.parse(line) as ControlRequest;
      if (request.version !== 1 || typeof request.id !== "string" || !request.id || !controlMethods.includes(request.method)) {
        throw new ControlFailure("INVALID_REQUEST", "invalid control request", false);
      }
      const result = await this.dispatch(state, request.id, request.method, request.params ?? {});
      if (result !== streaming) this.write(state, { version: 1, id: request.id, ok: true, result } satisfies ControlResponse);
    } catch (error) {
      const failure = normalizeError(error);
      this.write(state, { version: 1, id: typeof request!?.id === "string" ? request.id : "", ok: false, error: failure } satisfies ControlResponse);
    }
  }

  private async dispatch(state: ClientState, requestId: string, method: ControlRequest["method"], params: Record<string, unknown>): Promise<unknown> {
    if (method === "host.list") return this.inject(state, "GET", apiRoutes.hosts);
    if (method === "host.get") return findById(await this.inject(state, "GET", apiRoutes.hosts), idParam(params), "HOST_NOT_FOUND");
    if (method === "host.upsert") {
      const host = { ...((params.host ?? params) as Record<string, unknown>) };
      const verified = await verifyHostKey(host, Boolean(host.acceptHostKey));
      delete host.acceptHostKey;
      return this.inject(state, "POST", apiRoutes.hosts, { ...host, hostKeySha256: verified.fingerprint, acceptHostKey: true });
    }
    if (method === "host.codexThreads") return this.inject(state, "GET", apiRoutes.hostCodexThreads(idParam(params)));
    if (method === "thread.list") return this.inject(state, "GET", apiRoutes.threads);
    if (method === "thread.get") return this.thread(state, idParam(params));
    if (method === "thread.create") return this.inject(state, "POST", apiRoutes.threads, params);
    if (method === "thread.resume") return this.inject(state, "POST", apiRoutes.resumeThread, params);
    if (method === "thread.exit") return this.inject(state, "POST", `${apiRoutes.threads}/${encodeURIComponent(idParam(params))}/exit`);
    if (method === "thread.send") return this.inject(state, "POST", `${apiRoutes.threads}/${encodeURIComponent(idParam(params))}/messages`, { text: stringParam(params, "text") });
    if (method === "thread.interrupt") return this.inject(state, "POST", `${apiRoutes.threads}/${encodeURIComponent(idParam(params))}/interrupt`);
    if (method === "thread.watch" || method === "thread.wait" || method === "terminal.watch") {
      const threadId = idParam(params);
      const subscription: Subscription = {
        id: requestId,
        mode: method === "thread.wait" ? "wait" : method === "terminal.watch" ? "terminal" : "thread",
        ready: false,
        finishing: false,
        queued: [],
      };
      state.subscriptions.set(threadId, subscription);
      let snapshot: ThreadDetail;
      try {
        snapshot = await this.thread(state, threadId);
      } catch (error) {
        state.subscriptions.delete(threadId);
        throw error;
      }
      if (method !== "thread.wait") this.write(state, { version: 1, id: requestId, event: { type: "snapshot", thread: snapshot } } satisfies ControlEvent);
      let current = snapshot;
      for (;;) {
        const queued = subscription.queued.splice(0);
        for (const event of queued) {
          if (subscription.mode === "thread" || subscription.mode === "terminal" && (event.type === "terminal.data" || event.type === "terminal.state")) {
            this.write(state, { version: 1, id: subscription.id, event } satisfies ControlEvent);
          }
          if (event.type === "thread.updated") current = { ...current, ...event.thread };
        }
        if (!endsSubscription(subscription.mode, current.status)) {
          subscription.ready = true;
          return streaming;
        }
        current = await this.thread(state, threadId);
        if (subscription.queued.length) continue;
        state.subscriptions.delete(threadId);
        if (method === "thread.wait") return current;
        this.write(state, { version: 1, id: requestId, done: true, result: current } satisfies ControlDone);
        return streaming;
      }
    }
    if (method === "request.list") return (await this.thread(state, stringParam(params, "threadId"))).pendingRequests;
    if (method === "request.get") return findById((await this.thread(state, stringParam(params, "threadId"))).pendingRequests, stringParam(params, "requestId"), "REQUEST_NOT_FOUND", "requestId");
    if (method.startsWith("request.")) {
      const threadId = stringParam(params, "threadId");
      const requestId = stringParam(params, "requestId");
      let body: unknown;
      if (method === "request.approve") body = { approved: true };
      else if (method === "request.decline") body = { approved: false };
      else if (method === "request.answer") body = { answers: objectParam(params, "answers") };
      else body = params.response ?? Object.fromEntries(Object.entries(params).filter(([key]) => key !== "threadId" && key !== "requestId"));
      return this.inject(state, "POST", `${apiRoutes.threads}/${encodeURIComponent(threadId)}/requests/${encodeURIComponent(requestId)}`, body);
    }
    if (method === "terminal.screenshot") {
      const result = await this.injectRaw(state, "GET", `${apiRoutes.threads}/${encodeURIComponent(stringParam(params, "threadId"))}/terminal/screenshot`);
      return { mimeType: result.contentType, data: result.body.toString("base64") };
    }
    if (method === "terminal.takeover" || method === "terminal.release") {
      return this.inject(state, "POST", `${apiRoutes.threads}/${encodeURIComponent(stringParam(params, "threadId"))}/terminal/takeover`, {
        enabled: method === "terminal.takeover",
        ...(method === "terminal.takeover" ? { ttlMs: 300_000 } : {}),
      });
    }
    if (method === "terminal.input") {
      const threadId = stringParam(params, "threadId");
      return this.inject(state, "POST", `${apiRoutes.threads}/${encodeURIComponent(threadId)}/terminal/input`, {
        data: stringParam(params, "data"),
        ttlMs: 300_000,
      });
    }
    throw new ControlFailure("METHOD_NOT_FOUND", `unsupported method: ${method}`, false);
  }

  private async thread(state: ClientState, threadId: string): Promise<ThreadDetail> {
    return this.inject(state, "GET", `${apiRoutes.threads}/${encodeURIComponent(threadId)}`) as Promise<ThreadDetail>;
  }

  private deliver(state: ClientState, threadId: string, subscription: Subscription, event: ServerEvent): void {
    const terminal = event.type === "thread.updated" && endsSubscription(subscription.mode, event.thread.status);
    if (subscription.mode === "thread" || subscription.mode === "terminal" && (event.type === "terminal.data" || event.type === "terminal.state")) {
      this.write(state, { version: 1, id: subscription.id, event } satisfies ControlEvent);
    }
    if (!terminal || subscription.finishing) return;
    subscription.finishing = true;
    state.subscriptions.delete(threadId);
    void this.thread(state, threadId).then(detail => {
      if (event.type === "thread.updated") detail = { ...detail, ...event.thread };
      if (subscription.mode === "wait") this.write(state, { version: 1, id: subscription.id, ok: true, result: detail } satisfies ControlResponse);
      else this.write(state, { version: 1, id: subscription.id, done: true, result: detail } satisfies ControlDone);
    }).catch(error => {
      this.write(state, { version: 1, id: subscription.id, ok: false, error: normalizeError(error) } satisfies ControlResponse);
    });
  }

  private async inject(state: Pick<ClientState, "sessionId" | "csrfToken">, method: "GET" | "POST", url: string, payload?: unknown): Promise<any> {
    const result = await this.injectRaw(state, method, url, payload);
    if (result.body.length === 0) return {};
    return JSON.parse(result.body.toString("utf8"));
  }

  private async injectRaw(state: Pick<ClientState, "sessionId" | "csrfToken">, method: "GET" | "POST", url: string, payload?: unknown) {
    const options: InjectOptions = {
      method,
      url,
      headers: {
        "x-forwarded-proto": "https",
        origin: this.config.publicOrigin,
        cookie: `cwb_session=${state.sessionId}`,
        "x-cwb-internal-host-key": internalHostKeyToken,
        ...(method === "POST" ? { "x-csrf-token": state.csrfToken } : {}),
      },
      ...(payload === undefined ? {} : { payload: payload as InjectOptions["payload"] }),
    };
    const response = await this.app.inject(options);
    if (response.statusCode >= 400) {
      const body = response.json() as { error?: string; message?: string };
      const code = response.statusCode === 404 ? "NOT_FOUND" : response.statusCode === 409 ? "CONFLICT" : response.statusCode === 403 ? "FORBIDDEN" : response.statusCode >= 500 ? "RUNTIME_FAILURE" : "INVALID_ARGUMENT";
      throw new ControlFailure(code, body.error ?? body.message ?? `request failed (${response.statusCode})`, response.statusCode >= 500);
    }
    return { body: response.rawPayload, contentType: response.headers["content-type"] };
  }

  private write(state: ClientState, value: ControlResponse | ControlEvent | ControlDone): void {
    if (!state.socket.destroyed) state.socket.write(`${JSON.stringify(value)}\n`);
  }
}

const streaming = Symbol("streaming");

class ControlFailure extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean, readonly details?: unknown) {
    super(message);
  }
}

function normalizeError(error: unknown): ControlError {
  if (error instanceof ControlFailure) return { code: error.code, message: error.message, retryable: error.retryable, ...(error.details === undefined ? {} : { details: error.details }) };
  if (error instanceof HostKeyError) return { code: error.code, message: error.message, retryable: error.retryable, ...(error.details === undefined ? {} : { details: error.details }) };
  return { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error), retryable: false };
}

function stringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || !value) throw new ControlFailure("INVALID_ARGUMENT", `${name} must be a non-empty string`, false);
  return value;
}

function idParam(params: Record<string, unknown>): string {
  if (typeof params.id === "string" && params.id) return params.id;
  if (typeof params.hostId === "string" && params.hostId) return params.hostId;
  return stringParam(params, "threadId");
}

function objectParam(params: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = params[name];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ControlFailure("INVALID_ARGUMENT", `${name} must be an object`, false);
  return value as Record<string, unknown>;
}

function findById(value: unknown, id: string, code: string, key = "id"): unknown {
  if (!Array.isArray(value)) throw new ControlFailure("INTERNAL_ERROR", "expected a list response", false);
  const match = value.find(item => item && typeof item === "object" && (item as Record<string, unknown>)[key] === id);
  if (!match) throw new ControlFailure(code, `${id} was not found`, false);
  return match;
}

function endsSubscription(mode: Subscription["mode"], status: ThreadDetail["status"]): boolean {
  return status === "exited" || status === "error"
    || mode === "wait" && (status === "idle" || status === "waiting");
}

function socketAcceptsConnections(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", error => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ECONNREFUSED" || code === "ENOENT") resolve(false);
      else reject(error);
    });
  });
}

async function acquireStartupLock(path: string): Promise<FileHandle> {
  try {
    const lock = await open(path, "wx", 0o600);
    await lock.writeFile(String(process.pid));
    return lock;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = Number(await readFile(path, "utf8").catch(() => ""));
    throw new Error(Number.isSafeInteger(owner) && owner > 1
      ? `control socket startup lock already exists (PID ${owner})`
      : "control socket startup lock already exists");
  }
}

async function releaseStartupLock(lock: FileHandle, path: string): Promise<void> {
  await lock.close();
  await unlink(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}
