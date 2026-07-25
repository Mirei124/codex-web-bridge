import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const buildRoot = join(root, ".build");
const releaseRoot = join(root, "release");
const pkg = join(root, "node_modules", ".bin", process.platform === "win32" ? "pkg.cmd" : "pkg");
const platformNames = {
  linux: "linux",
  darwin: "macos",
  win32: "win",
};
const platform = platformNames[process.platform];
if (!platform) throw new Error(`Unsupported pkg platform: ${process.platform}`);

await mkdir(buildRoot, { recursive: true });
await mkdir(releaseRoot, { recursive: true });
const entry = join(root, "apps", "server", "dist", "pkg-entry.mjs");
await build({
  entryPoints: [join(root, "apps", "server", "src", "cli.ts")],
  outfile: entry,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@napi-rs/canvas", "@node-rs/argon2", "better-sqlite3", "cpu-features", "ssh2"],
});
const suffix = process.platform === "win32" ? ".exe" : "";
const libc =
  process.platform === "linux" ? (process.report.getReport().header.glibcVersionRuntime ? "gnu" : "musl") : undefined;
const outputPlatform = [process.platform, process.arch, libc].filter(Boolean).join("-");
const output = join(releaseRoot, `codex-web-bridge-${outputPlatform}${suffix}`);
const target = `node22-${platform}-${process.arch === "x64" ? "x64" : process.arch}`;
const result = spawnSync(
  pkg,
  ["--config", join(root, "scripts", "pkg.config.cjs"), "--targets", target, "--output", output, entry],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, PKG_CACHE_PATH: join(root, ".build", "pkg-cache") },
  },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`pkg binary written to ${relative(root, output)}`);
