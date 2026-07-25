# Architecture

## System Shape

Codex Web Bridge is a stateful daemon that exposes:

- an HTTP API for the web dashboard
- a WebSocket event stream for live thread updates
- a private Unix-socket control API for the CLI

The daemon stores durable state in SQLite and manages live remote Codex runtimes over SSH.

```text
Web UI -> Fastify HTTP API -> Storage
      -> WebSocket events -> live thread state

CLI -> control socket -> same daemon state and runtime manager

Daemon -> SSH -> tmux -> codex app-server
                    -> codex resume viewer
```

## Stable Structural Ideas

- The daemon is the only stateful coordinator.
- SQLite is the durable source of truth for bridge-side state.
- SSH and tmux keep remote Codex execution alive independently of browser sessions.
- Codex interaction is structured through `app-server`, not inferred from terminal text.
- The CLI and dashboard operate on the same daemon-managed state.

## Persistence Model

SQLite storage on the bridge host stores the bridge's own state, including:

- login sessions
- SSH hosts
- bridge threads
- conversation messages
- pending interactive requests
- a small amount of UI-related bridge metadata

## Security Boundaries

The bridge is intentionally single-user.

Important boundaries:

- dashboard login is password-based and stored as an Argon2id hash
- browser access is guarded by session cookie plus CSRF token
- direct HTTP access is restricted by origin rules
- SSH host keys are verified before hosts are persisted
- Codex credentials remain on the target machine
- the bridge stores host metadata, not remote Codex account state

## High-Level Lifecycle

- A bridge thread can create or attach to a Codex thread on a target host.
- Remote execution survives SSH disconnects and daemon restarts through tmux.
- The daemon can reconnect to non-exited threads after restart.
- Deleting a bridge thread removes bridge state, not remote Codex history.
- Exiting a thread is a real remote lifecycle action and must stop the managed runtime.

## Key Design Constraints

- The daemon must not silently replace explicit runtime options with stored config.
- Host and thread prepend paths are literal absolute-directory prefixes, not shell snippets.
- Remote external values such as proxy URLs must go through argument-based quoting paths.
- Thread deletion detaches local bridge state but does not kill the remote Codex session.
- Explicit exit must stop the remote tmux session before state is marked exited.
