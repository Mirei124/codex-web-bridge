# Repository Agent Instructions

Read this file before changing the repo. For deeper context, also read
`docs/engineering-conventions.md` when touching lifecycle, remote runtime, terminal,
Web request, packaging, deployment, or settings behavior.

## Must-Follow Rules

- Commit completed work in small, coherent checkpoints. Once a self-contained change
  is implemented and its relevant checks pass, create a Git commit before starting
  the next independent portion. Do not commit known-broken or partial states merely
  to create a checkpoint.
- Route `ServerEvent` values through the shared event-to-thread-ID logic. Events such
  as `thread.updated` carry the ID in `event.thread.id`, while message, request,
  terminal, and error events carry it in `event.threadId`. When adding an event
  variant, update the shared routing logic and regression tests.
- Keep explicit lifecycle operations strict. If a user asks to stop, exit, delete, or
  destroy a remote resource, propagate failure and update persisted state only after
  success. Reserve best-effort error suppression for rollback and shutdown cleanup.
- Never silently ignore an explicit CLI option because persisted configuration
  already exists. Apply it when supported or return a usage error before lifecycle
  changes such as stopping a running daemon.
- Keep SSH host-key verification shared across CLI and Web entry points. A Web
  confirmation challenge must not persist the host or place its password in daemon
  memory; mutate either only after the confirmed fingerprint has been accepted.
- Pass user-provided remote environment values through the argument-based
  `commandLine`/`shellQuote` path. Never interpolate proxy URLs or other external
  values into tmux command strings.
- Treat host and thread PATH prefixes as literal lists of absolute directories.
  Compose thread prefix, then host prefix, then remote PATH. Resolve Codex to an
  absolute path during prerequisite checks and use that path in every tmux pane
  command.
- Deleting a bridge thread is different from exiting its remote session. Detach the
  local runtime before deleting the database record, but leave the remote tmux
  session and Codex history untouched.
- Web requests with an empty body must not send `Content-Type: application/json`.
  Fastify rejects empty JSON bodies before lifecycle handlers can run.
- Start bridge-managed Codex app-server and viewer processes with
  `-c check_for_update_on_startup=false`; do not mutate the remote user's global
  Codex configuration to suppress bridge terminal upgrade prompts.
- Keep repository-wide formatting centralized in the root Prettier config and root
  `pnpm format` / `pnpm format:check` scripts.

## Frontend Theme

- Default frontend theme: `animal-island`.
- The reference repository is at `../animal-island-ui` relative to this repo. Use it
  as the design-system/style reference before adding or changing frontend UI.
