import { chmodSync } from "node:fs";

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
  new(path: string): DatabaseConnection;
}

const Database = (process.versions.bun
  ? (await import("bun:sqlite")).Database
  : (await import("better-sqlite3")).default) as DatabaseConstructor;

export interface SessionRecord { id: string; csrfToken: string; createdAt: number; expiresAt: number }
export interface HostRecord { id: string; name: string; hostname: string; port: number; username: string; hostKeySha256: string; identityFile: string; prependPath?: string; createdAt: number }
export interface ThreadRecord { id: string; hostId: string; codexThreadId?: string; tmuxSession: string; remotePort?: number; workingDirectory: string; proxy?: string; prependPath?: string; title: string; status: string; createdAt: number; updatedAt: number }
export interface MessageRecord { id: string; threadId: string; role: string; text: string; streaming: number; createdAt: number }
export interface PendingRecord { id: string; threadId: string; payload: string; rpcId: string; method: string; params: string; resolvedAt?: number; createdAt: number }

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
        working_directory TEXT NOT NULL, proxy TEXT, prepend_path TEXT, title TEXT NOT NULL, status TEXT NOT NULL,
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
    `);
    const hostColumns = this.db.prepare("PRAGMA table_info(hosts)").all() as Array<{ name: string }>;
    if (!hostColumns.some(column => column.name === "prepend_path")) {
      this.db.exec("ALTER TABLE hosts ADD COLUMN prepend_path TEXT");
      if (hostColumns.some(column => column.name === "path_env")) this.db.exec("UPDATE hosts SET prepend_path=path_env WHERE path_env IS NOT NULL");
    }
    const threadColumns = this.db.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>;
    if (!threadColumns.some(column => column.name === "title")) this.db.exec("ALTER TABLE threads ADD COLUMN title TEXT NOT NULL DEFAULT 'Codex thread'");
    if (!threadColumns.some(column => column.name === "remote_port")) this.db.exec("ALTER TABLE threads ADD COLUMN remote_port INTEGER");
    if (!threadColumns.some(column => column.name === "proxy")) this.db.exec("ALTER TABLE threads ADD COLUMN proxy TEXT");
    if (!threadColumns.some(column => column.name === "prepend_path")) this.db.exec("ALTER TABLE threads ADD COLUMN prepend_path TEXT");
    const pendingColumns=this.db.prepare("PRAGMA table_info(pending_requests)").all() as Array<{name:string}>;
    if(!pendingColumns.some(column=>column.name==="rpc_id"))this.db.exec("ALTER TABLE pending_requests ADD COLUMN rpc_id TEXT NOT NULL DEFAULT 'null'");
    if(!pendingColumns.some(column=>column.name==="method"))this.db.exec("ALTER TABLE pending_requests ADD COLUMN method TEXT NOT NULL DEFAULT ''");
    if(!pendingColumns.some(column=>column.name==="params"))this.db.exec("ALTER TABLE pending_requests ADD COLUMN params TEXT NOT NULL DEFAULT '{}'");
  }
  createSession(session: SessionRecord): void {
    this.db.prepare("INSERT INTO login_sessions(id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(session.id, session.csrfToken, session.createdAt, session.expiresAt);
  }
  session(id: string, now = Date.now()): SessionRecord | undefined {
    return this.db.prepare("SELECT id, csrf_token AS csrfToken, created_at AS createdAt, expires_at AS expiresAt FROM login_sessions WHERE id = ? AND expires_at > ?")
      .get(id, now) as SessionRecord | undefined;
  }
  deleteSession(id: string): void { this.db.prepare("DELETE FROM login_sessions WHERE id = ?").run(id); }
  deleteAllSessions(): void { this.db.prepare("DELETE FROM login_sessions").run(); }
  pruneSessions(now = Date.now()): void { this.db.prepare("DELETE FROM login_sessions WHERE expires_at <= ?").run(now); }
  hosts(): HostRecord[] { return this.db.prepare("SELECT id,name,hostname,port,username,host_key_sha256 AS hostKeySha256,identity_file AS identityFile,prepend_path AS prependPath,created_at AS createdAt FROM hosts ORDER BY name").all() as HostRecord[]; }
  host(id: string): HostRecord | undefined { return this.db.prepare("SELECT id,name,hostname,port,username,host_key_sha256 AS hostKeySha256,identity_file AS identityFile,prepend_path AS prependPath,created_at AS createdAt FROM hosts WHERE id=?").get(id) as HostRecord | undefined; }
  upsertHost(host: HostRecord): void { this.db.prepare("INSERT INTO hosts(id,name,hostname,port,username,host_key_sha256,identity_file,prepend_path,created_at) VALUES(@id,@name,@hostname,@port,@username,@hostKeySha256,@identityFile,@prependPath,@createdAt) ON CONFLICT(id) DO UPDATE SET name=excluded.name,hostname=excluded.hostname,port=excluded.port,username=excluded.username,host_key_sha256=excluded.host_key_sha256,identity_file=excluded.identity_file,prepend_path=excluded.prepend_path").run({ ...host, prependPath: host.prependPath ?? null }); }
  threads(): ThreadRecord[] { return this.db.prepare("SELECT id,host_id AS hostId,codex_thread_id AS codexThreadId,tmux_session AS tmuxSession,remote_port AS remotePort,working_directory AS workingDirectory,proxy,prepend_path AS prependPath,title,status,created_at AS createdAt,updated_at AS updatedAt FROM threads ORDER BY updated_at DESC").all() as ThreadRecord[]; }
  thread(id: string): ThreadRecord | undefined { return this.db.prepare("SELECT id,host_id AS hostId,codex_thread_id AS codexThreadId,tmux_session AS tmuxSession,remote_port AS remotePort,working_directory AS workingDirectory,proxy,prepend_path AS prependPath,title,status,created_at AS createdAt,updated_at AS updatedAt FROM threads WHERE id=?").get(id) as ThreadRecord | undefined; }
  createThread(thread: ThreadRecord): void { this.db.prepare("INSERT INTO threads(id,host_id,codex_thread_id,tmux_session,remote_port,working_directory,proxy,prepend_path,title,status,created_at,updated_at) VALUES(@id,@hostId,@codexThreadId,@tmuxSession,@remotePort,@workingDirectory,@proxy,@prependPath,@title,@status,@createdAt,@updatedAt)").run({ ...thread, codexThreadId: thread.codexThreadId ?? null, remotePort: thread.remotePort ?? null, proxy: thread.proxy ?? null, prependPath: thread.prependPath ?? null }); }
  updateThread(id: string, update: { codexThreadId?: string; remotePort?: number; status?: string; updatedAt: number }): void { this.db.prepare("UPDATE threads SET codex_thread_id=COALESCE(@codexThreadId,codex_thread_id),remote_port=COALESCE(@remotePort,remote_port),status=COALESCE(@status,status),updated_at=@updatedAt WHERE id=@id").run({ id, codexThreadId: update.codexThreadId ?? null, remotePort:update.remotePort??null,status: update.status ?? null, updatedAt: update.updatedAt }); }
  deleteThread(id: string): boolean { return this.db.prepare("DELETE FROM threads WHERE id=?").run(id).changes === 1; }
  messages(threadId: string): MessageRecord[] { return this.db.prepare("SELECT id,thread_id AS threadId,role,text,streaming,created_at AS createdAt FROM messages WHERE thread_id=? ORDER BY created_at,id").all(threadId) as MessageRecord[]; }
  putMessage(message: MessageRecord): void { this.db.prepare("INSERT INTO messages(id,thread_id,role,text,streaming,created_at) VALUES(@id,@threadId,@role,@text,@streaming,@createdAt) ON CONFLICT(id) DO UPDATE SET text=excluded.text,streaming=excluded.streaming").run(message); }
  appendMessage(id: string, text: string, streaming: boolean): void { this.db.prepare("UPDATE messages SET text=text||?,streaming=? WHERE id=?").run(text,streaming?1:0,id); }
  pending(threadId: string): PendingRecord[] { return this.db.prepare("SELECT id,thread_id AS threadId,payload,rpc_id AS rpcId,method,params,resolved_at AS resolvedAt,created_at AS createdAt FROM pending_requests WHERE thread_id=? AND resolved_at IS NULL ORDER BY created_at").all(threadId) as PendingRecord[]; }
  pendingById(id:string,threadId:string):PendingRecord|undefined{return this.db.prepare("SELECT id,thread_id AS threadId,payload,rpc_id AS rpcId,method,params,resolved_at AS resolvedAt,created_at AS createdAt FROM pending_requests WHERE id=? AND thread_id=? AND resolved_at IS NULL").get(id,threadId) as PendingRecord|undefined;}
  putPending(request: PendingRecord): void { this.db.prepare("INSERT INTO pending_requests(id,thread_id,payload,rpc_id,method,params,resolved_at,created_at) VALUES(@id,@threadId,@payload,@rpcId,@method,@params,@resolvedAt,@createdAt)").run({ ...request, resolvedAt: request.resolvedAt ?? null }); }
  resolvePending(id: string, threadId: string, now = Date.now()): boolean { return this.db.prepare("UPDATE pending_requests SET resolved_at=? WHERE id=? AND thread_id=? AND resolved_at IS NULL").run(now,id,threadId).changes === 1; }
  resolveAllPending(threadId:string,now=Date.now()):string[]{const ids=(this.db.prepare("SELECT id FROM pending_requests WHERE thread_id=? AND resolved_at IS NULL").all(threadId) as Array<{id:string}>).map(row=>row.id);if(ids.length)this.db.prepare("UPDATE pending_requests SET resolved_at=? WHERE thread_id=? AND resolved_at IS NULL").run(now,threadId);return ids;}
  close(): void { this.db.close(); }
}
