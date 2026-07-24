import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { commandLine, shellQuote, TerminalSnapshotRenderer, TmuxCodexRuntime, withRemotePath, type CommandResult, type RemoteExecutor } from "../src/index.js";

class FakeRemote implements RemoteExecutor {
  calls: Array<[string, readonly string[]]> = [];
  sessionExists = false; probeReady = false;
  streams: any[] = [];
  async execute(program: string, args: readonly string[] = []): Promise<CommandResult> {
    this.calls.push([program, args]);
    if (program === "tmux" && args[0] === "has-session") return { stdout: "", stderr: "", code: this.sessionExists ? 0 : 1 };
    if (program === "tmux" && args[0] === "list-panes") return { stdout: "%1\tapp-server\t\n%2\tviewer\tthread-1\n", stderr: "", code: 0 };
    if (program === "tmux" && args[0] === "new-session") return { stdout: "%1\n", stderr: "", code: 0 };
    if (program === "tmux" && args[0] === "split-window") return { stdout: "%2\n", stderr: "", code: 0 };
    if (program === "stat" || program === "id") return { stdout: "1000\n", stderr: "", code: 0 };
    if (program === "test" && args[0] === "-L") return { stdout: "", stderr: "", code: 1 };
    if (program === "test" && args[0] === "-e") return { stdout: "", stderr: "", code: 1 };
    return { stdout: "", stderr: "", code: 0 };
  }
  async stream() { const stream = new EventEmitter() as any; stream.closed = false; stream.close = () => { stream.closed = true; stream.emit("close"); }; this.streams.push(stream); return stream; }
  async probeTcp() { return this.probeReady; }
  async realpath() { return "/home/alice"; }
}
describe("remote command safety", () => {
  it("quotes every argument at the SSH shell boundary", () => { expect(commandLine("printf", ["a'b", "$(bad)"])).toBe("'printf' 'a'\\''b' '$(bad)'"); expect(shellQuote("")).toBe("''"); });
  it("applies a literal host PATH to command lookup and remote programs", async () => {
    const remote = new FakeRemote(); const path = "/home/alice/.local/share/tmux/bin:/usr/bin:/bin"; const wrapped = withRemotePath(remote, path);
    await wrapped.execute("command", ["-v", "tmux"]);
    await wrapped.execute("tmux", ["list-sessions"]);
    expect(remote.calls[0]).toEqual(["sh", ["-c", 'PATH=$1; export PATH; command -v "$2"', "cwb-path", path, "tmux"]]);
    expect(remote.calls[1]).toEqual(["sh", ["-c", 'PATH=$1; export PATH; shift; exec "$@"', "cwb-path", path, "tmux", "list-sessions"]]);
  });
  it("builds app server and viewer panes without interpolating user values", async () => {
    const remote = new FakeRemote(); const runtime = new TmuxCodexRuntime(remote, { runtimeDirectory: "/safe/runtime" });
    const session = await runtime.start("cwb_1", "/repo with spaces", 43123); const attached = await runtime.attachViewer(session, "/repo with spaces", "thread-1");
    expect(attached.viewerPane).toBe("%2");
    expect(remote.calls.find(c => c[1][0] === "new-session")?.[1]).toContain("/repo with spaces");
    expect(remote.calls.find(c => c[1][0] === "pipe-pane")?.[1].at(-1)).toContain("while true; do cat");
    expect(remote.calls.some(c => c[1][0] === "set-option" && c[1].includes("@cwb-thread") && c[1].includes("thread-1"))).toBe(true);
  });
  it("injects proxy variables into Codex commands with shell-safe quoting", async () => {
    const remote = new FakeRemote(); const runtime = new TmuxCodexRuntime(remote, { runtimeDirectory: "/safe/runtime" });
    const proxy = "http://user:p'a$(bad)@proxy.example:8080";
    const session = await runtime.start("proxied", "/repo", 43123, proxy);
    await runtime.attachViewer(session, "/repo", "thread-1", proxy);
    const appCommand = remote.calls.find(call => call[1][0] === "new-session")?.[1].at(-1);
    const viewerCommand = remote.calls.find(call => call[1][0] === "split-window")?.[1].at(-1);
    for (const command of [appCommand, viewerCommand]) {
      expect(command).toContain("'env'");
      expect(command).toContain(`'HTTPS_PROXY=http://user:p'\\''a$(bad)@proxy.example:8080'`);
      expect(command).toContain("'https_proxy=http://");
    }
  });
  it("derives a private runtime directory from the remote SFTP home", async () => { const remote = new FakeRemote(); await new TmuxCodexRuntime(remote).start("private", "/repo", 43123); expect(remote.calls.find(call => call[0] === "mkdir")?.[1]).toContain("/home/alice/.local/state/codex-web-bridge/runtime"); expect(remote.calls.some(call => call[0] === "stat" && call[1][1] === "%u")).toBe(true); });
  it("rejects unsafe tmux names before issuing commands", async () => { const remote = new FakeRemote(); await expect(new TmuxCodexRuntime(remote).start("bad;name", "/tmp", 4000)).rejects.toThrow("Invalid"); expect(remote.calls).toHaveLength(0); });
  it("discovers an existing managed tmux session without replacing it", async () => { const remote = new FakeRemote(); remote.sessionExists = true; const result = await new TmuxCodexRuntime(remote, { runtimeDirectory: "/safe/runtime" }).start("existing", "/tmp", 4000); expect(result).toMatchObject({ appServerPane: "%1", viewerPane: "%2" }); expect(remote.calls.some(call => call[1][0] === "new-session")).toBe(false); });
  it("waits for the forwarded app-server port", async () => { const remote = new FakeRemote(); remote.sessionExists = true; setTimeout(() => remote.probeReady = true, 5); await new TmuxCodexRuntime(remote).waitUntilReady({ name: "ready", appServerPane: "ready:0.0", remotePort: 4000, fifoPath: "/tmp/x" }, { timeoutMs: 100, intervalMs: 1 }); });
  it("renders a bounded PNG from a fresh ANSI snapshot", async () => { const result = await new TerminalSnapshotRenderer().render("\u001b[31mhello", { cols: 9999, rows: 1 }); expect(result.cols).toBe(240); expect(result.rows).toBe(5); expect(result.text).toContain("hello"); expect(result.png.subarray(1, 4).toString()).toBe("PNG"); });
  it("keeps one FIFO reader and captures a seed when reconnecting", async () => { const remote = new FakeRemote(); const runtime = new TmuxCodexRuntime(remote, { runtimeDirectory: "/safe/runtime" }); const session = { name: "cwb_1", appServerPane: "%1", viewerPane: "%2", remotePort: 4000, fifoPath: "/safe/runtime/cwb_1.ansi" }; await runtime.terminalStream(session); await runtime.reconnectTerminal(session); expect(remote.streams[0].closed).toBe(true); expect(remote.calls.some(call => call[1][0] === "capture-pane")).toBe(true); });
  it("kills the tmux session before removing its FIFO", async () => { const remote = new FakeRemote(); await new TmuxCodexRuntime(remote, { runtimeDirectory: "/safe/runtime" }).stop("cwb_1"); const kill = remote.calls.findIndex(call => call[0] === "tmux" && call[1][0] === "kill-session"); const remove = remote.calls.findIndex(call => call[0] === "rm"); expect(kill).toBeGreaterThanOrEqual(0); expect(remove).toBeGreaterThan(kill); });
});
