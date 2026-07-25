# Module Map

## Top-Level Layout

- `apps/server`: daemon, HTTP server, CLI, control socket
- `apps/web`: React dashboard
- `packages/codex-client`: typed client for `codex app-server`
- `packages/remote-runtime`: SSH and tmux orchestration
- `packages/storage`: SQLite persistence
- `packages/config`: config schema and data-dir paths
- `packages/protocol`: shared API and event types
- `deploy`: Caddy and systemd examples

## Server Modules

### `apps/server/src/cli.ts`

User-facing CLI entry point.

- starts, stops, and inspects the daemon
- bootstraps first-run config
- prints generated passwords
- dispatches business commands to the control socket

### `apps/server/src/daemon.ts`

Daemon bootstrap.

- loads config
- writes PID and ready files
- creates storage
- builds the HTTP server
- starts the control server

### `apps/server/src/server.ts`

Main application surface.

- Fastify routes
- session and CSRF enforcement
- host and thread CRUD
- pending request lifecycle
- WebSocket subscriptions
- projection from runtime events into persisted `ServerEvent` state

This is the main file to inspect for behavior changes visible to the dashboard or API.

### `apps/server/src/runtime-manager.ts`

Owns live remote runtimes.

- opens SSH connections
- starts or resumes tmux-managed Codex sessions
- reconnects surviving threads after restart
- attaches terminal streams
- routes Codex notifications and requests back to the server

This is the main file for session lifecycle and reconnect behavior.

### `apps/server/src/control.ts` and `control-client.ts`

Internal daemon control API used by the CLI.

### `apps/server/src/host-key.ts`

SSH host-key verification and confirmation handling.

### `apps/server/src/startup-transaction.ts`

Rollback rules for first-run configuration and daemon spawn failures.

## Shared Packages

### `packages/remote-runtime/src/index.ts`

Low-level remote orchestration primitives.

- `SshConnection`: SSH exec, streaming, local port forwarding
- `TmuxCodexRuntime`: tmux session management and viewer plumbing
- `withPrependedPath()`: applies host or thread PATH prefixes at the command boundary

Change this package when altering tmux commands, command quoting, terminal input handling, or remote prerequisite checks.

### `packages/codex-client/src/index.ts`

Typed WebSocket client for Codex app-server protocol methods and notifications.

### `packages/storage/src/index.ts`

SQLite schema and read/write operations.

Change this file when adding durable state. Keep migrations inline and backward compatible with existing databases.

### `packages/config/src/index.ts`

Data directory and config file locations.

Defaults to:

- config: `config.json`
- database: `bridge.sqlite3`
- control socket: `control.sock`
- logs: `daemon.log`

All under `CWB_DATA_DIR` or XDG state fallback.

### `packages/protocol/src/index.ts`

Shared web API request/response and event type definitions.

Update this package together with both server and web consumers when changing API shapes.

## Web Modules

### `apps/web/src/App.tsx`

Single-page dashboard shell.

- login flow
- host and thread management dialogs
- conversation display
- pending request UI
- settings UI
- unread and notification handling

### `apps/web/src/Terminal.tsx`

Terminal rendering and user input capture.

### `apps/web/src/api.ts`

Typed HTTP client for the dashboard.

### `apps/web/src/useThreadEvents.ts`

WebSocket subscription management per visible thread list.

## Common Change Entry Points

### Add a new persisted thread property

Touch at least:

- `packages/storage/src/index.ts`
- `packages/protocol/src/index.ts`
- `apps/server/src/server.ts`
- `apps/web/src/api.ts`
- `apps/web/src/App.tsx`

### Change remote lifecycle behavior

Touch at least:

- `apps/server/src/runtime-manager.ts`
- `packages/remote-runtime/src/index.ts`
- related runtime and integration tests

### Change event routing or event payloads

Touch at least:

- `packages/protocol/src/index.ts`
- `apps/server/src/server.ts`
- `apps/web/src/useThreadEvents.ts`
- event routing tests mentioned in `AGENTS.md`

### Change CLI behavior

Touch at least:

- `apps/server/src/cli-command.ts`
- `apps/server/src/cli.ts`
- `apps/server/src/cli-renderer.ts`
- CLI tests
