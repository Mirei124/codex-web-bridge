export interface ParsedCommand {
  method: string;
  params: Record<string, unknown>;
  stream: boolean;
  timeoutMs?: number;
  json: boolean;
  output?: string;
}

export class UsageError extends Error {}

type Options = Map<string, string | true>;

const usage = `Usage:
  codex-web-bridge start [--password VALUE|--reset-password] [--origin URL --port PORT] [--accept-risk] [--foreground]
  codex-web-bridge stop|restart|status|dashboard
  codex-web-bridge password reset
  codex-web-bridge password set NEW_PASSWORD
  codex-web-bridge daemon <start|stop|restart|status|url> [same daemon options]

  codex-web-bridge host list
  codex-web-bridge host get HOST_ID
  codex-web-bridge host codex-threads HOST_ID
  codex-web-bridge host add USER@HOST[:PORT] [--id ID] [--name NAME]
    [--identity-file ABSOLUTE_PATH] [--path PATH_VALUE] [--password|--password-stdin|--clear-password] [--accept-host-key]
  codex-web-bridge host upsert --id ID --name NAME --hostname HOST --username USER
    [--identity-file ABSOLUTE_PATH] [--path PATH_VALUE] [--port PORT] [--accept-host-key]
  codex-web-bridge host upsert (--input-json JSON | --input-file PATH)

  codex-web-bridge thread list
  codex-web-bridge thread get|exit|restore|interrupt THREAD_ID
  codex-web-bridge thread create --host HOST_ID --cwd ABSOLUTE_PATH [--proxy URL]
  codex-web-bridge thread resume --host HOST_ID --codex-thread CODEX_ID --cwd ABSOLUTE_PATH [--proxy URL]
  codex-web-bridge thread send THREAD_ID (--text TEXT | --text-file PATH)
  codex-web-bridge thread wait|watch THREAD_ID [--timeout MILLISECONDS]

  codex-web-bridge request list THREAD_ID
  codex-web-bridge request get|approve|decline THREAD_ID REQUEST_ID
  codex-web-bridge request resolve|answer THREAD_ID REQUEST_ID
    (--input-json JSON | --input-file PATH)

  codex-web-bridge terminal screenshot THREAD_ID --output PNG_PATH
  codex-web-bridge terminal watch THREAD_ID [--timeout MILLISECONDS]
  codex-web-bridge terminal takeover|release THREAD_ID
  codex-web-bridge terminal input THREAD_ID (--data TEXT | --data-file PATH)

Global options: --json
Use - as an input/text/data file to read stdin. Human-readable output is the default; --json emits one structured JSON value per line.`;

