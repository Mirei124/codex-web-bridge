#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadConfig, paths, saveConfig } from "@cwb/config";
import { hashPassword } from "./auth.js";
import { helpText, parseBusinessCommand, UsageError, type ParsedCommand } from "./cli-command.js";
import { controlRequest, ControlRequestError, type ControlError } from "./control-client.js";

type DaemonCommand = "start" | "stop" | "restart" | "status" | "dashboard" | "help";
const rawArgs = process.argv.slice(2);

function success(data: unknown, human = false, kind: "event" | "result" = "result"): void {
  if (human) {
    console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));
    return;
  }
  console.log(JSON.stringify({ schemaVersion: 1, ok: true, kind, data }));
}

function failure(error: ControlError, human = false): void {
  if (human) console.error(error.message);
  else console.error(JSON.stringify({ schemaVersion: 1, ok: false, error }));
}

function exitCode(code: string): number {
  const normalized = code.toLowerCase();
  if (["usage_error", "invalid_input", "invalid_argument", "invalid_request"].includes(normalized)) return 2;
  if (normalized === "daemon_unavailable" || normalized === "not_running") return 3;
  if (normalized === "not_found" || normalized.endsWith("_not_found")) return 4;
  if (normalized === "conflict" || normalized === "invalid_state" || normalized.endsWith("already_resolved")) return 5;
  if (["forbidden", "unauthorized", "security_error"].includes(normalized)) return 6;
  if (["remote_error", "ssh_error", "codex_error", "runtime_failure"].includes(normalized)) return 7;
  if (normalized === "timeout") return 8;
  if (normalized === "protocol_error" || normalized === "incompatible_version") return 9;
  return 10;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function pid(): Promise<number | undefined> {
  try {
    const value = JSON.parse(await readFile(paths().pid, "utf8")) as { pid?: number; marker?: string };
    return value.marker === "codex-web-bridge-daemon" ? value.pid : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return;
    throw error;
  }
}

async function alive(value: number): Promise<boolean> {
  try {
    process.kill(value, 0);
    if (process.platform === "linux") {
      const command = await readFile(`/proc/${value}/cmdline`, "utf8");
      return command.includes("daemon.js");
    }
    return true;
  } catch {
    return false;
  }
}

function processExists(value: number): boolean {
  try { process.kill(value, 0); return true; } catch { return false; }
}

async function clearStaleControlLock(): Promise<void> {
  const lockPath = `${paths().controlSocket}.lock`;
  let owner: number;
  try {
    owner = Number(await readFile(lockPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (Number.isSafeInteger(owner) && owner > 1 && processExists(owner)) {
    throw new ControlRequestError({ code: "conflict", message: `daemon startup is already in progress (PID ${owner})` });
  }
  await unlink(lockPath);
}

async function configure(args: string[]): Promise<void> {
  try {
    await loadConfig();
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const password = option(args, "--password") ?? process.env.CWB_PASSWORD;
  const publicOrigin = option(args, "--origin") ?? process.env.CWB_PUBLIC_ORIGIN;
  if (!password || !publicOrigin) throw new UsageError("first start requires --password and --origin (or CWB_PASSWORD and CWB_PUBLIC_ORIGIN)");
  const portText = option(args, "--port") ?? "3210";
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new UsageError("--port must be an integer from 1 to 65535");
  await saveConfig({
    version: 1,
    bindHost: "127.0.0.1",
    port: Number(portText),
    publicOrigin,
    passwordHash: await hashPassword(password),
    sessionSecret: randomBytes(32).toString("base64url"),
    trustedProxy: "127.0.0.1",
  });
}

function validateDaemonOptions(command: DaemonCommand, args: string[]): { human: boolean; foreground: boolean } {
  const allowed = command === "start" || command === "restart"
    ? new Set(["--human", "--foreground", "--password", "--origin", "--port"])
    : new Set(["--human"]);
  let human = false;
  let foreground = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (!value.startsWith("--") || !allowed.has(value)) throw new UsageError(`unknown option or argument: ${value}`);
    if (seen.has(value)) throw new UsageError(`${value} was provided more than once`);
    seen.add(value);
    if (value === "--human") { human = true; continue; }
    if (value === "--foreground") { foreground = true; continue; }
    if (args[index + 1] === undefined || args[index + 1]!.startsWith("--")) throw new UsageError(`option ${value} requires a value`);
    index++;
  }
  return { human, foreground };
}

async function start(args: string[], human: boolean, foreground: boolean): Promise<void> {
  const old = await pid();
  if (old && await alive(old)) throw new ControlRequestError({ code: "conflict", message: `already running (PID ${old})` });
  if (old) await unlink(paths().pid).catch(() => undefined);
  await clearStaleControlLock();
  await configure(args);
  if (foreground) {
    await import("./daemon.js");
    return;
  }
  const log = await open(paths().log, "a", 0o600);
  const child = spawn(process.execPath, [fileURLToPath(new URL("./daemon.js", import.meta.url))], {
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    env: process.env,
  });
  child.unref();
  await log.close();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const current = await pid();
    try {
      const ready = JSON.parse(await readFile(paths().ready, "utf8")) as { pid: number };
      if (current && ready.pid === current && await alive(current)) {
        success({ state: "running", pid: current }, human);
        return;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new ControlRequestError({ code: "daemon_unavailable", message: `daemon did not start; inspect ${paths().log}` });
}

async function stop(human: boolean, emit = true): Promise<{ state: "not_running" | "stopped"; pid?: number }> {
  const current = await pid();
  if (!current || !await alive(current)) {
    if (current) await unlink(paths().pid).catch(() => undefined);
    const result = { state: "not_running" as const };
    if (emit) success(result, human);
    return result;
  }
  process.kill(current, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && await alive(current)) await new Promise(resolve => setTimeout(resolve, 50));
  if (await alive(current)) throw new ControlRequestError({ code: "timeout", message: `daemon PID ${current} did not stop` });
  const result = { state: "stopped" as const, pid: current };
  if (emit) success(result, human);
  return result;
}

async function readInputFile(path: string): Promise<string> {
  if (path !== "-") return readFile(path, "utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function hydrate(command: ParsedCommand): Promise<void> {
  const params = command.params;
  const inputJson = params.inputJson;
  const inputFile = params.inputFile;
  if (typeof inputJson === "string" || typeof inputFile === "string") {
    const text = typeof inputJson === "string" ? inputJson : await readInputFile(inputFile as string);
    let input: unknown;
    try { input = JSON.parse(text); } catch { throw new UsageError("structured input is not valid JSON"); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new UsageError("structured input must be a JSON object");
    delete params.inputJson;
    delete params.inputFile;
    if (command.method === "request.resolve") params.response = input;
    else if (command.method === "request.answer") params.answers = "answers" in input ? (input as Record<string, unknown>).answers : input;
    else Object.assign(params, input);
  }
  for (const [fileKey, valueKey] of [["textFile", "text"], ["dataFile", "data"]] as const) {
    const file = params[fileKey];
    if (typeof file === "string") {
      params[valueKey] = await readInputFile(file);
      delete params[fileKey];
    }
  }
  for (const key of Object.keys(params)) if (params[key] === undefined) delete params[key];
}

async function runBusiness(args: string[]): Promise<void> {
  const command = parseBusinessCommand(args);
  await hydrate(command);
  const socketPath = paths().controlSocket;
  const renderEvent = (event: unknown) => success(event, command.human, "event");
  const result = await controlRequest(socketPath, command.method, command.params, {
    stream: command.stream,
    timeoutMs: command.timeoutMs ?? (command.method === "thread.wait" ? 600_000 : command.stream ? 86_400_000 : undefined),
    onEvent: renderEvent,
  });
  if (command.output) {
    const encoded = typeof result === "string"
      ? result
      : (result as { data?: string; pngBase64?: string } | undefined)?.data
        ?? (result as { pngBase64?: string } | undefined)?.pngBase64;
    if (typeof encoded !== "string") throw new ControlRequestError({ code: "protocol_error", message: "screenshot response did not contain base64 image data" });
    await writeFile(command.output, Buffer.from(encoded, "base64"), { mode: 0o600 });
    success({ path: command.output }, command.human);
  } else if (!command.stream || result !== undefined) {
    success(result ?? { completed: true }, command.human);
  }
}

async function main(): Promise<void> {
  let args = [...rawArgs];
  if (args[0] === "daemon") {
    const nested = args[1];
    if (nested === "url") args = ["dashboard", ...args.slice(2)];
    else args = [nested ?? "help", ...args.slice(2)];
  }
  const command = (args[0] ?? "help") as DaemonCommand;
  if (["start", "stop", "restart", "status", "dashboard", "help"].includes(command)) {
    const commandArgs = args.slice(1);
    const { human, foreground } = validateDaemonOptions(command, commandArgs);
    if (command === "help") { success({ usage: helpText() }, human); return; }
    if (command === "start") { await start(commandArgs, human, foreground); return; }
    if (command === "stop") { await stop(human); return; }
    if (command === "restart") { await stop(human, false); await start(commandArgs, human, foreground); return; }
    if (command === "status") {
      const current = await pid();
      const running = Boolean(current && await alive(current));
      success({ state: running ? "running" : "not_running", ...(running ? { pid: current } : {}) }, human);
      process.exitCode = running ? 0 : 3;
      return;
    }
    const config = await loadConfig();
    success({ url: config.publicOrigin }, human);
    return;
  }
  await runBusiness(args);
}

main().catch(error => {
  const human = rawArgs.includes("--human");
  const detail: ControlError = error instanceof ControlRequestError
    ? error.controlError
    : error instanceof UsageError
      ? { code: "usage_error", message: error.message }
      : { code: "internal_error", message: error instanceof Error ? error.message : String(error) };
  failure(detail, human);
  process.exitCode = exitCode(detail.code);
});
