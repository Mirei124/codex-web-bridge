# Repository engineering notes

- Route `ServerEvent` values through the shared event-to-thread-ID logic. Events such as
  `thread.updated` carry the ID in `event.thread.id`, while message, request, terminal,
  and error events carry it in `event.threadId`. When adding an event variant, update
  the shared routing logic and its regression tests so WebSocket and CLI subscribers
  receive the same events.
- Treat first-run configuration that contains a generated, one-time credential as part
  of daemon startup. If startup fails before the credential can be delivered, remove
  only the configuration created by that invocation, and only after confirming that
  its complete contents have not been replaced or modified concurrently.
- Commit completed work in small, coherent checkpoints. Once a self-contained portion
  of a change is implemented and its relevant checks pass, create a Git commit before
  starting the next independent portion. Do not commit known-broken or partially
  implemented states merely to create a checkpoint.
- Keep explicit lifecycle operations strict: if a user asks to stop or destroy a
  remote resource, propagate failure and update persisted state only after success.
  Reserve best-effort error suppression for rollback and shutdown cleanup paths.
- Never silently ignore an explicit CLI option because persisted configuration
  already exists. Apply it when supported or return a usage error before making
  lifecycle changes such as stopping a running daemon.
- Keep SSH host-key verification shared across CLI and Web entry points. A Web
  confirmation challenge must not persist the host or place its password in daemon
  memory; mutate either only after the confirmed fingerprint has been accepted.
- Pass user-provided remote environment values through the argument-based
  `commandLine`/`shellQuote` path. Never interpolate proxy URLs or other external
  values into tmux command strings.
- Treat a host-specific PATH setting as a literal list of absolute directories to
  prepend to the non-interactive SSH `PATH`. Apply it at the SSH command boundary
  for prerequisite checks, tmux, Codex, helper commands, and streams.
- A thread-specific PATH prefix is persisted with the thread and takes precedence
  over the host prefix. Compose them as thread, then host, then the remote PATH so
  reconnect and restore preserve the same launch environment.
- Do not rely on a pre-existing tmux server to inherit PATH from the current SSH
  command. Resolve Codex to an absolute path during prerequisite checks and use that
  path in every tmux pane command.
- Deleting a bridge thread is different from exiting its remote session. Detach the
  local runtime before deleting the database record, but leave the remote tmux
  session and Codex history untouched.
- Keep logical deletion independent from slow network cleanup. Mark the runtime
  detached synchronously and remove the bridge record immediately, then finish SSH
  and forwarding cleanup in the background.
- Persist daemon settings changed through the running server and report that a
  restart is required. Do not make an HTTP request handler stop and replace its own
  daemon process.
- When translating Fastify error responses to CLI/control errors, prefer the
  response `message` over `error`. Fastify's `error` field may only contain a generic
  HTTP status such as "Internal Server Error", while `message` carries the actionable
  runtime failure.
- Some SSH servers close an exec channel without sending `exit-status`. For discovery
  commands such as `command -v`, accept a non-empty absolute result when the status is
  `null`, then use that resolved absolute executable path for subsequent tmux/Codex
  commands.
- Recover remote command status at the `SshConnection.execute` boundary with a
  per-command shell marker instead of relying exclusively on the SSH channel's
  optional `exit-status`. Keep the marker out of returned stderr so callers retain
  normal command semantics.
- Web requests with an empty body must not send `Content-Type: application/json`;
  Fastify rejects empty JSON bodies before lifecycle handlers such as exit, delete,
  resume, interrupt, and logout can run. Add the JSON content type only when a body
  is present.
- Fresh Codex threads may remain headless until terminal functionality is requested.
  Screenshot, takeover, and terminal input paths must prepare the viewer pane and
  terminal stream on demand before capturing or accepting input.
- Persist Web create-thread form defaults on the server, not in browser-local
  storage. Load them only for the create flow, keep resume discovery independent,
  and fall back to an available host if the remembered host was removed.
- Normalize xterm's standalone DEL byte (`0x7f`) to terminal Backspace (`0x08`) at
  the Web input boundary before forwarding it through tmux.
- Send standalone C0 control bytes from terminal input through tmux `send-keys`
  semantics (for example Ctrl-C, Ctrl-D, Enter, Tab, Escape, and Backspace).
  Preserve multi-byte ANSI sequences and ordinary text as one raw buffer so arrow,
  navigation, function, and Alt-key sequences are never split across SSH calls.
- Start bridge-managed Codex app-server and viewer processes with the invocation
  override `-c check_for_update_on_startup=false`; do not mutate the remote user's
  global Codex configuration merely to suppress bridge terminal upgrade prompts.
- Daemon shutdown first allows five seconds for graceful `SIGTERM` cleanup, then
  escalates the already validated daemon PID to `SIGKILL`. Keep restart, password
  changes, and explicit stop on this same shutdown path.
- A Codex `thread/start` ID has no resumable rollout until its first accepted turn.
  Persist rollout availability and do not launch the terminal viewer with
  `codex resume` for a fresh empty thread.
- Subscribe the dashboard event socket to every listed thread when implementing
  cross-thread completion alerts; a selected-thread-only subscription cannot
  reliably drive unread state or background notifications.
- Treat xterm escape sequences for navigation/function keys as tmux key names,
  not pasted bytes. Use a unique tmux paste buffer per text input because
  `paste-buffer -d` deletes the buffer and concurrent inputs otherwise race.
- Headless canvas does not reliably resolve the CSS generic `monospace` family.
  Choose an installed concrete monospace/CJK font and render screenshots at the
  actual tmux pane dimensions.
- Keep repository-wide formatting centralized in the root Prettier config and root
  `pnpm format` / `pnpm format:check` scripts so every workspace uses the same
  formatter behavior.
