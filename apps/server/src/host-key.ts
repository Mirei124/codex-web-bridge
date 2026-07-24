import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFile, chmod, readFile } from "node:fs/promises";
import { paths } from "@cwb/config";

export const internalHostKeyToken = randomUUID();

export class HostKeyError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean, readonly details?: unknown) {
    super(message);
  }
}

export async function verifyHostKey(
  host: Record<string, unknown>,
  accept: boolean,
  requireConfirmation = false,
): Promise<{ fingerprint: string }> {
  const supplied = typeof host.hostKeySha256 === "string" && /^SHA256:[A-Za-z0-9+/]{43}=?$/.test(host.hostKeySha256)
    ? host.hostKeySha256
    : undefined;
  if (supplied && !requireConfirmation) return { fingerprint: supplied };

  const hostname = requiredString(host, "hostname");
  const port = typeof host.port === "number" ? host.port : 22;
  const output = await scan(hostname, port);
  const candidates = output.split("\n").filter(line => line && !line.startsWith("#"))
    .map(line => line.trim().split(/\s+/)).filter(parts => parts.length >= 3);
  const selected = candidates.find(parts => parts[1] === "ssh-ed25519") ?? candidates[0];
  if (!selected) throw new HostKeyError("SSH_HOST_KEY_SCAN_FAILED", `unable to read SSH host key for ${hostname}:${port}`, true);

  const keyName = port === 22 ? hostname : `[${hostname}]:${port}`;
  const entry = `${keyName} ${selected[1]} ${selected[2]}`;
  const fingerprint = `SHA256:${createHash("sha256").update(Buffer.from(selected[2]!, "base64")).digest("base64").replace(/=+$/, "")}`;
  if (supplied && supplied !== fingerprint) {
    throw new HostKeyError("HOST_KEY_CHANGED", `SSH host key does not match the confirmed fingerprint for ${hostname}:${port}`, false, { fingerprint });
  }

  let existing = "";
  try { existing = await readFile(paths().knownHosts, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const known = existing.split("\n").find(line => line.startsWith(`${keyName} `));
  if (known && known !== entry) throw new HostKeyError("HOST_KEY_CHANGED", `SSH host key changed for ${hostname}:${port}`, false, { fingerprint });
  if (!accept && (requireConfirmation || !known)) {
    throw new HostKeyError("HOST_KEY_UNKNOWN", `SSH host key requires confirmation for ${hostname}:${port}`, false, { fingerprint });
  }
  if (!known) {
    await appendFile(paths().knownHosts, `${entry}\n`, { mode: 0o600 });
    await chmod(paths().knownHosts, 0o600);
  }
  return { fingerprint };
}

function requiredString(value: Record<string, unknown>, name: string): string {
  const field = value[name];
  if (typeof field !== "string" || !field) throw new HostKeyError("INVALID_ARGUMENT", `${name} must be a non-empty string`, false);
  return field;
}

function scan(hostname: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh-keyscan", ["-T", "5", "-p", String(port), hostname], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => stdout += chunk);
    child.once("error", reject);
    child.once("close", code => code === 0 && stdout.trim()
      ? resolve(stdout)
      : reject(new HostKeyError("SSH_HOST_KEY_SCAN_FAILED", `unable to read SSH host key for ${hostname}:${port}`, true)));
  });
}
