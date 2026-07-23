import type {
  CodexThreadSummary, CreateThreadRequest, HostConfig, HostSummary, LoginRequest, ResolveRequest, ResumeThreadRequest, SessionResponse,
  SendMessageRequest, ThreadDetail, ThreadSummary,
} from "@cwb/protocol";
import { apiRoutes } from "@cwb/protocol";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let csrfToken: string | undefined;
export function currentCsrfToken() { return csrfToken; }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...(init?.method && init.method !== "GET" && csrfToken ? { "x-csrf-token": csrfToken } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { message?: string; error?: string };
    throw new ApiError(response.status, body.message ?? body.error ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  session: async () => { const session = await request<SessionResponse>(apiRoutes.session); csrfToken = session.csrfToken; return session; },
  login: async (body: LoginRequest) => { const session = await request<SessionResponse>(apiRoutes.login, { method: "POST", body: JSON.stringify(body) }); csrfToken = session.csrfToken; },
  logout: async () => { await request<void>(apiRoutes.logout, { method: "POST" }); csrfToken = undefined; window.dispatchEvent(new Event("cwb-auth-changed")); },
  hosts: () => request<HostSummary[]>(apiRoutes.hosts),
  saveHost: (body: HostConfig) => request<{ id: string }>(apiRoutes.hosts, { method: "POST", body: JSON.stringify(body) }),
  codexThreads: (hostId: string) => request<CodexThreadSummary[]>(apiRoutes.hostCodexThreads(hostId)),
  threads: () => request<ThreadSummary[]>(apiRoutes.threads),
  thread: (id: string) => request<ThreadDetail>(`${apiRoutes.threads}/${encodeURIComponent(id)}`),
  createThread: (body: CreateThreadRequest) => request<ThreadDetail>(apiRoutes.threads, { method: "POST", body: JSON.stringify(body) }),
  resumeThread: (body: ResumeThreadRequest) => request<ThreadDetail>(apiRoutes.resumeThread, { method: "POST", body: JSON.stringify(body) }),
  exitThread: (id: string) => request<void>(`${apiRoutes.threads}/${encodeURIComponent(id)}/exit`, { method: "POST" }),
  sendMessage: (id: string, body: SendMessageRequest) => request<void>(`${apiRoutes.threads}/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify(body) }),
  interrupt: (id: string) => request<void>(`${apiRoutes.threads}/${encodeURIComponent(id)}/interrupt`, { method: "POST" }),
  resolve: (id: string, requestId: string, body: ResolveRequest) => request<void>(`${apiRoutes.threads}/${encodeURIComponent(id)}/requests/${encodeURIComponent(requestId)}`, { method: "POST", body: JSON.stringify(body) }),
  takeover: (id: string, enabled: boolean) => request<void>(`${apiRoutes.threads}/${encodeURIComponent(id)}/terminal/takeover`, { method: "POST", body: JSON.stringify({ enabled }) }),
  terminalInput: (id: string, data: string) => request<void>(`${apiRoutes.threads}/${encodeURIComponent(id)}/terminal/input`, { method: "POST", body: JSON.stringify({ data }) }),
  screenshotUrl: (id: string) => `${apiRoutes.threads}/${encodeURIComponent(id)}/terminal/screenshot?t=${Date.now()}`,
};
