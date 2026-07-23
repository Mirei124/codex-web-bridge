import { useEffect, useState } from "react";
import type { HostSummary } from "@cwb/protocol";
import { api } from "./api";
import { HostDialog } from "./App";

export function HostManager() {
  const [authenticated, setAuthenticated] = useState(false);
  const [hosts, setHosts] = useState<HostSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<HostSummary | "new">();
  async function refresh() { setHosts(await api.hosts()); }
  useEffect(() => {
    if (location.protocol !== "https:") return;
    const update = () => api.session().then(session => { setAuthenticated(session.authenticated); if (session.authenticated) void refresh(); }).catch(() => setAuthenticated(false));
    void update(); window.addEventListener("cwb-auth-changed", update);
    return () => window.removeEventListener("cwb-auth-changed", update);
  }, []);
  if (!authenticated) return null;
  return <><button className="host-manager-button" onClick={() => setOpen(true)}>主机配置</button>{open && !editing && <div className="host-manager-list"><strong>已配置主机</strong>{hosts.map(host => <button key={host.id} onClick={() => setEditing(host)}><i className={host.status} />{host.name}<small>{host.status}</small></button>)}<button onClick={() => setEditing("new")}>＋ 新增主机</button><button className="secondary" onClick={() => setOpen(false)}>关闭</button></div>}{editing && <HostDialog host={editing === "new" ? undefined : editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); void refresh(); }} />}</>;
}
