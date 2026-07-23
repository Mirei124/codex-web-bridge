import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadDetail } from "@cwb/protocol";
import App from "./App";

let terminalInput: ((data: string) => void) | undefined;
let terminalWrites: string[] = [];
vi.mock("@xterm/xterm", () => ({ Terminal: class { options = {}; loadAddon() {} open() {} onData(callback: (data: string) => void) { terminalInput = callback; return { dispose() {} }; } write(data: string) { terminalWrites.push(data); } dispose() {} } }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

class WebSocketStub {
  static instances: WebSocketStub[] = [];
  static OPEN = 1;
  readyState = WebSocketStub.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { WebSocketStub.instances.push(this); queueMicrotask(() => this.onopen?.()); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  emit(event: object) { this.onmessage?.({ data: JSON.stringify(event) }); }
}

const thread: ThreadDetail = {
  id: "t", hostId: "a", title: "Bridge", cwd: "/repo", status: "idle", updatedAt: "2026-01-01",
  messages: [{ id: "m", role: "assistant", text: "Ready", createdAt: "2026-01-01" }],
  pendingRequests: [{ kind: "approval", requestId: "approve-1", title: "运行命令", detail: "需要执行", command: "pnpm test" }],
  terminal: { connected: true, takeover: false },
};

function response(body?: unknown, status = 200) {
  return body === undefined ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function authenticatedFetch() {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = typeof input === "string" ? input : input.toString();
    if (path === "/api/auth/session") return response({ authenticated: true, csrfToken: "csrf-token" });
    if (path === "/api/hosts") return response([{ id: "a", name: "Machine A", address: "10.0.0.2", status: "online" }]);
    if (path === "/api/hosts/a/codex-threads") return response([{ id: "codex-found", title: "Found task", cwd: "/repo/found" }]);
    if (path === "/api/threads" && !init?.method) return response([{ id: "t", hostId: "a", title: "Bridge", cwd: "/repo", status: "idle", updatedAt: "2026-01-01" }]);
    if (path === "/api/threads/t") return response(thread);
    if (path === "/api/threads" && init?.method === "POST") return response({ ...thread, id: "created", title: "Created" });
    if (path === "/api/threads/resume") return response({ ...thread, id: "resumed", title: "Resumed" });
    return response(undefined, 204);
  });
}

async function openThread(fetch = authenticatedFetch()) {
  vi.stubGlobal("fetch", fetch); render(<App />);
  fireEvent.click(await screen.findByText("Bridge"));
  await screen.findByText("Ready");
  return fetch;
}

describe("dashboard security and operations", () => {
  beforeEach(() => { WebSocketStub.instances = []; terminalInput = undefined; terminalWrites = []; vi.stubGlobal("WebSocket", WebSocketStub); });
  afterEach(() => { vi.useRealTimers(); cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("blocks every plain HTTP origin, including localhost, without making a request", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("location", { protocol: "http:", hostname: "localhost", host: "localhost:5173" });
    render(<App />);
    expect(screen.getByRole("heading", { name: "需要安全连接" })).toBeInTheDocument();
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the login CSRF token on the first authenticated mutation", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ authenticated: false }))
      .mockResolvedValueOnce(response({ authenticated: true, csrfToken: "from-login" }))
      .mockResolvedValueOnce(response([{ id: "a", name: "Machine A", address: "host", status: "online" }]))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({ ...thread, id: "created" }));
    vi.stubGlobal("fetch", fetch); render(<App />);
    fireEvent.change(await screen.findByLabelText("密码"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    fireEvent.click(await screen.findByRole("button", { name: /新会话/ }));
    fireEvent.change(screen.getByLabelText("工作目录"), { target: { value: "/repo" } });
    fireEvent.click(within(screen.getByRole("heading", { name: "创建会话" }).parentElement!).getByRole("button", { name: "创建" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));
    const mutation = fetch.mock.calls[4]![1] as RequestInit;
    expect(new Headers(mutation.headers).get("x-csrf-token")).toBe("from-login");
  });

  it("creates and resumes threads", async () => {
    const fetch = authenticatedFetch(); vi.stubGlobal("fetch", fetch); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /新会话/ }));
    fireEvent.change(screen.getByLabelText("工作目录"), { target: { value: "/repo/new" } });
    fireEvent.click(within(screen.getByRole("heading", { name: "创建会话" }).parentElement!).getByRole("button", { name: "创建" }));
    expect(await screen.findByRole("heading", { name: "Created" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    fireEvent.change(screen.getByLabelText("Codex Thread ID"), { target: { value: "codex-123" } });
    fireEvent.change(screen.getByLabelText("工作目录"), { target: { value: "/repo/resumed" } });
    fireEvent.click(within(screen.getByRole("heading", { name: "恢复会话" }).parentElement!).getByRole("button", { name: "恢复" }));
    expect(await screen.findByRole("heading", { name: "Resumed" })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/threads/resume", expect.objectContaining({ method: "POST" }));
    const resume = fetch.mock.calls.find(call => call[0] === "/api/threads/resume")![1] as RequestInit;
    expect(JSON.parse(String(resume.body))).toEqual({ hostId: "a", codexThreadId: "codex-123", cwd: "/repo/resumed" });
  });

  it("discovers host Codex threads and fills thread ID and cwd while retaining manual fields", async () => {
    const fetch = authenticatedFetch(); vi.stubGlobal("fetch", fetch); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "恢复" }));
    const discovered = await screen.findByLabelText("发现的历史会话");
    expect(within(discovered).getByRole("option", { name: "Found task · /repo/found" })).toBeInTheDocument();
    fireEvent.change(discovered, { target: { value: "codex-found" } });
    expect(screen.getByLabelText("Codex Thread ID")).toHaveValue("codex-found");
    expect(screen.getByLabelText("工作目录")).toHaveValue("/repo/found");
    fireEvent.change(screen.getByLabelText("Codex Thread ID"), { target: { value: "manual-id" } });
    expect(screen.getByLabelText("Codex Thread ID")).toHaveValue("manual-id");
    expect(fetch).toHaveBeenCalledWith("/api/hosts/a/codex-threads", expect.anything());
  });

  it("sends, interrupts, approves and exits a thread", async () => {
    const fetch = await openThread(); vi.stubGlobal("confirm", vi.fn(() => true));
    fireEvent.change(screen.getByPlaceholderText("继续对话…"), { target: { value: "Continue" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    fireEvent.click(screen.getByRole("button", { name: "允许" }));
    WebSocketStub.instances.at(-1)?.emit({ type: "thread.updated", thread: { id: "t", hostId: "a", title: "Bridge", cwd: "/repo", updatedAt: "2026-01-01", status: "running" } });
    await screen.findByRole("button", { name: "中断" }); fireEvent.click(screen.getByRole("button", { name: "中断" }));
    fireEvent.click(screen.getByRole("button", { name: "退出会话" }));
    await waitFor(() => {
      const paths = fetch.mock.calls.map(call => [call[0], (call[1] as RequestInit | undefined)?.method]);
      expect(paths).toContainEqual(["/api/threads/t/messages", "POST"]);
      expect(paths).toContainEqual(["/api/threads/t/requests/approve-1", "POST"]);
      expect(paths).toContainEqual(["/api/threads/t/interrupt", "POST"]);
      expect(paths).toContainEqual(["/api/threads/t/exit", "POST"]);
    });
  });

  it("keeps terminal input read-only until an explicit takeover event", async () => {
    const fetch = await openThread(); fireEvent.click(screen.getByRole("button", { name: "终端" }));
    await screen.findByLabelText("Codex terminal"); terminalInput?.("blocked");
    expect(fetch.mock.calls.some(call => call[0] === "/api/threads/t/terminal/input")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "显式接管" }));
    expect(fetch).toHaveBeenCalledWith("/api/threads/t/terminal/takeover", expect.objectContaining({ method: "POST" }));
    WebSocketStub.instances.at(-1)?.emit({ type: "terminal.state", threadId: "t", connected: true, takeover: true, owner: "browser" });
    await screen.findByRole("button", { name: "结束接管" }); terminalInput?.("allowed");
    await waitFor(() => expect(fetch.mock.calls.some(call => call[0] === "/api/threads/t/terminal/input")).toBe(true));
    const inputCall = fetch.mock.calls.find(call => call[0] === "/api/threads/t/terminal/input")!;
    expect(new Headers((inputCall[1] as RequestInit).headers).get("x-csrf-token")).toBe("csrf-token");
    WebSocketStub.instances.at(-1)?.emit({ type: "terminal.state", threadId: "t", connected: true, takeover: false });
    await screen.findByRole("button", { name: "显式接管" }); const previousInputs = fetch.mock.calls.filter(call => call[0] === "/api/threads/t/terminal/input").length;
    terminalInput?.("blocked-again");
    expect(fetch.mock.calls.filter(call => call[0] === "/api/threads/t/terminal/input")).toHaveLength(previousInputs);
  });

  it("collects each question answer before resolving one request", async () => {
    const fetch = await openThread();
    WebSocketStub.instances.at(-1)?.emit({ type: "request.created", threadId: "t", request: { kind: "questions", requestId: "q-1", title: "Plan questions", questions: [
      { id: "scope", header: "Scope", prompt: "Choose scope", options: [{ label: "Minimal", value: "minimal" }, { label: "Full", value: "full" }] },
      { id: "note", header: "Note", prompt: "Add a note" },
    ] } });
    const submit = await screen.findByRole("button", { name: "提交全部回答" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Scope/), { target: { value: "full" } });
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: "ship it" } });
    expect(submit).toBeEnabled(); fireEvent.click(submit);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/threads/t/requests/q-1", expect.objectContaining({ method: "POST" })));
    const call = fetch.mock.calls.find(item => item[0] === "/api/threads/t/requests/q-1")![1] as RequestInit;
    expect(JSON.parse(String(call.body))).toEqual({ answers: { scope: { answers: ["full"] }, note: { answers: ["ship it"] } } });
  });

  it("subscribes, reconnects, and unsubscribes from the selected thread", async () => {
    const fetch = authenticatedFetch(); vi.stubGlobal("fetch", fetch);
    const view = render(<App />); fireEvent.click(await screen.findByText("Bridge")); await screen.findByText("Ready");
    await waitFor(() => expect(WebSocketStub.instances.at(-1)?.sent).toContain(JSON.stringify({ type: "subscribe", threadId: "t" })));
    expect(WebSocketStub.instances.at(-1)?.url).toBe("wss://bridge.test/api/events?csrf=csrf-token");
    vi.useFakeTimers(); WebSocketStub.instances.at(-1)?.onclose?.(); await vi.advanceTimersByTimeAsync(1_000); await Promise.resolve();
    expect(WebSocketStub.instances).toHaveLength(2);
    await Promise.resolve();
    expect(WebSocketStub.instances[1]!.sent).toContain(JSON.stringify({ type: "subscribe", threadId: "t" }));
    expect(WebSocketStub.instances[1]!.url).toBe("wss://bridge.test/api/events?csrf=csrf-token");
    view.unmount();
    expect(WebSocketStub.instances[1]!.sent).toContain(JSON.stringify({ type: "unsubscribe", threadId: "t" }));
    vi.useRealTimers();
  });

  it("renders created, delta, completed and user messages in server event order", async () => {
    await openThread(); const socket = WebSocketStub.instances.at(-1)!;
    socket.emit({ type: "message.created", threadId: "t", message: { id: "user-2", role: "user", text: "Please continue", createdAt: "2026-01-01" } });
    socket.emit({ type: "message.created", threadId: "t", message: { id: "assistant-2", role: "assistant", text: "", streaming: true, createdAt: "2026-01-01" } });
    socket.emit({ type: "message.delta", threadId: "t", messageId: "assistant-2", delta: "First " });
    socket.emit({ type: "message.delta", threadId: "t", messageId: "assistant-2", delta: "answer" });
    expect(await screen.findByText("Please continue")).toBeInTheDocument();
    expect(await screen.findByText("First answer")).toBeInTheDocument();
    expect(screen.getByText("生成中")).toBeInTheDocument();
    socket.emit({ type: "message.completed", threadId: "t", messageId: "assistant-2" });
    await waitFor(() => expect(screen.queryByText("生成中")).not.toBeInTheDocument());
  });

  it("uses running and idle thread updates to control the interrupt action", async () => {
    await openThread(); const socket = WebSocketStub.instances.at(-1)!;
    expect(screen.queryByRole("button", { name: "中断" })).not.toBeInTheDocument();
    socket.emit({ type: "thread.updated", thread: { id: "t", hostId: "a", title: "Bridge", cwd: "/repo", status: "running", updatedAt: "2026-01-02" } });
    expect(await screen.findByRole("button", { name: "中断" })).toBeInTheDocument();
    expect(screen.getByText("/repo · running")).toBeInTheDocument();
    socket.emit({ type: "thread.updated", thread: { id: "t", hostId: "a", title: "Bridge", cwd: "/repo", status: "idle", updatedAt: "2026-01-03" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "中断" })).not.toBeInTheDocument());
    expect(screen.getByText("/repo · idle")).toBeInTheDocument();
  });

  it("renders the first snapshot and writes terminal ANSI seed without base64 transformation", async () => {
    await openThread(); const socket = WebSocketStub.instances.at(-1)!;
    socket.emit({ type: "snapshot", thread: { ...thread, title: "Recovered snapshot", messages: [{ id: "snapshot-message", role: "assistant", text: "Recovered answer", createdAt: "2026-01-01" }] } });
    expect(await screen.findByRole("heading", { name: "Recovered snapshot" })).toBeInTheDocument();
    expect(screen.getByText("Recovered answer")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "终端" })); await screen.findByLabelText("Codex terminal");
    const ansiSeed = "\u001b[31mred output\u001b[0m\r\n";
    socket.emit({ type: "terminal.data", threadId: "t", data: ansiSeed });
    await waitFor(() => expect(terminalWrites).toContain(ansiSeed));
    expect(terminalWrites).not.toContain(Buffer.from(ansiSeed).toString("base64"));
  });
});
