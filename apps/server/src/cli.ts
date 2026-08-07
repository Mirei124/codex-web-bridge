#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { loadConfig, parseConfig, paths, saveConfig, type AppConfig } from "@cwb/config";
import { hashPassword } from "./auth.js";
import { helpText, parseBusinessCommand, UsageError, type ParsedCommand } from "./cli-command.js";
import { controlRequest, ControlRequestError, type ControlError } from "./control-client.js";
import { humanEventMode, renderHuman, renderHumanError } from "./cli-renderer.js";
import { rollbackCreatedConfig, terminateSpawnedDaemon } from "./startup-transaction.js";

type DaemonCommand = "start" | "stop" | "restart" | "status" | "dashboard" | "help";
const rawArgs = process.argv.slice(2);

function isStandalone(): boolean {
  return Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);
}

function success(
  data: unknown,
  json = false,
  kind: "event" | "result" = "result",
  method?: string,
  params?: Record<string, unknown>,
): void {
  if (json) console.log(JSON.stringify({ schemaVersion: 1, ok: true, kind, data }));
  else {
    const rendered = renderHuman(data, { kind, method, params });
    const mode = kind === "event" ? humanEventMode(data, method) : "line";
    if (mode === "raw") process.stdout.write(rendered);
    else if (mode === "stderr") console.error(rendered);
    else if (mode === "line") console.log(rendered);
  }
}

function failure(error: ControlError, json = false): void {
  if (json) console.error(JSON.stringify({ schemaVersion: 1, ok: false, error }));
  else console.error(renderHumanError(error));
}

function exitCode(code: string): number {
  const normalized = code.toLowerCase();
  if (["usage_error", "invalid_input", "invalid_argument", "invalid_request"].includes(normalized)) return 2;
  if (normalized === "daemon_unavailable" || normalized === "not_running") return 3;
  if (normalized === "not_found" || normalized.endsWith("_not_found")) return 4;
  if (normalized === "conflict" || normalized === "invalid_state" || normalized.endsWith("already_resolved")) return 5;
  if (
    [
      "forbidden",
      "unauthorized",
      "security_error",
      "host_key_unknown",
      "host_key_changed",
      "host_key_rejected",
    ].includes(normalized)
  )
    return 6;
  if (["remote_error", "ssh_error", "codex_error", "runtime_failure", "ssh_host_key_scan_failed"].includes(normalized))
    return 7;
  if (normalized === "timeout") return 8;
  if (normalized === "protocol_error" || normalized === "incompatible_version") return 9;
  return 10;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function validateDashboardPassword(password: string): string {
  if (password.length < 12) throw new UsageError("dashboard password must contain at least 12 characters");
  return password;
}

async function validateExplicitStartPassword(args: string[]): Promise<void> {
  const password = option(args, "--password");
  if (password === undefined) return;
  validateDashboardPassword(password);
  try {
    await loadConfig();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new UsageError("configuration already exists; use 'codex-web-bridge password set NEW_PASSWORD'");
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
      return command.includes("daemon.js") || command.includes("__daemon");
    }
    return true;
  } catch {
    return false;
  }
}

function processExists(value: number): boolean {
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
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
    throw new ControlRequestError({
      code: "conflict",
      message: `daemon startup is already in progress (PID ${owner})`,
    });
  }
  await unlink(lockPath);
}

function parsePortOption(value: string | undefined, fallback: number): number {
  const portText = value ?? String(fallback);
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535)
    throw new UsageError("--port must be an integer from 1 to 65535");
  return Number(portText);
}

function updateDefaultLoopbackOrigin(origin: string, oldPort: number, newPort: number): string {
  if (oldPort === newPort) return origin;
  if (origin === `http://127.0.0.1:${oldPort}`) return `http://127.0.0.1:${newPort}`;
  if (origin === `http://localhost:${oldPort}`) return `http://localhost:${newPort}`;
  return origin;
}

