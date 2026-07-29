# Engineering Conventions

This file keeps only repo-specific pitfalls that have already caused bugs or regressions.

## Lifecycle Pitfalls

- Deleting a bridge thread is not the same as exiting its remote session. Delete must detach local bridge state and leave remote tmux and Codex history intact.
- Explicit stop, exit, destroy, password-change restart, and daemon restart paths must treat remote shutdown as strict, not best-effort. Persisted state should change only after the explicit lifecycle action succeeds.
- First-run startup that generated a one-time password is transactional. If startup fails before the password is delivered, roll back only the config created by that startup attempt.
- A fresh `thread/start` has no resumable rollout until the first accepted turn. Do not assume a viewer pane or `codex resume` target exists yet.

## Event And Projection Pitfalls

- `ServerEvent` variants do not all carry thread identity in the same field. Update shared thread-routing logic whenever a new event shape is added, or WebSocket and CLI subscribers will diverge.
- Persist pending requests and resolve them carefully across reconnect boundaries. Connection changes can invalidate outstanding interactions.
- For control and CLI surfaces, prefer actionable Fastify response `message` values over generic HTTP `error` text.

## SSH And Remote Command Pitfalls

- Never interpolate external values such as proxy URLs into tmux command strings. Route them through argument-based quoting.
- Host and thread prepend PATH settings are literal absolute-directory prefixes, not shell fragments. Thread prefix takes precedence over host prefix.
- Do not rely on a pre-existing tmux server inheriting PATH from the current SSH command. Resolve Codex to an absolute path first and reuse that path in later tmux commands.
- Some SSH servers omit `exit-status` on exec close. Treat a non-empty absolute result from discovery commands such as `command -v` as usable, and recover final status at the `SshConnection.execute` boundary.
- SSH host-key confirmation for Web flows must not persist the host or stash the host password in daemon memory until the fingerprint is explicitly accepted.

## Terminal Pitfalls

- Fresh threads can stay headless. Screenshot, terminal input, and takeover flows must prepare the viewer lazily.
- Standalone control bytes should go through tmux key semantics, while ordinary text and multi-byte escape sequences should stay intact as one raw payload.
- Use a unique tmux paste buffer per terminal text input. Reusing buffer names races under concurrent input.
- Normalize standalone DEL to Backspace at the web terminal boundary.

## Web And Settings Pitfalls

- Empty-body web requests must not send `Content-Type: application/json`, or Fastify can reject them before lifecycle handlers run.
- Create-thread defaults belong on the server, not in browser-local storage.
- Runtime settings changed through the running server must be persisted and marked as restart-required; the request handler must not try to replace its own daemon process.

## Detailed Notes Moved From AGENTS.md

These notes are not required for every task, but they should be checked when touching
the related subsystem.

### Startup And Lifecycle

- Treat first-run configuration that contains a generated, one-time credential as
  part of daemon startup. If startup fails before the credential can be delivered,
  remove only the configuration created by that invocation, and only after confirming
  that its complete contents have not been replaced or modified concurrently.
- Keep logical deletion independent from slow network cleanup. Mark the runtime
  detached synchronously and remove the bridge record immediately, then finish SSH and
  forwarding cleanup in the background.
- Daemon shutdown first allows five seconds for graceful `SIGTERM` cleanup, then
  escalates the already validated daemon PID to `SIGKILL`. Keep restart, password
  changes, and explicit stop on this same shutdown path.

### Events, Requests, And Status

- When translating Fastify error responses to CLI/control errors, prefer the response
  `message` over `error`. Fastify's `error` field may only contain a generic HTTP
  status such as "Internal Server Error", while `message` carries the actionable
  runtime failure.
- Persist Web create-thread form defaults on the server, not in browser-local
  storage. Load them only for the create flow, keep resume discovery independent, and
  fall back to an available host if the remembered host was removed.
- Subscribe the dashboard event socket to every listed thread when implementing
  cross-thread completion alerts; a selected-thread-only subscription cannot reliably
  drive unread state or background notifications.

### SSH And PATH

- Some SSH servers close an exec channel without sending `exit-status`. For discovery
  commands such as `command -v`, accept a non-empty absolute result when the status is
  `null`, then use that resolved absolute executable path for subsequent tmux/Codex
  commands.
- Recover remote command status at the `SshConnection.execute` boundary with a
  per-command shell marker instead of relying exclusively on the SSH channel's
  optional `exit-status`. Keep the marker out of returned stderr so callers retain
  normal command semantics.

### Terminal And Viewer

- Fresh Codex threads may remain headless until terminal functionality is requested.
  Screenshot, takeover, and terminal input paths must prepare the viewer pane and
  terminal stream on demand before capturing or accepting input.
- Normalize xterm's standalone DEL byte (`0x7f`) to terminal Backspace (`0x08`) at
  the Web input boundary before forwarding it through tmux.
- Send standalone C0 control bytes from terminal input through tmux `send-keys`
  semantics, for example Ctrl-C, Ctrl-D, Enter, Tab, Escape, and Backspace. Preserve
  multi-byte ANSI sequences and ordinary text as one raw buffer so arrow, navigation,
  function, and Alt-key sequences are never split across SSH calls.
- Treat xterm escape sequences for navigation/function keys as tmux key names, not
  pasted bytes. Use a unique tmux paste buffer per text input because
  `paste-buffer -d` deletes the buffer and concurrent inputs otherwise race.
- Headless canvas does not reliably resolve the CSS generic `monospace` family.
  Choose an installed concrete monospace/CJK font and render screenshots at the actual
  tmux pane dimensions.

### Codex Runtime

- A Codex `thread/start` ID has no resumable rollout until its first accepted turn.
  Persist rollout availability and do not launch the terminal viewer with
  `codex resume` for a fresh empty thread.

### Deployment And Packaging

- When using Caddy on non-standard HTTPS ports, remember that `https_port` changes the
  listener port but does not by itself guarantee a `Location` header with `:8443`. If a
  deployment must redirect clients to the explicit HTTPS port, add an `http://`
  redirect block and verify the returned URL with `curl`.
- For IP-only Caddy deployments, do not rely on `tls internal` to satisfy plain
  `curl https://<ip>:8443` tests. IP clients often do not send SNI, so Caddy may fail
  to select a cert. Use a certificate whose SAN includes the IP and point the site at
  explicit cert/key paths, or make the HTTPS site block hostless with `:8443` so it
  behaves like a default server.
- Keep public-IP examples generic in deploy snippets and certificate paths. Replace
  hardcoded production addresses with placeholders so example files do not leak
  environment-specific values or get copied into the wrong deployment.
- Build pkg executables from a Node-targeted bundle so workspace TypeScript exports
  and top-level await do not depend on pkg's CommonJS transformer. Keep native modules
  external to the bundle and list their resolved `.node` files as pkg assets relative
  to the pkg config directory.
- When a pkg executable launches its own daemon, set the child `PKG_EXECPATH` to an
  empty string. Otherwise pkg treats the first application argument as a JavaScript
  filename instead of re-entering the packaged default entrypoint.
