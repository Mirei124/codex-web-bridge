import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

const schema = z.object({
  version: z.literal(1),
  bindHost: z.literal("127.0.0.1").default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(3210),
  publicOrigin: z.string().url().refine((value) => value.startsWith("https://"), "publicOrigin must use HTTPS"),
  passwordHash: z.string().min(1),
  sessionSecret: z.string().min(32),
  trustedProxy: z.literal("127.0.0.1").default("127.0.0.1"),
});

export type AppConfig = z.infer<typeof schema>;

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CWB_DATA_DIR ?? join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "codex-web-bridge");
}

export function paths(env: NodeJS.ProcessEnv = process.env) {
  const root = dataDir(env);
  return { root, config: join(root, "config.json"), database: join(root, "bridge.sqlite3"), pid: join(root, "daemon.pid"), ready: join(root, "daemon.ready"), log: join(root, "daemon.log") };
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<AppConfig> {
  const raw = JSON.parse(await readFile(paths(env).config, "utf8"));
  return schema.parse(raw);
}

export async function saveConfig(config: AppConfig, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const parsed = schema.parse(config);
  const target = paths(env).config;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, target);
}

export function parseConfig(value: unknown): AppConfig { return schema.parse(value); }
