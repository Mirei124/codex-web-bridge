interface RenderContext {
  method?: string;
  kind?: "event" | "result";
  params?: Record<string, unknown>;
}

type Row = Record<string, unknown>;

const columns: Record<string, Array<[string, string]>> = {
  "host.list": [["ID", "id"], ["NAME", "name"], ["ADDRESS", "address"], ["STATUS", "status"]],
  "host.codexThreads": [["ID", "id"], ["TITLE", "title"], ["CWD", "cwd"], ["UPDATED", "updatedAt"]],
  "thread.list": [["ID", "id"], ["TITLE", "title"], ["HOST", "hostId"], ["CWD", "cwd"], ["STATUS", "status"], ["UPDATED", "updatedAt"]],
  "request.list": [["ID", "requestId"], ["KIND", "kind"], ["TITLE", "title"], ["PROMPT", "prompt"]],
};

function scalar(value: unknown): string {
  if (value === undefined || value === null) return "-";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return value.map(scalar).join(", ");
  return Object.entries(value as Row).map(([key, item]) => `${key}=${scalar(item)}`).join(", ");
}

function table(rows: Row[], selected?: Array<[string, string]>): string {
  const definition = selected ?? Object.keys(rows[0] ?? {}).map(key => [key.toUpperCase(), key]);
  if (definition.length === 0) return "No results.";
  const values = rows.map(row => definition.map(([, key]) => scalar(row[key]).replaceAll(/\r?\n/g, " ")));
  const widths = definition.map(([heading], index) =>
    Math.max(heading.length, ...values.map(row => row[index]!.length)));
  const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();
  return [line(definition.map(([heading]) => heading)), ...values.map(line)].join("\n");
}

function details(data: Row): string {
  const entries = Object.entries(data);
  if (entries.length === 0) return "Done.";
  const width = Math.max(...entries.map(([key]) => key.length));
  return entries.map(([key, value]) => `${key.padEnd(width)}  ${scalar(value)}`).join("\n");
}

function event(data: unknown): string {
  if (!data || typeof data !== "object") return scalar(data);
  const value = data as Row;
  if (value.type === "snapshot" && value.thread && typeof value.thread === "object") {
    return threadDetails(value.thread as Row);
  }
  if (value.type === "terminal.data") return scalar(value.data);
  if (value.type === "message.delta") return scalar(value.delta);
  if (value.type === "message.created" && value.message && typeof value.message === "object") {
    const message = value.message as Row;
    return `${scalar(message.role)}: ${scalar(message.text)}`;
  }
  if (value.type === "message.completed") return "";
  if (value.type === "request.created" && value.request && typeof value.request === "object") {
    const request = value.request as Row;
    return `ACTION REQUIRED  ${scalar(request.kind)}  ${scalar(request.requestId)}  ${scalar(request.title)}`;
  }
  if (value.type === "request.resolved") return `Request ${scalar(value.requestId)} resolved.`;
  if (value.type === "thread.updated" && value.thread && typeof value.thread === "object") {
    const thread = value.thread as Row;
    return `Thread ${scalar(thread.id)} is ${scalar(thread.status)}.`;
  }
  if (value.type === "error") return `Error: ${scalar(value.message)}`;
  return details(value);
}

function labeled(entries: Array<[string, unknown]>): string {
  const width = Math.max(...entries.map(([label]) => label.length));
  return entries.map(([label, value]) => `${label.padEnd(width)}  ${scalar(value)}`).join("\n");
}

function threadDetails(data: Row): string {
  const lines = [labeled([
    ["ID", data.id],
    ["Title", data.title],
    ["Status", data.status],
    ["Host", data.hostId],
    ["Codex thread", data.codexThreadId],
    ["Working directory", data.cwd],
    ["Updated", data.updatedAt],
  ])];
  if (Array.isArray(data.messages) && data.messages.length) {
    lines.push("MESSAGES", ...data.messages.map(item => {
      const message = item as Row;
      return `[${scalar(message.createdAt)}] ${scalar(message.role)}\n${scalar(message.text)}`;
    }));
  }
  if (Array.isArray(data.pendingRequests) && data.pendingRequests.length) {
    lines.push("PENDING REQUESTS", table(data.pendingRequests as Row[], columns["request.list"]));
  }
  return lines.join("\n\n");
}

