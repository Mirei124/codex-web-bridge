import { EventEmitter } from "node:events";
import WebSocket from "ws";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface RpcNotification {
  method: string;
  params?: Json;
}
export interface RpcServerRequest extends RpcNotification {
  id: string | number;
}
export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export interface ThreadSummary {
  id: string;
  [key: string]: unknown;
}

export interface CodexClientOptions {
  url: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  webSocketFactory?: (url: string) => WebSocket;
  clientInfo?: { name: string; version: string; title?: string };
  diagnostic?: (event: string, details?: Record<string, unknown>) => void;
}

/** Thin, version-pinned client for the Codex app-server v2 JSON-RPC protocol. */
export class CodexClient extends EventEmitter {
  private socket?: WebSocket;
  private sequence = 0;
  private readonly pending = new Map<
    number,
    { resolve(v: any): void; reject(e: Error): void; timer: NodeJS.Timeout }
  >();
  constructor(private readonly options: CodexClientOptions) {
    super();
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.diagnostic("connect.started");
    const socket = (this.options.webSocketFactory ?? ((url) => new WebSocket(url)))(this.options.url);
    this.socket = socket;
    socket.on("message", (bytes) => this.receive(String(bytes)));
    socket.on("close", (code, reason) => {
      this.failAll(new Error("Codex app-server connection closed"));
      this.emit("transportClose", { code, reason: reason.toString("utf8") });
    });
    socket.on("error", (error) => this.emit("transportError", error));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.diagnostic("connect.timed-out", {
          timeoutMs: this.options.connectTimeoutMs ?? 10_000,
        });
        reject(new Error("Timed out connecting to Codex app-server"));
      }, this.options.connectTimeoutMs ?? 10_000);
      socket.once("open", () => {
        clearTimeout(timer);
        this.diagnostic("connect.succeeded");
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        this.diagnostic("connect.failed", { error: errorText(error) });
        reject(error);
      });
    });
    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? { name: "codex-web-bridge", version: "0.1.0", title: "Codex Web Bridge" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
  }

  close(): void {
    this.socket?.close();
    this.failAll(new Error("Codex client closed"));
  }

  request<T = unknown>(method: string, params?: Json): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Codex app-server is not connected"));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request '${method}' timed out`));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify(params === undefined ? { id, method } : { id, method, params }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method: string, params?: Json): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("Codex app-server is not connected");
    this.socket.send(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  async createThread(params: {
    cwd: string;
    model?: string;
    approvalPolicy?: "untrusted" | "on-request" | "never";
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  }): Promise<ThreadSummary> {
    const result = await this.request<{ thread: ThreadSummary }>("thread/start", {
      ...params,
      ephemeral: false,
      serviceName: "codex-web-bridge",
    });
    return result.thread;
  }
  async resumeThread(threadId: string, overrides: { cwd?: string; model?: string } = {}): Promise<ThreadSummary> {
    const result = await this.request<{ thread: ThreadSummary }>("thread/resume", { threadId, ...overrides });
    return result.thread;
  }
  async listThreads(
    params: { cursor?: string; limit?: number; cwd?: string; searchTerm?: string } = {},
  ): Promise<{ data: ThreadSummary[]; nextCursor?: string | null }> {
    return this.request("thread/list", params);
  }
  async startTurn(threadId: string, text: string, clientUserMessageId?: string): Promise<unknown> {
    return this.request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
    });
  }
  async steerTurn(threadId: string, text: string): Promise<unknown> {
    return this.request("turn/steer", { threadId, input: [{ type: "text", text, text_elements: [] }] });
  }
  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }
  respondToApproval(requestId: string | number, decision: ApprovalDecision): void {
    this.respond(requestId, { decision });
  }
  respondToUserInput(requestId: string | number, answers: Record<string, string[]>): void {
    this.respond(requestId, {
      answers: Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, { answers: values }])),
    });
  }
  respond(requestId: string | number, result: Json): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("Codex app-server is not connected");
    this.socket.send(JSON.stringify({ id: requestId, result }));
  }

  private receive(raw: string): void {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      this.emit("protocolError", new Error("Invalid JSON from Codex app-server"));
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined) && !message.method) {
      const entry = this.pending.get(Number(message.id));
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(Number(message.id));
      if (message.error) entry.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else entry.resolve(message.result);
      return;
    }
    if (message.method && message.id !== undefined) this.emit("request", message as RpcServerRequest);
    else if (message.method) this.emit("notification", message as RpcNotification);
  }
  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private diagnostic(event: string, details?: Record<string, unknown>): void {
    this.options.diagnostic?.(`codex-client.${event}`, { url: this.options.url, ...details });
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
