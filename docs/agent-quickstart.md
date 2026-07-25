# Agent Quickstart

This is the fastest accurate way to build a working mental model of the repository before you change code.

## In One Minute

- This project is a single-user bridge between a browser or CLI and Codex sessions running on local or remote machines over SSH.
- Durable state lives on the bridge host in SQLite.
- Live Codex execution lives on the target host inside managed `tmux` sessions.
- The daemon talks to Codex through `codex app-server`, not by parsing terminal text.
- The dashboard and CLI are two surfaces over the same daemon state.

## Core Files

Read these first:

1. `apps/server/src/server.ts`
2. `apps/server/src/runtime-manager.ts`
3. `packages/remote-runtime/src/index.ts`
4. `packages/storage/src/index.ts`
5. `apps/web/src/App.tsx`
6. `AGENTS.md`

That set gives you the API surface, runtime lifecycle, remote command model, persistence schema, UI behavior, and repo-specific invariants.

## The Main Mental Model

One bridge thread is local bridge state plus one remote tmux-managed Codex runtime.

Durable state:

- host records
- bridge thread records
- persisted messages
- pending requests
- login sessions

Remote state:

- SSH connection
- tmux session
- `codex app-server`
- optional `codex resume` viewer pane

Deleting a bridge thread removes only the durable bridge record and local runtime attachment. It must not erase Codex history on the target host.

## Request Flow

### Sending a message

1. HTTP request enters `server.ts`
2. user message is stored in SQLite
3. `runtime-manager.ts` sends `turn/start` through `CodexClient`
4. Codex events stream back
5. `server.ts` projects them into stored messages and `ServerEvent`s
6. the dashboard updates through WebSocket

### Approvals and questions

1. Codex emits an RPC request
2. `server.ts` stores it as a pending request
3. the dashboard renders it
4. user resolves it
5. the response is sent back through the runtime manager

### Terminal

1. terminal access is prepared lazily
2. remote tmux viewer output is piped into a FIFO
3. SSH streams FIFO bytes back to the daemon
4. WebSocket pushes terminal data to the browser

## Where Bugs Usually Hide

- thread lifecycle transitions across create, resume, reconnect, exit, and delete
- event routing for new `ServerEvent` shapes
- terminal handling before the first rollout exists
- PATH and proxy handling at the SSH command boundary
- request persistence and replay after reconnect or reload
- divergence between server state, storage state, and dashboard projections

## Non-Negotiable Project Rules

- Do not invent behavior for files you have not read.
- Do not add speculative abstractions.
- Do not add impossible-state defensive logic inside trusted internals.
- Do not interpolate external values into remote shell command strings.
- Do not treat bridge-thread deletion as remote-session destruction.
- Do not bypass shared event thread-ID routing logic.

## Fast Task Routing

If you need to:

- change API behavior: start in `apps/server/src/server.ts`
- change SSH or tmux behavior: start in `packages/remote-runtime/src/index.ts`
- change reconnect or runtime lifecycle: start in `apps/server/src/runtime-manager.ts`
- change durable data: start in `packages/storage/src/index.ts`
- change dashboard behavior: start in `apps/web/src/App.tsx`
- change CLI behavior: start in `apps/server/src/cli.ts` and `cli-command.ts`

Then use [Change Guide](./change-guide.md) for the detailed edit map.

## Supporting Docs

- [Architecture](./architecture.md)
- [Change Guide](./change-guide.md)
- [Engineering Conventions](./engineering-conventions.md)
- [AGENTS.md](../AGENTS.md)
