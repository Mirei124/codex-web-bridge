import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostRecord, ThreadRecord } from "@cwb/storage";
import type { CodexClient } from "@cwb/codex-client";
import type { CommandStream, SshConnection, TmuxCodexRuntime } from "@cwb/remote-runtime";
import { HostRuntimeManager, opensshSha256ToHex } from "./runtime-manager.js";

describe("OpenSSH host fingerprints", () => {
  it("converts canonical SHA256 base64 to ssh2 hostHash hex", () => {
    const bytes = Buffer.alloc(32, 0xab);
    expect(opensshSha256ToHex(`SHA256:${bytes.toString("base64").replace(/=+$/, "")}`)).toBe(bytes.toString("hex"));
  });
  it("rejects non-canonical or wrong-length fingerprints", () => {
    expect(() => opensshSha256ToHex("abcdef")).toThrow(/OpenSSH/);
    expect(() => opensshSha256ToHex("SHA256:YQ")).toThrow(/length/);
  });
});

class FakeStream extends EventEmitter {
  closed = false;
  close() {
    this.closed = true;
    this.emit("close");
  }
}
class FakeSsh {
  closed = false;
  forwardClosed = false;
  async connect() {}
  close() {
    this.closed = true;
  }
  async forwardRemotePort() {
    return {
      port: 12345,
      close: async () => {
        this.forwardClosed = true;
      },
    };
  }
}
class FakeRuntime {
  stopped = false;
  failStop = false;
  stream = new FakeStream();
  calls: string[] = [];
  async checkPrerequisites() {}
  async exists() {
    return false;
  }
  async start(name: string, _cwd: string, remotePort: number) {
    return { name, appServerPane: "%1", remotePort, fifoPath: "/fifo", appServerLogPath: "/log" };
  }
  async waitUntilReady() {}
  async attachViewer(session: any, _cwd: string, threadId: string) {
    this.calls.push("attachViewer");
    return { ...session, viewerPane: "%2", threadId };
  }
  async terminalStream() {
    this.calls.push("terminalStream");
    return this.stream as unknown as CommandStream;
  }
  async stop() {
    this.stopped = true;
    if (this.failStop) throw new Error("tmux stop failed");
  }
  async capture() {
    this.calls.push("capture");
    return "";
  }
  async dimensions() {
    this.calls.push("dimensions");
    return { cols: 80, rows: 24 };
  }
  async sendKeys() {
    this.calls.push("sendKeys");
  }
}
class FakeClient extends EventEmitter {
  closed = false;
  connectStarted = false;
  failCreate = false;
  failConnect = false;
  connectGate?: Promise<void>;
  threads: any[] = [];
  calls: string[] = [];
  async connect() {
    this.connectStarted = true;
    await this.connectGate;
    if (this.failConnect) throw new Error("connect failed");
  }
  async createThread() {
    if (this.failCreate) throw new Error("thread/start failed");
    return { id: "codex-1" };
  }
  async resumeThread() {
    return { id: "codex-1" };
  }
  close() {
    this.closed = true;
  }
  async startTurn() {
    this.calls.push("startTurn");
    return { turn: { id: "turn-1" } };
  }
  async interruptTurn() {}
  respond() {}
  async listThreads() {
    return { data: this.threads };
  }
}
let directory: string | undefined;
afterEach(async () => {
  vi.useRealTimers();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});
async function fixture() {
  directory = await mkdtemp(join(tmpdir(), "cwb-runtime-test-"));
  const identityFile = join(directory, "key");
  await writeFile(identityFile, "key");
  const host: HostRecord = {
    id: "host",
    name: "A",
    hostname: "a",
    port: 22,
    username: "u",
    hostKeySha256: `SHA256:${Buffer.alloc(32, 1).toString("base64").replace(/=+$/, "")}`,
    identityFile,
    createdAt: 1,
  };
  const thread: ThreadRecord = {
    id: "thread",
    hostId: host.id,
    tmuxSession: "cwb-thread",
    remotePort: 45678,
    workingDirectory: "/work",
    title: "t",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  };
  return { host, thread };
}

