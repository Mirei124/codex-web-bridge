import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const cli = resolve(import.meta.dirname, "../dist/cli.js");
let dataDir: string | undefined;

function run(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [cli, ...args, "--json"], { env, encoding: "utf8", timeout: 10_000 });
}

function output(result: ReturnType<typeof run>) {
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    schemaVersion: number;
    ok: boolean;
    kind: string;
    data: Record<string, unknown>;
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("missing TCP address"));
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

async function waitForHttpReady(url: string, headers: Record<string, string>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { headers: { ...headers, connection: "close" } });
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not become ready: ${url}`);
}

afterEach(async () => {
  if (!dataDir) return;
  run(["stop"], { ...process.env, CWB_DATA_DIR: dataDir });
  await rm(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

describe("built CLI and daemon", () => {
  it("uses human-readable output by default and structured output only with --json", () => {
    const human = spawnSync(process.execPath, [cli, "help"], { env: process.env, encoding: "utf8" });
    expect(human.status).toBe(0);
    expect(human.stdout).toMatch(/^Usage:/);
    expect(human.stdout).not.toContain('"schemaVersion":1');

    const json = spawnSync(process.execPath, [cli, "help", "--json"], { env: process.env, encoding: "utf8" });
    expect(output(json)).toMatchObject({ schemaVersion: 1, ok: true, kind: "result" });

    const focused = spawnSync(process.execPath, [cli, "host", "add", "--help"], { env: process.env, encoding: "utf8" });
    expect(focused.status).toBe(0);
    expect(focused.stdout).toMatch(/^Usage: codex-web-bridge host add/);
    expect(focused.stdout).not.toContain("thread create");
  });

  it("starts, reports status, serves dashboard/API, prints the URL, and stops safely", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cwb-cli-test-"));
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const env = { ...process.env, CWB_DATA_DIR: dataDir };

    const started = run(["start", "--port", String(port)], env);
    const startedOutput = output(started);
    expect(startedOutput).toMatchObject({ schemaVersion: 1, ok: true, kind: "result", data: { state: "running" } });
    expect(startedOutput.data.generatedPassword).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const pidFile = JSON.parse(await readFile(join(dataDir, "daemon.pid"), "utf8")) as { pid: number; marker: string };
    expect(pidFile.marker).toBe("codex-web-bridge-daemon");
    expect(pidFile.pid).toBeGreaterThan(1);

    expect(output(run(["status"], env))).toMatchObject({ data: { state: "running", pid: pidFile.pid } });
    expect(output(run(["dashboard"], env))).toMatchObject({ data: { url: origin } });
    expect(output(run(["host", "list"], env))).toMatchObject({ data: [] });

    const headers = { origin };
    const dashboard = await fetch(`http://127.0.0.1:${port}/`, { headers });
    expect(dashboard.status).toBe(200);
    expect(await dashboard.text()).toContain('<div id="root"></div>');

    const anonymous = await fetch(`http://127.0.0.1:${port}/api/auth/session`, { headers });
    expect(anonymous.status).toBe(401);
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: "POST",
      headers: { ...headers, connection: "close", "content-type": "application/json" },
      body: JSON.stringify({ password: startedOutput.data.generatedPassword }),
    });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).not.toContain("Secure");

    const resetOutput = output(run(["password", "reset"], env));
    expect(resetOutput.data.generatedPassword).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(resetOutput.data.daemonRestarted).toBe(true);
    await waitForHttpReady(`http://127.0.0.1:${port}/api/auth/session`, headers);
    const resetLogin = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: "POST",
      headers: { ...headers, connection: "close", "content-type": "application/json" },
      body: JSON.stringify({ password: resetOutput.data.generatedPassword }),
    });
    expect(resetLogin.status).toBe(200);

    const beforeSetPid = (JSON.parse(await readFile(join(dataDir, "daemon.pid"), "utf8")) as { pid: number }).pid;
    const setOutput = output(run(["password", "set", "new-dashboard-password"], env));
    expect(setOutput.data).toEqual({ daemonRestarted: true });
    const afterSetPid = (JSON.parse(await readFile(join(dataDir, "daemon.pid"), "utf8")) as { pid: number }).pid;
    expect(afterSetPid).not.toBe(beforeSetPid);
    await waitForHttpReady(`http://127.0.0.1:${port}/api/auth/session`, headers);
    const setLogin = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: "POST",
      headers: { ...headers, connection: "close", "content-type": "application/json" },
      body: JSON.stringify({ password: "new-dashboard-password" }),
    });
    expect(setLogin.status).toBe(200);
    const staleLogin = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: "POST",
      headers: { ...headers, connection: "close", "content-type": "application/json" },
      body: JSON.stringify({ password: resetOutput.data.generatedPassword }),
    });
    expect(staleLogin.status).toBe(401);

    const rejectedPassword = run(["restart", "--password", "another-dashboard-password"], env);
    expect(rejectedPassword.status).toBe(2);
    expect(JSON.parse(rejectedPassword.stderr)).toMatchObject({ error: { code: "usage_error" } });
    expect(output(run(["status"], env))).toMatchObject({ data: { state: "running", pid: afterSetPid } });

    const restarted = run(["restart"], env);
    expect(output(restarted).data).not.toHaveProperty("generatedPassword");
    const restartedPid = (JSON.parse(await readFile(join(dataDir, "daemon.pid"), "utf8")) as { pid: number }).pid;

    const stopped = run(["stop"], env);
    expect(output(stopped)).toMatchObject({ data: { state: "stopped", pid: restartedPid } });
    const status = run(["status"], env);
    expect(status.status).toBe(3);
    expect(JSON.parse(status.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      kind: "result",
      data: { state: "not_running" },
    });

    const startedWithNewPassword = output(run(["start", "--reset-password"], env));
    expect(startedWithNewPassword.data.generatedPassword).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(output(run(["stop"], env))).toMatchObject({ data: { state: "stopped" } });
  }, 20_000);

  it("applies updated start options to an existing config", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cwb-cli-test-"));
    const initialPort = await freePort();
    const updatedPort = await freePort();
    const updatedOrigin = "https://192.0.2.10:8443";
    const env = { ...process.env, CWB_DATA_DIR: dataDir };

    const started = output(run(["start", "--port", String(initialPort)], env));
    const password = String(started.data.generatedPassword);
    expect(output(run(["stop"], env))).toMatchObject({ data: { state: "stopped" } });

    expect(output(run(["start", "--port", String(updatedPort), "--origin", updatedOrigin], env))).toMatchObject({
      data: { state: "running" },
    });
    expect(output(run(["dashboard"], env))).toMatchObject({ data: { url: updatedOrigin } });
    expect(JSON.parse(await readFile(join(dataDir, "config.json"), "utf8"))).toMatchObject({
      port: updatedPort,
      publicOrigin: updatedOrigin,
    });

    const accepted = await fetch(`http://127.0.0.1:${updatedPort}/api/auth/login`, {
      method: "POST",
      headers: {
        origin: updatedOrigin,
        "x-forwarded-proto": "https",
        connection: "close",
        "content-type": "application/json",
      },
      body: JSON.stringify({ password }),
    });
    expect(accepted.status).toBe(200);

    const rejected = await fetch(`http://127.0.0.1:${updatedPort}/api/auth/login`, {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "x-forwarded-proto": "https",
        connection: "close",
        "content-type": "application/json",
      },
      body: JSON.stringify({ password }),
    });
    expect(rejected.status).toBe(403);
  }, 20_000);

  it("updates the default loopback dashboard origin when only the port changes", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cwb-cli-test-"));
    const initialPort = await freePort();
    const updatedPort = await freePort();
    const env = { ...process.env, CWB_DATA_DIR: dataDir };

    output(run(["start", "--port", String(initialPort)], env));
    expect(output(run(["stop"], env))).toMatchObject({ data: { state: "stopped" } });

    expect(output(run(["start", "--port", String(updatedPort)], env))).toMatchObject({
      data: { state: "running" },
    });
    expect(output(run(["dashboard"], env))).toMatchObject({ data: { url: `http://127.0.0.1:${updatedPort}` } });
    expect(JSON.parse(await readFile(join(dataDir, "config.json"), "utf8"))).toMatchObject({
      port: updatedPort,
      publicOrigin: `http://127.0.0.1:${updatedPort}`,
    });
  }, 20_000);

  it("reports an unavailable daemon as structured JSON", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cwb-cli-test-"));
    const result = run(["host", "list"], { ...process.env, CWB_DATA_DIR: dataDir });
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stderr)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      error: { code: "daemon_unavailable", retryable: true },
    });
  });

  it("escalates stop to SIGKILL when a daemon ignores SIGTERM", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cwb-cli-test-"));
    const stubborn = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)", "__daemon"],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    stubborn.unref();
    await new Promise<void>((resolveSpawn, reject) => {
      stubborn.once("spawn", resolveSpawn);
      stubborn.once("error", reject);
    });
    await writeFile(
      join(dataDir, "daemon.pid"),
      JSON.stringify({ pid: stubborn.pid, marker: "codex-web-bridge-daemon" }),
    );

    const stopped = run(["stop"], { ...process.env, CWB_DATA_DIR: dataDir });

    expect(output(stopped)).toMatchObject({ data: { state: "stopped", pid: stubborn.pid } });
  }, 10_000);

  it("rejects a short first-run password without creating configuration", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cwb-cli-test-"));
    const env = { ...process.env, CWB_DATA_DIR: dataDir };
    const result = run(["start", "--password", "moon"], env);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: "usage_error", message: "dashboard password must contain at least 12 characters" },
    });
    await expect(readFile(join(dataDir, "config.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back a newly generated password config when daemon startup fails", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cwb-cli-test-"));
    const port = await freePort();
    const blocker = createServer();
    await new Promise<void>((resolveListen, reject) => {
      blocker.once("error", reject);
      blocker.listen(port, "127.0.0.1", resolveListen);
    });
    const env = { ...process.env, CWB_DATA_DIR: dataDir };
    try {
      const failed = run(["start", "--port", String(port)], env);
      expect(failed.status).toBe(3);
      expect(JSON.parse(failed.stderr)).toMatchObject({ ok: false, error: { code: "daemon_unavailable" } });
      await expect(readFile(join(dataDir, "config.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await new Promise<void>((resolveClose, reject) =>
        blocker.close((error) => (error ? reject(error) : resolveClose())),
      );
    }
  }, 15_000);

  it("rolls back a new config when opening the daemon log fails before spawn", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cwb-cli-test-"));
    await mkdir(join(dataDir, "daemon.log"));
    const env = { ...process.env, CWB_DATA_DIR: dataDir };

    const failed = run(["start"], env);

    expect(failed.status).toBe(10);
    expect(JSON.parse(failed.stderr)).toMatchObject({ ok: false, error: { code: "internal_error" } });
    await expect(readFile(join(dataDir, "config.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
