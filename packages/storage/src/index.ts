import { chmodSync } from "node:fs";
import BetterSqlite3 from "better-sqlite3";

interface Statement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface DatabaseConnection {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

interface DatabaseConstructor {
  new (path: string): DatabaseConnection;
}

const Database = BetterSqlite3 as unknown as DatabaseConstructor;

export interface SessionRecord {
  id: string;
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
}
export interface HostRecord {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  hostKeySha256: string;
  identityFile: string;
  prependPath?: string;
  createdAt: number;
}
export interface ThreadRecord {
  id: string;
  hostId: string;
  codexThreadId?: string;
  tmuxSession: string;
  remotePort?: number;
  workingDirectory: string;
  proxy?: string;
  prependPath?: string;
  model?: string;
  title: string;
  status: string;
  hasRollout?: number;
  createdAt: number;
  updatedAt: number;
}
export interface MessageRecord {
  id: string;
  threadId: string;
  role: string;
  text: string;
  streaming: number;
  createdAt: number;
}
export interface PendingRecord {
  id: string;
  threadId: string;
  payload: string;
  rpcId: string;
  method: string;
  params: string;
  resolvedAt?: number;
  createdAt: number;
}
export interface ThreadCreateDefaultsRecord {
  lastHostId?: string;
  hosts: ThreadCreateHostDefaultsRecord[];
  cwdHistory: string[];
}
export interface ThreadCreateHostDefaultsRecord {
  hostId: string;
  cwd: string;
  proxy?: string;
  prependPath?: string;
  updatedAt: number;
}

export class Storage {
  readonly db: DatabaseConnection;
  constructor(path: string) {
    this.db = new Database(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS login_sessions (
        id TEXT PRIMARY KEY,
        csrf_token TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hosts (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, hostname TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 22, username TEXT NOT NULL,
        host_key_sha256 TEXT NOT NULL, identity_file TEXT NOT NULL, prepend_path TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES hosts(id),
        codex_thread_id TEXT, tmux_session TEXT NOT NULL UNIQUE, remote_port INTEGER,
        working_directory TEXT NOT NULL, proxy TEXT, prepend_path TEXT, title TEXT NOT NULL, status TEXT NOT NULL, has_rollout INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS threads_host_id ON threads(host_id);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL, text TEXT NOT NULL, streaming INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_requests (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        payload TEXT NOT NULL, rpc_id TEXT NOT NULL DEFAULT 'null', method TEXT NOT NULL DEFAULT '', params TEXT NOT NULL DEFAULT '{}', resolved_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_create_defaults (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        host_id TEXT NOT NULL, cwd TEXT NOT NULL, proxy TEXT, prepend_path TEXT
      );
      CREATE TABLE IF NOT EXISTS thread_create_preferences (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        last_host_id TEXT
      );
      CREATE TABLE IF NOT EXISTS thread_create_host_defaults (
        host_id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL, proxy TEXT, prepend_path TEXT, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_create_cwd_history (
        cwd TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL
      );
    `);
    const hostColumns = this.db.prepare("PRAGMA table_info(hosts)").all() as Array<{ name: string }>;
    if (!hostColumns.some((column) => column.name === "prepend_path")) {
      this.db.exec("ALTER TABLE hosts ADD COLUMN prepend_path TEXT");
      if (hostColumns.some((column) => column.name === "path_env"))
        this.db.exec("UPDATE hosts SET prepend_path=path_env WHERE path_env IS NOT NULL");
    }
    const threadColumns = this.db.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>;
    if (!threadColumns.some((column) => column.name === "title"))
      this.db.exec("ALTER TABLE threads ADD COLUMN title TEXT NOT NULL DEFAULT 'Codex thread'");
    if (!threadColumns.some((column) => column.name === "remote_port"))
      this.db.exec("ALTER TABLE threads ADD COLUMN remote_port INTEGER");
    if (!threadColumns.some((column) => column.name === "proxy"))
      this.db.exec("ALTER TABLE threads ADD COLUMN proxy TEXT");
    if (!threadColumns.some((column) => column.name === "prepend_path"))
      this.db.exec("ALTER TABLE threads ADD COLUMN prepend_path TEXT");
    if (!threadColumns.some((column) => column.name === "has_rollout")) {
      this.db.exec("ALTER TABLE threads ADD COLUMN has_rollout INTEGER NOT NULL DEFAULT 0");
      this.db.exec(
        "UPDATE threads SET has_rollout=1 WHERE title LIKE 'Resume %' OR EXISTS (SELECT 1 FROM messages WHERE messages.thread_id=threads.id)",
      );
    }
    if (!threadColumns.some((column) => column.name === "model"))
      this.db.exec("ALTER TABLE threads ADD COLUMN model TEXT");
    const pendingColumns = this.db.prepare("PRAGMA table_info(pending_requests)").all() as Array<{ name: string }>;
    if (!pendingColumns.some((column) => column.name === "rpc_id"))
      this.db.exec("ALTER TABLE pending_requests ADD COLUMN rpc_id TEXT NOT NULL DEFAULT 'null'");
    if (!pendingColumns.some((column) => column.name === "method"))
      this.db.exec("ALTER TABLE pending_requests ADD COLUMN method TEXT NOT NULL DEFAULT ''");
    if (!pendingColumns.some((column) => column.name === "params"))
      this.db.exec("ALTER TABLE pending_requests ADD COLUMN params TEXT NOT NULL DEFAULT '{}'");
    this.migrateThreadCreateDefaults();
  }
  createSession(session: SessionRecord): void {
    this.db
      .prepare("INSERT INTO login_sessions(id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(session.id, session.csrfToken, session.createdAt, session.expiresAt);
  }
  session(id: string, now = Date.now()): SessionRecord | undefined {
    return this.db
      .prepare(
        "SELECT id, csrf_token AS csrfToken, created_at AS createdAt, expires_at AS expiresAt FROM login_sessions WHERE id = ? AND expires_at > ?",
      )
      .get(id, now) as SessionRecord | undefined;
  }
  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM login_sessions WHERE id = ?").run(id);
  }
  deleteAllSessions(): void {
    this.db.prepare("DELETE FROM login_sessions").run();
  }
  pruneSessions(now = Date.now()): void {
    this.db.prepare("DELETE FROM login_sessions WHERE expires_at <= ?").run(now);
  }
  hosts(): HostRecord[] {
    return this.db
      .prepare(
        "SELECT id,name,hostname,port,username,host_key_sha256 AS hostKeySha256,identity_file AS identityFile,prepend_path AS prependPath,created_at AS createdAt FROM hosts ORDER BY name",
      )
      .all() as HostRecord[];
  }
  host(id: string): HostRecord | undefined {
    return this.db
      .prepare(
        "SELECT id,name,hostname,port,username,host_key_sha256 AS hostKeySha256,identity_file AS identityFile,prepend_path AS prependPath,created_at AS createdAt FROM hosts WHERE id=?",
      )
      .get(id) as HostRecord | undefined;
  }
  upsertHost(host: HostRecord): void {
    this.db
      .prepare(
        "INSERT INTO hosts(id,name,hostname,port,username,host_key_sha256,identity_file,prepend_path,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,hostname=excluded.hostname,port=excluded.port,username=excluded.username,host_key_sha256=excluded.host_key_sha256,identity_file=excluded.identity_file,prepend_path=excluded.prepend_path",
      )
      .run(
        host.id,
        host.name,
        host.hostname,
        host.port,
        host.username,
        host.hostKeySha256,
        host.identityFile,
        host.prependPath ?? null,
        host.createdAt,
      );
  }
  deleteHost(id: string): boolean {
    const deleted = this.db.prepare("DELETE FROM hosts WHERE id=?").run(id).changes === 1;
    if (deleted) {
      this.db.prepare("DELETE FROM thread_create_defaults WHERE host_id=?").run(id);
      this.db.prepare("DELETE FROM thread_create_host_defaults WHERE host_id=?").run(id);
      this.db
        .prepare("UPDATE thread_create_preferences SET last_host_id=NULL WHERE singleton=1 AND last_host_id=?")
        .run(id);
    }
    return deleted;
  }
  threads(): ThreadRecord[] {
    return this.db
      .prepare(
        "SELECT id,host_id AS hostId,codex_thread_id AS codexThreadId,tmux_session AS tmuxSession,remote_port AS remotePort,working_directory AS workingDirectory,proxy,prepend_path AS prependPath,model,title,status,has_rollout AS hasRollout,created_at AS createdAt,updated_at AS updatedAt FROM threads ORDER BY updated_at DESC",
      )
      .all() as ThreadRecord[];
  }
  thread(id: string): ThreadRecord | undefined {
    return this.db
      .prepare(
        "SELECT id,host_id AS hostId,codex_thread_id AS codexThreadId,tmux_session AS tmuxSession,remote_port AS remotePort,working_directory AS workingDirectory,proxy,prepend_path AS prependPath,model,title,status,has_rollout AS hasRollout,created_at AS createdAt,updated_at AS updatedAt FROM threads WHERE id=?",
      )
      .get(id) as ThreadRecord | undefined;
  }
  createThread(thread: ThreadRecord): void {
    this.db
      .prepare(
        "INSERT INTO threads(id,host_id,codex_thread_id,tmux_session,remote_port,working_directory,proxy,prepend_path,model,title,status,has_rollout,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        thread.id,
        thread.hostId,
        thread.codexThreadId ?? null,
        thread.tmuxSession,
        thread.remotePort ?? null,
        thread.workingDirectory,
        thread.proxy ?? null,
        thread.prependPath ?? null,
        thread.model ?? null,
        thread.title,
        thread.status,
        thread.hasRollout ?? 0,
        thread.createdAt,
        thread.updatedAt,
      );
  }
  updateThread(
    id: string,
    update: {
      codexThreadId?: string;
      remotePort?: number;
      model?: string;
      status?: string;
      hasRollout?: number;
      updatedAt: number;
    },
  ): void {
    this.db
      .prepare(
        "UPDATE threads SET codex_thread_id=COALESCE(?,codex_thread_id),remote_port=COALESCE(?,remote_port),model=COALESCE(?,model),status=COALESCE(?,status),has_rollout=COALESCE(?,has_rollout),updated_at=? WHERE id=?",
      )
      .run(
        update.codexThreadId ?? null,
        update.remotePort ?? null,
        update.model ?? null,
        update.status ?? null,
        update.hasRollout ?? null,
        update.updatedAt,
        id,
      );
  }
  deleteThread(id: string): boolean {
    return this.db.prepare("DELETE FROM threads WHERE id=?").run(id).changes === 1;
  }
  messages(threadId: string): MessageRecord[] {
    return this.db
      .prepare(
        "SELECT id,thread_id AS threadId,role,text,streaming,created_at AS createdAt FROM messages WHERE thread_id=? ORDER BY created_at,id",
      )
      .all(threadId) as MessageRecord[];
  }
  putMessage(message: MessageRecord): void {
    this.db
      .prepare(
        "INSERT INTO messages(id,thread_id,role,text,streaming,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text,streaming=excluded.streaming",
      )
      .run(message.id, message.threadId, message.role, message.text, message.streaming, message.createdAt);
  }
  appendMessage(id: string, text: string, streaming: boolean): void {
    this.db.prepare("UPDATE messages SET text=text||?,streaming=? WHERE id=?").run(text, streaming ? 1 : 0, id);
  }
  pending(threadId: string): PendingRecord[] {
    return this.db
      .prepare(
        "SELECT id,thread_id AS threadId,payload,rpc_id AS rpcId,method,params,resolved_at AS resolvedAt,created_at AS createdAt FROM pending_requests WHERE thread_id=? AND resolved_at IS NULL ORDER BY created_at",
      )
      .all(threadId) as PendingRecord[];
  }
  pendingById(id: string, threadId: string): PendingRecord | undefined {
    return this.db
      .prepare(
        "SELECT id,thread_id AS threadId,payload,rpc_id AS rpcId,method,params,resolved_at AS resolvedAt,created_at AS createdAt FROM pending_requests WHERE id=? AND thread_id=? AND resolved_at IS NULL",
      )
      .get(id, threadId) as PendingRecord | undefined;
  }
  putPending(request: PendingRecord): void {
    this.db
      .prepare(
        "INSERT INTO pending_requests(id,thread_id,payload,rpc_id,method,params,resolved_at,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        request.id,
        request.threadId,
        request.payload,
        request.rpcId,
        request.method,
        request.params,
        request.resolvedAt ?? null,
        request.createdAt,
      );
  }
  resolvePending(id: string, threadId: string, now = Date.now()): boolean {
    return (
      this.db
        .prepare("UPDATE pending_requests SET resolved_at=? WHERE id=? AND thread_id=? AND resolved_at IS NULL")
        .run(now, id, threadId).changes === 1
    );
  }
  resolveAllPending(threadId: string, now = Date.now()): string[] {
    const ids = (
      this.db
        .prepare("SELECT id FROM pending_requests WHERE thread_id=? AND resolved_at IS NULL")
        .all(threadId) as Array<{ id: string }>
    ).map((row) => row.id);
    if (ids.length)
      this.db
        .prepare("UPDATE pending_requests SET resolved_at=? WHERE thread_id=? AND resolved_at IS NULL")
        .run(now, threadId);
    return ids;
  }
  private migrateThreadCreateDefaults(): void {
    const migrated = this.db.prepare("SELECT COUNT(*) AS count FROM thread_create_host_defaults").get() as
      { count: number } | undefined;
    if (migrated?.count) return;
    const old = this.db
      .prepare(
        "SELECT host_id AS hostId,cwd,proxy,prepend_path AS prependPath FROM thread_create_defaults WHERE singleton=1",
      )
      .get() as { hostId: string; cwd: string; proxy: string | null; prependPath: string | null } | undefined;
    if (!old) return;
    const now = Date.now();
    this.db
      .prepare("INSERT OR IGNORE INTO thread_create_preferences(singleton,last_host_id) VALUES(1,?)")
      .run(old.hostId);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO thread_create_host_defaults(host_id,cwd,proxy,prepend_path,updated_at) VALUES(?,?,?,?,?)",
      )
      .run(old.hostId, old.cwd, old.proxy, old.prependPath, now);
    this.db.prepare("INSERT OR IGNORE INTO thread_create_cwd_history(cwd,updated_at) VALUES(?,?)").run(old.cwd, now);
  }
  threadCreateDefaults(): ThreadCreateDefaultsRecord | undefined {
    const preferences = this.db
        .prepare("SELECT last_host_id AS lastHostId FROM thread_create_preferences WHERE singleton=1")
        .get() as { lastHostId: string | null } | undefined,
      hosts = this.db
        .prepare(
          "SELECT host_id AS hostId,cwd,proxy,prepend_path AS prependPath,updated_at AS updatedAt FROM thread_create_host_defaults ORDER BY updated_at DESC",
        )
        .all() as Array<{
        hostId: string;
        cwd: string;
        proxy: string | null;
        prependPath: string | null;
        updatedAt: number;
      }>,
      cwdHistory = (
        this.db.prepare("SELECT cwd FROM thread_create_cwd_history ORDER BY updated_at DESC").all() as Array<{
          cwd: string;
        }>
      ).map((row) => row.cwd);
    if (!preferences?.lastHostId && hosts.length === 0 && cwdHistory.length === 0) return undefined;
    return {
      ...(preferences?.lastHostId ? { lastHostId: preferences.lastHostId } : {}),
      hosts: hosts.map((value) => ({
        hostId: value.hostId,
        cwd: value.cwd,
        ...(value.proxy ? { proxy: value.proxy } : {}),
        ...(value.prependPath ? { prependPath: value.prependPath } : {}),
        updatedAt: value.updatedAt,
      })),
      cwdHistory,
    };
  }
  saveThreadCreateDefaults(value: ThreadCreateHostDefaultsRecord): void {
    this.db
      .prepare(
        "INSERT INTO thread_create_preferences(singleton,last_host_id) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET last_host_id=excluded.last_host_id",
      )
      .run(value.hostId);
    this.db
      .prepare(
        "INSERT INTO thread_create_host_defaults(host_id,cwd,proxy,prepend_path,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(host_id) DO UPDATE SET cwd=excluded.cwd,proxy=excluded.proxy,prepend_path=excluded.prepend_path,updated_at=excluded.updated_at",
      )
      .run(value.hostId, value.cwd, value.proxy ?? null, value.prependPath ?? null, value.updatedAt);
    this.db
      .prepare(
        "INSERT INTO thread_create_cwd_history(cwd,updated_at) VALUES(?,?) ON CONFLICT(cwd) DO UPDATE SET updated_at=excluded.updated_at",
      )
      .run(value.cwd, value.updatedAt);
  }
  deleteThreadCreateCwd(cwd: string): boolean {
    return this.db.prepare("DELETE FROM thread_create_cwd_history WHERE cwd=?").run(cwd).changes === 1;
  }
  close(): void {
    this.db.close();
  }
}
