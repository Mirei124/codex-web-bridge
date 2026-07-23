import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexClient } from "../src/index.js";

const enabled = process.env.CWB_CODEX_SMOKE === "1";
let child: ChildProcess | undefined;
let workingDirectory: string | undefined;
afterEach(async () => {
  child?.kill("SIGTERM"); child = undefined;
  if (workingDirectory) await rm(workingDirectory, { recursive: true, force: true });
});

describe.skipIf(!enabled)("installed Codex app-server", () => {
  it("initializes over loopback WebSocket and lists threads without starting a turn", async context => {
    const version = spawnSync("codex", ["--version"], { encoding: "utf8" });
    if (version.error && (version.error as NodeJS.ErrnoException).code === "ENOENT") { console.warn("SKIP: codex is not installed or not in PATH"); return context.skip(); }
    expect(version.status, version.stderr).toBe(0);

    let port: number;
    try { port = await reserveLoopbackPort(); }
    catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { console.warn("SKIP: sandbox does not permit loopback bind"); return context.skip(); }
      throw error;
    }
    workingDirectory = await mkdtemp(join(tmpdir(), "cwb-codex-smoke-"));
    let stderr = "";
    child = spawn("codex", ["app-server", "--listen", `ws://127.0.0.1:${port}`], { cwd: workingDirectory, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", chunk => stderr = (stderr + String(chunk)).slice(-8_000));
    try { await waitForPort(port, child, 15_000); }
    catch (error) {
      if (/operation not permitted|permission denied/i.test(stderr)) { console.warn(`SKIP: sandbox rejected app-server bind: ${stderr.trim()}`); return context.skip(); }
      throw new Error(`${(error as Error).message}${stderr ? `\n${stderr}` : ""}`);
    }

    const client = new CodexClient({ url: `ws://127.0.0.1:${port}`, clientInfo: { name: "cwb-smoke", version: "0.1.0" } });
    try {
      await client.connect();
      const result = await client.listThreads({ limit: 1, useStateDbOnly: true } as never);
      expect(Array.isArray(result.data)).toBe(true);
    } finally { client.close(); }
    console.info(`Verified ${version.stdout.trim()}: initialize, initialized, thread/list`);
  }, 25_000);
});

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("failed to reserve loopback port");
  const port = address.port; await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); return port;
}
async function waitForPort(port: number, process: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`codex app-server exited with code ${process.exitCode}`);
    if (await canConnect(port)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for codex app-server");
}
function canConnect(port: number): Promise<boolean> { return new Promise(resolve => { const socket = connect({ host: "127.0.0.1", port }); socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => resolve(false)); }); }
