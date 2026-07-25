# Agent Quickstart

Use this file to get oriented before reading code.

## Project In One View

- This project is a single-user bridge between a browser or CLI and Codex sessions running on local or remote machines over SSH.
- Durable state lives on the bridge host in SQLite.
- Live Codex execution lives on the target host inside managed `tmux` sessions.
- The daemon talks to Codex through `codex app-server`, not by parsing terminal text.
- The dashboard and CLI are two surfaces over the same daemon state.

## Main Code Areas

- `apps/server/src`: daemon, HTTP API, control API, runtime orchestration
- `apps/web/src`: dashboard UI
- `packages/remote-runtime/src`: SSH and tmux integration
- `packages/storage/src`: SQLite schema and persistence
- `packages/protocol/src`: shared API and event types

## Core Mental Model

One bridge thread combines:

- host records
- bridge thread records
- persisted messages
- pending requests
- a remote tmux-managed Codex runtime

Deleting a bridge thread removes only the durable bridge record and local runtime attachment. It must not erase Codex history on the target host.

## What To Read First

If the task is mostly:

- API or state projection: read `apps/server/src/server.ts`
- SSH, tmux, or runtime lifecycle: read `apps/server/src/runtime-manager.ts` and `packages/remote-runtime/src/index.ts`
- persistence: read `packages/storage/src/index.ts`
- dashboard behavior: read `apps/web/src/App.tsx`

## Common Risk Areas

- thread lifecycle transitions across create, resume, reconnect, exit, and delete
- event routing for new `ServerEvent` shapes
- terminal handling before the first rollout exists
- PATH and proxy handling at the SSH command boundary
- request persistence and replay after reconnect or reload
- divergence between runtime state, stored state, and UI state

## Non-Negotiable Constraints

- Do not invent behavior for files you have not read.
- Do not add speculative abstractions.
- Do not add impossible-state defensive logic inside trusted internals.
- Do not interpolate external values into remote shell command strings.
- Do not treat bridge-thread deletion as remote-session destruction.
- Do not bypass shared event thread-ID routing logic.

## Next Docs

- [Architecture](./architecture.md)
- [Change Guide](./change-guide.md)
- [Engineering Conventions](./engineering-conventions.md)
- [AGENTS.md](../AGENTS.md)
