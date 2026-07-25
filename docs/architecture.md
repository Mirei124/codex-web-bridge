# Architecture

## Purpose

Codex Web Bridge is a single-user bridge between:

- a browser dashboard
- a local CLI
- Codex sessions running on local or remote machines over SSH

```text
Web UI -> Fastify HTTP API -> Storage
      -> WebSocket events -> live thread state

CLI -> control socket -> same daemon state and runtime manager

Daemon -> SSH -> tmux -> codex app-server
                    -> codex resume viewer
```

## Code Organization

### `apps/server`

Owns the daemon and coordination layer:

- HTTP API
- WebSocket event delivery
- CLI control surface
- runtime lifecycle and reconnect logic

### `apps/web`

Owns the dashboard:

- login flow
- host and thread views
- conversation rendering
- approvals and question prompts
- terminal view

### `packages/remote-runtime`

Owns remote execution primitives:

- SSH command execution
- tmux session management
- terminal streaming
- screenshot rendering support

### `packages/storage`

Owns bridge-side persistence:

- SQLite schema
- migrations
- records for hosts, threads, messages, requests, and sessions

### `packages/protocol`

Owns the shared request, response, and event shapes used by server and web code.

### `packages/config`

Owns data-directory and config-file layout.

### `packages/codex-client`

Owns the typed bridge to `codex app-server`.

## Key Principles

- The daemon is the only stateful coordinator.
- SQLite is the durable source of truth for bridge-side state.
- SSH and tmux keep remote Codex execution alive independently of browser sessions.
- Codex interaction is structured through `app-server`, not inferred from terminal text.
- The CLI and dashboard operate on the same daemon-managed state.

## Main Runtime Concepts

### Bridge thread

A bridge thread is the bridge's durable record of one Codex conversation plus its managed remote runtime.

### Remote runtime

The live execution side runs on the target host inside a dedicated tmux session. The bridge reconnects to it instead of treating the browser session as the owner.

### Structured interaction

The bridge uses `codex app-server` for messages, approvals, plan-mode questions, and status updates. The terminal view is an auxiliary surface, not the primary source of truth.

## Security Model

The bridge is intentionally single-user.

Important boundaries:

- dashboard login is password-based and stored as an Argon2id hash
- browser access is guarded by session cookie plus CSRF token
- direct HTTP access is restricted by origin rules
- SSH host keys are verified before hosts are persisted
- Codex credentials remain on the target machine
- the bridge stores host metadata, not remote Codex account state

## Lifecycle Model

- A bridge thread can create or attach to a Codex thread on a target host.
- Remote execution survives SSH disconnects and daemon restarts through tmux.
- The daemon can reconnect to non-exited threads after restart.
- Deleting a bridge thread removes bridge state, not remote Codex history.
- Exiting a thread is a real remote lifecycle action and must stop the managed runtime.