const commandHelp: Record<string, string> = {
  start: `Usage: codex-web-bridge start [--password VALUE|--reset-password] [--origin URL] [--port PORT] [--accept-risk] [--foreground] [--json]

Start the daemon. The first start generates a dashboard password unless --password is supplied.
Use --reset-password to replace an existing password while starting.
When configuration already exists, use password set instead of --password.
The daemon listens on 127.0.0.1 by default; --accept-risk binds to 0.0.0.0 over HTTP.`,
  stop: "Usage: codex-web-bridge stop [--json]\n\nStop the daemon without destroying remote tmux or Codex history.",
  restart: `Usage: codex-web-bridge restart [--password VALUE|--reset-password] [--origin URL] [--port PORT] [--accept-risk] [--foreground] [--json]

Restart the daemon. Remote tmux sessions remain running.`,
  status: "Usage: codex-web-bridge status [--json]\n\nShow whether the daemon is running and its PID.",
  dashboard: "Usage: codex-web-bridge dashboard [--json]\n\nPrint the configured dashboard URL.",
  password: "Usage:\n  codex-web-bridge password reset [--json]\n  codex-web-bridge password set NEW_PASSWORD [--json]\n\nReplace the dashboard password and restart a running daemon.",
  "password reset": "Usage: codex-web-bridge password reset [--json]\n\nGenerate and print a new dashboard password. A running daemon is restarted automatically.",
  "password set": "Usage: codex-web-bridge password set NEW_PASSWORD [--json]\n\nSet a dashboard password of at least 12 characters. A running daemon is restarted automatically.",
  host: `Usage:
  codex-web-bridge host list
  codex-web-bridge host get HOST_ID
  codex-web-bridge host codex-threads HOST_ID
  codex-web-bridge host add USER@HOST[:PORT] [OPTIONS]
  codex-web-bridge host upsert [OPTIONS]`,
  "host list": "Usage: codex-web-bridge host list [--json]\n\nList configured SSH hosts.",
  "host get": "Usage: codex-web-bridge host get HOST_ID [--json]\n\nShow one configured SSH host.",
  "host codex-threads": "Usage: codex-web-bridge host codex-threads HOST_ID [--json]\n\nList Codex threads discovered on a host.",
  "host add": `Usage: codex-web-bridge host add USER@HOST[:PORT] [--id ID] [--name NAME]
  [--identity-file ABSOLUTE_PATH] [--path PATH_VALUE] [--password|--password-stdin|--clear-password]
  [--accept-host-key] [--json]

Add a host, verify its SSH host key, and optionally supply an in-memory password.
Use --path to set the complete PATH for remote commands; include system directories such as /usr/bin:/bin.`,
  "host upsert": `Usage:
  codex-web-bridge host upsert --id ID --name NAME --hostname HOST --username USER
    [--identity-file ABSOLUTE_PATH] [--path PATH_VALUE] [--port PORT] [--accept-host-key] [--json]
  codex-web-bridge host upsert (--input-json JSON | --input-file PATH) [--json]

Create or update a host using explicit fields or a JSON object.
--path is a complete colon-separated list of absolute directories.`,
  thread: `Usage:
  codex-web-bridge thread list
  codex-web-bridge thread get THREAD_ID
  codex-web-bridge thread create --host HOST_ID --cwd ABSOLUTE_PATH [--proxy URL]
  codex-web-bridge thread resume --host HOST_ID --codex-thread CODEX_ID --cwd ABSOLUTE_PATH [--proxy URL]
  codex-web-bridge thread send|wait|watch|interrupt|exit ...`,
  "thread list": "Usage: codex-web-bridge thread list [--json]\n\nList bridge-managed Codex threads.",
  "thread get": "Usage: codex-web-bridge thread get THREAD_ID [--json]\n\nShow messages, pending requests, terminal state, and metadata.",
  "thread create": "Usage: codex-web-bridge thread create --host HOST_ID --cwd ABSOLUTE_PATH [--proxy URL] [--json]\n\nCreate a new Codex thread.",
  "thread resume": "Usage: codex-web-bridge thread resume --host HOST_ID --codex-thread CODEX_ID --cwd ABSOLUTE_PATH [--proxy URL] [--json]\n\nResume an existing Codex thread as a new bridge-managed record.",
  "thread restore": "Usage: codex-web-bridge thread restore THREAD_ID [--json]\n\nRestart an exited bridge-managed thread in place.",
  "thread send": "Usage: codex-web-bridge thread send THREAD_ID (--text TEXT | --text-file PATH) [--json]\n\nSend a new user message.",
  "thread wait": "Usage: codex-web-bridge thread wait THREAD_ID [--timeout MILLISECONDS] [--json]\n\nWait until the thread becomes idle, waiting, exited, or errored.",
  "thread watch": "Usage: codex-web-bridge thread watch THREAD_ID [--timeout MILLISECONDS] [--json]\n\nStream thread events until exit, error, timeout, or interruption.",
  "thread interrupt": "Usage: codex-web-bridge thread interrupt THREAD_ID [--json]\n\nInterrupt the active Codex turn.",
  "thread exit": "Usage: codex-web-bridge thread exit THREAD_ID [--json]\n\nStop the tmux-backed runtime without deleting Codex history.",
  request: `Usage:
  codex-web-bridge request list THREAD_ID
  codex-web-bridge request get THREAD_ID REQUEST_ID
  codex-web-bridge request approve|decline THREAD_ID REQUEST_ID
  codex-web-bridge request answer|resolve THREAD_ID REQUEST_ID (--input-json JSON | --input-file PATH)`,
  "request list": "Usage: codex-web-bridge request list THREAD_ID [--json]\n\nList pending requests for a thread.",
  "request get": "Usage: codex-web-bridge request get THREAD_ID REQUEST_ID [--json]\n\nShow a pending request.",
  "request approve": "Usage: codex-web-bridge request approve THREAD_ID REQUEST_ID [--json]\n\nApprove a pending approval request.",
  "request decline": "Usage: codex-web-bridge request decline THREAD_ID REQUEST_ID [--json]\n\nDecline a pending approval request.",
  "request answer": "Usage: codex-web-bridge request answer THREAD_ID REQUEST_ID (--input-json JSON | --input-file PATH) [--json]\n\nAnswer Plan-mode or request_user_input questions.",
  "request resolve": "Usage: codex-web-bridge request resolve THREAD_ID REQUEST_ID (--input-json JSON | --input-file PATH) [--json]\n\nResolve a pending request with a structured response.",
  terminal: `Usage:
  codex-web-bridge terminal screenshot THREAD_ID --output PNG_PATH
  codex-web-bridge terminal watch THREAD_ID [--timeout MILLISECONDS]
  codex-web-bridge terminal takeover|release THREAD_ID
  codex-web-bridge terminal input THREAD_ID (--data TEXT | --data-file PATH)`,
  "terminal screenshot": "Usage: codex-web-bridge terminal screenshot THREAD_ID --output PNG_PATH [--json]\n\nRender the current terminal to a PNG file.",
  "terminal watch": "Usage: codex-web-bridge terminal watch THREAD_ID [--timeout MILLISECONDS] [--json]\n\nStream raw terminal output. Status messages are written to stderr.",
  "terminal takeover": "Usage: codex-web-bridge terminal takeover THREAD_ID [--json]\n\nAcquire a temporary terminal input lease.",
  "terminal release": "Usage: codex-web-bridge terminal release THREAD_ID [--json]\n\nRelease the terminal input lease.",
  "terminal input": "Usage: codex-web-bridge terminal input THREAD_ID (--data TEXT | --data-file PATH) [--json]\n\nSend input while holding the terminal takeover lease.",
};

