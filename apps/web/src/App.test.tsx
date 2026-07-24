import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadDetail } from "@cwb/protocol";
import App, { HostDialog, SettingsPanel } from "./App";

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
  id: "t", codexThreadId: "codex-t", hostId: "a", title: "Bridge", cwd: "/repo", proxy: "http://proxy.example:7890", status: "idle", updatedAt: "2026-01-01",
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
    if (path === "/api/threads/t/resume") return response({ ...thread, status: "idle" });
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

  it("supports the daemon's explicit direct HTTP startup mode", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ authenticated: false })); vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("location", { protocol: "http:", hostname: "localhost", host: "localhost:5173" });
    render(<App />);
    expect(await screen.findByLabelText("密码")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/auth/session", expect.anything());
  });

  it("uses the login CSRF token on the first authenticated mutation", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ authenticated: false }))
      .mockResolvedValueOnce(response({ authenticated: true, csrfToken: "from-login" }))
      .mockResolvedValueOnce(response([{ id: "a", name: "Machine A", address: "host", status: "online" }]))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response(undefined,204))
      .mockResolvedValueOnce(response({ ...thread, id: "created" }));
    vi.stubGlobal("fetch", fetch); render(<App />);
    fireEvent.change(await screen.findByLabelText("密码"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    fireEvent.click(await screen.findByRole("button", { name: /新会话/ }));
    fireEvent.change(screen.getByLabelText("工作目录"), { target: { value: "/repo" } });
    fireEvent.click(await within(screen.getByRole("heading", { name: "创建会话" }).parentElement!).findByRole("button", { name: "创建" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(7));
    const mutation = fetch.mock.calls[5]![1] as RequestInit;
    expect(new Headers(mutation.headers).get("x-csrf-token")).toBe("from-login");
  });

  it("creates and resumes threads", async () => {
    const fetch = authenticatedFetch(); vi.stubGlobal("fetch", fetch); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /新会话/ }));
    fireEvent.change(screen.getByLabelText("工作目录"), { target: { value: "/repo/new" } });
    fireEvent.change(screen.getByLabelText("代理地址（可选）"), { target: { value: "http://proxy.example:7890" } });
    fireEvent.change(screen.getByLabelText(/^会话前置 PATH/), { target: { value: "/thread/bin:/opt/bin" } });
    fireEvent.click(await within(screen.getByRole("heading", { name: "创建会话" }).parentElement!).findByRole("button", { name: "创建" }));
    expect(await screen.findByRole("heading", { name: "Created" })).toBeInTheDocument();
    const create = fetch.mock.calls.find(call => call[0] === "/api/threads" && (call[1] as RequestInit | undefined)?.method === "POST")![1] as RequestInit;
    expect(JSON.parse(String(create.body))).toEqual({ hostId: "a", cwd: "/repo/new", proxy: "http://proxy.example:7890", prependPath:"/thread/bin:/opt/bin" });
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    fireEvent.change(screen.getByLabelText("Codex Thread ID"), { target: { value: "codex-123" } });
    fireEvent.change(screen.getByLabelText("工作目录"), { target: { value: "/repo/resumed" } });
    fireEvent.change(screen.getByLabelText("代理地址（可选）"), { target: { value: "https://proxy.example:8443" } });
    fireEvent.change(screen.getByLabelText(/^会话前置 PATH/), { target: { value: "/resume/bin" } });
    fireEvent.click(within(screen.getByRole("heading", { name: "恢复会话" }).parentElement!).getByRole("button", { name: "恢复" }));
    expect(await screen.findByRole("heading", { name: "Resumed" })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/threads/resume", expect.objectContaining({ method: "POST" }));
    const resume = fetch.mock.calls.find(call => call[0] === "/api/threads/resume")![1] as RequestInit;
    expect(JSON.parse(String(resume.body))).toEqual({ hostId: "a", codexThreadId: "codex-123", cwd: "/repo/resumed", proxy: "https://proxy.example:8443", prependPath:"/resume/bin" });
  });

  it("loads and saves backend defaults for the create-thread form", async () => {
    const baseFetch=authenticatedFetch();
    const fetch=vi.fn((input:string|URL|Request,init?:RequestInit)=>{
      const path=typeof input==="string"?input:input.toString();
      if(path==="/api/preferences/thread-create"&&!init?.method)return Promise.resolve(response({hostId:"a",cwd:"/remembered",proxy:"http://proxy:8080",prependPath:"/custom/bin"}));
      if(path==="/api/preferences/thread-create"&&init?.method==="PUT")return Promise.resolve(response(undefined,204));
      return baseFetch(input,init);
    });
    vi.stubGlobal("fetch",fetch);render(<App />);
    fireEvent.click(await screen.findByRole("button",{name:/新会话/}));
    expect(await screen.findByDisplayValue("/remembered")).toBeInTheDocument();
    expect(screen.getByDisplayValue("http://proxy:8080")).toBeInTheDocument();
    expect(screen.getByDisplayValue("/custom/bin")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:"创建"}));
    await waitFor(()=>expect(fetch).toHaveBeenCalledWith("/api/preferences/thread-create",expect.objectContaining({
      method:"PUT",
      body:JSON.stringify({hostId:"a",cwd:"/remembered",proxy:"http://proxy:8080",prependPath:"/custom/bin"}),
    })));
  });

  it("confirms a scanned fingerprint before adding a host with optional metadata", async () => {
    const baseFetch = authenticatedFetch();
    const scannedFingerprint = `SHA256:${"B".repeat(43)}`;
    let saveAttempts = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = typeof input === "string" ? input : input.toString();
      if (path === "/api/hosts" && init?.method === "POST") {
        saveAttempts += 1;
        return saveAttempts === 1
          ? response({ error: "host key confirmation required", code: "HOST_KEY_UNKNOWN", details: { fingerprint: scannedFingerprint } }, 409)
          : response({ id: "generated-id" }, 201);
      }
      return baseFetch(input, init);
    });
    vi.stubGlobal("fetch", fetch); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "添加主机" }));
    for (const [label, value] of [["主机名或 IP","a.internal"],["SSH 用户名","codex"],["前置 PATH（可选）","/home/codex/.local/bin:/usr/bin"],["SSH 密码（可选）","memory-only"]]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("heading", { name: "确认 SSH 主机指纹" })).toBeInTheDocument();
    expect(screen.getByText(scannedFingerprint)).toBeInTheDocument();
    expect(screen.getByText("a.internal:22")).toBeInTheDocument();
    const firstSave = fetch.mock.calls.find(call => call[0] === "/api/hosts" && (call[1] as RequestInit | undefined)?.method === "POST")![1] as RequestInit;
    expect(JSON.parse(String(firstSave.body))).toEqual({
      hostname: "a.internal", port: 22, username: "codex", prependPath: "/home/codex/.local/bin:/usr/bin", password: "memory-only",
    });
    fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));
    await waitFor(() => expect(saveAttempts).toBe(2));
    const saves = fetch.mock.calls.filter(call => call[0] === "/api/hosts" && (call[1] as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((saves[1]![1] as RequestInit).body))).toEqual({
      hostname: "a.internal", port: 22, username: "codex", prependPath: "/home/codex/.local/bin:/usr/bin", password: "memory-only",
      hostKeySha256: scannedFingerprint, acceptHostKey: true,
    });
  });

  it("sends an explicit empty prepend PATH when clearing an existing host setting", async () => {
    const fingerprint = `SHA256:${"C".repeat(43)}`;
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ error: "confirmation required", code: "HOST_KEY_UNKNOWN", details: { fingerprint } }, 409))
      .mockResolvedValueOnce(response({ id: "a" }, 201));
    vi.stubGlobal("fetch", fetch);
    render(<HostDialog host={{ id: "a", name: "A", address: "codex@a.internal:22", status: "offline", hostname: "a.internal", port: 22, username: "codex", prependPath: "/custom/bin" }} onClose={() => undefined} onSaved={() => undefined} />);
    fireEvent.change(screen.getByLabelText("前置 PATH（可选）"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByRole("heading", { name: "确认 SSH 主机指纹" });
    expect(JSON.parse(String((fetch.mock.calls[0]![1] as RequestInit).body))).toMatchObject({ id: "a", prependPath: "" });
    fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String((fetch.mock.calls[1]![1] as RequestInit).body))).toMatchObject({ id: "a", prependPath: "", acceptHostKey: true });
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
    const exitInit = fetch.mock.calls.find(call => call[0] === "/api/threads/t/exit")?.[1] as RequestInit;
    expect(exitInit.body).toBeUndefined();
    expect(exitInit.headers).not.toHaveProperty("content-type");
    const resumeButton = screen.getByRole("button", { name: "恢复会话" });
    expect(resumeButton).toBeEnabled();
    expect(screen.getByPlaceholderText("该会话已退出")).toBeDisabled();
    fireEvent.click(resumeButton);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/threads/t/resume", expect.objectContaining({ method: "POST" })));
    expect(screen.getByRole("button", { name: "退出会话" })).toBeEnabled();
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("shows an exit failure and keeps the selected thread active", async () => {
    const fetch = authenticatedFetch();
    fetch.mockImplementationOnce(async () => response({ authenticated: true, csrfToken: "csrf-token" }));
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const path = typeof input === "string" ? input : input.toString();
      if (path === "/api/threads/t/exit") return response({ message: "tmux stop failed" }, 500);
      return fetch(input, init);
    });
    render(<App />); fireEvent.click(await screen.findByText("Bridge")); await screen.findByText("Ready");
    vi.stubGlobal("confirm", vi.fn(() => true));
    fireEvent.click(screen.getByRole("button", { name: "退出会话" }));
    expect(await screen.findByText("tmux stop failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退出会话" })).toBeEnabled();
  });

  it("deletes a thread from the sidebar without deleting Codex history", async () => {
    const baseFetch = authenticatedFetch(); let finishDelete!: () => void;
    const pendingDelete = new Promise<Response>(resolve => { finishDelete = () => resolve(response(undefined, 204)); });
    const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const path = typeof input === "string" ? input : input.toString();
      return path === "/api/threads/t" && init?.method === "DELETE" ? pendingDelete : baseFetch(input, init);
    });
    vi.stubGlobal("fetch", fetch); vi.stubGlobal("confirm", vi.fn(() => true));
    render(<App />);
    const remove = await screen.findByRole("button", { name: "删除会话 Bridge" });
    expect(remove.closest("button")?.parentElement?.tagName).not.toBe("BUTTON");
    fireEvent.click(remove);
    expect(screen.queryByText("Bridge")).not.toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/threads/t", expect.objectContaining({ method: "DELETE" })));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Codex 自身的会话记录不会被删除"));
    finishDelete();
  });

  it("removes a selected thread when the server emits thread.deleted", async () => {
    await openThread();
    WebSocketStub.instances.at(-1)?.emit({ type: "thread.deleted", threadId: "t" });
    expect(await screen.findByRole("heading", { name: "选择一个会话" })).toBeInTheDocument();
    expect(screen.queryByText("Bridge")).not.toBeInTheDocument();
  });

  it("updates daemon settings and warns before exposing the HTTP listener", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ bindHost: "127.0.0.1", port: 3210, publicOrigin: "", dataDir: "/var/lib/cwb", restartRequired: false }))
      .mockResolvedValueOnce(response({ bindHost: "0.0.0.0", port: 4321, publicOrigin: "https://bridge.example.com", dataDir: "/var/lib/cwb", restartRequired: true }));
    vi.stubGlobal("fetch", fetch); vi.stubGlobal("confirm", vi.fn(() => true));
    render(<SettingsPanel />);
    expect(await screen.findByLabelText("数据目录")).toHaveValue("/var/lib/cwb");
    fireEvent.change(screen.getByLabelText("监听地址"), { target: { value: "0.0.0.0" } });
    fireEvent.change(screen.getByLabelText("端口"), { target: { value: "4321" } });
    fireEvent.change(screen.getByLabelText("公开访问地址"), { target: { value: "https://bridge.example.com" } });
    fireEvent.change(screen.getByLabelText("新密码（留空表示不修改）"), { target: { value: "new-password-123" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("纯 HTTP 可能泄露密码和会话内容"));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch).toHaveBeenLastCalledWith("/api/settings", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ bindHost: "0.0.0.0", port: 4321, publicOrigin: "https://bridge.example.com", newPassword: "new-password-123" }),
    }));
    expect(await screen.findByText(/cwb restart/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "https://bridge.example.com" })).toHaveAttribute("href", "https://bridge.example.com");
    expect(screen.getByLabelText("新密码（留空表示不修改）")).toHaveValue("");
  });

  it("keeps terminal input read-only until an explicit takeover event", async () => {
    const fetch = await openThread(); fireEvent.click(screen.getByRole("button", { name: "终端" }));
    await screen.findByLabelText("Codex terminal"); terminalInput?.("blocked");
    expect(fetch.mock.calls.some(call => call[0] === "/api/threads/t/terminal/input")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "显式接管" }));
    expect(fetch).toHaveBeenCalledWith("/api/threads/t/terminal/takeover", expect.objectContaining({ method: "POST" }));
    WebSocketStub.instances.at(-1)?.emit({ type: "terminal.state", threadId: "t", connected: true, takeover: true, owner: "browser" });
    await screen.findByRole("button", { name: "结束接管" }); terminalInput?.("\x7f"); terminalInput?.("allowed");
    await waitFor(() => expect(fetch.mock.calls.filter(call => call[0] === "/api/threads/t/terminal/input")).toHaveLength(2));
    const inputCalls = fetch.mock.calls.filter(call => call[0] === "/api/threads/t/terminal/input");
    const inputCall = inputCalls[0]!;
    expect(JSON.parse(String((inputCall[1] as RequestInit).body))).toEqual({data:"\x08"});
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

  it("highlights an unread background thread and sends a loopback notification when it completes", async () => {
    class NotificationStub {
      static permission: NotificationPermission = "granted";
      static instances: NotificationStub[] = [];
      onclick: (() => void) | null = null;
      constructor(readonly title: string, readonly options?: NotificationOptions) { NotificationStub.instances.push(this); }
      close() {}
      static requestPermission() { return Promise.resolve(NotificationStub.permission); }
    }
    vi.stubGlobal("Notification", NotificationStub); vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("location", { protocol: "http:", hostname: "localhost", host: "localhost:3210" });
    const baseFetch = authenticatedFetch();
    const other = { id: "other", hostId: "a", title: "Background", cwd: "/other", status: "running" as const, updatedAt: "2026-01-01" };
    const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const path = typeof input === "string" ? input : input.toString();
      if (path === "/api/threads" && !init?.method) return Promise.resolve(response([{ id: "t", hostId: "a", title: "Bridge", cwd: "/repo", status: "idle", updatedAt: "2026-01-01" }, other]));
      if (path === "/api/threads/other") return Promise.resolve(response({ ...thread, ...other, messages: [], pendingRequests: [] }));
      return baseFetch(input, init);
    });
    vi.stubGlobal("fetch", fetch); render(<App />);
    await waitFor(() => expect(WebSocketStub.instances.at(-1)?.sent).toContain(JSON.stringify({ type: "subscribe", threadId: "other" })));
    const socket = WebSocketStub.instances.at(-1)!;
    socket.emit({ type: "snapshot", thread: { ...thread, ...other, messages: [], pendingRequests: [] } });
    socket.emit({ type: "thread.updated", thread: { ...other, status: "idle", updatedAt: "2026-01-02" } });
    await waitFor(() => expect(screen.getByText("Background").closest(".thread-row")).toHaveClass("unread"));
    expect(document.title).toBe("(1) Codex Bridge");
    expect(NotificationStub.instances[0]).toMatchObject({ title: "Codex 已完成回答", options: { body: "Background" } });
    fireEvent.click(screen.getByText("Background").closest("button")!);
    await waitFor(() => expect(document.title).toBe("Codex Bridge"));
  });

  it("shows a toast after refresh when system notifications are unavailable", async () => {
    vi.stubGlobal("fetch", authenticatedFetch()); render(<App />);
    expect(await screen.findByText("当前浏览器不支持系统通知，将使用未读高亮和标签提醒。")).toBeInTheDocument();
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
