# Engineering Conventions

This file summarizes project-specific rules that are easy to miss when changing code. It complements, but does not replace, [AGENTS.md](../AGENTS.md).

## General Principles

- Prefer the minimum complexity needed for the current behavior.
- Do not add defensive checks for impossible internal states.
- Validate at system boundaries: HTTP input, CLI input, SSH results, external processes.
- Read the relevant source files before changing behavior.

## Session Lifecycle

- A bridge thread is not the same thing as a remote Codex session.
- Deleting a thread removes local bridge state and detaches the runtime, but must not destroy remote Codex history.
- Exiting a thread is an explicit remote lifecycle action and must fail loudly if the remote shutdown fails.
- First-run config that generated a one-time password is part of startup transaction handling and must roll back carefully on failure.

## Runtime and SSH Rules

- Route host and thread `prependPath` through `withPrependedPath()` and command arguments, not string interpolation.
- Treat prepend paths as colon-separated absolute directories only.
- Resolve `tmux` and `codex` to absolute paths during prerequisite checks and reuse those resolved paths later.
- Do not assume a pre-existing tmux server inherited the current SSH command environment.
- Do not persist host acceptance or daemon in-memory host passwords before SSH host-key confirmation succeeds.

## Terminal Rules

- A fresh thread may not have a viewer pane yet.
- Terminal, screenshot, and takeover flows must prepare the viewer lazily.
- Send standalone control bytes through tmux key semantics.
- Preserve ordinary text and multibyte escape sequences as raw pasted buffers.
- Use unique tmux paste buffers per input event to avoid concurrent races.

## Event and API Rules

- Keep server-side event routing centralized.
- When adding a new `ServerEvent`, update shared thread-ID extraction logic so WebSocket and CLI subscribers stay aligned.
- Persist thread-create defaults on the server, not in browser-local storage.
- For Fastify error translations exposed through the CLI, prefer the response `message` over generic HTTP `error`.
- Do not attach `Content-Type: application/json` to empty-body web requests.

## Storage and Migrations

- `packages/storage` owns schema creation and inline migrations.
- Prefer additive migrations that preserve existing state.
- If a new field affects create, resume, reconnect, or list flows, verify all of those paths explicitly.

## Documentation Expectations

- Keep user-facing documentation in `README.md`.
- Keep agent and developer onboarding material in `docs/`.
- When a completed fix reveals a reusable project rule, add the generalized lesson to `AGENTS.md`.
