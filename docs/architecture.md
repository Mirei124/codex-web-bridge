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

## Runtime Model

### Bridge host

The bridge host runs the daemon process from [`apps/server/src/daemon.ts`](../apps/server/src/daemon.ts).

Responsibilities:

- load config
- open SQLite storage
- create the Fastify server
- expose the control socket
- publish readiness and PID files

### Target host

Each target host is an SSH destination recorded in the `hosts` table. For each active bridge thread, the daemon opens one SSH connection and manages one tmux session.

### Managed tmux session

Each bridge thread persists:

- a bridge thread ID
- a Codex thread ID once created or resumed
- a tmux session name
- a remote app-server port

The tmux session contains:

- an `app-server` pane that runs `codex app-server`
- an optional viewer pane that runs `codex resume`

The viewer pane is attached lazily. A fresh thread can stay headless until terminal functionality is needed.

## Event Flow

### User message path

1. The browser or CLI submits a message.
2. The server stores the user message in SQLite.
3. `HostRuntimeManager.send()` starts a turn through `CodexClient`.
4. Runtime events return over the app-server connection.
5. The server persists assistant deltas and completion state.
6. Matching WebSocket subscribers receive `ServerEvent` updates.

### Approval and question path

1. Codex emits an approval or request-user-input RPC request.
2. The server converts it into a stored pending request.
3. The dashboard renders a structured action card.
4. The user resolves it through HTTP.
5. The runtime manager sends the response back to Codex.

### Terminal path

1. The UI subscribes to a thread event stream.
2. When terminal access is needed, the runtime prepares the viewer pane.
3. tmux pipes viewer output into a FIFO on the target host.
4. The daemon streams FIFO bytes over SSH.
5. WebSocket subscribers receive `terminal.data` events.

Keyboard input follows the reverse path through `runtime.terminalInput()` and tmux `send-keys` or paste-buffer operations.

## Persistence Model

SQLite storage lives in the bridge data directory and currently stores:

- login sessions
- SSH hosts
- bridge threads
- conversation messages
- pending interactive requests
- saved defaults for the create-thread form

The daemon assumes SQLite is the durable source of truth for bridge inventory. Live SSH and tmux state are reconstructable from stored thread metadata.

## Startup and Recovery

On daemon startup:

1. config is loaded
2. storage is opened
3. the HTTP server and control socket start
4. non-exited threads are loaded from storage
5. the runtime manager attempts to reconnect them

If reconnect fails repeatedly, the thread transitions to `error`.

## Security Boundaries

The bridge is intentionally single-user.

Important boundaries:

- dashboard login is password-based and stored as an Argon2id hash
- browser access is guarded by session cookie plus CSRF token
- direct HTTP access is restricted by origin rules
- SSH host keys are verified before hosts are persisted
- Codex credentials remain on the target machine
- the bridge stores host metadata, not remote Codex account state

## Design Constraints That Matter in Code

- The daemon must not silently replace explicit runtime options with stored config.
- Host and thread prepend paths are literal absolute-directory prefixes, not shell snippets.
- Remote external values such as proxy URLs must go through argument-based quoting paths.
- Thread deletion detaches local bridge state but does not kill the remote Codex session.
- Explicit exit must stop the remote tmux session before state is marked exited.