export function helpText(argv: string[] = []): string {
  const words = argv.filter(value => !value.startsWith("--")).slice(0, 2);
  if (words[0] === "daemon" && words[1]) {
    return commandHelp[words[1] === "url" ? "dashboard" : words[1]] ?? usage;
  }
  return commandHelp[words.join(" ")] ?? commandHelp[words[0] ?? ""] ?? usage;
}

function splitOptions(args: string[]): { positional: string[]; options: Options } {
  const positional: string[] = [];
  const options: Options = new Map();
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    if (options.has(value)) throw new UsageError(`option ${value} was provided more than once`);
    if (["--json", "--foreground", "--password", "--password-stdin", "--clear-password", "--accept-host-key"].includes(value)) {
      options.set(value, true);
      continue;
    }
    const next = args[++index];
    if (next === undefined || next.startsWith("--")) throw new UsageError(`option ${value} requires a value`);
    options.set(value, next);
  }
  return { positional, options };
}

function take(options: Options, name: string, required = false): string | undefined {
  const value = options.get(name);
  options.delete(name);
  if (value === true) throw new UsageError(`option ${name} requires a value`);
  if (required && value === undefined) throw new UsageError(`missing required option ${name}`);
  return value;
}

function flag(options: Options, name: string): boolean {
  const present = options.get(name) === true;
  options.delete(name);
  return present;
}

