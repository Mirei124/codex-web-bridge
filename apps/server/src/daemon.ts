#!/usr/bin/env node
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { loadConfig, paths } from "@cwb/config";
import { Storage } from "@cwb/storage";
import { buildServer } from "./server.js";

const config = await loadConfig();
const files = paths();
await mkdir(files.root, { recursive: true, mode: 0o700 });
try {
  const existing = (JSON.parse(await readFile(files.pid, "utf8")) as { pid?: number }).pid;
  if (existing && existing !== process.pid) { process.kill(existing, 0); throw new Error(`daemon is already running as PID ${existing}`); }
} catch (error) {
  if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
}
await writeFile(files.pid, JSON.stringify({ pid: process.pid, marker: "codex-web-bridge-daemon" }), { mode: 0o600 });
const storage = new Storage(files.database);
const app = await buildServer(config, storage);
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  await app.close(); storage.close();
  await unlink(files.pid).catch(() => undefined); await unlink(files.ready).catch(() => undefined);
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("uncaughtException", async (error) => { app.log.error(error); await shutdown(); });
process.on("unhandledRejection", async (error) => { app.log.error(error); await shutdown(); });
await app.listen({ host: config.bindHost, port: config.port });
await writeFile(files.ready, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
