import { randomInt, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { WebSocketServer, WebSocket } from "ws";
import {
  apiRoutes,
  serverEventThreadId,
  type PendingRequest,
  type SaveThreadCreateDefaultsRequest,
  type ServerEvent,
  type SettingsResponse,
  type ThreadDetail,
  type ThreadSummary,
  type UpdateSettingsRequest,
} from "@cwb/protocol";
import { parseConfig, paths, saveConfig, type AppConfig } from "@cwb/config";
import { Storage, type HostRecord, type SessionRecord, type ThreadRecord } from "@cwb/storage";
import { hashPassword, sameToken, token, verifyPassword } from "./auth.js";
import { HostKeyError, internalHostKeyToken, verifyHostKey } from "./host-key.js";
import { HostRuntimeManager, type RuntimeEvent, type RuntimeManager } from "./runtime-manager.js";

declare module "fastify" {
  interface FastifyRequest {
    loginSession?: SessionRecord;
  }
}
export interface ServerOptions {
  runtime?: RuntimeManager;
  webRoot?: string | false;
  eventSink?: (event: ServerEvent) => void;
  hostKeyVerifier?: typeof verifyHostKey;
  settingsSaver?: (config: AppConfig) => Promise<void>;
}

interface EmbeddedWebAsset {
  path: string;
  contentType: string;
}

declare global {
  var __CWB_EMBEDDED_WEB__: Record<string, EmbeddedWebAsset> | undefined;
}

function isAllowedRequest(request: FastifyRequest, config: AppConfig): boolean {
  const remote = request.socket.remoteAddress?.replace(/^::ffff:/, "");
  const forwardedProto = request.headers["x-forwarded-proto"];
  return forwardedProto === undefined || (remote === config.trustedProxy && forwardedProto === "https");
}
function isAllowedOrigin(
  origin: string | undefined,
  host: string | undefined,
  config: AppConfig,
  direct: boolean,
): boolean {
  if (origin === undefined || origin === config.publicOrigin) return true;
  if (direct && host !== undefined && isLoopbackOrigin(origin, host, config.port)) return true;
  const dynamicHttpOrigin = config.bindHost === "0.0.0.0" && config.publicOrigin === `http://127.0.0.1:${config.port}`;
  return direct && dynamicHttpOrigin && host !== undefined && origin === `http://${host}`;
}
function isLoopbackOrigin(origin: string, host: string, port: number): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      url.host === host &&
      Number(url.port || 80) === port &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
function summary(thread: ThreadRecord): ThreadSummary {
  return {
    id: thread.id,
    codexThreadId: thread.codexThreadId,
    hostId: thread.hostId,
    title: thread.title,
    cwd: thread.workingDirectory,
    proxy: thread.proxy,
    prependPath: thread.prependPath,
    status: thread.status as ThreadSummary["status"],
    updatedAt: new Date(thread.updatedAt).toISOString(),
  };
}
function detail(storage: Storage, thread: ThreadRecord): ThreadDetail {
  return {
    ...summary(thread),
    messages: storage.messages(thread.id).map((m) => ({
      id: m.id,
      role: m.role as "user" | "assistant" | "system",
      text: m.text,
      streaming: Boolean(m.streaming),
      createdAt: new Date(m.createdAt).toISOString(),
    })),
    pendingRequests: storage.pending(thread.id).map((p) => JSON.parse(p.payload) as PendingRequest),
    terminal: { connected: thread.status !== "exited" && thread.hasRollout !== 0, takeover: false },
  };
}

export async function buildServer(
  config: AppConfig,
  storage: Storage,
  options: ServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, trustProxy: false });
  const runtime = options.runtime ?? new HostRuntimeManager();
  let savedConfig = config;
  const settingsSaver = options.settingsSaver ?? ((next: AppConfig) => saveConfig(next));
  const hostKeyVerifier = options.hostKeyVerifier ?? verifyHostKey;
  const takeover = new Map<string, { owner: string; expiresAt?: number }>();
  const publishedModels = new Map<string, string>();
  function activeLease(threadId: string) {
    const lease = takeover.get(threadId);
    if (lease?.expiresAt !== undefined && lease.expiresAt <= Date.now()) {
      takeover.delete(threadId);
      return;
    }
    return lease;
  }
  await app.register(cookie);
  const webRoot =
    options.webRoot === undefined
      ? resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist")
      : options.webRoot;
  const embeddedWeb = options.webRoot === undefined ? globalThis.__CWB_EMBEDDED_WEB__ : undefined;

  app.addHook("onRequest", async (request, reply) => {
    if (!isAllowedRequest(request, config)) return reply.code(404).send();
    if (
      !isAllowedOrigin(
        request.headers.origin,
        request.headers.host,
        config,
        request.headers["x-forwarded-proto"] === undefined,
      )
    )
      return reply.code(403).send({ error: "forbidden" });
  });
  const attempts = new Map<string, { count: number; resetAt: number }>();
  app.post<{ Body: { password?: string } }>(apiRoutes.login, async (request, reply) => {
    const now = Date.now();
    let bucket = attempts.get("single-user");
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + 60_000 };
      attempts.set("single-user", bucket);
    }
    if (bucket.count >= 5) return reply.code(429).send({ error: "authentication failed" });
    const valid =
      typeof request.body?.password === "string" && (await verifyPassword(config.passwordHash, request.body.password));
    if (!valid) {
      bucket.count++;
      return reply.code(401).send({ error: "authentication failed" });
    }
    attempts.clear();
    const session = { id: token(), csrfToken: token(), createdAt: now, expiresAt: now + 86_400_000 };
    storage.createSession(session);
    reply.setCookie("cwb_session", session.id, {
      httpOnly: true,
      secure: config.publicOrigin.startsWith("https://"),
      sameSite: "strict",
      path: "/",
      maxAge: 86400,
    });
    return { authenticated: true, csrfToken: session.csrfToken };
  });
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/") || request.url === apiRoutes.login) return;
    const session = request.cookies.cwb_session ? storage.session(request.cookies.cwb_session) : undefined;
    if (!session) return reply.code(401).send({ error: "unauthorized" });
    request.loginSession = session;
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      !sameToken(request.headers["x-csrf-token"] as string | undefined, session.csrfToken)
    )
      return reply.code(403).send({ error: "forbidden" });
  });

  app.get(apiRoutes.session, async (request) => ({ authenticated: true, csrfToken: request.loginSession!.csrfToken }));
  app.get(apiRoutes.settings, async (): Promise<SettingsResponse> => ({
    bindHost: savedConfig.bindHost,
    port: savedConfig.port,
    publicOrigin: savedConfig.publicOrigin,
    dataDir: paths().root,
    restartRequired: JSON.stringify(savedConfig) !== JSON.stringify(config),
  }));
  app.get(apiRoutes.threadCreateDefaults, async () => {
    const value = storage.threadCreateDefaults();
    return value
      ? {
          ...value,
          hosts: value.hosts.map((host) => ({ ...host, updatedAt: new Date(host.updatedAt).toISOString() })),
        }
      : null;
  });
  app.put<{ Body: SaveThreadCreateDefaultsRequest }>(apiRoutes.threadCreateDefaults, async (request, reply) => {
    const value = request.body,
      host = value && storage.host(value.hostId),
      proxy = value && normalizedProxy(value.proxy),
      prependPath = value?.prependPath?.trim() || undefined;
    if (
      !value ||
      !host ||
      typeof value.cwd !== "string" ||
      !isAbsolute(value.cwd) ||
      proxy === null ||
      (prependPath && !validPrependPath(prependPath))
    )
      return reply.code(400).send({ error: "invalid thread creation defaults" });
    storage.saveThreadCreateDefaults({ hostId: host.id, cwd: value.cwd, proxy, prependPath, updatedAt: Date.now() });
    return reply.code(204).send();
  });
  app.delete<{ Body: { cwd?: string } }>(apiRoutes.threadCreateCwdHistory, async (request, reply) => {
    const cwd = request.body?.cwd;
    if (typeof cwd !== "string" || !isAbsolute(cwd)) return reply.code(400).send({ error: "invalid cwd" });
    storage.deleteThreadCreateCwd(cwd);
    return reply.code(204).send();
  });
  app.put<{ Body: UpdateSettingsRequest }>(apiRoutes.settings, async (request, reply) => {
    const value = request.body;
    if (
      !value ||
      !["127.0.0.1", "0.0.0.0"].includes(value.bindHost) ||
      !Number.isInteger(value.port) ||
      value.port < 1 ||
      value.port > 65535 ||
      typeof value.publicOrigin !== "string" ||
      (value.newPassword !== undefined && (typeof value.newPassword !== "string" || value.newPassword.length < 12))
    )
      return reply.code(400).send({ error: "invalid settings" });
    let origin: URL;
    try {
      origin = new URL(value.publicOrigin);
    } catch {
      return reply.code(400).send({ error: "public origin must be a valid HTTP or HTTPS URL" });
    }
    if (!["http:", "https:"].includes(origin.protocol))
      return reply.code(400).send({ error: "public origin must use HTTP or HTTPS" });
    if (origin.origin !== value.publicOrigin)
      return reply.code(400).send({ error: "public origin must contain only scheme, host, and port" });
    const next = parseConfig({
      ...savedConfig,
      bindHost: value.bindHost,
      port: value.port,
      publicOrigin: value.publicOrigin,
      ...(value.newPassword ? { passwordHash: await hashPassword(value.newPassword) } : {}),
    });
    await settingsSaver(next);
    savedConfig = next;
    if (value.newPassword) {
      storage.deleteAllSessions();
      for (const socket of sockets.keys()) socket.close(1000, "password changed");
    }
    return {
      bindHost: next.bindHost,
      port: next.port,
      publicOrigin: next.publicOrigin,
      dataDir: paths().root,
      restartRequired: true,
    } satisfies SettingsResponse;
  });
  app.post(apiRoutes.logout, async (request, reply) => {
    const sessionId = request.loginSession!.id;
    storage.deleteSession(sessionId);
    releaseLeases(sessionId);
    for (const [socket, state] of sockets) if (state.sessionId === sessionId) socket.close(1000, "logged out");
    reply.clearCookie("cwb_session", {
      path: "/",
      secure: config.publicOrigin.startsWith("https://"),
      sameSite: "strict",
    });
    return reply.code(204).send();
  });
  app.get(apiRoutes.hosts, async () =>
    storage.hosts().map((h) => ({
      id: h.id,
      name: h.name,
      address: `${h.username}@${h.hostname}:${h.port}`,
      status: runtime.hostStatus?.(h.id) ?? "offline",
      hostname: h.hostname,
      port: h.port,
      username: h.username,
      hostKeySha256: h.hostKeySha256,
      identityFile: h.identityFile,
      prependPath: h.prependPath,
    })),
  );
  app.post<{
    Body: Partial<Omit<HostRecord, "createdAt">> & {
      password?: string;
      clearPassword?: boolean;
      acceptHostKey?: boolean;
    };
  }>(apiRoutes.hosts, async (request, reply) => {
    const value = request.body ?? {};
    if (
      (value.id !== undefined && typeof value.id !== "string") ||
      (value.name !== undefined && typeof value.name !== "string") ||
      typeof value.hostname !== "string" ||
      !value.hostname.trim() ||
      value.hostname.length > 253 ||
      !Number.isInteger(value.port) ||
      value.port! < 1 ||
      value.port! > 65535 ||
      typeof value.username !== "string" ||
      !value.username.trim() ||
      value.username.length > 128 ||
      (value.identityFile !== undefined && value.identityFile !== "" && !isAbsolute(value.identityFile)) ||
      (value.prependPath !== undefined &&
        value.prependPath !== "" &&
        (typeof value.prependPath !== "string" || !validPrependPath(value.prependPath))) ||
      (value.hostKeySha256 !== undefined && !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(value.hostKeySha256)) ||
      (value.password !== undefined && typeof value.password !== "string") ||
      (value.clearPassword !== undefined && typeof value.clearPassword !== "boolean") ||
      (value.acceptHostKey !== undefined && typeof value.acceptHostKey !== "boolean") ||
      (value.password !== undefined && value.clearPassword) ||
      (value.acceptHostKey && value.hostKeySha256 === undefined)
    ) {
      return reply.code(400).send({ error: "invalid host configuration" });
    }
    const id = value.id?.trim() || randomUUID();
    const name = value.name?.trim() || `${value.username.trim()}@${value.hostname.trim()}`;
    if (!validId(id) || name.length > 128) return reply.code(400).send({ error: "invalid host configuration" });
    let verified: { fingerprint: string };
    try {
      verified =
        request.headers["x-cwb-internal-host-key"] === internalHostKeyToken
          ? { fingerprint: value.hostKeySha256! }
          : await hostKeyVerifier(value as Record<string, unknown>, Boolean(value.acceptHostKey), true);
    } catch (error) {
      if (error instanceof HostKeyError) {
        return reply.code(error.code === "SSH_HOST_KEY_SCAN_FAILED" ? 502 : 409).send({
          error: error.message,
          code: error.code,
          ...(error.details === undefined ? {} : { details: error.details }),
        });
      }
      throw error;
    }
    const previous = storage.host(id);
    const { password, clearPassword, acceptHostKey: _acceptHostKey, ...persisted } = value;
    const host: HostRecord = {
      ...persisted,
      id,
      name,
      hostname: value.hostname.trim(),
      port: value.port!,
      username: value.username.trim(),
      hostKeySha256: verified.fingerprint,
      identityFile: persisted.identityFile ?? "",
      prependPath: Object.hasOwn(value, "prependPath")
        ? persisted.prependPath?.trim() || undefined
        : previous?.prependPath,
      createdAt: Date.now(),
    };
    if (password !== undefined) runtime.setHostPassword?.(host.id, password);
    else if (clearPassword || (previous && hostConnectionChanged(previous, host)))
      runtime.setHostPassword?.(host.id, undefined);
    storage.upsertHost(host);
    return reply.code(201).send({ id: host.id });
  });
  app.delete<{ Params: { id: string } }>(`${apiRoutes.hosts}/:id`, async (request, reply) => {
    const host = storage.host(request.params.id);
    if (!host) return reply.code(404).send({ error: "host not found" });
    if (storage.threads().some((thread) => thread.hostId === host.id))
      return reply.code(409).send({ error: "delete the host's CWB threads first" });
    runtime.setHostPassword?.(host.id, undefined);
    storage.deleteHost(host.id);
    return reply.code(204).send();
  });
  app.get(apiRoutes.threads, async () => storage.threads().map(summary));
  app.get<{ Params: { id: string } }>(`${apiRoutes.threads}/:id`, async (request, reply) => {
    const thread = storage.thread(request.params.id);
    if (!thread) return reply.code(404).send({ error: "not found" });
    const result = detail(storage, thread),
      lease = activeLease(thread.id),
      owner = lease?.owner;
    result.terminal = {
      ...result.terminal,
      takeover: Boolean(owner),
      owner: owner === request.loginSession!.id ? "you" : owner ? "another session" : undefined,
    };
    return result;
  });
  app.post<{
    Body: { hostId: string; cwd: string; proxy?: string; prependPath?: string; createDirectory?: boolean };
  }>(apiRoutes.threads, async (request, reply) => {
    if (Object.hasOwn(request.body as object, "title"))
      return reply.code(400).send({ error: "thread title is generated by the server" });
    const host = storage.host(request.body.hostId);
    if (!host) return reply.code(404).send({ error: "host not found" });
    if (!isAbsolute(request.body.cwd)) return reply.code(400).send({ error: "cwd must be an absolute path" });
    if (request.body.createDirectory !== undefined && typeof request.body.createDirectory !== "boolean")
      return reply.code(400).send({ error: "createDirectory must be a boolean" });
    const proxy = normalizedProxy(request.body.proxy);
    if (proxy === null) return reply.code(400).send({ error: "proxy must be an HTTP or HTTPS URL" });
    const prependPath = request.body.prependPath?.trim() || undefined;
    if (prependPath && !validPrependPath(prependPath))
      return reply.code(400).send({ error: "prependPath must contain absolute directories separated by colons" });
    const directoryExists = await runtime.ensureWorkingDirectory?.(
      host,
      request.body.cwd,
      request.body.createDirectory === true,
    );
    if (directoryExists === false && request.body.createDirectory !== true)
      return reply.code(409).send({
        error: "working directory does not exist",
        code: "WORKING_DIRECTORY_NOT_FOUND",
        details: { cwd: request.body.cwd },
      });
    const now = Date.now(),
      id = randomUUID();
    const thread: ThreadRecord = {
      id,
      hostId: host.id,
      tmuxSession: `cwb-${id.replaceAll("-", "").slice(0, 20)}`,
      remotePort: allocatePort(storage, host.id),
      workingDirectory: request.body.cwd,
      proxy,
      prependPath,
      title: `Codex thread ${id.slice(0, 8)}`,
      status: "connecting",
      createdAt: now,
      updatedAt: now,
    };
    storage.createThread(thread);
    try {
      const created = await runtime.create(host, thread);
      const codexThreadId = typeof created === "string" ? created : created.id;
      storage.updateThread(id, {
        codexThreadId,
        status: "idle",
        updatedAt: Date.now(),
      });
      publish({ type: "thread.updated", thread: summary(storage.thread(id)!) });
      return reply.code(201).send({
        ...detail(storage, storage.thread(id)!),
        model: typeof created === "string" ? undefined : created.model,
      });
    } catch (error) {
      storage.updateThread(id, { status: "error", updatedAt: Date.now() });
      publish({ type: "thread.updated", thread: summary(storage.thread(id)!) });
      throw error;
    }
  });
  app.post<{ Body: { hostId: string; codexThreadId: string; cwd?: string; proxy?: string; prependPath?: string } }>(
    apiRoutes.resumeThread,
    async (request, reply) => {
      const host = storage.host(request.body.hostId);
      if (!host) return reply.code(404).send({ error: "host not found" });
      if (!request.body.cwd || !isAbsolute(request.body.cwd))
        return reply.code(400).send({ error: "cwd must be an absolute path" });
      const proxy = normalizedProxy(request.body.proxy);
      if (proxy === null) return reply.code(400).send({ error: "proxy must be an HTTP or HTTPS URL" });
      const prependPath = request.body.prependPath?.trim() || undefined;
      if (prependPath && !validPrependPath(prependPath))
        return reply.code(400).send({ error: "prependPath must contain absolute directories separated by colons" });
      const now = Date.now(),
        id = randomUUID();
      const thread: ThreadRecord = {
        id,
        hostId: host.id,
        codexThreadId: request.body.codexThreadId,
        tmuxSession: `cwb-${id.replaceAll("-", "").slice(0, 20)}`,
        remotePort: allocatePort(storage, host.id),
        workingDirectory: request.body.cwd,
        proxy,
        prependPath,
        title: `Resume ${request.body.codexThreadId.slice(0, 8)}`,
        status: "connecting",
        hasRollout: 1,
        createdAt: now,
        updatedAt: now,
      };
      storage.createThread(thread);
      try {
        const resumed = await runtime.resume(host, thread, request.body.codexThreadId);
        storage.updateThread(id, { status: "idle", updatedAt: Date.now() });
        publish({ type: "thread.updated", thread: summary(storage.thread(id)!) });
        return reply.code(201).send({ ...detail(storage, storage.thread(id)!), model: resumed?.model });
      } catch (error) {
        storage.updateThread(id, { status: "error", updatedAt: Date.now() });
        publish({ type: "thread.updated", thread: summary(storage.thread(id)!) });
        throw error;
      }
    },
  );
  const withThread = (id: string) => {
    if (!validId(id)) throw Object.assign(new Error("thread not found"), { statusCode: 404 });
    const thread = storage.thread(id);
    if (!thread) throw Object.assign(new Error("thread not found"), { statusCode: 404 });
    return thread;
  };
  app.delete<{ Params: { id: string } }>(`${apiRoutes.threads}/:id`, async (request, reply) => {
    const thread = withThread(request.params.id);
    await runtime.detach?.(thread.id);
    takeover.delete(thread.id);
    storage.deleteThread(thread.id);
    publish({ type: "thread.deleted", threadId: thread.id });
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>(`${apiRoutes.threads}/:id/exit`, async (request, reply) => {
    const thread = withThread(request.params.id),
      host = storage.host(thread.hostId);
    if (!host) return reply.code(409).send({ error: "thread host no longer exists" });
    await runtime.exit(thread, host);
    storage.updateThread(thread.id, { status: "exited", updatedAt: Date.now() });
    publish({ type: "thread.updated", thread: summary(storage.thread(thread.id)!) });
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>(`${apiRoutes.threads}/:id/resume`, async (request, reply) => {
    const thread = withThread(request.params.id);
    if (thread.status !== "exited") return reply.code(409).send({ error: "only an exited thread can be resumed" });
    if (!thread.codexThreadId) return reply.code(409).send({ error: "thread has no Codex thread ID" });
    const host = storage.host(thread.hostId);
    if (!host) return reply.code(409).send({ error: "thread host no longer exists" });
    storage.updateThread(thread.id, {
      remotePort: allocatePort(storage, host.id),
      status: "connecting",
      updatedAt: Date.now(),
    });
    const resuming = storage.thread(thread.id)!;
    try {
      await runtime.resume(host, resuming, resuming.codexThreadId!);
      storage.updateThread(thread.id, { status: "idle", updatedAt: Date.now() });
      publish({ type: "thread.updated", thread: summary(storage.thread(thread.id)!) });
      return detail(storage, storage.thread(thread.id)!);
    } catch (error) {
      storage.updateThread(thread.id, { status: "exited", updatedAt: Date.now() });
      publish({ type: "thread.updated", thread: summary(storage.thread(thread.id)!) });
      throw error;
    }
  });
  app.post<{ Params: { id: string }; Body: { text: string } }>(
    `${apiRoutes.threads}/:id/messages`,
    async (request, reply) => {
      if (typeof request.body.text !== "string" || !request.body.text.trim() || request.body.text.length > 100000)
        return reply.code(400).send({ error: "invalid message" });
      const thread = withThread(request.params.id),
        now = Date.now(),
        id = randomUUID(),
        message = { id, role: "user" as const, text: request.body.text, createdAt: new Date(now).toISOString() };
      storage.putMessage({
        id,
        threadId: thread.id,
        role: "user",
        text: request.body.text,
        streaming: 0,
        createdAt: now,
      });
      publish({ type: "message.created", threadId: thread.id, message });
      const turnId = await runtime.send(thread, request.body.text);
      storage.updateThread(thread.id, { status: "running", hasRollout: 1, updatedAt: now });
      publish({ type: "thread.updated", thread: summary(storage.thread(thread.id)!) });
      publish({
        type: "terminal.state",
        threadId: thread.id,
        connected: true,
        takeover: Boolean(activeLease(thread.id)),
      });
      return { turnId };
    },
  );
  app.post<{ Params: { id: string } }>(`${apiRoutes.threads}/:id/interrupt`, async (request, reply) => {
    await runtime.interrupt(withThread(request.params.id));
    return reply.code(204).send();
  });
  app.post<{
    Params: { id: string; requestId: string };
    Body: {
      value?: string;
      approved?: boolean;
      scope?: "turn" | "session";
      answers?: Record<string, { answers: string[] }>;
    };
  }>(`${apiRoutes.threads}/:id/requests/:requestId`, async (request, reply) => {
    const thread = withThread(request.params.id),
      pending = storage.pendingById(request.params.requestId, thread.id);
    if (!pending) return reply.code(409).send({ error: "already resolved" });
    const approvalScope = request.body.scope === "session" ? "session" : "turn";
    const response = request.body.answers
      ? { answers: request.body.answers }
      : pending.method === "item/permissions/requestApproval"
        ? request.body.approved
          ? { permissions: JSON.parse(pending.params).permissions ?? {}, scope: approvalScope }
          : { permissions: {}, scope: "turn" }
        : request.body.approved !== undefined
          ? {
              decision: request.body.approved
                ? approvalScope === "session"
                  ? "acceptForSession"
                  : "accept"
                : "decline",
            }
          : { answers: { value: { answers: [request.body.value ?? ""] } } };
    await runtime.resolve(thread, JSON.parse(pending.rpcId) as string | number, response);
    storage.resolvePending(request.params.requestId, thread.id);
    publish({ type: "request.resolved", threadId: thread.id, requestId: request.params.requestId });
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string }; Body: { enabled: boolean; ttlMs?: number } }>(
    `${apiRoutes.threads}/:id/terminal/takeover`,
    async (request, reply) => {
      const thread = withThread(request.params.id);
      if (request.body.enabled && thread.hasRollout === 0)
        return reply.code(409).send({ error: "send the first message before taking over the terminal" });
      const owner = request.loginSession!.id,
        current = activeLease(request.params.id);
      if (
        request.body.ttlMs !== undefined &&
        (!Number.isInteger(request.body.ttlMs) || request.body.ttlMs < 1 || request.body.ttlMs > 300000)
      )
        return reply.code(400).send({ error: "invalid takeover TTL" });
      if (request.body.enabled && current && current.owner !== owner)
        return reply.code(409).send({ error: "terminal already owned" });
      if (request.body.enabled) {
        await runtime.prepareTerminal(thread);
        takeover.set(request.params.id, {
          owner,
          expiresAt: request.body.ttlMs === undefined ? undefined : Date.now() + request.body.ttlMs,
        });
      } else if (current?.owner === owner) takeover.delete(request.params.id);
      publish({
        type: "terminal.state",
        threadId: request.params.id,
        connected: true,
        takeover: Boolean(activeLease(request.params.id)),
        owner: activeLease(request.params.id) ? "active" : undefined,
      });
      return reply.code(204).send();
    },
  );
  app.post<{ Params: { id: string }; Body: { data: string; ttlMs?: number } }>(
    `${apiRoutes.threads}/:id/terminal/input`,
    async (request, reply) => {
      if (typeof request.body.data !== "string" || Buffer.byteLength(request.body.data) > 65536)
        return reply.code(400).send({ error: "terminal data is too large" });
      if (
        request.body.ttlMs !== undefined &&
        (!Number.isInteger(request.body.ttlMs) || request.body.ttlMs < 1 || request.body.ttlMs > 300000)
      )
        return reply.code(400).send({ error: "invalid takeover TTL" });
      const lease = activeLease(request.params.id);
      if (lease?.owner !== request.loginSession!.id) return reply.code(403).send({ error: "takeover required" });
      if (request.body.ttlMs !== undefined)
        takeover.set(request.params.id, { owner: lease.owner, expiresAt: Date.now() + request.body.ttlMs });
      await runtime.terminalInput(withThread(request.params.id), request.body.data);
      return reply.code(204).send();
    },
  );
  app.get<{ Params: { id: string } }>(`${apiRoutes.hosts}/:id/codex-threads`, async (request, reply) => {
    const host = storage.host(request.params.id);
    if (!host) return reply.code(404).send({ error: "host not found" });
    return runtime.listHistorical ? runtime.listHistorical(host) : [];
  });
  app.get<{ Params: { id: string } }>(`${apiRoutes.threads}/:id/terminal/screenshot`, async (request, reply) => {
    const image = await runtime.screenshot(withThread(request.params.id));
    if (!image) return reply.code(501).send({ error: "screenshot unavailable" });
    return reply.type("image/png").send(image);
  });

  const sockets = new Map<WebSocket, { sessionId: string; threads: Set<string> }>(),
    wss = new WebSocketServer({ noServer: true });
  app.server.on("upgrade", (request, socket, head) => {
    const remote = request.socket.remoteAddress?.replace(/^::ffff:/, ""),
      forwardedProto = request.headers["x-forwarded-proto"],
      direct = forwardedProto === undefined,
      allowed = direct || (remote === config.trustedProxy && forwardedProto === "https"),
      origin = request.headers.origin,
      cookies = parseCookies(request.headers.cookie),
      session = cookies.cwb_session ? storage.session(cookies.cwb_session) : undefined,
      url = new URL(request.url ?? "/", config.publicOrigin);
    if (
      url.pathname !== apiRoutes.events ||
      !allowed ||
      !isAllowedOrigin(origin, request.headers.host, config, direct) ||
      !session ||
      !sameToken(url.searchParams.get("csrf") ?? undefined, session.csrfToken)
    ) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.set(ws, { sessionId: session.id, threads: new Set() });
      wss.emit("connection", ws, request);
    });
  });
  wss.on("connection", (socket) => {
    socket.on("message", async (data) => {
      try {
        const event = JSON.parse(String(data)) as { type: string; threadId?: string },
          state = sockets.get(socket);
        if (!state || !event.threadId || !validId(event.threadId)) return;
        if (event.type === "subscribe") {
          const thread = storage.thread(event.threadId);
          if (!thread) return;
          state.threads.add(event.threadId);
          socket.send(JSON.stringify({ type: "snapshot", thread: detail(storage, thread) } satisfies ServerEvent));
          try {
            const ansi = await runtime.terminalSeed(thread);
            if (ansi)
              socket.send(
                JSON.stringify({ type: "terminal.data", threadId: thread.id, data: ansi } satisfies ServerEvent),
              );
          } catch {}
        } else if (event.type === "unsubscribe") state.threads.delete(event.threadId);
      } catch {
        socket.close(1003, "invalid event");
      }
    });
    socket.on("close", () => {
      const state = sockets.get(socket);
      if (state) releaseLeases(state.sessionId);
      sockets.delete(socket);
    });
  });
  function publish(message: ServerEvent) {
    options.eventSink?.(message);
    const json = JSON.stringify(message),
      threadId = serverEventThreadId(message);
    for (const [socket, state] of sockets)
      if (socket.readyState === 1 && threadId && state.threads.has(threadId)) {
        if (!storage.session(state.sessionId)) {
          releaseLeases(state.sessionId);
          socket.close(1008, "session expired");
          continue;
        }
        socket.send(json);
      }
  }
  function releaseLeases(sessionId: string) {
    for (const [threadId, lease] of takeover)
      if (lease.owner === sessionId) {
        takeover.delete(threadId);
        publish({ type: "terminal.state", threadId, connected: true, takeover: false });
      }
  }
  runtime.events.on("event", (event: RuntimeEvent) => {
    if (event.type === "terminal") {
      publish({ type: "terminal.data", threadId: event.threadId, data: String(event.payload) });
      return;
    }
    const rpc = event.payload as { method: string; id?: string | number; params: Record<string, any> },
      method = rpc.method,
      params = rpc.params ?? {},
      now = Date.now();
    const reportedModel = runtimeEventModel(method, params);
    if (reportedModel && publishedModels.get(event.threadId) !== reportedModel) {
      publishedModels.set(event.threadId, reportedModel);
      publish({ type: "thread.model.updated", threadId: event.threadId, model: reportedModel });
    }
    if (method === "item/agentMessage/delta") {
      const messageId = String(params.itemId),
        exists = storage.messages(event.threadId).some((message) => message.id === messageId);
      if (!exists) {
        storage.putMessage({
          id: messageId,
          threadId: event.threadId,
          role: "assistant",
          text: "",
          streaming: 1,
          createdAt: now,
        });
        publish({
          type: "message.created",
          threadId: event.threadId,
          message: {
            id: messageId,
            role: "assistant",
            text: "",
            streaming: true,
            createdAt: new Date(now).toISOString(),
          },
        });
      }
      storage.appendMessage(messageId, String(params.delta), true);
      publish({ type: "message.delta", threadId: event.threadId, messageId, delta: String(params.delta) });
      return;
    }
    if (method === "item/completed" && params.item?.type === "agentMessage") {
      const messageId = String(params.item.id);
      if (!storage.messages(event.threadId).some((message) => message.id === messageId)) {
        storage.putMessage({
          id: messageId,
          threadId: event.threadId,
          role: "assistant",
          text: String(params.item.text ?? ""),
          streaming: 0,
          createdAt: now,
        });
        publish({
          type: "message.created",
          threadId: event.threadId,
          message: {
            id: messageId,
            role: "assistant",
            text: String(params.item.text ?? ""),
            createdAt: new Date(now).toISOString(),
          },
        });
      } else storage.appendMessage(messageId, "", false);
      publish({ type: "message.completed", threadId: event.threadId, messageId });
      return;
    }
    if (method === "turn/plan/updated") {
      const message = {
        id: `plan-${String(params.turnId)}`,
        role: "system" as const,
        text: JSON.stringify({ explanation: params.explanation, plan: params.plan }),
        createdAt: new Date(now).toISOString(),
      };
      storage.putMessage({
        id: message.id,
        threadId: event.threadId,
        role: "system",
        text: message.text,
        streaming: 0,
        createdAt: now,
      });
      publish({ type: "message.created", threadId: event.threadId, message });
      return;
    }
    if (method === "turn/started") {
      storage.updateThread(event.threadId, { status: "running", updatedAt: now });
      const thread = storage.thread(event.threadId);
      if (thread) publish({ type: "thread.updated", thread: summary(thread) });
      return;
    }
    if (method === "turn/completed") {
      storage.updateThread(event.threadId, {
        status: params.turn?.status === "failed" ? "error" : "idle",
        updatedAt: now,
      });
      const thread = storage.thread(event.threadId);
      if (thread) publish({ type: "thread.updated", thread: summary(thread) });
      if (params.turn?.error)
        publish({
          type: "error",
          threadId: event.threadId,
          message: String(params.turn.error.message ?? params.turn.error),
        });
      return;
    }
    const approvals = new Set([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
    ]);
    if (approvals.has(method) || method === "item/tool/requestUserInput") {
      const requestId = randomUUID(),
        request: PendingRequest =
          method === "item/tool/requestUserInput"
            ? {
                kind: "questions",
                requestId,
                title: "Codex needs input",
                questions: (params.questions ?? []).map((question: any) => ({
                  id: String(question.id),
                  header: String(question.header),
                  prompt: String(question.question),
                  options: question.options?.map((option: any) => ({
                    label: String(option.label),
                    value: String(option.label),
                    description: String(option.description),
                  })),
                })),
              }
            : {
                kind: "approval",
                requestId,
                title: "Approval required",
                detail: String(
                  params.reason ??
                    (method === "item/fileChange/requestApproval"
                      ? `File changes${params.grantRoot ? ` under ${params.grantRoot}` : ""}`
                      : method),
                ),
                command: params.command ? String(params.command) : undefined,
              };
      storage.putPending({
        id: requestId,
        threadId: event.threadId,
        payload: JSON.stringify(request),
        rpcId: JSON.stringify(rpc.id),
        method,
        params: JSON.stringify(params),
        createdAt: now,
      });
      storage.updateThread(event.threadId, { status: "waiting", updatedAt: now });
      publish({ type: "request.created", threadId: event.threadId, request });
      const thread = storage.thread(event.threadId);
      if (thread) publish({ type: "thread.updated", thread: summary(thread) });
    }
  });
  runtime.events.on("reconnectFailed", ({ threadId }: { threadId: string }) => {
    storage.updateThread(threadId, { status: "error", updatedAt: Date.now() });
    const thread = storage.thread(threadId);
    if (thread) {
      publish({ type: "thread.updated", thread: summary(thread) });
      publish({ type: "error", threadId, message: "Unable to reconnect to the remote Codex runtime" });
    }
  });
  const invalidatePending = ({ threadId, reason }: { threadId: string; reason?: string }) => {
    for (const requestId of storage.resolveAllPending(threadId))
      publish({ type: "request.resolved", threadId, requestId });
    publish({
      type: "error",
      threadId,
      message: reason ?? "Pending interactions expired because the Codex connection changed",
    });
  };
  runtime.events.on("connectionLost", invalidatePending);
  runtime.events.on("generationChanged", invalidatePending);
  runtime.events.on("connectionGenerationChanged", invalidatePending);
  for (const thread of storage.threads().filter((thread) => thread.status !== "exited")) {
    const host = storage.host(thread.hostId);
    if (host)
      runtime
        .reconnect(host, thread)
        .catch(() => storage.updateThread(thread.id, { status: "error", updatedAt: Date.now() }));
  }
  app.addHook("onClose", async () => {
    for (const socket of sockets.keys()) socket.close();
    wss.close();
    await runtime.close();
  });
  if (embeddedWeb || (webRoot && existsSync(webRoot)))
    app.setNotFoundHandler(async (request, reply) => {
      const pathname = new URL(request.url, config.publicOrigin).pathname;
      if (pathname.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      let path: string;
      try {
        path = decodeURIComponent(pathname) === "/" ? "index.html" : decodeURIComponent(pathname).slice(1);
      } catch {
        return reply.code(400).send();
      }
      if (embeddedWeb) {
        const asset = embeddedWeb[path];
        if (asset) return reply.type(asset.contentType).send(await readFile(asset.path));
        if (path.includes(".")) return reply.code(404).send();
        const index = embeddedWeb["index.html"]!;
        return reply.type(index.contentType).send(await readFile(index.path));
      }
      const root = resolve(webRoot as string),
        target = resolve(root, path);
      if (target !== resolve(root, "index.html") && !target.startsWith(root + "/")) return reply.code(404).send();
      try {
        const body = await readFile(target);
        const extension = target.split(".").pop();
        return reply
          .type(
            extension === "js"
              ? "application/javascript"
              : extension === "css"
                ? "text/css"
                : extension === "html"
                  ? "text/html"
                  : "application/octet-stream",
          )
          .send(body);
      } catch {
        return reply.type("text/html").send(await readFile(resolve(root, "index.html")));
      }
    });
  return app;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    try {
      const key = decodeURIComponent(part.slice(0, separator).trim()),
        value = decodeURIComponent(part.slice(separator + 1).trim());
      if (key && !Object.hasOwn(result, key)) result[key] = value;
    } catch {
      continue;
    }
  }
  return result;
}
function allocatePort(storage: Storage, hostId: string): number {
  const used = new Set(
    storage
      .threads()
      .filter((thread) => thread.hostId === hostId && thread.status !== "exited")
      .map((thread) => thread.remotePort),
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = randomInt(20000, 60000);
    if (!used.has(port)) return port;
  }
  throw new Error("unable to allocate app-server port");
}
function validId(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}
function hostConnectionChanged(previous: HostRecord, next: HostRecord): boolean {
  return (
    previous.hostname !== next.hostname ||
    previous.username !== next.username ||
    previous.port !== next.port ||
    previous.identityFile !== next.identityFile ||
    previous.prependPath !== next.prependPath
  );
}
function validPrependPath(value: string): boolean {
  return (
    value.length <= 4096 && !/[\0\r\n]/.test(value) && value.split(":").every((directory) => directory.startsWith("/"))
  );
}

function runtimeEventModel(method: string, params: Record<string, any>): string | undefined {
  const value =
    method === "model/rerouted"
      ? params.toModel
      : method === "model/safetyBuffering/updated"
        ? params.model
        : (params.turn?.model ?? params.thread?.model ?? params.model);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function normalizedProxy(value: unknown): string | undefined | null {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}
