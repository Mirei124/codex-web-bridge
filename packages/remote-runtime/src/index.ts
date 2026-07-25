import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { Client, type ConnectConfig, type ClientChannel } from "ssh2";
export {
  TerminalSnapshotRenderer,
  type RenderedTerminalSnapshot,
  type TerminalSnapshotOptions,
} from "./terminal-snapshot.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal?: string;
}
export interface CommandStream extends EventEmitter {
  on(event: "data", listener: (chunk: Buffer) => void): this;
  close(): void;
}
export interface RemoteExecutor {
  execute(program: string, args?: readonly string[]): Promise<CommandResult>;
  stream(program: string, args?: readonly string[]): Promise<CommandStream>;
  probeTcp?(host: string, port: number): Promise<boolean>;
  realpath?(path: string): Promise<string>;
}

export function withPrependedPath(remote: RemoteExecutor, prependPath: string | undefined): RemoteExecutor {
  if (!prependPath) return remote;
  return {
    execute: (program, args = []) =>
      program === "command" && args[0] === "-v" && typeof args[1] === "string"
        ? remote.execute("sh", [
            "-c",
            'PATH=$1${PATH:+:$PATH}; export PATH; command -v "$2"',
            "cwb-path",
            prependPath,
            args[1],
          ])
        : remote.execute("sh", [
            "-c",
            'PATH=$1${PATH:+:$PATH}; export PATH; shift; exec "$@"',
            "cwb-path",
            prependPath,
            program,
            ...args,
          ]),
    stream: (program, args = []) =>
      remote.stream("sh", [
        "-c",
        'PATH=$1${PATH:+:$PATH}; export PATH; shift; exec "$@"',
        "cwb-path",
        prependPath,
        program,
        ...args,
      ]),
    ...(remote.probeTcp ? { probeTcp: remote.probeTcp.bind(remote) } : {}),
    ...(remote.realpath ? { realpath: remote.realpath.bind(remote) } : {}),
  };
}