function integer(value: string | undefined, name: string, bounds?: [number, number]): number | undefined {
  if (value === undefined) return;
  if (!/^\d+$/.test(value)) throw new UsageError(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || bounds && (parsed < bounds[0] || parsed > bounds[1])) {
    throw new UsageError(`${name} is outside its allowed range`);
  }
  return parsed;
}

function one(positional: string[], label: string): string {
  if (positional.length !== 1) throw new UsageError(`expected exactly one ${label}`);
  return positional[0]!;
}

function none(positional: string[]): void {
  if (positional.length) throw new UsageError(`unexpected argument: ${positional[0]}`);
}

function finish(command: Omit<ParsedCommand, "json">, options: Options, json: boolean): ParsedCommand {
  if (options.size) throw new UsageError(`unknown option: ${options.keys().next().value}`);
  return { ...command, json };
}

function structuredInput(options: Options): { inputJson?: string; inputFile?: string } {
  const inputJson = take(options, "--input-json");
  const inputFile = take(options, "--input-file");
  if (inputJson !== undefined && inputFile !== undefined) throw new UsageError("--input-json and --input-file are mutually exclusive");
  return { inputJson, inputFile };
}

export function parseBusinessCommand(argv: string[]): ParsedCommand {
  const { positional, options } = splitOptions(argv);
  const json = flag(options, "--json");
  const group = positional.shift();
  const action = positional.shift();
  if (!group || !action) throw new UsageError(helpText());

  if (group === "host") {
    if (action === "list") { none(positional); return finish({ method: "host.list", params: {}, stream: false }, options, json); }
    if (action === "get") return finish({ method: "host.get", params: { hostId: one(positional, "host ID") }, stream: false }, options, json);
    if (action === "codex-threads") return finish({ method: "host.codexThreads", params: { hostId: one(positional, "host ID") }, stream: false }, options, json);
    if (action === "add" || action === "upsert") {
      const target = action === "add" ? one(positional, "user@hostname[:port] target") : (none(positional), undefined);
      const input = structuredInput(options);
      const parsedTarget = target ? parseSshTarget(target) : undefined;
      const params: Record<string, unknown> = input.inputJson !== undefined || input.inputFile !== undefined ? input : {
        id: take(options, "--id", !target) ?? defaultHostId(parsedTarget!),
        name: take(options, "--name", !target) ?? parsedTarget!.hostname,
        ...(parsedTarget ?? {
          hostname: take(options, "--hostname", true),
          username: take(options, "--username", true),
          port: integer(take(options, "--port") ?? "22", "--port", [1, 65535]),
        }),
        identityFile: take(options, "--identity-file"),
        pathEnv: take(options, "--path"),
        hostKeySha256: take(options, "--host-key"),
        passwordPrompt: flag(options, "--password"),
        passwordStdin: flag(options, "--password-stdin"),
        clearPassword: flag(options, "--clear-password"),
        acceptHostKey: flag(options, "--accept-host-key"),
      };
      if (params.passwordPrompt && params.passwordStdin) throw new UsageError("--password and --password-stdin are mutually exclusive");
      if (params.clearPassword && (params.passwordPrompt || params.passwordStdin)) throw new UsageError("--clear-password cannot be combined with password input");
      return finish({ method: "host.upsert", params, stream: false }, options, json);
    }
  }

  if (group === "thread") {
    if (action === "list") { none(positional); return finish({ method: "thread.list", params: {}, stream: false }, options, json); }
    if (["get", "exit", "restore", "interrupt"].includes(action)) {
      const threadId = one(positional, "thread ID");
      return finish({ method: `thread.${action}`, params: { threadId }, stream: false }, options, json);
    }
    if (action === "create") {
      none(positional);
      const proxy = take(options, "--proxy");
      return finish({ method: "thread.create", params: {
        hostId: take(options, "--host", true), cwd: take(options, "--cwd", true), ...(proxy ? { proxy } : {}),
      }, stream: false }, options, json);
    }
    if (action === "resume") {
      none(positional);
      const proxy = take(options, "--proxy");
      return finish({ method: "thread.resume", params: {
        hostId: take(options, "--host", true), codexThreadId: take(options, "--codex-thread", true), cwd: take(options, "--cwd", true), ...(proxy ? { proxy } : {}),
      }, stream: false }, options, json);
    }
    if (action === "send") {
      const threadId = one(positional, "thread ID");
      const text = take(options, "--text");
      const textFile = take(options, "--text-file");
      if ((text === undefined) === (textFile === undefined)) throw new UsageError("provide exactly one of --text or --text-file");
      return finish({ method: "thread.send", params: { threadId, text, textFile }, stream: false }, options, json);
    }
    if (["wait", "watch"].includes(action)) {
      const threadId = one(positional, "thread ID");
      const timeoutMs = integer(take(options, "--timeout"), "--timeout", [1, 86_400_000]);
      return finish({ method: `thread.${action}`, params: { threadId }, stream: action === "watch", timeoutMs }, options, json);
    }
  }

  if (group === "request") {
    if (action === "list") return finish({ method: "request.list", params: { threadId: one(positional, "thread ID") }, stream: false }, options, json);
    if (["get", "approve", "decline"].includes(action)) {
      if (positional.length !== 2) throw new UsageError("expected thread ID and request ID");
      return finish({ method: `request.${action}`, params: { threadId: positional[0], requestId: positional[1] }, stream: false }, options, json);
    }
    if (["resolve", "answer"].includes(action)) {
      if (positional.length !== 2) throw new UsageError("expected thread ID and request ID");
      const input = structuredInput(options);
      if (input.inputJson === undefined && input.inputFile === undefined) throw new UsageError("provide --input-json or --input-file");
      return finish({ method: `request.${action}`, params: { threadId: positional[0], requestId: positional[1], ...input }, stream: false }, options, json);
    }
  }

  if (group === "terminal") {
    if (["takeover", "release"].includes(action)) {
      return finish({ method: `terminal.${action}`, params: { threadId: one(positional, "thread ID") }, stream: false }, options, json);
    }
    if (action === "screenshot") {
      const threadId = one(positional, "thread ID");
      const output = take(options, "--output", true);
      return finish({ method: "terminal.screenshot", params: { threadId }, stream: false, output }, options, json);
    }
    if (action === "input") {
      const threadId = one(positional, "thread ID");
      const data = take(options, "--data");
      const dataFile = take(options, "--data-file");
      if ((data === undefined) === (dataFile === undefined)) throw new UsageError("provide exactly one of --data or --data-file");
      return finish({ method: "terminal.input", params: { threadId, data, dataFile }, stream: false }, options, json);
    }
    if (action === "watch") {
      const threadId = one(positional, "thread ID");
      const timeoutMs = integer(take(options, "--timeout"), "--timeout", [1, 86_400_000]);
      return finish({ method: "terminal.watch", params: { threadId }, stream: true, timeoutMs }, options, json);
    }
  }
  throw new UsageError(`unknown command: ${group} ${action}\n${helpText()}`);
}

function parseSshTarget(value: string): { username: string; hostname: string; port: number } {
  const match = /^([^@\s]+)@(?:\[([^\]]+)\]|([^:\s]+))(?::(\d+))?$/.exec(value);
  if (!match) throw new UsageError("host target must be user@hostname[:port]");
  const port = integer(match[4] ?? "22", "target port", [1, 65535])!;
  return { username: match[1]!, hostname: match[2] ?? match[3]!, port };
}

function defaultHostId(target: { username: string; hostname: string; port: number }): string {
  const value = `${target.username}-${target.hostname}-${target.port}`.toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 128);
  if (!value) throw new UsageError("cannot derive a host ID; provide --id");
  return value;
}
