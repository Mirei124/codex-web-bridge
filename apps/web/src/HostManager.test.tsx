import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostManager } from "./HostManager";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));

function response(body?: unknown, status = 200) { return body === undefined ? new Response(null, { status }) : new Response(JSON.stringify(body), { status }); }

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("host configuration", () => {
  it("edits a host using only a verified fingerprint and B-side key path", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ authenticated: true, csrfToken: "csrf" }))
      .mockResolvedValueOnce(response([{ id: "a", name: "Machine A", address: "codex@10.0.0.2:22", status: "connecting" }]))
      .mockResolvedValueOnce(response({ id: "a" }))
      .mockResolvedValueOnce(response([]));
    vi.stubGlobal("fetch", fetch); render(<HostManager />);
    fireEvent.click(await screen.findByRole("button", { name: "主机配置" }));
    expect(screen.getByText("connecting")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Machine A/ }));
    expect(screen.getByText(/私钥不会上传/)).toBeInTheDocument();
    expect(screen.getByLabelText("主机 ID")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("主机密钥指纹"), { target: { value: "SHA256:verified" } });
    fireEvent.change(screen.getByLabelText("B 上的私钥路径"), { target: { value: "/home/bridge/.ssh/id_ed25519" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    const saved = fetch.mock.calls[2]![1] as RequestInit;
    expect(JSON.parse(String(saved.body))).toEqual({ id: "a", name: "Machine A", hostname: "10.0.0.2", port: 22, username: "codex", hostKeySha256: "SHA256:verified", identityFile: "/home/bridge/.ssh/id_ed25519" });
    expect(new Headers(saved.headers).get("x-csrf-token")).toBe("csrf");
  });

  it("adds a new host with all required SSH boundary fields", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ authenticated: true, csrfToken: "csrf" })).mockResolvedValueOnce(response([])).mockResolvedValueOnce(response({ id: "new-a" })).mockResolvedValueOnce(response([]));
    vi.stubGlobal("fetch", fetch); render(<HostManager />);
    fireEvent.click(await screen.findByRole("button", { name: "主机配置" })); fireEvent.click(screen.getByRole("button", { name: "＋ 新增主机" }));
    for (const [label, value] of [["主机 ID","new-a"],["名称","New A"],["主机名或 IP","a.internal"],["SSH 用户名","codex"],["主机密钥指纹","SHA256:key"],["B 上的私钥路径","/keys/a"]]) fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    expect(fetch.mock.calls[2]![0]).toBe("/api/hosts");
  });
});