/** POSIX-shell quoting used only at the SSH protocol's unavoidable shell boundary. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
export function commandLine(program: string, args: readonly string[] = []): string {
  return [program, ...args].map(shellQuote).join(" ");
}

export class SshConnection implements RemoteExecutor {
  private client?: Client;
  constructor(private readonly config: ConnectConfig) {}
  async connect(): Promise<void> {
    if (this.client) return;
    const client = new Client();
    this.client = client;
    await new Promise<void>((resolve, reject) => {
      client.once("ready", resolve).once("error", reject).connect(this.config);
    });
  }
  close(): void {
    this.client?.end();
    this.client = undefined;
  }
  async execute(program: string, args: readonly string[] = []): Promise<CommandResult> {
    const marker = `__CWB_EXIT_${randomUUID()}__`;
    const command = commandLine(program, args);
    const channel = await this.exec(
      `${command}; cwb_exit_status=$?; printf '\\n${marker}%s\\n' "$cwb_exit_status" >&2; exit "$cwb_exit_status"`,
    );
    let stdout = "",
      stderr = "",
      code: number | null = null,
      signal: string | undefined;
    channel.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    channel.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    await new Promise<void>((resolve, reject) => {
      channel
        .once("exit", (c: number | null, s?: string) => {
          code = c;
          signal = s;
        })
        .once("close", resolve)
        .once("error", reject);
    });
    const markerStart = stderr.lastIndexOf(`\n${marker}`);
    if (markerStart >= 0) {
      const encodedStatus = stderr.slice(markerStart + marker.length + 1).trim();
      if (/^\d+$/.test(encodedStatus)) {
        code = Number(encodedStatus);
        stderr = stderr.slice(0, markerStart);
      }
    }
    return { stdout, stderr, code, signal };
  }
  async stream(program: string, args: readonly string[] = []): Promise<CommandStream> {
    const channel = await this.exec(commandLine(program, args));
    const output = new EventEmitter() as CommandStream;
    channel.on("data", (chunk: Buffer) => output.emit("data", Buffer.from(chunk)));
    channel.on("close", () => output.emit("close"));
    channel.on("error", (error: Error) => output.emit("error", error));
    output.close = () => channel.close();
    return output;
  }
  async forwardRemotePort(remotePort: number, localPort = 0): Promise<{ port: number; close(): Promise<void> }> {
    const client = this.requireClient();
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      client.forwardOut("127.0.0.1", 0, "127.0.0.1", remotePort, (error, channel) => {
        if (error) {
          socket.destroy(error);
          return;
        }
        socket.pipe(channel).pipe(socket);
      });
    });
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(localPort, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local port forward did not bind TCP");
    return {
      port: address.port,
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await closeServer(server);
      },
    };
  }
  async probeTcp(host: string, port: number): Promise<boolean> {
    const client = this.requireClient();
    return new Promise((resolve) =>
      client.forwardOut("127.0.0.1", 0, host, port, (error, channel) => {
        if (error) return resolve(false);
        channel.close();
        resolve(true);
      }),
    );
  }
  async realpath(path: string): Promise<string> {
    const client = this.requireClient();
    const sftp = await new Promise<import("ssh2").SFTPWrapper>((resolve, reject) =>
      client.sftp((error, value) => (error ? reject(error) : resolve(value))),
    );
    try {
      return await new Promise((resolve, reject) =>
        sftp.realpath(path, (error, value) => (error ? reject(error) : resolve(value))),
      );
    } finally {
      sftp.end();
    }
  }
  private requireClient(): Client {
    if (!this.client) throw new Error("SSH connection is not open");
    return this.client;
  }
  private async exec(command: string): Promise<ClientChannel> {
    const client = this.requireClient();
    return new Promise((resolve, reject) =>
      client.exec(command, (error, channel) => (error ? reject(error) : resolve(channel))),
    );
  }
}
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

export interface TmuxRuntimeOptions {
  tmux?: string;
  codex?: string;
  runtimeDirectory?: string;
}
export interface RemoteSession {
  name: string;
  appServerPane: string;
  viewerPane?: string;
  remotePort: number;
  fifoPath: string;
  appServerLogPath: string;
  threadId?: string;
}

export class TmuxCodexRuntime {
  private readonly tmux: string;
  private readonly codex: string;
  private readonly configuredRuntimeDirectory?: string;
  private resolvedTmux?: string;
  private resolvedCodex?: string;
  private resolvedRuntimeDirectory?: string;
  private readonly terminalReaders = new Map<string, CommandStream>();
  constructor(
    private readonly remote: RemoteExecutor,
    options: TmuxRuntimeOptions = {},
  ) {
    this.tmux = options.tmux ?? "tmux";
    this.codex = options.codex ?? "codex";
    this.configuredRuntimeDirectory = options.runtimeDirectory;
  }
  async checkPrerequisites(): Promise<void> {
    for (const program of [this.tmux, this.codex, "node"]) {
      const result = await this.remote.execute("command", ["-v", program]);
      const resolved = result.stdout.trim();
      if ((result.code !== 0 && result.code !== null) || !resolved)
        throw new Error(`Remote program not found: ${program}`);
      if (!resolved.startsWith("/")) throw new Error(`Remote program did not resolve to an absolute path: ${program}`);
      if (program === this.tmux) this.resolvedTmux = resolved;
      if (program === this.codex) this.resolvedCodex = resolved;
    }
    const codexVersion = await this.remote.execute(this.resolvedCodex ?? this.codex, ["--version"]);
    if (codexVersion.code !== 0) throw new Error(this.describeExecutableFailure("codex", codexVersion));
  }
  /** Start the persistent app-server pane. Attach the viewer after thread/start or thread/resume. */
  async start(name: string, cwd: string, remotePort: number, proxy?: string): Promise<RemoteSession> {
    validateName(name);
    validatePort(remotePort);
    const runtimeDirectory = await this.runtimeDirectory();
    const fifoPath = `${runtimeDirectory}/${name}.ansi`,
      appServerLogPath = `${runtimeDirectory}/${name}.app-server.log`;
    await this.prepareRuntimeDirectory(runtimeDirectory);
    const panes = await this.findPanes(name);
    if (panes)
      return { name, appServerPane: panes.appServerPane, viewerPane: panes.viewerPane, remotePort, fifoPath, appServerLogPath };
    const existing = await this.remote.execute("test", ["-e", fifoPath]);
    if (existing.code === 0) {
      const isFifo = await this.remote.execute("test", ["-p", fifoPath]);
      if (isFifo.code !== 0) throw new Error(`Refusing to replace non-FIFO runtime path: ${fifoPath}`);
      await this.must("rm", ["-f", fifoPath]);
    }
    await this.must("mkfifo", ["-m", "600", fifoPath]);
    const appCommand = this.appServerCommand(remotePort, appServerLogPath, proxy);
    const created = await this.must(this.resolvedTmux ?? this.tmux, [
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-s",
      name,
      "-c",
      cwd,
      appCommand,
    ]);
    const appServerPane = created.stdout.trim();
    await this.must(this.resolvedTmux ?? this.tmux, [
      "set-option",
      "-p",
      "-t",
      appServerPane,
      "@cwb-role",
      "app-server",
    ]);
    return { name, appServerPane, remotePort, fifoPath, appServerLogPath };
  }
  async waitUntilReady(
    session: RemoteSession,
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<void> {
    if (!this.remote.probeTcp) throw new Error("Remote executor does not support TCP readiness probes");
    const deadline = Date.now() + (options.timeoutMs ?? 15_000);
    do {
      if (await this.remote.probeTcp("127.0.0.1", session.remotePort)) return;
      if (!(await this.exists(session.name)))
        throw new Error(
          this.describeAppServerFailure(
            "Codex app-server tmux session exited before becoming ready",
            await this.appServerLogExcerpt(session.appServerLogPath),
          ),
        );
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 100));
    } while (Date.now() < deadline);
    throw new Error(
      this.describeAppServerFailure(
        `Codex app-server did not listen on port ${session.remotePort} before timeout`,
        await this.appServerLogExcerpt(session.appServerLogPath),
      ),
    );
  }
  async attachViewer(session: RemoteSession, cwd: string, threadId: string, proxy?: string): Promise<RemoteSession> {
    if (session.viewerPane) return { ...session, threadId };
    const viewerCommand = proxiedCommand(
      this.resolvedCodex ?? this.codex,
      [
        "-c",
        "check_for_update_on_startup=false",
        "--remote",
        `ws://127.0.0.1:${session.remotePort}`,
        "resume",
        threadId,
      ],
      proxy,
    );
    const result = await this.must(this.resolvedTmux ?? this.tmux, [
      "split-window",
      "-d",
      "-t",
      session.name,
      "-c",
      cwd,
      "-P",
      "-F",
      "#{pane_id}",
      viewerCommand,
    ]);
    const pane = result.stdout.trim();
    await this.must(this.resolvedTmux ?? this.tmux, ["set-option", "-p", "-t", pane, "@cwb-role", "viewer"]);
    await this.must(this.resolvedTmux ?? this.tmux, ["set-option", "-p", "-t", pane, "@cwb-thread", threadId]);
    // Reopen the FIFO after each reader disconnects, allowing browser/SSH stream reconnects.
    const pipeCommand = `while true; do cat > ${shellQuote(session.fifoPath)}; done`;
    await this.must(this.resolvedTmux ?? this.tmux, [
      "pipe-pane",
      "-O",
      "-t",
      pane,
      commandLine("sh", ["-c", pipeCommand]),
    ]);
    return { ...session, viewerPane: pane, threadId };
  }
  async exists(name: string): Promise<boolean> {
    validateName(name);
    return (await this.remote.execute(this.resolvedTmux ?? this.tmux, ["has-session", "-t", name])).code === 0;
  }
  async stop(name: string): Promise<void> {
    validateName(name);
    const result = await this.remote.execute(this.resolvedTmux ?? this.tmux, ["kill-session", "-t", name]);
    if (result.code !== 0 && !/can't find session|no server running/i.test(result.stderr)) throw commandError(result);
    this.terminalReaders.get(name)?.close();
    this.terminalReaders.delete(name);
    const fifoPath = `${await this.runtimeDirectory()}/${name}.ansi`;
    if ((await this.remote.execute("test", ["-p", fifoPath])).code === 0) await this.must("rm", ["-f", fifoPath]);
  }
  async capture(session: RemoteSession, historyLines = 0): Promise<string> {
    if (!session.viewerPane) throw new Error("Viewer pane has not been attached");
    const start = historyLines > 0 ? String(-historyLines) : "0";
    return (
      await this.must(this.resolvedTmux ?? this.tmux, [
        "capture-pane",
        "-e",
        "-p",
        "-J",
        "-S",
        start,
        "-t",
        session.viewerPane,
      ])
    ).stdout;
  }
  async dimensions(session: RemoteSession): Promise<{ cols: number; rows: number }> {
    if (!session.viewerPane) throw new Error("Viewer pane has not been attached");
    const value = (
      await this.must(this.resolvedTmux ?? this.tmux, [
        "display-message",
        "-p",
        "-t",
        session.viewerPane,
        "#{pane_width}\t#{pane_height}",
      ])
    ).stdout
      .trim()
      .split("\t");
    const cols = Number(value[0]),
      rows = Number(value[1]);
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) throw new Error("tmux returned invalid pane dimensions");
    return { cols, rows };
  }
  async terminalStream(session: RemoteSession): Promise<CommandStream> {
    if (!session.viewerPane) throw new Error("Viewer pane has not been attached");
    this.terminalReaders.get(session.name)?.close();
    const stream = await this.remote.stream("cat", [session.fifoPath]);
    this.terminalReaders.set(session.name, stream);
    stream.once("close", () => {
      if (this.terminalReaders.get(session.name) === stream) this.terminalReaders.delete(session.name);
    });
    return stream;
  }
  /** Atomically replace the sole FIFO reader; seed repairs any bytes lost during reconnect. */
  async reconnectTerminal(session: RemoteSession): Promise<{ seed: string; stream: CommandStream }> {
    const seed = await this.capture(session);
    return { seed, stream: await this.terminalStream(session) };
  }
  async sendKeys(session: RemoteSession, bytes: string): Promise<void> {
    if (!session.viewerPane) throw new Error("Viewer pane has not been attached");
    const key = tmuxTerminalKey(bytes);
    if (key) {
      await this.must(this.resolvedTmux ?? this.tmux, ["send-keys", "-t", session.viewerPane, key]);
      return;
    }
    // tmux set-buffer/paste-buffer preserves arbitrary user text as one argument.
    const buffer = `cwb-input-${randomUUID()}`;
    await this.must(this.resolvedTmux ?? this.tmux, ["set-buffer", "-b", buffer, bytes]);
    await this.must(this.resolvedTmux ?? this.tmux, ["paste-buffer", "-b", buffer, "-d", "-t", session.viewerPane]);
  }
  private async must(program: string, args: string[], ok = [0]): Promise<CommandResult> {
    const result = await this.remote.execute(program, args);
    if (!ok.includes(result.code ?? -1)) throw commandError(result);
    return result;
  }
  private async runtimeDirectory(): Promise<string> {
    if (this.resolvedRuntimeDirectory) return this.resolvedRuntimeDirectory;
    if (this.configuredRuntimeDirectory) {
      if (!this.configuredRuntimeDirectory.startsWith("/")) throw new Error("runtimeDirectory must be absolute");
      return (this.resolvedRuntimeDirectory = this.configuredRuntimeDirectory.replace(/\/$/, ""));
    }
    if (!this.remote.realpath) throw new Error("Remote executor cannot resolve the user's home directory");
    const home = await this.remote.realpath(".");
    if (!home.startsWith("/")) throw new Error("Remote home directory is not absolute");
    return (this.resolvedRuntimeDirectory = `${home.replace(/\/$/, "")}/.local/state/codex-web-bridge/runtime`);
  }
  private async prepareRuntimeDirectory(path: string): Promise<void> {
    await this.must("mkdir", ["-p", "-m", "700", path]);
    if (
      (await this.remote.execute("test", ["-d", path])).code !== 0 ||
      (await this.remote.execute("test", ["-L", path])).code === 0
    )
      throw new Error(`Unsafe runtime directory: ${path}`);
    const owner = (await this.must("stat", ["-c", "%u", path])).stdout.trim();
    const current = (await this.must("id", ["-u"])).stdout.trim();
    if (!owner || owner !== current) throw new Error(`Runtime directory is not owned by remote user: ${path}`);
    await this.must("chmod", ["700", path]);
  }
  private async findPanes(name: string): Promise<{ appServerPane: string; viewerPane?: string } | undefined> {
    if (!(await this.exists(name))) return;
    const result = await this.must(this.resolvedTmux ?? this.tmux, [
      "list-panes",
      "-t",
      name,
      "-F",
      "#{pane_id}\t#{@cwb-role}\t#{@cwb-thread}",
    ]);
    let appServerPane: string | undefined, viewerPane: string | undefined;
    for (const line of result.stdout.trim().split("\n")) {
      const [id, role] = line.split("\t");
      if (role === "app-server") appServerPane = id;
      if (role === "viewer") viewerPane = id;
    }
    if (!appServerPane) throw new Error(`Existing tmux session '${name}' is not managed by Codex Web Bridge`);
    return { appServerPane, viewerPane };
  }
  private appServerCommand(remotePort: number, appServerLogPath: string, proxy?: string): string {
    const command = proxiedCommand(
      this.resolvedCodex ?? this.codex,
      ["-c", "check_for_update_on_startup=false", "app-server", "--listen", `ws://127.0.0.1:${remotePort}`],
      proxy,
    );
    return commandLine("sh", ["-lc", `exec ${command} > ${shellQuote(appServerLogPath)} 2>&1`]);
  }
  private async appServerLogExcerpt(appServerLogPath: string): Promise<string | undefined> {
    const result = await this.remote.execute("sh", [
      "-c",
      'test -f "$1" && tail -n 20 "$1"',
      "cwb-app-server-log",
      appServerLogPath,
    ]);
    const output = `${result.stdout}${result.stderr}`.trim();
    return output || undefined;
  }
  private describeExecutableFailure(program: string, result: CommandResult): string {
    const detail = (result.stderr || result.stdout).trim();
    return detail ? `Remote ${program} failed: ${detail}` : `Remote ${program} failed (${result.code ?? "unknown"})`;
  }
  private describeAppServerFailure(message: string, output: string | undefined): string {
    return output ? `${message}. Last app-server output:\n${output}` : message;
  }
}
function validateName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error("Invalid tmux session name");
}
function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid app-server port");
}
function tmuxTerminalKey(bytes: string): string | undefined {
  if (bytes.length === 1) return tmuxControlKey(bytes.charCodeAt(0));
  const direct: Record<string, string> = {
    "\x1b[A": "Up",
    "\x1bOA": "Up",
    "\x1b[B": "Down",
    "\x1bOB": "Down",
    "\x1b[C": "Right",
    "\x1bOC": "Right",
    "\x1b[D": "Left",
    "\x1bOD": "Left",
    "\x1b[H": "Home",
    "\x1bOH": "Home",
    "\x1b[1~": "Home",
    "\x1b[7~": "Home",
    "\x1b[F": "End",
    "\x1bOF": "End",
    "\x1b[4~": "End",
    "\x1b[8~": "End",
    "\x1b[2~": "Insert",
    "\x1b[3~": "Delete",
    "\x1b[5~": "PageUp",
    "\x1b[6~": "PageDown",
    "\x1b[Z": "BTab",
    "\x1bOP": "F1",
    "\x1bOQ": "F2",
    "\x1bOR": "F3",
    "\x1bOS": "F4",
    "\x1b[15~": "F5",
    "\x1b[17~": "F6",
    "\x1b[18~": "F7",
    "\x1b[19~": "F8",
    "\x1b[20~": "F9",
    "\x1b[21~": "F10",
    "\x1b[23~": "F11",
    "\x1b[24~": "F12",
  };
  if (direct[bytes]) return direct[bytes];
  const modified = bytes.match(/^\x1b\[1;([2-8])([ABCDHF])$/);
  if (modified) {
    const modifiers: Record<string, string> = {
        "2": "S",
        "3": "M",
        "4": "M-S",
        "5": "C",
        "6": "C-S",
        "7": "C-M",
        "8": "C-M-S",
      },
      keys: Record<string, string> = { A: "Up", B: "Down", C: "Right", D: "Left", H: "Home", F: "End" };
    return `${modifiers[modified[1]!]!}-${keys[modified[2]!]!}`;
  }
  if (bytes.length === 2 && bytes[0] === "\x1b" && bytes.charCodeAt(1) >= 32 && bytes.charCodeAt(1) < 127)
    return `M-${bytes[1]}`;
}
function tmuxControlKey(code: number): string | undefined {
  if (code === 0) return "C-@";
  if (code === 8) return "BSpace";
  if (code === 9) return "Tab";
  if (code === 13) return "Enter";
  if (code >= 1 && code <= 26) return `C-${String.fromCharCode(96 + code)}`;
  if (code === 27) return "Escape";
  if (code === 28) return "C-\\";
  if (code === 29) return "C-]";
  if (code === 30) return "C-^";
  if (code === 31) return "C-_";
  if (code === 127) return "BSpace";
}
function proxiedCommand(program: string, args: string[], proxy?: string): string {
  if (!proxy) return commandLine(program, args);
  const variables = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].map((name) => `${name}=${proxy}`);
  return commandLine("env", [...variables, program, ...args]);
}
function commandError(result: CommandResult): Error {
  return new Error(`Remote command failed (${result.code}): ${result.stderr.trim()}`);
}
