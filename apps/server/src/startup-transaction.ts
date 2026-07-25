import type { ChildProcess } from "node:child_process";
import { unlink } from "node:fs/promises";
import { loadConfig, paths, type AppConfig } from "@cwb/config";

export async function rollbackCreatedConfig(createdConfig: AppConfig | undefined): Promise<void> {
  if (!createdConfig) return;
  try {
    const current = await loadConfig();
    if (JSON.stringify(current) === JSON.stringify(createdConfig)) await unlink(paths().config);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function terminateSpawnedDaemon(child: ChildProcess, graceMs = 1_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, graceMs)) return;
  child.kill("SIGKILL");
  if (!(await waitForExit(child, graceMs))) throw new Error("spawned daemon did not exit after SIGKILL");
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", exited);
      resolve(false);
    }, timeoutMs);
    const exited = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", exited);
  });
}
