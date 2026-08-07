import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type {
  CodexThreadSummary,
  HostConfig,
  HostSummary,
  PendingRequest,
  ResolveRequest,
  ServerEvent,
  ThreadDetail,
  ThreadCreateDefaults,
  ThreadSummary,
  UpdateSettingsRequest,
} from "@cwb/protocol";
import { ApiError, api } from "./api";
import { Terminal } from "./Terminal";
import { useThreadEvents } from "./useThreadEvents";

const baseTitle = "Codex Bridge";
function notificationContextAvailable(): boolean {
  return window.isSecureContext;
}
function notificationProblem(): string | undefined {
  if (!("Notification" in window)) return "当前浏览器不支持系统通知，将使用未读高亮和标签提醒。";
  if (!notificationContextAvailable())
    return "系统通知仅在安全上下文（HTTPS 或本机回环地址）可用，将使用未读高亮和标签提醒。";
  if (Notification.permission === "denied") return "系统通知权限已被禁用，请在浏览器站点设置中重新允许。";
  if (Notification.permission === "default") return "允许系统通知后，Codex 回答完成时可以在后台提醒你。";
}

function Login({ onLogin }: { onLogin(): void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.login({ password });
      onLogin();
      window.dispatchEvent(new Event("cwb-auth-changed"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="center">
      <form className="card login" onSubmit={submit}>
        <div className="brand">Codex Bridge</div>
        <h1>登录控制台</h1>
        <p>输入部署时配置的访问密码。</p>
        <label>
          密码
          <input autoFocus type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="error">{error}</div>}
        <button disabled={!password || busy}>{busy ? "验证中…" : "登录"}</button>
      </form>
    </main>
  );
}

function RequestCard({ request, onResolve }: { request: PendingRequest; onResolve(value: ResolveRequest): void }) {
  const [input, setInput] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (request.kind === "questions")
    return (
      <section className="request questions">
        <strong>{request.title}</strong>
        {request.questions.map((question) => (
          <label key={question.id}>
            {question.header}
            <span>{question.prompt}</span>
            {question.options?.length ? (
              <select
                value={answers[question.id] ?? ""}
                onChange={(e) => setAnswers((old) => ({ ...old, [question.id]: e.target.value }))}
              >
                <option value="">请选择</option>
                {question.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={answers[question.id] ?? ""}
                onChange={(e) => setAnswers((old) => ({ ...old, [question.id]: e.target.value }))}
              />
            )}
          </label>
        ))}
        <button
          disabled={request.questions.some((q) => !answers[q.id]?.trim())}
          onClick={() =>
            onResolve({
              answers: Object.fromEntries(request.questions.map((q) => [q.id, { answers: [answers[q.id]!.trim()] }])),
            })
          }
        >
          提交全部回答
        </button>
      </section>
    );
  return (
    <section className={`request ${request.kind}`}>
      <strong>{request.title}</strong>
      {request.kind === "approval" ? (
        <>
          <p>{request.detail}</p>
          {request.command && <pre>{request.command}</pre>}
          <div className="actions">
            <button onClick={() => onResolve({ approved: true })}>允许</button>
            <button className="secondary" onClick={() => onResolve({ approved: true, scope: "session" })}>
              全部允许
            </button>
            <button className="danger" onClick={() => onResolve({ approved: false })}>
              拒绝
            </button>
          </div>
        </>
      ) : request.kind === "choice" ? (
        <>
          <p>{request.prompt}</p>
          <div className="choices">
            {request.options.map((option) => (
              <button key={option.value} onClick={() => onResolve({ value: option.value })}>
                <b>{option.label}</b>
                {option.description && <small>{option.description}</small>}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <p>{request.prompt}</p>
          <div className="inline">
            <input value={input} placeholder={request.placeholder} onChange={(e) => setInput(e.target.value)} />
            <button disabled={!input.trim()} onClick={() => onResolve({ value: input.trim() })}>
              提交
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function CreateDialog({
  hosts,
  mode,
  onClose,
  onDone,
}: {
  hosts: HostSummary[];
  mode: "create" | "resume";
  onClose(): void;
  onDone(thread: ThreadDetail): void;
}) {
  const [hostId, setHostId] = useState(hosts[0]?.id ?? "");
  const [cwd, setCwd] = useState("");
  const [threadId, setThreadId] = useState("");
  const [proxy, setProxy] = useState("");
  const [prependPath, setPrependPath] = useState("");
  const [error, setError] = useState("");
  const [discovered, setDiscovered] = useState<CodexThreadSummary[]>([]);
  const [defaults, setDefaults] = useState<ThreadCreateDefaults>({ hosts: [], cwdHistory: [] });
  const [loadingDefaults, setLoadingDefaults] = useState(mode === "create");
  const [submitting, setSubmitting] = useState(false);
  function applyHostDefaults(nextHostId: string, source = defaults) {
    const remembered = source.hosts.find((item) => item.hostId === nextHostId);
    setCwd(remembered?.cwd ?? "");
    setProxy(remembered?.proxy ?? "");
    setPrependPath(remembered?.prependPath ?? "");
  }
  useEffect(() => {
    if (mode !== "create") return;
    let active = true;
    api
      .threadCreateDefaults()
      .then((value) => {
        if (!active) return;
        const next = value ?? { hosts: [], cwdHistory: [] };
        setDefaults(next);
        if (!value) return;
        const rememberedHost =
          next.lastHostId && hosts.some((host) => host.id === next.lastHostId) ? next.lastHostId : hosts[0]?.id;
        if (!rememberedHost) return;
        setHostId(rememberedHost);
        applyHostDefaults(rememberedHost, next);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoadingDefaults(false);
      });
    return () => {
      active = false;
    };
  }, [hosts, mode]);
  useEffect(() => {
    if (mode !== "resume" || !hostId) return;
    let active = true;
    api
      .codexThreads(hostId)
      .then((items) => {
        if (active) setDiscovered(items);
      })
      .catch(() => {
        if (active) setDiscovered([]);
      });
    return () => {
      active = false;
    };
  }, [hostId, mode]);
  function chooseDiscovered(id: string) {
    const item = discovered.find((candidate) => candidate.id === id);
    if (!item) return;
    setThreadId(item.id);
    if (item.cwd) setCwd(item.cwd);
  }
  function changeHost(nextHostId: string) {
    setHostId(nextHostId);
    if (mode === "create") applyHostDefaults(nextHostId);
  }
  async function deleteCwdHistory(value: string) {
    try {
      await api.deleteThreadCreateCwd({ cwd: value });
      setDefaults((old) => ({ ...old, cwdHistory: old.cwdHistory.filter((item) => item !== value) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除工作目录历史失败");
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setError("");
    const proxyValue = proxy.trim(),
      prependPathValue = prependPath.trim(),
      values = {
        hostId,
        cwd: cwd.trim(),
        ...(proxyValue ? { proxy: proxyValue } : {}),
        ...(prependPathValue ? { prependPath: prependPathValue } : {}),
      };
    setSubmitting(true);
    try {
      if (mode === "create") {
        await api.saveThreadCreateDefaults(values);
        try {
          onDone(await api.createThread(values));
        } catch (e) {
          if (
            e instanceof ApiError &&
            e.code === "WORKING_DIRECTORY_NOT_FOUND" &&
            confirm(`工作目录“${values.cwd}”不存在，是否创建该目录？`)
          ) {
            onDone(await api.createThread({ ...values, createDirectory: true }));
          } else throw e;
        }
      } else onDone(await api.resumeThread({ ...values, codexThreadId: threadId }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <form className="card modal" onSubmit={submit}>
        <h2>{mode === "create" ? "创建会话" : "恢复会话"}</h2>
        <label>
          主机
          <select disabled={loadingDefaults} value={hostId} onChange={(e) => changeHost(e.target.value)}>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </label>
        {mode === "resume" && (
          <>
            <label>
              发现的历史会话
              <select value="" onChange={(e) => chooseDiscovered(e.target.value)}>
                <option value="">选择后自动填写</option>
                {discovered.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title ?? item.id}
                    {item.cwd ? ` · ${item.cwd}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Codex Thread ID
              <input
                autoFocus
                value={threadId}
                onChange={(e) => setThreadId(e.target.value)}
                placeholder="也可手动输入 019…"
              />
            </label>
          </>
        )}
        <label>
          工作目录
          <input
            disabled={loadingDefaults}
            autoFocus={mode === "create"}
            list={mode === "create" && defaults.cwdHistory.length ? "thread-create-cwd-history" : undefined}
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/srv/project"
          />
          {mode === "create" && defaults.cwdHistory.length > 0 && (
            <>
              <datalist id="thread-create-cwd-history">
                {defaults.cwdHistory.map((item) => (
                  <option key={item} value={item} />
                ))}
              </datalist>
              <div className="cwd-history" aria-label="曾用工作目录">
                {defaults.cwdHistory.map((item) => (
                  <span key={item}>
                    <button type="button" className="secondary" onClick={() => setCwd(item)}>
                      {item}
                    </button>
                    <button
                      type="button"
                      className="icon danger"
                      aria-label={`删除 ${item}`}
                      onClick={() => void deleteCwdHistory(item)}
                    >
                      x
                    </button>
                  </span>
                ))}
              </div>
            </>
          )}
        </label>
        <label>
          代理地址（可选）
          <input
            disabled={loadingDefaults}
            value={proxy}
            onChange={(e) => setProxy(e.target.value)}
            placeholder="http://127.0.0.1:7890"
          />
        </label>
        <label>
          会话前置 PATH（可选）
          <input
            disabled={loadingDefaults}
            value={prependPath}
            onChange={(e) => setPrependPath(e.target.value)}
            placeholder="/home/user/.local/bin:/opt/bin"
          />
          <small>添加到主机级前置 PATH 之前，仅影响此会话。</small>
        </label>
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button type="button" className="secondary" disabled={submitting} onClick={onClose}>
            取消
          </button>
          <button
            disabled={
              loadingDefaults || submitting || !hostId || !cwd.trim() || (mode === "resume" && !threadId.trim())
            }
          >
            {loadingDefaults
              ? "读取中…"
              : submitting
                ? mode === "create"
                  ? "创建中…"
                  : "恢复中…"
                : mode === "create"
                  ? "创建"
                  : "恢复"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function SettingsPanel() {
  const [form, setForm] = useState<{
    bindHost: UpdateSettingsRequest["bindHost"];
    port: number;
    publicOrigin: string;
    newPassword: string;
  }>({ bindHost: "127.0.0.1", port: 3210, publicOrigin: "", newPassword: "" });
  const [dataDir, setDataDir] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [saved, setSaved] = useState<{ restartRequired: boolean; url: string }>();
  useEffect(() => {
    let active = true;
    api
      .settings()
      .then((value) => {
        if (!active) return;
        setForm({
          bindHost: value.bindHost,
          port: value.port,
          publicOrigin: value.publicOrigin ?? "",
          newPassword: "",
        });
        setDataDir(value.dataDir);
        setBusy(false);
      })
      .catch((error) => {
        if (active) {
          setError(error instanceof Error ? error.message : "读取设置失败");
          setBusy(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      form.bindHost === "0.0.0.0" &&
      !confirm("监听 0.0.0.0 会让其他设备直接访问服务。纯 HTTP 可能泄露密码和会话内容，确认继续？")
    )
      return;
    setBusy(true);
    setError("");
    setSaved(undefined);
    try {
      const value = await api.updateSettings({
        bindHost: form.bindHost,
        port: form.port,
        publicOrigin: form.publicOrigin.trim(),
        ...(form.newPassword ? { newPassword: form.newPassword } : {}),
      });
      const visibleHost = value.bindHost === "0.0.0.0" ? "localhost" : value.bindHost;
      setSaved({
        restartRequired: value.restartRequired,
        url: value.publicOrigin || `http://${visibleHost}:${value.port}`,
      });
      setForm((old) => ({ ...old, newPassword: "" }));
    } catch (error) {
      setError(error instanceof Error ? error.message : "保存设置失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-page">
      <div className="settings-heading">
        <h1>设置</h1>
        <p>配置 daemon 的监听地址、公开访问地址和控制台密码。</p>
      </div>
      <form className="card settings-form" onSubmit={submit}>
        <label>
          监听地址
          <select
            value={form.bindHost}
            onChange={(event) =>
              setForm((old) => ({ ...old, bindHost: event.target.value === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1" }))
            }
          >
            <option value="127.0.0.1">127.0.0.1（仅本机）</option>
            <option value="0.0.0.0">0.0.0.0（危险：所有网络接口）</option>
          </select>
        </label>
        <label>
          端口
          <input
            type="number"
            min="1"
            max="65535"
            value={form.port}
            onChange={(event) => setForm((old) => ({ ...old, port: Number(event.target.value) }))}
          />
        </label>
        <label>
          公开访问地址
          <input
            value={form.publicOrigin}
            onChange={(event) => setForm((old) => ({ ...old, publicOrigin: event.target.value }))}
            placeholder="https://bridge.example.com"
          />
        </label>
        <label>
          新密码（留空表示不修改）
          <input
            type="password"
            autoComplete="new-password"
            value={form.newPassword}
            onChange={(event) => setForm((old) => ({ ...old, newPassword: event.target.value }))}
          />
        </label>
        <label>
          数据目录
          <input value={dataDir} readOnly />
        </label>
        <p>数据目录由启动环境决定，不能在运行中的 dashboard 修改。</p>
        {error && <div className="error">{error}</div>}
        {saved && (
          <div className="settings-result" role="status">
            {saved.restartRequired ? (
              <>
                <strong>
                  设置已保存，需要运行 <code>cwb restart</code> 后生效。
                </strong>
                <span>
                  重启后的访问地址：<a href={saved.url}>{saved.url}</a>
                </span>
              </>
            ) : (
              <strong>设置已保存并已生效。</strong>
            )}
          </div>
        )}
        <button disabled={busy || form.port < 1 || form.port > 65535}>{busy ? "处理中…" : "保存设置"}</button>
      </form>
    </section>
  );
}

export function HostDialog({ host, onClose, onSaved }: { host?: HostSummary; onClose(): void; onSaved(): void }) {
  const match = host?.address.match(/^(.+)@(.+):(\d+)$/);
  const [form, setForm] = useState<HostConfig>({
    id: host?.id ?? "",
    name: host?.name ?? "",
    hostname: host?.hostname ?? match?.[2] ?? "",
    port: host?.port ?? Number(match?.[3] ?? 22),
    username: host?.username ?? match?.[1] ?? "",
    hostKeySha256: host?.hostKeySha256 ?? "",
    identityFile: host?.identityFile ?? "",
    prependPath: host?.prependPath ?? "",
  });
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{ fingerprint: string; payload: HostConfig }>();
  const set = <K extends keyof HostConfig>(key: K, value: HostConfig[K]) =>
    setForm((old) => ({ ...old, [key]: value }));
  function payload(): HostConfig {
    const id = form.id?.trim();
    const name = form.name?.trim();
    const fingerprint = form.hostKeySha256?.trim();
    const identityFile = form.identityFile?.trim();
    const prependPath = form.prependPath?.trim();
    return {
      ...(id ? { id } : {}),
      ...(name ? { name } : {}),
      hostname: form.hostname.trim(),
      port: form.port,
      username: form.username.trim(),
      ...(fingerprint ? { hostKeySha256: fingerprint } : {}),
      ...(identityFile ? { identityFile } : {}),
      prependPath: prependPath ?? "",
      ...(password ? { password } : {}),
    };
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api.saveHost(payload());
      onSaved();
    } catch (e) {
      const fingerprint =
        e instanceof ApiError &&
        e.code === "HOST_KEY_UNKNOWN" &&
        typeof e.details === "object" &&
        e.details !== null &&
        "fingerprint" in e.details &&
        typeof e.details.fingerprint === "string"
          ? e.details.fingerprint
          : undefined;
      if (fingerprint) setConfirmation({ fingerprint, payload: payload() });
      else setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  async function confirmFingerprint() {
    if (!confirmation) return;
    setError("");
    setBusy(true);
    try {
      await api.saveHost({ ...confirmation.payload, hostKeySha256: confirmation.fingerprint, acceptHostKey: true });
      onSaved();
    } catch (e) {
      setConfirmation(undefined);
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  async function deleteHost() {
    if (!host || !confirm(`删除主机“${host.name}”？请先删除该主机下的 CWB 会话。`)) return;
    setError("");
    setBusy(true);
    try {
      await api.deleteHost(host.id);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusy(false);
    }
  }
  const fingerprint = form.hostKeySha256?.trim() ?? "";
  const complete =
    form.hostname.trim() &&
    form.port > 0 &&
    form.port <= 65535 &&
    form.username.trim() &&
    (!fingerprint || /^SHA256:[A-Za-z0-9+/]{43}=?$/.test(fingerprint));
  if (confirmation)
    return (
      <div className="modal-backdrop">
        <section className="card modal" role="dialog" aria-labelledby="host-key-title">
          <h2 id="host-key-title">确认 SSH 主机指纹</h2>
          <p>
            目标主机{" "}
            <strong>
              {confirmation.payload.hostname}:{confirmation.payload.port}
            </strong>{" "}
            返回了以下密钥指纹。请通过可信渠道核对后再确认：
          </p>
          <pre>{confirmation.fingerprint}</pre>
          {error && <div className="error">{error}</div>}
          <div className="actions">
            <button type="button" className="secondary" disabled={busy} onClick={() => setConfirmation(undefined)}>
              返回修改
            </button>
            <button type="button" disabled={busy} onClick={() => void confirmFingerprint()}>
              {busy ? "保存中…" : "确认并保存"}
            </button>
          </div>
        </section>
      </div>
    );
  return (
    <div className="modal-backdrop">
      <form className="card modal" onSubmit={submit}>
        <h2>{host ? "编辑主机" : "新增主机"}</h2>
        <p>
          提交后会扫描并展示 SSH 主机指纹供你确认。认证可使用 daemon 内存中的密码、B 上的私钥，或 B 已配置的 SSH
          Agent/默认密钥。
        </p>
        <label>
          主机 ID（可选）
          <input
            value={form.id ?? ""}
            disabled={Boolean(host)}
            onChange={(e) => set("id", e.target.value)}
            placeholder="留空则自动生成"
          />
        </label>
        <label>
          名称（可选）
          <input value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} placeholder="留空则自动生成" />
        </label>
        <label>
          主机名或 IP
          <input value={form.hostname} onChange={(e) => set("hostname", e.target.value)} />
        </label>
        <label>
          SSH 端口
          <input
            type="number"
            min="1"
            max="65535"
            value={form.port}
            onChange={(e) => set("port", Number(e.target.value))}
          />
        </label>
        <label>
          SSH 用户名
          <input value={form.username} onChange={(e) => set("username", e.target.value)} />
        </label>
        <label>
          前置 PATH（可选）
          <input
            value={form.prependPath ?? ""}
            onChange={(e) => set("prependPath", e.target.value)}
            placeholder="/home/user/.local/bin:/usr/local/bin"
          />
        </label>
        <label>
          主机密钥指纹（可选）
          <input
            value={form.hostKeySha256 ?? ""}
            onChange={(e) => set("hostKeySha256", e.target.value)}
            placeholder="SHA256:…"
          />
        </label>
        <label>
          SSH 密码（可选）
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={host ? "留空表示不修改" : "仅保存在 daemon 内存"}
          />
        </label>
        <label>
          B 上的私钥路径（可选）
          <input
            value={form.identityFile ?? ""}
            onChange={(e) => set("identityFile", e.target.value)}
            placeholder="留空则尝试 Agent 或默认密钥"
          />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="actions">
          {host && (
            <button type="button" className="danger" disabled={busy} onClick={() => void deleteHost()}>
              删除主机
            </button>
          )}
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button disabled={!complete || busy}>{busy ? "扫描中…" : "保存"}</button>
        </div>
      </form>
    </div>
  );
}

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean>();
  const [hosts, setHosts] = useState<HostSummary[]>([]);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [selected, setSelected] = useState<ThreadDetail>();
  const [dialog, setDialog] = useState<"create" | "resume">();
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<"chat" | "terminal">("chat");
  const [terminalData, setTerminalData] = useState<string[]>([]);
  const [screenshot, setScreenshot] = useState<string>();
  const [hostDialog, setHostDialog] = useState<HostSummary | "new">();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [operationError, setOperationError] = useState("");
  const [view, setView] = useState<"threads" | "settings">("threads");
  const [unread, setUnread] = useState<Set<string>>(() => new Set());
  const [toast, setToast] = useState<string>();
  const [interruptArmedThreadId, setInterruptArmedThreadId] = useState<string>();
  const [showScrollHint, setShowScrollHint] = useState(false);
  const selectedId = useRef<string | undefined>(undefined);
  const viewRef = useRef(view);
  const threadsRef = useRef<ThreadSummary[]>([]);
  const threadStates = useRef(new Map<string, ThreadSummary["status"]>());
  const interruptTimer = useRef<number | undefined>(undefined);
  const conversationRef = useRef<HTMLDivElement>(null);
  selectedId.current = selected?.id;
  viewRef.current = view;
  threadsRef.current = threads;
  const load = useCallback(async () => {
    const [nextHosts, nextThreads] = await Promise.all([api.hosts(), api.threads()]);
    setHosts(nextHosts);
    setThreads(nextThreads);
  }, []);
  useEffect(() => {
    api
      .session()
      .then((s) => {
        setAuthenticated(s.authenticated);
        if (s.authenticated) void load();
      })
      .catch(() => setAuthenticated(false));
  }, [load]);
  useEffect(() => {
    if (authenticated) setToast(notificationProblem());
  }, [authenticated]);
  useEffect(() => {
    const count = unread.size;
    document.title = count ? `(${count}) ${baseTitle}` : baseTitle;
    let icon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    if (!icon) {
      icon = document.createElement("link");
      icon.rel = "icon";
      document.head.append(icon);
    }
    const badge = count
      ? `<circle cx="25" cy="7" r="7" fill="#e85d5d"/><text x="25" y="10" text-anchor="middle" font-size="9" font-family="sans-serif" fill="white">${Math.min(count, 9)}${count > 9 ? "+" : ""}</text>`
      : "";
    icon.href = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#64bfa7" d="M27 4C15 4 6 9 5 20c4-5 9-8 15-9-7 3-12 8-15 15l3 2c2-5 5-8 9-10 7-3 10-8 10-14Z"/>${badge}</svg>`)}`;
    return () => {
      document.title = baseTitle;
    };
  }, [unread]);
  useEffect(() => {
    const readVisibleThread = () => {
      const id = selectedId.current;
      if (document.visibilityState !== "visible" || viewRef.current !== "threads" || !id) return;
      setUnread((old) => {
        if (!old.has(id)) return old;
        const next = new Set(old);
        next.delete(id);
        return next;
      });
    };
    document.addEventListener("visibilitychange", readVisibleThread);
    return () => document.removeEventListener("visibilitychange", readVisibleThread);
  }, []);
  useEffect(() => {
    if (!selected || tab !== "chat") return;
    scrollConversationToLastMessage();
  }, [selected?.id, tab]);
  useEffect(() => {
    if (!selected || view !== "threads") return;
    const hash = `#${encodeURIComponent(selected.id)}`;
    if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
  }, [selected?.id, view]);
  useEffect(() => {
    if (selected || view !== "threads") return;
    const id = decodeURIComponent((window.location.hash ?? "").replace(/^#/, ""));
    const thread = threads.find((item) => item.id === id);
    if (thread) void selectThread(thread, { preserveHash: true });
  }, [threads, selected?.id, view]);
  useEffect(
    () => () => {
      if (interruptTimer.current) window.clearTimeout(interruptTimer.current);
    },
    [],
  );
  const codexGenerating =
    selected?.status === "running" || Boolean(selected?.messages.some((m) => m.role === "assistant" && m.streaming));
  useEffect(() => {
    if (codexGenerating) return;
    setInterruptArmedThreadId(undefined);
    if (interruptTimer.current) window.clearTimeout(interruptTimer.current);
    interruptTimer.current = undefined;
  }, [codexGenerating, selected?.id]);
  async function enableNotifications() {
    if (!("Notification" in window) || !notificationContextAvailable()) return;
    const permission = await Notification.requestPermission();
    setToast(permission === "granted" ? undefined : notificationProblem());
  }
  useEffect(() => {
    document.querySelector(".toast")?.remove();
    if (!toast) return;
    const element = document.createElement("div");
    element.className = "toast";
    element.setAttribute("role", "status");
    const message = document.createElement("span");
    message.textContent = toast;
    element.append(message);
    if ("Notification" in window && notificationContextAvailable() && Notification.permission === "default") {
      const enable = document.createElement("button");
      enable.textContent = "启用通知";
      enable.onclick = () => void enableNotifications();
      element.append(enable);
    }
    const close = document.createElement("button");
    close.className = "toast-close";
    close.setAttribute("aria-label", "关闭提醒");
    close.textContent = "×";
    close.onclick = () => setToast(undefined);
    element.append(close);
    document.body.append(element);
    return () => element.remove();
  }, [toast]);
  function selectedThreadIsVisible(threadId: string) {
    return selectedId.current === threadId && viewRef.current === "threads" && document.visibilityState === "visible";
  }
  function notifyUnreadThread(threadId: string, title: string, body: string) {
    if (selectedThreadIsVisible(threadId)) return;
    setUnread((old) => new Set(old).add(threadId));
    if ("Notification" in window && notificationContextAvailable() && Notification.permission === "granted") {
      const notice = new Notification(title, { body, tag: `cwb-${threadId}` });
      notice.onclick = () => {
        const thread = threadsRef.current.find((item) => item.id === threadId);
        window.focus();
        if (thread) {
          setView("threads");
          void selectThread(thread);
        }
        notice.close();
      };
    }
  }
  function conversationNearBottom() {
    const element = conversationRef.current;
    return !element || element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  }
  function scrollConversationToLastMessage() {
    const messages = conversationRef.current?.querySelectorAll<HTMLElement>("article");
    messages?.item(messages.length - 1)?.scrollIntoView?.({ block: "start" });
    setShowScrollHint(false);
  }
  const handleEvent = useCallback((event: ServerEvent) => {
    if (event.type === "snapshot") {
      threadStates.current.set(event.thread.id, event.thread.status);
      if (event.thread.id === selectedId.current) setSelected(event.thread);
    }
    if (event.type === "thread.updated") {
      const previous = threadStates.current.get(event.thread.id);
      threadStates.current.set(event.thread.id, event.thread.status);
      setThreads((old) => old.map((t) => (t.id === event.thread.id ? event.thread : t)));
      setSelected((old) => (old?.id === event.thread.id ? { ...old, ...event.thread } : old));
      const completed =
        (previous === "running" || previous === "waiting") &&
        (event.thread.status === "idle" || event.thread.status === "error");
      if (completed)
        notifyUnreadThread(
          event.thread.id,
          event.thread.status === "error" ? "Codex 会话执行失败" : "Codex 已完成回答",
          event.thread.title,
        );
      if (event.thread.status === "waiting")
        notifyUnreadThread(event.thread.id, "Codex 需要你操作", event.thread.title);
    }
    if (event.type === "thread.deleted") {
      setThreads((old) => old.filter((t) => t.id !== event.threadId));
      setSelected((old) => (old?.id === event.threadId ? undefined : old));
    }
    if (event.type === "message.created") {
      if (event.threadId === selectedId.current && event.message.role === "assistant" && !conversationNearBottom())
        setShowScrollHint(true);
      setSelected((old) => (old?.id === event.threadId ? { ...old, messages: [...old.messages, event.message] } : old));
    }
    if (event.type === "message.delta") {
      if (event.threadId === selectedId.current && !conversationNearBottom()) setShowScrollHint(true);
      setSelected((old) =>
        old?.id === event.threadId
          ? {
              ...old,
              messages: old.messages.map((m) =>
                m.id === event.messageId ? { ...m, text: m.text + event.delta, streaming: true } : m,
              ),
            }
          : old,
      );
    }
    if (event.type === "message.completed")
      setSelected((old) =>
        old?.id === event.threadId
          ? { ...old, messages: old.messages.map((m) => (m.id === event.messageId ? { ...m, streaming: false } : m)) }
          : old,
      );
    if (event.type === "request.created")
      setSelected((old) =>
        old?.id === event.threadId ? { ...old, pendingRequests: [...old.pendingRequests, event.request] } : old,
      );
    if (event.type === "request.resolved")
      setSelected((old) =>
        old?.id === event.threadId
          ? { ...old, pendingRequests: old.pendingRequests.filter((r) => r.requestId !== event.requestId) }
          : old,
      );
    if (event.type === "terminal.data" && event.threadId === selectedId.current)
      setTerminalData((old) => [...old, event.data]);
    if (event.type === "terminal.state")
      setSelected((old) =>
        old?.id === event.threadId
          ? { ...old, terminal: { connected: event.connected, takeover: event.takeover, owner: event.owner } }
          : old,
      );
  }, []);
  useThreadEvents(
    threads.map((thread) => thread.id),
    handleEvent,
  );
  async function selectThread(thread: ThreadSummary, options: { preserveHash?: boolean } = {}) {
    setUnread((old) => {
      const next = new Set(old);
      next.delete(thread.id);
      return next;
    });
    setTerminalData([]);
    setScreenshot(undefined);
    setOperationError("");
    setSelected(await api.thread(thread.id));
    if (!options.preserveHash) window.history.replaceState(null, "", `#${encodeURIComponent(thread.id)}`);
    setNavigationOpen(false);
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!selected || !draft.trim()) return;
    const text = draft.trim();
    setDraft("");
    await api.sendMessage(selected.id, { text });
  }
  async function resolve(request: PendingRequest, value: ResolveRequest) {
    if (selected) await api.resolve(selected.id, request.requestId, value);
  }
  async function interruptSelected() {
    if (!selected || !codexGenerating) return;
    if (interruptArmedThreadId !== selected.id) {
      setInterruptArmedThreadId(selected.id);
      if (interruptTimer.current) window.clearTimeout(interruptTimer.current);
      interruptTimer.current = window.setTimeout(() => setInterruptArmedThreadId(undefined), 3000);
      return;
    }
    if (interruptTimer.current) window.clearTimeout(interruptTimer.current);
    interruptTimer.current = undefined;
    setInterruptArmedThreadId(undefined);
    await api.interrupt(selected.id);
  }
  async function exitSelected() {
    if (!selected || exiting || !confirm("退出运行中的会话？历史记录不会被删除。")) return;
    setExiting(true);
    setOperationError("");
    try {
      await api.exitThread(selected.id);
      setSelected((old) =>
        old?.id === selected.id
          ? { ...old, status: "exited", terminal: { ...old.terminal, connected: false, takeover: false } }
          : old,
      );
      void load().catch(() => undefined);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "退出会话失败");
    } finally {
      setExiting(false);
    }
  }
  async function resumeSelected() {
    if (!selected || resuming) return;
    setResuming(true);
    setOperationError("");
    try {
      const resumed = await api.resumeExitedThread(selected.id);
      setSelected(resumed);
      setThreads((old) => old.map((thread) => (thread.id === resumed.id ? resumed : thread)));
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "恢复会话失败");
    } finally {
      setResuming(false);
    }
  }
  async function deleteThread(thread: ThreadSummary) {
    if (!confirm(`从 CWB 中删除会话“${thread.title}”？Codex 自身的会话记录不会被删除。`)) return;
    const previousThreads = threads;
    const previousSelected = selected;
    setThreads((old) => old.filter((item) => item.id !== thread.id));
    setSelected((old) => (old?.id === thread.id ? undefined : old));
    try {
      await api.deleteThread(thread.id);
    } catch (error) {
      setThreads(previousThreads);
      setSelected(previousSelected);
      setOperationError(error instanceof Error ? error.message : "删除会话失败");
    }
  }
  const terminalInput = useCallback(
    (data: string) => {
      if (selected?.terminal.takeover) void api.terminalInput(selected.id, data);
    },
    [selected],
  );
  if (authenticated === undefined) return <main className="center">正在建立安全会话…</main>;
  if (!authenticated)
    return (
      <Login
        onLogin={() => {
          setAuthenticated(true);
          void load();
        }}
      />
    );
  return (
    <div className="shell">
      <aside className={navigationOpen ? "open" : ""}>
        <div className="sidebar-heading">
          <div className="brand">Codex Bridge</div>
          <button className="mobile-close secondary" aria-label="关闭导航" onClick={() => setNavigationOpen(false)}>
            ×
          </button>
        </div>
        <div className="toolbar">
          <button
            onClick={() => {
              setView("threads");
              setDialog("create");
            }}
          >
            ＋ 新会话
          </button>
          <button
            className="secondary"
            onClick={() => {
              setView("threads");
              setDialog("resume");
            }}
          >
            恢复
          </button>
        </div>
        <div className="section-title">
          <h3>主机</h3>
          <button className="icon-button secondary" aria-label="添加主机" onClick={() => setHostDialog("new")}>
            ＋
          </button>
        </div>
        {hosts.map((h) => (
          <button className="host" key={h.id} onClick={() => setHostDialog(h)}>
            <i className={h.status} />
            <span>{h.name}</span>
            <small>{h.address}</small>
          </button>
        ))}
        <h3>会话</h3>
        <nav>
          {threads.map((t) => (
            <div
              className={`thread-row ${selected?.id === t.id && view === "threads" ? "active" : ""} ${
                unread.has(t.id) ? "unread" : ""
              } ${t.status === "waiting" ? "waiting" : ""}`}
              key={t.id}
            >
              <button
                className="thread-select"
                onClick={() => {
                  setView("threads");
                  void selectThread(t);
                }}
              >
                <span>{t.title}</span>
                <small>
                  {t.status} · {t.cwd}
                </small>
              </button>
              <button className="thread-delete" aria-label={`删除会话 ${t.title}`} onClick={() => void deleteThread(t)}>
                ×
              </button>
            </div>
          ))}
        </nav>
        <button
          className={`sidebar-settings ${view === "settings" ? "active" : ""}`}
          onClick={() => {
            setView("settings");
            setNavigationOpen(false);
          }}
        >
          设置
        </button>
        <button className="logout" onClick={() => void api.logout().then(() => setAuthenticated(false))}>
          退出登录
        </button>
      </aside>
      {navigationOpen && (
        <button className="navigation-backdrop" aria-label="关闭导航" onClick={() => setNavigationOpen(false)} />
      )}
      <main className="workspace">
        <button className="mobile-nav-toggle secondary" onClick={() => setNavigationOpen(true)}>
          ☰ 主机与会话
        </button>
        {view === "settings" ? (
          <SettingsPanel />
        ) : selected ? (
          <>
            <header>
              <div>
                <h1>{selected.title}</h1>
                <p>
                  {selected.cwd} · {selected.status}
                  {selected.model ? ` · 模型：${selected.model}` : ""}
                </p>
              </div>
              <div className="actions">
                <button className={tab === "chat" ? "" : "secondary"} onClick={() => setTab("chat")}>
                  对话
                </button>
                <button className={tab === "terminal" ? "" : "secondary"} onClick={() => setTab("terminal")}>
                  终端
                </button>
                {selected.status === "exited" ? (
                  <button disabled={resuming} onClick={() => void resumeSelected()}>
                    {resuming ? "恢复中…" : "恢复会话"}
                  </button>
                ) : (
                  <button className="danger" disabled={exiting} onClick={() => void exitSelected()}>
                    {exiting ? "退出中…" : "退出会话"}
                  </button>
                )}
              </div>
            </header>
            {operationError && <div className="operation-error error">{operationError}</div>}
            {tab === "chat" ? (
              <>
                {selected.pendingRequests.length > 0 && (
                  <button className="attention-banner waiting" type="button" onClick={scrollConversationToLastMessage}>
                    需要你处理权限或输入请求
                  </button>
                )}
                <div
                  className="conversation"
                  ref={conversationRef}
                  onScroll={() => {
                    if (conversationNearBottom()) setShowScrollHint(false);
                  }}
                >
                  {selected.messages.map((m) => (
                    <article className={m.role} key={m.id}>
                      <label>
                        {m.role === "assistant" ? "Codex" : m.role === "user" ? "你" : "系统"}
                        {m.streaming && <em>生成中</em>}
                      </label>
                      <div>{m.text}</div>
                    </article>
                  ))}
                  {selected.pendingRequests.map((r) => (
                    <RequestCard key={r.requestId} request={r} onResolve={(v) => void resolve(r, v)} />
                  ))}
                </div>
                {showScrollHint && (
                  <button className="scroll-hint" type="button" onClick={scrollConversationToLastMessage}>
                    有新回复，向下滑动查看
                  </button>
                )}
                <form className="composer" onSubmit={send}>
                  <textarea
                    disabled={selected.status === "exited"}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={selected.status === "exited" ? "该会话已退出" : "继续对话…"}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        e.currentTarget.form?.requestSubmit();
                      }
                    }}
                  />
                  <div>
                    {codexGenerating && (
                      <button type="button" className="danger" onClick={() => void interruptSelected()}>
                        {interruptArmedThreadId === selected.id ? "再次点击中断" : "中断"}
                      </button>
                    )}
                    <button disabled={selected.status === "exited" || !draft.trim()}>发送</button>
                  </div>
                </form>
              </>
            ) : (
              <div className="terminal-panel">
                <div className="terminal-toolbar">
                  <span>
                    {selected.terminal.connected ? "已连接" : "未连接"} ·{" "}
                    {selected.terminal.takeover
                      ? `接管中${selected.terminal.owner ? ` (${selected.terminal.owner})` : ""}`
                      : "只读"}
                  </span>
                  <div className="actions">
                    <button className="secondary" onClick={() => setScreenshot(api.screenshotUrl(selected.id))}>
                      截图
                    </button>
                    <button
                      disabled={selected.status === "exited" || !selected.terminal.connected}
                      className={selected.terminal.takeover ? "danger" : ""}
                      onClick={() => void api.takeover(selected.id, !selected.terminal.takeover)}
                    >
                      {selected.terminal.takeover ? "结束接管" : "显式接管"}
                    </button>
                  </div>
                </div>
                <Terminal data={terminalData} writable={selected.terminal.takeover} onInput={terminalInput} />
                {screenshot && (
                  <div className="screenshot">
                    <button onClick={() => setScreenshot(undefined)}>关闭</button>
                    <img src={screenshot} alt="终端截图" />
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <section className="empty">
            <h1>选择一个会话</h1>
            <p>查看 Codex 输出，继续对话或恢复历史线程。</p>
          </section>
        )}
      </main>
      {dialog && (
        <CreateDialog
          hosts={hosts}
          mode={dialog}
          onClose={() => setDialog(undefined)}
          onDone={(thread) => {
            setDialog(undefined);
            setThreads((old) => [thread, ...old]);
            setSelected(thread);
            setView("threads");
            setNavigationOpen(false);
          }}
        />
      )}
      {hostDialog && (
        <HostDialog
          host={hostDialog === "new" ? undefined : hostDialog}
          onClose={() => setHostDialog(undefined)}
          onSaved={() => {
            setHostDialog(undefined);
            void load();
          }}
        />
      )}
    </div>
  );
}
