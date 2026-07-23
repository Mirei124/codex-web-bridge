import { randomUUID } from "node:crypto";
import { connect } from "node:net";

export interface ControlError {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
}

interface ControlResponse {
  version: 1;
  id: string;
  ok?: boolean;
  result?: unknown;
  error?: ControlError;
  event?: unknown;
  done?: boolean;
}

export class ControlRequestError extends Error {
  constructor(public readonly controlError: ControlError) {
    super(controlError.message);
  }
}

export async function controlRequest(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  options: { stream?: boolean; timeoutMs?: number; onEvent?: (event: unknown) => void } = {},
): Promise<unknown> {
  const id = randomUUID();
  const timeoutMs = options.timeoutMs ?? (method === "thread.wait" ? 600_000 : 30_000);
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new ControlRequestError({
      code: "timeout",
      message: `control request timed out after ${timeoutMs}ms`,
      retryable: true,
    })), timeoutMs);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ version: 1, id, method, params })}\n`);
    });
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let response: ControlResponse;
        try {
          response = JSON.parse(line) as ControlResponse;
        } catch {
          finish(new ControlRequestError({ code: "protocol_error", message: "daemon returned invalid JSON" }));
          return;
        }
        if (response.version !== 1 || response.id !== id) {
          finish(new ControlRequestError({ code: "protocol_error", message: "daemon returned a mismatched response" }));
          return;
        }
        if (response.error) {
          finish(new ControlRequestError(response.error));
          return;
        }
        if (options.stream) {
          if (response.done) finish(undefined, response.result);
          else if ("event" in response) options.onEvent?.(response.event);
          else if (response.ok) finish(undefined, response.result);
        } else if (response.ok) {
          finish(undefined, response.result);
        }
      }
    });
    socket.once("error", error => {
      const nodeError = error as NodeJS.ErrnoException;
      finish(new ControlRequestError({
        code: ["ENOENT", "ECONNREFUSED"].includes(nodeError.code ?? "") ? "daemon_unavailable" : "io_error",
        message: nodeError.code === "ENOENT" ? "daemon is not running" : error.message,
        retryable: true,
      }));
    });
    socket.once("end", () => {
      if (!settled) finish(new ControlRequestError({ code: "protocol_error", message: "daemon closed the control connection before responding" }));
    });
  });
}
