export interface ParsedCommand {
  method: string;
  params: Record<string, unknown>;
  stream: boolean;
  timeoutMs?: number;
  human: boolean;
  output?: string;
}

export class UsageError extends Error {}

type Options = Map<string, string | true>;

const usage = `Usage:
  codex-web-bridge start [--password VALUE --origin HTTPS_URL --port PORT] [--foreground]
  codex-web-bridge stop|restart|status|dashboard
  codex-web-bridge daemon <start|stop|restart|status|url> [same daemon options]

  codex-web-bridge host list
  codex-web-bridge host get HOST_ID
  codex-web-bridge host codex-threads HOST_ID
  codex-web-bridge host upsert --id ID --name NAME --hostname HOST --username USER
    --host-key SHA256:FINGERPRINT --identity-file ABSOLUTE_PATH [--port PORT]
  codex-web-bridge host upsert (--input-json JSON | --input-file PATH)

  codex-web-bridge thread list
  codex-web-bridge thread get|exit|interrupt THREAD_ID
  codex-web-bridge thread create --host HOST_ID --cwd ABSOLUTE_PATH [--title TITLE]
  codex-web-bridge thread resume --host HOST_ID --codex-thread CODEX_ID --cwd ABSOLUTE_PATH
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

Global options: --human
Use - as an input/text/data file to read stdin. JSON is the default output; --human is opt-in.`;

export function helpText(): string {
  return usage;
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
    if (["--human", "--foreground"].includes(value)) {
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

function finish(command: Omit<ParsedCommand, "human">, options: Options, human: boolean): ParsedCommand {
  if (options.size) throw new UsageError(`unknown option: ${options.keys().next().value}`);
  return { ...command, human };
}

function structuredInput(options: Options): { inputJson?: string; inputFile?: string } {
  const inputJson = take(options, "--input-json");
  const inputFile = take(options, "--input-file");
  if (inputJson !== undefined && inputFile !== undefined) throw new UsageError("--input-json and --input-file are mutually exclusive");
  return { inputJson, inputFile };
}

export function parseBusinessCommand(argv: string[]): ParsedCommand {
  const { positional, options } = splitOptions(argv);
  const human = flag(options, "--human");
  const group = positional.shift();
  const action = positional.shift();
  if (!group || !action) throw new UsageError(helpText());

  if (group === "host") {
    if (action === "list") { none(positional); return finish({ method: "host.list", params: {}, stream: false }, options, human); }
    if (action === "get") return finish({ method: "host.get", params: { hostId: one(positional, "host ID") }, stream: false }, options, human);
    if (action === "codex-threads") return finish({ method: "host.codexThreads", params: { hostId: one(positional, "host ID") }, stream: false }, options, human);
    if (action === "upsert") {
      none(positional);
      const input = structuredInput(options);
      const params: Record<string, unknown> = input.inputJson !== undefined || input.inputFile !== undefined ? input : {
        id: take(options, "--id", true), name: take(options, "--name", true),
        hostname: take(options, "--hostname", true),
        port: integer(take(options, "--port") ?? "22", "--port", [1, 65535]),
        username: take(options, "--username", true),
        hostKeySha256: take(options, "--host-key", true),
        identityFile: take(options, "--identity-file", true),
      };
      return finish({ method: "host.upsert", params, stream: false }, options, human);
    }
  }

  if (group === "thread") {
    if (action === "list") { none(positional); return finish({ method: "thread.list", params: {}, stream: false }, options, human); }
    if (["get", "exit", "interrupt"].includes(action)) {
      const threadId = one(positional, "thread ID");
      return finish({ method: `thread.${action}`, params: { threadId }, stream: false }, options, human);
    }
    if (action === "create") {
      none(positional);
      return finish({ method: "thread.create", params: {
        hostId: take(options, "--host", true), cwd: take(options, "--cwd", true), title: take(options, "--title"),
      }, stream: false }, options, human);
    }
    if (action === "resume") {
      none(positional);
      return finish({ method: "thread.resume", params: {
        hostId: take(options, "--host", true), codexThreadId: take(options, "--codex-thread", true), cwd: take(options, "--cwd", true),
      }, stream: false }, options, human);
    }
    if (action === "send") {
      const threadId = one(positional, "thread ID");
      const text = take(options, "--text");
      const textFile = take(options, "--text-file");
      if ((text === undefined) === (textFile === undefined)) throw new UsageError("provide exactly one of --text or --text-file");
      return finish({ method: "thread.send", params: { threadId, text, textFile }, stream: false }, options, human);
    }
    if (["wait", "watch"].includes(action)) {
      const threadId = one(positional, "thread ID");
      const timeoutMs = integer(take(options, "--timeout"), "--timeout", [1, 86_400_000]);
      return finish({ method: `thread.${action}`, params: { threadId }, stream: action === "watch", timeoutMs }, options, human);
    }
  }

  if (group === "request") {
    if (action === "list") return finish({ method: "request.list", params: { threadId: one(positional, "thread ID") }, stream: false }, options, human);
    if (["get", "approve", "decline"].includes(action)) {
      if (positional.length !== 2) throw new UsageError("expected thread ID and request ID");
      return finish({ method: `request.${action}`, params: { threadId: positional[0], requestId: positional[1] }, stream: false }, options, human);
    }
    if (["resolve", "answer"].includes(action)) {
      if (positional.length !== 2) throw new UsageError("expected thread ID and request ID");
      const input = structuredInput(options);
      if (input.inputJson === undefined && input.inputFile === undefined) throw new UsageError("provide --input-json or --input-file");
      return finish({ method: `request.${action}`, params: { threadId: positional[0], requestId: positional[1], ...input }, stream: false }, options, human);
    }
  }

  if (group === "terminal") {
    if (["takeover", "release"].includes(action)) {
      return finish({ method: `terminal.${action}`, params: { threadId: one(positional, "thread ID") }, stream: false }, options, human);
    }
    if (action === "screenshot") {
      const threadId = one(positional, "thread ID");
      const output = take(options, "--output", true);
      return finish({ method: "terminal.screenshot", params: { threadId }, stream: false, output }, options, human);
    }
    if (action === "input") {
      const threadId = one(positional, "thread ID");
      const data = take(options, "--data");
      const dataFile = take(options, "--data-file");
      if ((data === undefined) === (dataFile === undefined)) throw new UsageError("provide exactly one of --data or --data-file");
      return finish({ method: "terminal.input", params: { threadId, data, dataFile }, stream: false }, options, human);
    }
    if (action === "watch") {
      const threadId = one(positional, "thread ID");
      const timeoutMs = integer(take(options, "--timeout"), "--timeout", [1, 86_400_000]);
      return finish({ method: "terminal.watch", params: { threadId }, stream: true, timeoutMs }, options, human);
    }
  }
  throw new UsageError(`unknown command: ${group} ${action}\n${helpText()}`);
}
