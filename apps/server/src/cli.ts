#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, paths, saveConfig } from "@cwb/config";
import { hashPassword } from "./auth.js";

type Command = "start" | "stop" | "restart" | "status" | "dashboard" | "help";
const args = process.argv.slice(2);
const command = (args[0] ?? "help") as Command;
function option(name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
function has(name: string): boolean { return args.includes(name); }
async function pid(): Promise<number | undefined> {
  try { const value=JSON.parse(await readFile(paths().pid,"utf8")) as {pid?:number;marker?:string}; return value.marker==="codex-web-bridge-daemon"?value.pid:undefined; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return; throw error; }
}
async function alive(value: number): Promise<boolean> { try { process.kill(value,0); if(process.platform==="linux"){const command=await readFile(`/proc/${value}/cmdline`,"utf8");return command.includes("daemon.js");} return true; } catch { return false; } }
async function configure(): Promise<void> {
  try { await loadConfig(); return; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const password = option("--password") ?? process.env.CWB_PASSWORD;
  const publicOrigin = option("--origin") ?? process.env.CWB_PUBLIC_ORIGIN;
  if (!password || !publicOrigin) throw new Error("first start requires --password and --origin (or CWB_PASSWORD and CWB_PUBLIC_ORIGIN)");
  await saveConfig({ version: 1, bindHost: "127.0.0.1", port: Number(option("--port") ?? 3210), publicOrigin, passwordHash: await hashPassword(password), sessionSecret: randomBytes(32).toString("base64url"), trustedProxy: "127.0.0.1" });
}
async function start(): Promise<void> {
  const old = await pid(); if (old && await alive(old)) throw new Error(`already running (PID ${old})`);
  if (old) await unlink(paths().pid).catch(() => undefined);
  await configure();
  if (has("--foreground")) { await import("./daemon.js"); return; }
  const log = await open(paths().log, "a", 0o600);
  const child = spawn(process.execPath, [fileURLToPath(new URL("./daemon.js", import.meta.url))], { detached: true, stdio: ["ignore", log.fd, log.fd], env: process.env });
  child.unref(); await log.close();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const current = await pid(); try { const ready=JSON.parse(await readFile(paths().ready,"utf8")) as {pid:number}; if(current&&ready.pid===current&&await alive(current)){console.log(`started (PID ${current})`);return;} } catch {} await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error(`daemon did not start; inspect ${paths().log}`);
}
async function stop(): Promise<void> {
  const current = await pid();
  if (!current || !await alive(current)) { if (current) await unlink(paths().pid).catch(() => undefined); console.log("not running"); return; }
  process.kill(current, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && await alive(current)) await new Promise((resolve) => setTimeout(resolve, 50));
  if (await alive(current)) throw new Error(`daemon PID ${current} did not stop`);
  console.log("stopped");
}
async function main() {
  if (command === "start") return start();
  if (command === "stop") return stop();
  if (command === "restart") { await stop(); return start(); }
  if (command === "status") { const current = await pid(), running=Boolean(current&&await alive(current)); console.log(running ? `running (PID ${current})` : "not running"); process.exitCode = running ? 0 : 3; return; }
  if (command === "dashboard") { const config = await loadConfig(); console.log(config.publicOrigin); return; }
  console.log("Usage: codex-web-bridge <start|stop|restart|status|dashboard> [--password VALUE --origin https://HOST --port PORT --foreground]");
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