describe("runtime lifecycle reliability", () => {
  it("keeps an SSH password in manager memory and passes it to ssh2 without requiring an identity file", async () => {
    const { host, thread } = await fixture();
    host.identityFile = "";
    let captured: Record<string, unknown> | undefined;
    const ssh = new FakeSsh(),
      runtime = new FakeRuntime(),
      manager = new HostRuntimeManager({
        sshFactory: (config) => {
          captured = config as unknown as Record<string, unknown>;
          return ssh as unknown as SshConnection;
        },
        runtimeFactory: () => runtime as unknown as TmuxCodexRuntime,
      });
    manager.setHostPassword(host.id, "memory-only");
    await manager.exit(thread, host);
    expect(captured).toMatchObject({ host: "a", username: "u", password: "memory-only" });
    expect(captured).not.toHaveProperty("privateKey");
  });
  it("keeps a fresh empty Codex thread headless until its first accepted turn", async () => {
    const { host, thread } = await fixture(),
      ssh = new FakeSsh(),
      runtime = new FakeRuntime(),
      client = new FakeClient(),
      manager = new HostRuntimeManager({
        sshFactory: () => ssh as unknown as SshConnection,
        runtimeFactory: () => runtime as unknown as TmuxCodexRuntime,
        clientFactory: () => client as unknown as CodexClient,
      });
    const codexId = await manager.create(host, thread);
    expect(codexId).toBe("codex-1");
    expect(runtime.calls).toEqual([]);
    await manager.send({ ...thread, codexThreadId: codexId }, "hello");
    expect(client.calls).toEqual(["startTurn"]);
    expect(runtime.calls).toEqual(["attachViewer", "terminalStream"]);
    await manager.close();
  });
  it("does not resume a fresh thread in the terminal before its first rollout exists", async () => {
    const { host, thread } = await fixture(),
      ssh = new FakeSsh(),
      runtime = new FakeRuntime(),
      client = new FakeClient(),
      manager = new HostRuntimeManager({
        sshFactory: () => ssh as unknown as SshConnection,
        runtimeFactory: () => runtime as unknown as TmuxCodexRuntime,
        clientFactory: () => client as unknown as CodexClient,
      });
    const codexThreadId = await manager.create(host, thread),
      activeThread = { ...thread, codexThreadId };
    await expect(manager.screenshot(activeThread)).resolves.toBeUndefined();
    await expect(manager.terminalSeed(activeThread)).resolves.toBe("");
    await expect(manager.prepareTerminal(activeThread)).rejects.toThrow("first message");
    expect(runtime.calls).toEqual([]);
    await manager.close();
  });
  it("cleans every opened resource and a newly-created tmux when thread/start fails", async () => {
    const { host, thread } = await fixture(),
      ssh = new FakeSsh(),
      runtime = new FakeRuntime(),
      client = new FakeClient();
    client.failCreate = true;
    const manager = new HostRuntimeManager({
      sshFactory: () => ssh as unknown as SshConnection,
      runtimeFactory: () => runtime as unknown as TmuxCodexRuntime,
      clientFactory: () => client as unknown as CodexClient,
    });
    await expect(manager.create(host, thread)).rejects.toThrow("thread/start failed");
    expect(client.closed).toBe(true);
    expect(ssh.forwardClosed).toBe(true);
    expect(ssh.closed).toBe(true);
    expect(runtime.stopped).toBe(true);
  });
  it("uses temporary pinned SSH to stop an inactive tmux", async () => {
    const { host, thread } = await fixture(),
      ssh = new FakeSsh(),
      runtime = new FakeRuntime(),
      manager = new HostRuntimeManager({
        sshFactory: () => ssh as unknown as SshConnection,
        runtimeFactory: () => runtime as unknown as TmuxCodexRuntime,
      });
    await manager.exit(thread, host);
    expect(runtime.stopped).toBe(true);
    expect(ssh.closed).toBe(true);
  });
  it("detaches a managed thread without waiting for cleanup or stopping its remote tmux", async () => {
    const { host, thread } = await fixture(),
      ssh = new FakeSsh(),
      runtime = new FakeRuntime(),
      client = new FakeClient(),
      manager = new HostRuntimeManager({
        sshFactory: () => ssh as unknown as SshConnection,
        runtimeFactory: () => runtime as unknown as TmuxCodexRuntime,
        clientFactory: () => client as unknown as CodexClient,
      });
    let release!: () => void;
    ssh.forwardRemotePort = async () => ({
      port: 12345,
      close: () =>
        new Promise<void>((resolve) => {
          release = () => {
            ssh.forwardClosed = true;
            resolve();
          };
        }),
    });
    await manager.create(host, thread);
    await manager.detach(thread.id);
    expect(client.closed).toBe(true);
    expect(ssh.closed).toBe(false);
    expect(runtime.stopped).toBe(false);
    release();
    await vi.waitFor(() => expect(ssh.closed).toBe(true));
  });
  it("prevents an in-flight reconnect from activating after detach", async () => {
    const { host, thread } = await fixture();
    thread.codexThreadId = "codex-1";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ssh = new FakeSsh(),
      runtime = new FakeRuntime(),
      client = new FakeClient();
    client.connectGate = gate;
    const manager = new HostRuntimeManager({
      sshFactory: () => ssh as unknown as SshConnection,
      runtimeFactory: () => runtime as unknown as TmuxCodexRuntime,
      clientFactory: () => client as unknown as CodexClient,
    });
    const reconnect = manager.reconnect(host, thread);
    await vi.waitFor(() => expect(client.connectStarted).toBe(true));
    await manager.detach(thread.id);
    release();
    await reconnect;
    expect(client.closed).toBe(true);
    expect(ssh.closed).toBe(true);
    expect(runtime.stopped).toBe(false);
    await expect(manager.send(thread, "hello")).rejects.toThrow("not connected");
  });
  it("propagates an active tmux stop failure while still closing every resource", async () => {
    const { host, thread } = await fixture(),
      ssh = new FakeSsh(),
      runtime = new FakeRuntime(),
      client = new FakeClient(),
      manager = new HostRuntimeManager({
        sshFactory: () => ssh as unknown as SshConnection,
        runtimeFactory: () => runtime as unknown as TmuxCodexRuntime,
        clientFactory: () => client as unknown as CodexClient,
      });
    await manager.create(host, thread);
    runtime.failStop = true;
    await expect(manager.exit(thread, host)).rejects.toThrow("tmux stop failed");
    expect(runtime.stopped).toBe(true);
    expect(client.closed).toBe(true);
    expect(ssh.forwardClosed).toBe(true);
    expect(ssh.closed).toBe(true);
  });
  it("lists history through a temporary app-server and always removes its tmux", async () => {
    const { host } = await fixture(),
      ssh = new FakeSsh(),
      runtime = new FakeRuntime(),
      client = new FakeClient();
    client.threads = [{ id: "history-1", name: "Old thread", cwd: "/work" }];
    const manager = new HostRuntimeManager({
      sshFactory: () => ssh as unknown as SshConnection,
      runtimeFactory: () => runtime as unknown as TmuxCodexRuntime,
      clientFactory: () => client as unknown as CodexClient,
    });
    await expect(manager.listHistorical(host)).resolves.toEqual([
      { id: "history-1", title: "Old thread", cwd: "/work", updatedAt: undefined },
    ]);
    expect(runtime.stopped).toBe(true);
    expect(client.closed).toBe(true);
    expect(ssh.forwardClosed).toBe(true);
    expect(ssh.closed).toBe(true);
  });
  it("reconnects with the persisted port after an unexpected terminal close", async () => {
    const { host, thread } = await fixture(),
      sshs: FakeSsh[] = [],
      runtimes: FakeRuntime[] = [],
      clients: FakeClient[] = [];
    const manager = new HostRuntimeManager({
      retryBaseMs: 1,
      retryMaxMs: 1,
      sshFactory: () => {
        const value = new FakeSsh();
        sshs.push(value);
        return value as unknown as SshConnection;
      },
      runtimeFactory: () => {
        const value = new FakeRuntime();
        runtimes.push(value);
        return value as unknown as TmuxCodexRuntime;
      },
      clientFactory: () => {
        const value = new FakeClient();
        clients.push(value);
        return value as unknown as CodexClient;
      },
    });
    const codexId = await manager.create(host, thread);
    await manager.send({ ...thread, codexThreadId: codexId }, "hello");
    runtimes[0]!.stream.emit("close");
    await vi.waitFor(() => expect(runtimes.length).toBeGreaterThan(1), { timeout: 500 });
    expect(clients.length).toBeGreaterThan(1);
    expect(sshs[0]!.closed).toBe(true);
    await manager.close();
  });
  it("reconnects when the Codex WebSocket closes cleanly", async () => {
    const { host, thread } = await fixture(),
      clients: FakeClient[] = [];
    const manager = new HostRuntimeManager({
      retryBaseMs: 1,
      retryMaxMs: 1,
      sshFactory: () => new FakeSsh() as unknown as SshConnection,
      runtimeFactory: () => new FakeRuntime() as unknown as TmuxCodexRuntime,
      clientFactory: () => {
        const value = new FakeClient();
        clients.push(value);
        return value as unknown as CodexClient;
      },
    });
    await manager.create(host, thread);
    clients[0]!.emit("transportClose", { code: 1006 });
    await vi.waitFor(() => expect(clients.length).toBeGreaterThan(1), { timeout: 500 });
    await manager.close();
  });
  it("caps failed reconnect attempts and emits a terminal failure signal", async () => {
    const { host, thread } = await fixture();
    thread.codexThreadId = "codex-1";
    let clients = 0,
      failed: any;
    const manager = new HostRuntimeManager({
      retryBaseMs: 1,
      retryMaxMs: 1,
      retryLimit: 2,
      sshFactory: () => new FakeSsh() as unknown as SshConnection,
      runtimeFactory: () => new FakeRuntime() as unknown as TmuxCodexRuntime,
      clientFactory: () => {
        clients++;
        const value = new FakeClient();
        value.failConnect = true;
        return value as unknown as CodexClient;
      },
    });
    manager.events.on("reconnectFailed", (value) => (failed = value));
    await manager.reconnect(host, thread);
    await vi.waitFor(() => expect(failed).toBeTruthy(), { timeout: 500 });
    expect(clients).toBe(3);
    expect(failed).toMatchObject({ threadId: "thread", attempts: 2 });
    await manager.close();
  });
});
