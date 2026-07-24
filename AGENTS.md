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
- Treat a host-specific remote `PATH` as a complete literal value. Apply it at the
  SSH command boundary so prerequisite checks, tmux, Codex, helper commands, and
  streams behave consistently; do not rely on interactive shell startup files.
