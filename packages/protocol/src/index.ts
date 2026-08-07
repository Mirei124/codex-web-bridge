export type HostStatus = "online" | "offline" | "connecting";
export type ThreadStatus = "idle" | "running" | "waiting" | "exited" | "error";

export interface HostSummary {
  id: string;
  name: string;
  address: string;
  status: HostStatus;
  hostname?: string;
  port?: number;
  username?: string;
  hostKeySha256?: string;
  identityFile?: string;
  prependPath?: string;
}

export interface HostConfig {
  id?: string;
  name?: string;
  hostname: string;
  port: number;
  username: string;
  hostKeySha256?: string;
  acceptHostKey?: boolean;
  identityFile?: string;
  prependPath?: string;
  password?: string;
  clearPassword?: boolean;
}

export interface CodexThreadSummary {
  id: string;
  title?: string;
  cwd?: string;
  updatedAt?: string;
}

export interface ThreadSummary {
  id: string;
  codexThreadId?: string;
  hostId: string;
  title: string;
  cwd: string;
  proxy?: string;
  prependPath?: string;
  model?: string;
  status: ThreadStatus;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  streaming?: boolean;
  createdAt: string;
}

export interface ChoiceOption {
  label: string;
  value: string;
  description?: string;
}

export interface ChoiceRequest {
  kind: "choice";
  requestId: string;
  title: string;
  prompt: string;
  options: ChoiceOption[];
}

export interface ApprovalRequest {
  kind: "approval";
  requestId: string;
  title: string;
  detail: string;
  command?: string;
  risk?: "low" | "medium" | "high";
}

export interface InputRequest {
  kind: "input";
  requestId: string;
  title: string;
  prompt: string;
  placeholder?: string;
}

export interface QuestionItem {
  id: string;
  header: string;
  prompt: string;
  options?: ChoiceOption[];
}

export interface QuestionsRequest {
  kind: "questions";
  requestId: string;
  title: string;
  questions: QuestionItem[];
}

export type PendingRequest = ChoiceRequest | ApprovalRequest | InputRequest | QuestionsRequest;

export interface ThreadDetail extends ThreadSummary {
  messages: ChatMessage[];
  pendingRequests: PendingRequest[];
  terminal: { connected: boolean; takeover: boolean; owner?: string };
}

export interface LoginRequest {
  password: string;
}
export interface SessionResponse {
  authenticated: boolean;
  csrfToken?: string;
}
export interface SettingsResponse {
  bindHost: "127.0.0.1" | "0.0.0.0";
  port: number;
  publicOrigin: string;
  dataDir: string;
  restartRequired: boolean;
}
export interface UpdateSettingsRequest {
  bindHost: "127.0.0.1" | "0.0.0.0";
  port: number;
  publicOrigin: string;
  newPassword?: string;
}
export interface CreateThreadRequest {
  hostId: string;
  cwd: string;
  proxy?: string;
  prependPath?: string;
  createDirectory?: boolean;
}
export interface ThreadCreateHostDefaults extends Omit<CreateThreadRequest, "createDirectory"> {
  updatedAt: string;
}
export interface ThreadCreateDefaults {
  lastHostId?: string;
  hosts: ThreadCreateHostDefaults[];
  cwdHistory: string[];
}
export type SaveThreadCreateDefaultsRequest = Omit<CreateThreadRequest, "createDirectory">;
export interface DeleteThreadCreateCwdRequest {
  cwd: string;
}
export interface ResumeThreadRequest {
  hostId: string;
  codexThreadId: string;
  cwd: string;
  proxy?: string;
  prependPath?: string;
}
export interface SendMessageRequest {
  text: string;
}
export interface ResolveRequest {
  value?: string;
  approved?: boolean;
  scope?: "turn" | "session";
  answers?: Record<string, { answers: string[] }>;
}

export type ServerEvent =
  | { type: "snapshot"; thread: ThreadDetail }
  | { type: "thread.updated"; thread: ThreadSummary }
  | { type: "thread.model.updated"; threadId: string; model: string }
  | { type: "thread.deleted"; threadId: string }
  | { type: "message.created"; threadId: string; message: ChatMessage }
  | { type: "message.delta"; threadId: string; messageId: string; delta: string }
  | { type: "message.completed"; threadId: string; messageId: string }
  | { type: "request.created"; threadId: string; request: PendingRequest }
  | { type: "request.resolved"; threadId: string; requestId: string }
  | { type: "terminal.data"; threadId: string; data: string }
  | { type: "terminal.state"; threadId: string; connected: boolean; takeover: boolean; owner?: string }
  | { type: "error"; threadId?: string; message: string };

export function serverEventThreadId(event: ServerEvent): string | undefined {
  return event.type === "snapshot" || event.type === "thread.updated" ? event.thread.id : event.threadId;
}

export type ClientEvent =
  | { type: "subscribe"; threadId: string }
  | { type: "unsubscribe"; threadId: string }
  | { type: "terminal.resize"; threadId: string; cols: number; rows: number }
  | { type: "terminal.input"; threadId: string; data: string };

export const controlMethods = [
  "host.list",
  "host.get",
  "host.upsert",
  "host.delete",
  "host.codexThreads",
  "thread.list",
  "thread.get",
  "thread.create",
  "thread.resume",
  "thread.restore",
  "thread.exit",
  "thread.delete",
  "thread.send",
  "thread.interrupt",
  "thread.wait",
  "thread.watch",
  "request.list",
  "request.get",
  "request.resolve",
  "request.approve",
  "request.decline",
  "request.answer",
  "terminal.screenshot",
  "terminal.watch",
  "terminal.takeover",
  "terminal.release",
  "terminal.input",
] as const;
export type ControlMethod = (typeof controlMethods)[number];
export interface ControlRequest {
  version: 1;
  id: string;
  method: ControlMethod;
  params?: Record<string, unknown>;
}
export interface ControlError {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}
export type ControlResponse =
  { version: 1; id: string; ok: true; result: unknown } | { version: 1; id: string; ok: false; error: ControlError };
export interface ControlEvent {
  version: 1;
  id: string;
  event: ServerEvent;
}
export interface ControlDone {
  version: 1;
  id: string;
  done: true;
  result?: unknown;
}

export const apiRoutes = {
  session: "/api/auth/session",
  login: "/api/auth/login",
  logout: "/api/auth/logout",
  hosts: "/api/hosts",
  settings: "/api/settings",
  threads: "/api/threads",
  threadCreateDefaults: "/api/preferences/thread-create",
  threadCreateCwdHistory: "/api/preferences/thread-create/cwd-history",
  resumeThread: "/api/threads/resume",
  resumeExitedThread: (threadId: string) => `/api/threads/${encodeURIComponent(threadId)}/resume`,
  events: "/api/events",
  hostCodexThreads: (hostId: string) => `/api/hosts/${encodeURIComponent(hostId)}/codex-threads`,
} as const;
