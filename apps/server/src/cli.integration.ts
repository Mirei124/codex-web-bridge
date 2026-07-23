import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const cli = resolve(import.meta.dirname, "../dist/cli.js");
let dataDir: string | undefined;

function run(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", timeout: 10_000 });
}

function output(result: ReturnType<typeof run>) {
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { schemaVersion: number; ok: boolean; kind: string; data: Record<string, unknown> };
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("missing TCP address"));
      server.close(error => error ? reject(error) : resolvePort(address.port));
    });
  });
}

afterEach(async () => {
  if (!dataDir) return;
  run(["stop"], { ...process.env, CWB_DATA_DIR: dataDir });
  await rm(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

describe("built CLI and daemon", () => {
  it("starts, reports status, serves dashboard/API, prints the URL, and stops safely", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cwb-cli-test-"));
    const port = await freePort();
    const origin = "https://bridge.test";
    const env = { ...process.env, CWB_DATA_DIR: dataDir };

    const started = run(["start", "--password", "test-password", "--origin", origin, "--port", String(port)], env);
    expect(output(started)).toMatchObject({ schemaVersion: 1, ok: true, kind: "result", data: { state: "running" } });

    const pidFile = JSON.parse(await readFile(join(dataDir, "daemon.pid"), "utf8")) as { pid: number; marker: string };
    expect(pidFile.marker).toBe("codex-web-bridge-daemon");
    expect(pidFile.pid).toBeGreaterThan(1);

    expect(output(run(["status"], env))).toMatchObject({ data: { state: "running", pid: pidFile.pid } });
    expect(output(run(["dashboard"], env))).toMatchObject({ data: { url: origin } });
    expect(output(run(["host", "list"], env))).toMatchObject({ data: [] });

    const headers = { "x-forwarded-proto": "https", origin };
    const dashboard = await fetch(`http://127.0.0.1:${port}/`, { headers });
    expect(dashboard.status).toBe(200);
    expect(await dashboard.text()).toContain('<div id="root"></div>');

    const anonymous = await fetch(`http://127.0.0.1:${port}/api/auth/session`, { headers });
    expect(anonymous.status).toBe(401);
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ password: "test-password" }),
    });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("Secure");

    const stopped = run(["stop"], env);
    expect(output(stopped)).toMatchObject({ data: { state: "stopped", pid: pidFile.pid } });
    const status = run(["status"], env);
    expect(status.status).toBe(3);
    expect(JSON.parse(status.stdout)).toMatchObject({ schemaVersion: 1, ok: true, kind: "result", data: { state: "not_running" } });
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
});