function operationResult(method: string | undefined, params: Row | undefined, data: Row): string | undefined {
  const hostId = scalar(data.id ?? params?.id);
  const threadId = scalar(data.id ?? params?.threadId);
  const requestId = scalar(params?.requestId);
  if (method === "host.upsert") return `Host ${hostId} saved.`;
  if (method === "thread.exit") return `Thread ${threadId} exited.`;
  if (method === "thread.delete") return `Thread ${threadId} deleted from Codex Web Bridge.`;
  if (method === "thread.interrupt") return `Thread ${threadId} interrupted.`;
  if (method === "thread.send") return data.turnId ? `Turn ${scalar(data.turnId)} started.` : "Message sent.";
  if (method === "request.approve") return `Request ${requestId} approved.`;
  if (method === "request.decline") return `Request ${requestId} declined.`;
  if (method === "request.answer") return `Request ${requestId} answered.`;
  if (method === "request.resolve") return `Request ${requestId} resolved.`;
  if (method === "terminal.takeover") return `Terminal takeover acquired for ${threadId}.`;
  if (method === "terminal.release") return `Terminal takeover released for ${threadId}.`;
  if (method === "terminal.input") return `Terminal input sent to ${threadId}.`;
  if (method === "terminal.screenshot") return `Screenshot saved to ${scalar(data.path)}.`;
}

function daemonResult(method: string | undefined, data: Row): string | undefined {
  if (method === "help") return typeof data.usage === "string" ? data.usage : undefined;
  if (method === "dashboard") return typeof data.url === "string" ? data.url : undefined;
  if (method === "status") {
    return data.state === "running" ? `Daemon is running (PID ${scalar(data.pid)}).` : "Daemon is not running.";
  }
  if (method === "start" || method === "restart") {
    const lines = [`Daemon ${data.state === "starting" ? "is starting" : "started"}${data.pid ? ` (PID ${scalar(data.pid)})` : ""}.`];
    if (data.generatedPassword) lines.push(`Dashboard password: ${scalar(data.generatedPassword)}`);
    return lines.join("\n");
  }
  if (method === "stop") {
    return data.state === "stopped" ? `Daemon stopped (PID ${scalar(data.pid)}).` : "Daemon is not running.";
  }
  if (method === "password.reset") {
    return [
      "Dashboard password reset.",
      `New password: ${scalar(data.generatedPassword)}`,
      `Daemon restarted: ${scalar(data.daemonRestarted)}`,
    ].join("\n");
  }
  if (method === "password.set") {
    return [
      "Dashboard password updated.",
      `Daemon restarted: ${scalar(data.daemonRestarted)}`,
    ].join("\n");
  }
}

export function renderHuman(data: unknown, context: RenderContext = {}): string {
  if (context.kind === "event") return event(data);
  if (typeof data === "string") return data;
  if (data === undefined || data === null) return "Done.";
  if (Array.isArray(data)) {
    const rows = data.filter((item): item is Row => Boolean(item) && typeof item === "object" && !Array.isArray(item));
    return rows.length === data.length ? table(rows, context.method ? columns[context.method] : undefined) : data.map(scalar).join("\n");
  }
  if (typeof data !== "object") return scalar(data);
  const daemon = daemonResult(context.method, data as Row);
  if (daemon !== undefined) return daemon;
  const operation = operationResult(context.method, context.params, data as Row);
  if (operation !== undefined) return operation;
  if (["thread.get", "thread.create", "thread.resume", "thread.restore", "thread.wait", "thread.watch"].includes(context.method ?? "")) {
    return threadDetails(data as Row);
  }
  if (context.method === "host.get") {
    const host = data as Row;
    return labeled([
      ["ID", host.id], ["Name", host.name], ["Address", host.address], ["Status", host.status],
      ["Host key", host.hostKeySha256], ["Identity file", host.identityFile],
    ]);
  }
  return details(data as Row);
}

export function humanEventMode(
  data: unknown,
  method?: string,
): "raw" | "line" | "stderr" | "ignore" {
  if (!data || typeof data !== "object") return "line";
  const type = (data as Row).type;
  if (method === "terminal.watch") {
    if (type === "terminal.data") return "raw";
    if (type === "terminal.state") return "stderr";
    return "ignore";
  }
  if (type === "message.delta") return "raw";
  return "line";
}

export function renderHumanError(error: { code: string; message: string }): string {
  return `Error: ${error.message} (${error.code})`;
}
