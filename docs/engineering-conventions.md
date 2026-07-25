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