async function configure(args: string[]): Promise<{
  generatedPassword?: string;
  createdConfig?: AppConfig;
  replacedConfig?: { previous: AppConfig; current: AppConfig };
}> {
  try {
    const config = await loadConfig();
    if (option(args, "--password") !== undefined)
      throw new UsageError("configuration already exists; use 'codex-web-bridge password set NEW_PASSWORD'");
    const port = parsePortOption(option(args, "--port"), config.port);
    const publicOrigin =
      option(args, "--origin") ?? updateDefaultLoopbackOrigin(config.publicOrigin, config.port, port);
    const generatedPassword = args.includes("--reset-password") ? randomBytes(24).toString("base64url") : undefined;
    const next = parseConfig({
      ...config,
      port,
      publicOrigin,
      ...(args.includes("--accept-risk") ? { bindHost: "0.0.0.0" } : {}),
      ...(generatedPassword ? { passwordHash: await hashPassword(generatedPassword) } : {}),
    });
    if (JSON.stringify(next) === JSON.stringify(config)) return {};
    await saveConfig(next);
    return generatedPassword
      ? { generatedPassword, replacedConfig: { previous: config, current: next } }
      : { replacedConfig: { previous: config, current: next } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const port = parsePortOption(option(args, "--port"), 3210);
  const suppliedPassword = option(args, "--password") ?? process.env.CWB_PASSWORD;
  const generatedPassword = suppliedPassword ? undefined : randomBytes(24).toString("base64url");
  const password = validateDashboardPassword(suppliedPassword ?? generatedPassword!);
  const publicOrigin = option(args, "--origin") ?? process.env.CWB_PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`;
  const acceptRisk = args.includes("--accept-risk");
  const createdConfig = parseConfig({
    version: 1,
    bindHost: acceptRisk ? "0.0.0.0" : "127.0.0.1",
    port,
    publicOrigin,
    passwordHash: await hashPassword(password),
    sessionSecret: randomBytes(32).toString("base64url"),
    trustedProxy: "127.0.0.1",
  });
  await saveConfig(createdConfig);
  return { generatedPassword, createdConfig };
}

function validateDaemonOptions(command: DaemonCommand, args: string[]): { json: boolean; foreground: boolean } {
  const allowed =
    command === "start" || command === "restart"
      ? new Set(["--json", "--foreground", "--accept-risk", "--reset-password", "--password", "--origin", "--port"])
      : new Set(["--json"]);
  let json = false;
  let foreground = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (!value.startsWith("--") || !allowed.has(value)) throw new UsageError(`unknown option or argument: ${value}`);
    if (seen.has(value)) throw new UsageError(`${value} was provided more than once`);
    seen.add(value);
    if (value === "--json") {
      json = true;
      continue;
    }
    if (value === "--foreground") {
      foreground = true;
      continue;
    }
    if (value === "--accept-risk") continue;
    if (value === "--reset-password") continue;
    if (args[index + 1] === undefined || args[index + 1]!.startsWith("--"))
      throw new UsageError(`option ${value} requires a value`);
    index++;
  }
  return { json, foreground };
}

async function start(args: string[], json: boolean, foreground: boolean, emit = true): Promise<void> {
  const old = await pid();
  if (old && (await alive(old)))
    throw new ControlRequestError({ code: "conflict", message: `already running (PID ${old})` });
  if (old) await unlink(paths().pid).catch(() => undefined);
  await clearStaleControlLock();
  const configured = await configure(args);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const config = await loadConfig();
    if (config.bindHost === "0.0.0.0") {
      const message =
        "listening on 0.0.0.0 over HTTP can expose the dashboard password and conversation data. Use a trusted network or an HTTPS reverse proxy.";
      if (json) console.error(JSON.stringify({ schemaVersion: 1, ok: true, kind: "warning", data: { message } }));
      else console.error(`WARNING: ${message}`);
    }
    if (foreground) {
      if (emit && configured.generatedPassword)
        success({ state: "starting", generatedPassword: configured.generatedPassword }, json, "result", "start");
      await import("./daemon.js");
      return;
    }
    const log = await open(paths().log, "a", 0o600);
    try {
      const packaged = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);
      const daemonArgs = isStandalone() ? ["__daemon"] : [fileURLToPath(new URL("./daemon.js", import.meta.url))];
      const daemonEnv = packaged ? { ...process.env, PKG_EXECPATH: "" } : process.env;
      child = spawn(process.execPath, daemonArgs, {
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
        env: daemonEnv,
      });
      child.unref();
    } finally {
      await log.close();
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const current = await pid();
      try {
        const ready = JSON.parse(await readFile(paths().ready, "utf8")) as { pid: number };
        if (current && ready.pid === current && (await alive(current))) {
          if (emit) {
            success(
              {
                state: "running",
                pid: current,
                ...(configured.generatedPassword ? { generatedPassword: configured.generatedPassword } : {}),
              },
              json,
              "result",
              "start",
            );
          }
          return;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new ControlRequestError({
      code: "daemon_unavailable",
      message: `daemon did not start; inspect ${paths().log}`,
    });
  } catch (error) {
    if (child) await terminateSpawnedDaemon(child);
    await rollbackCreatedConfig(configured.createdConfig);
    if (configured.replacedConfig) {
      const current = await loadConfig();
      if (JSON.stringify(current) === JSON.stringify(configured.replacedConfig.current)) {
        await saveConfig(configured.replacedConfig.previous);
      }
    }
    throw error;
  }
}

async function stop(json: boolean, emit = true): Promise<{ state: "not_running" | "stopped"; pid?: number }> {
  const current = await pid();
  if (!current || !(await alive(current))) {
    if (current) await unlink(paths().pid).catch(() => undefined);
    const result = { state: "not_running" as const };
    if (emit) success(result, json, "result", "stop");
    return result;
  }
  process.kill(current, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (await alive(current))) await new Promise((resolve) => setTimeout(resolve, 50));
  if (await alive(current)) {
    process.kill(current, "SIGKILL");
    const killDeadline = Date.now() + 1000;
    while (Date.now() < killDeadline && (await alive(current))) await new Promise((resolve) => setTimeout(resolve, 50));
    if (await alive(current))
      throw new ControlRequestError({ code: "timeout", message: `daemon PID ${current} survived SIGKILL` });
  }
  const result = { state: "stopped" as const, pid: current };
  if (emit) success(result, json, "result", "stop");
  return result;
}

async function changePassword(password: string, json: boolean, generatedPassword?: string): Promise<void> {
  const config = await loadConfig();
  const passwordHash = await hashPassword(validateDashboardPassword(password));
  const current = await pid();
  const running = Boolean(current && (await alive(current)));
  if (running) await stop(json, false);
  await saveConfig({ ...config, passwordHash });
  if (running) {
    try {
      await start([], json, false, false);
    } catch (error) {
      await saveConfig(config);
      await start([], json, false, false);
      throw error;
    }
  }
  success(
    { ...(generatedPassword ? { generatedPassword } : {}), daemonRestarted: running },
    json,
    "result",
    generatedPassword ? "password.reset" : "password.set",
  );
}

async function resetPassword(json: boolean): Promise<void> {
  const generatedPassword = randomBytes(24).toString("base64url");
  await changePassword(generatedPassword, json, generatedPassword);
}

async function readInputFile(path: string): Promise<string> {
  if (path !== "-") return readFile(path, "utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function hiddenPassword(): Promise<string> {
  if (!process.stdin.isTTY) throw new UsageError("--password requires a TTY; use --password-stdin for automation");
  process.stderr.write("SSH password: ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";
  try {
    for await (const chunk of process.stdin) {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n") {
          process.stderr.write("\n");
          return value;
        }
        if (character === "\u0003") throw new UsageError("password input cancelled");
        if (character === "\u007f") value = value.slice(0, -1);
        else value += character;
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  return value;
}

async function hydrate(command: ParsedCommand): Promise<void> {
  const params = command.params;
  const inputJson = params.inputJson;
  const inputFile = params.inputFile;
  if (typeof inputJson === "string" || typeof inputFile === "string") {
    const text = typeof inputJson === "string" ? inputJson : await readInputFile(inputFile as string);
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      throw new UsageError("structured input is not valid JSON");
    }
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new UsageError("structured input must be a JSON object");
    delete params.inputJson;
    delete params.inputFile;
    if (command.method === "request.resolve") params.response = input;
    else if (command.method === "request.answer")
      params.answers = "answers" in input ? (input as Record<string, unknown>).answers : input;
    else Object.assign(params, input);
  }
  for (const [fileKey, valueKey] of [
    ["textFile", "text"],
    ["dataFile", "data"],
  ] as const) {
    const file = params[fileKey];
    if (typeof file === "string") {
      params[valueKey] = await readInputFile(file);
      delete params[fileKey];
    }
  }
  if (params.passwordStdin) {
    params.password = (await readInputFile("-")).replace(/\r?\n$/, "");
    delete params.passwordStdin;
  } else if (params.passwordPrompt) {
    params.password = await hiddenPassword();
    delete params.passwordPrompt;
  }
  for (const key of Object.keys(params)) if (params[key] === undefined) delete params[key];
}

async function runBusiness(args: string[]): Promise<void> {
  const command = parseBusinessCommand(args);
  await hydrate(command);
  const socketPath = paths().controlSocket;
  const renderEvent = (event: unknown) => success(event, command.json, "event", command.method, command.params);
  const request = () =>
    controlRequest(socketPath, command.method, command.params, {
      stream: command.stream,
      timeoutMs:
        command.timeoutMs ?? (command.method === "thread.wait" ? 600_000 : command.stream ? 86_400_000 : undefined),
      onEvent: renderEvent,
    });
  let result: unknown;
  try {
    result = await request();
  } catch (error) {
    if (
      !(error instanceof ControlRequestError) ||
      error.controlError.code !== "HOST_KEY_UNKNOWN" ||
      command.method !== "host.upsert" ||
      !process.stdin.isTTY ||
      command.json
    )
      throw error;
    const fingerprint =
      (error.controlError.details as { fingerprint?: string } | undefined)?.fingerprint ?? "unknown fingerprint";
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await prompt.question(`Unknown SSH host key ${fingerprint}. Trust and save it? [y/N] `);
    prompt.close();
    if (!/^y(?:es)?$/i.test(answer.trim()))
      throw new ControlRequestError({
        code: "HOST_KEY_REJECTED",
        message: "SSH host key was not accepted",
        retryable: false,
      });
    command.params.acceptHostKey = true;
    result = await request();
  }
  if (command.output) {
    if (command.method === "terminal.screenshot") {
      const ansi = (result as { ansi?: unknown } | undefined)?.ansi;
      if (typeof ansi !== "string")
        throw new ControlRequestError({
          code: "protocol_error",
          message: "screenshot response did not contain ANSI snapshot data",
        });
      await writeFile(command.output, ansi, { mode: 0o600 });
      success({ path: command.output }, command.json, "result", command.method, command.params);
      return;
    }
    const encoded =
      typeof result === "string"
        ? result
        : ((result as { data?: string; pngBase64?: string } | undefined)?.data ??
          (result as { pngBase64?: string } | undefined)?.pngBase64);
    if (typeof encoded !== "string")
      throw new ControlRequestError({
        code: "protocol_error",
        message: "screenshot response did not contain base64 image data",
      });
    await writeFile(command.output, Buffer.from(encoded, "base64"), { mode: 0o600 });
    success({ path: command.output }, command.json, "result", command.method, command.params);
  } else if (!command.stream || result !== undefined) {
    success(result ?? { completed: true }, command.json, "result", command.method, command.params);
  }
}

async function main(): Promise<void> {
  let args = [...rawArgs];
  if (args.length === 1 && args[0] === "__daemon") {
    await import("./daemon.js");
    return;
  }
  if (args[0] === "--json") args = [...args.slice(1), "--json"];
  if (args.includes("--help")) {
    const json = args.includes("--json");
    success({ usage: helpText(args) }, json, "result", "help");
    return;
  }
  if (args[0] === "daemon") {
    const nested = args[1];
    if (nested === "url") args = ["dashboard", ...args.slice(2)];
    else args = [nested ?? "help", ...args.slice(2)];
  }
  if (args[0] === "password") {
    const action = args[1];
    const json = args.includes("--json");
    if (args.filter((value) => value === "--json").length > 1)
      throw new UsageError("option --json was provided more than once");
    if (action === "reset" && args.slice(2).every((value) => value === "--json")) {
      await resetPassword(json);
      return;
    }
    if (action === "set" && args.length === (json ? 4 : 3) && (!json || args[3] === "--json")) {
      await changePassword(args[2]!, json);
      return;
    }
    throw new UsageError(
      "Usage: codex-web-bridge password reset [--json]\n       codex-web-bridge password set NEW_PASSWORD [--json]",
    );
  }
  const command = (args[0] ?? "help") as DaemonCommand;
  if (["start", "stop", "restart", "status", "dashboard", "help"].includes(command)) {
    const commandArgs = args.slice(1);
    const { json, foreground } = validateDaemonOptions(command, commandArgs);
    if (command === "start" || command === "restart") await validateExplicitStartPassword(commandArgs);
    if (command === "help") {
      success({ usage: helpText() }, json, "result", "help");
      return;
    }
    if (command === "start") {
      await start(commandArgs, json, foreground);
      return;
    }
    if (command === "stop") {
      await stop(json);
      return;
    }
    if (command === "restart") {
      await stop(json, false);
      await start(commandArgs, json, foreground);
      return;
    }
    if (command === "status") {
      const current = await pid();
      const running = Boolean(current && (await alive(current)));
      success(
        { state: running ? "running" : "not_running", ...(running ? { pid: current } : {}) },
        json,
        "result",
        "status",
      );
      process.exitCode = running ? 0 : 3;
      return;
    }
    const config = await loadConfig();
    success({ url: config.publicOrigin }, json, "result", "dashboard");
    return;
  }
  await runBusiness(args);
}

main().catch((error) => {
  const json = rawArgs.includes("--json");
  const detail: ControlError =
    error instanceof ControlRequestError
      ? error.controlError
      : error instanceof UsageError
        ? { code: "usage_error", message: error.message }
        : { code: "internal_error", message: error instanceof Error ? error.message : String(error) };
  failure(detail, json);
  process.exitCode = exitCode(detail.code);
});
