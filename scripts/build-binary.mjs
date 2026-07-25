import { mkdir, readdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { extname, join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const webRoot = join(root, "apps", "web", "dist");
const buildRoot = join(root, ".build");
const releaseRoot = join(root, "release");

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else result.push(path);
  }
  return result.sort();
}

const contentTypes = {
  ".css": "text/css",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".js": "application/javascript",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

await mkdir(buildRoot, { recursive: true });
await mkdir(releaseRoot, { recursive: true });
const assets = await files(webRoot);
const imports = assets.map((path, index) => {
  const specifier = relative(buildRoot, path).split(sep).join("/");
  return `import asset${index} from ${JSON.stringify(`./${specifier}`)} with { type: "file" };`;
});
const manifest = assets.map((path, index) => {
  const webPath = relative(webRoot, path).split(sep).join("/");
  const contentType = contentTypes[extname(path)] ?? "application/octet-stream";
  return `  ${JSON.stringify(webPath)}: { path: asset${index}, contentType: ${JSON.stringify(contentType)} },`;
});
const entry = `${imports.join("\n")}

globalThis.__CWB_STANDALONE__ = true;
globalThis.__CWB_EMBEDDED_WEB__ = {
${manifest.join("\n")}
};
await import("../apps/server/src/cli.ts");
`;
const entryPath = join(buildRoot, "binary-entry.ts");
await writeFile(entryPath, entry);

const suffix = process.platform === "win32" ? ".exe" : "";
const libc =
  process.platform === "linux" ? (process.report.getReport().header.glibcVersionRuntime ? "gnu" : "musl") : undefined;
const platform = [process.platform, process.arch, libc].filter(Boolean).join("-");
const output = join(releaseRoot, `codex-web-bridge-${platform}${suffix}`);
const result = spawnSync("bun", ["build", "--compile", "--minify", entryPath, "--outfile", output], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Binary written to ${relative(root, output)}`);
