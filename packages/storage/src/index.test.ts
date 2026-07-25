import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Storage } from "./index.js";

let storage: Storage | undefined;
const packageRoot = dirname(fileURLToPath(import.meta.url));
const bunBinary = resolve(packageRoot, "../../../node_modules/.bin/bun");

afterEach(() => storage?.close());
describe("Storage", () => {
  it("expires login sessions", () => {
    storage = new Storage(":memory:");
    storage.createSession({ id: "id", csrfToken: "csrf", createdAt: 1, expiresAt: 10 });
    expect(storage.session("id", 9)?.csrfToken).toBe("csrf");
    expect(storage.session("id", 10)).toBeUndefined();
  });
  it("invalidates every unresolved request in one thread only", () => {
    storage = new Storage(":memory:");
    storage.db.exec(
      "INSERT INTO hosts(id,name,hostname,username,host_key_sha256,identity_file,created_at) VALUES('h','h','h','u','k','/k',1); INSERT INTO threads(id,host_id,tmux_session,working_directory,title,status,created_at,updated_at) VALUES('t','h','tmux','/w','t','idle',1,1),('other','h','tmux2','/w','o','idle',1,1)",
    );
    for (const [id, threadId] of [
      ["a", "t"],
      ["b", "t"],
      ["c", "other"],
    ])
      storage.putPending({ id, threadId, payload: "{}", rpcId: "1", method: "m", params: "{}", createdAt: 1 });
    expect(storage.resolveAllPending("t", 2).sort()).toEqual(["a", "b"]);
    expect(storage.pending("t")).toHaveLength(0);
    expect(storage.pending("other")).toHaveLength(1);
  });
  it("round-trips thread launch settings", () => {
    storage = new Storage(":memory:");
    storage.upsertHost({
      id: "h",
      name: "h",
      hostname: "h",
      port: 22,
      username: "u",
      hostKeySha256: "k",
      identityFile: "",
      createdAt: 1,
    });
    storage.createThread({
      id: "t",
      hostId: "h",
      tmuxSession: "tmux",
      workingDirectory: "/w",
      proxy: "http://proxy:8080",
      prependPath: "/thread/bin",
      title: "t",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    });
    expect(storage.thread("t")).toMatchObject({ proxy: "http://proxy:8080", prependPath: "/thread/bin" });
  });
  it("round-trips and updates a host PATH prefix", () => {
    storage = new Storage(":memory:");
    const host = {
      id: "h",
      name: "h",
      hostname: "h",
      port: 22,
      username: "u",
      hostKeySha256: "k",
      identityFile: "",
      prependPath: "/custom/bin",
      createdAt: 1,
    };
    storage.upsertHost(host);
    expect(storage.host("h")?.prependPath).toBe(host.prependPath);
    storage.upsertHost({ ...host, prependPath: "/other/bin" });
    expect(storage.host("h")?.prependPath).toBe("/other/bin");
  });
  it("persists the last Web thread creation form", () => {
    storage = new Storage(":memory:");
    expect(storage.threadCreateDefaults()).toBeUndefined();
    storage.saveThreadCreateDefaults({ hostId: "h", cwd: "/work", proxy: "http://proxy:8080", prependPath: "/bin" });
    expect(storage.threadCreateDefaults()).toEqual({
      hostId: "h",
      cwd: "/work",
      proxy: "http://proxy:8080",
      prependPath: "/bin",
    });
    storage.saveThreadCreateDefaults({ hostId: "other", cwd: "/next" });
    expect(storage.threadCreateDefaults()).toEqual({ hostId: "other", cwd: "/next" });
  });
  it("deletes only bridge-owned thread data", () => {
    storage = new Storage(":memory:");
    storage.upsertHost({
      id: "h",
      name: "h",
      hostname: "h",
      port: 22,
      username: "u",
      hostKeySha256: "k",
      identityFile: "",
      createdAt: 1,
    });
    storage.createThread({
      id: "t",
      hostId: "h",
      tmuxSession: "tmux",
      workingDirectory: "/w",
      title: "t",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    });
    storage.putMessage({ id: "m", threadId: "t", role: "user", text: "x", streaming: 0, createdAt: 1 });
    storage.putPending({ id: "p", threadId: "t", payload: "{}", rpcId: "1", method: "m", params: "{}", createdAt: 1 });
    expect(storage.deleteThread("t")).toBe(true);
    expect(storage.thread("t")).toBeUndefined();
    expect(storage.messages("t")).toEqual([]);
    expect(storage.pending("t")).toEqual([]);
    expect(storage.host("h")).toBeDefined();
  });
  it("deletes a host and its saved thread form defaults", () => {
    storage = new Storage(":memory:");
    storage.upsertHost({
      id: "h",
      name: "h",
      hostname: "h",
      port: 22,
      username: "u",
      hostKeySha256: "k",
      identityFile: "",
      createdAt: 1,
    });
    storage.saveThreadCreateDefaults({ hostId: "h", cwd: "/work" });
    expect(storage.deleteHost("h")).toBe(true);
    expect(storage.host("h")).toBeUndefined();
    expect(storage.threadCreateDefaults()).toBeUndefined();
    expect(storage.deleteHost("h")).toBe(false);
  });
  it("writes host names correctly in the Bun runtime used by the standalone binary", () => {
    if (!existsSync(bunBinary)) return;
    const script = `
      import { Storage } from ${JSON.stringify(pathToFileURL(resolve(packageRoot, "index.ts")).href)};
      const storage = new Storage(":memory:");
      storage.upsertHost({
        id: "h",
        name: "admin@10.28.126.3",
        hostname: "10.28.126.3",
        port: 22,
        username: "admin",
        hostKeySha256: "fingerprint",
        identityFile: "",
        createdAt: 1,
      });
      console.log(JSON.stringify(storage.host("h")));
      storage.close();
    `;
    const result = spawnSync(bunBinary, ["--eval", script], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ id: "h", name: "admin@10.28.126.3" });
  });
});
