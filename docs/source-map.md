# Source Map

This document is for fast source-code navigation.

Use it when you already know the symptom or feature area and want the shortest path
to the relevant code.

## Top-Level Areas

### `apps/server/src`

Bridge daemon and coordination layer.

Primary responsibilities:

- CLI entry points and command parsing
- Fastify HTTP API
- WebSocket event delivery
- daemon lifecycle
- mapping runtime failures into bridge/API errors

Start here for:

- login, session, CSRF, origin, and proxy behavior
- host CRUD and thread CRUD API behavior
- daemon start/stop/restart behavior
- CLI flags not taking effect
- runtime failures shown in the dashboard or CLI

Important files:

- [`apps/server/src/cli.ts`](../apps/server/src/cli.ts)
  CLI entry point, daemon start/restart/config handling
- [`apps/server/src/cli-command.ts`](../apps/server/src/cli-command.ts)
  CLI grammar and option parsing
- [`apps/server/src/server.ts`](../apps/server/src/server.ts)
  HTTP routes, auth/session checks, origin validation, WebSocket upgrade
- [`apps/server/src/runtime-manager.ts`](../apps/server/src/runtime-manager.ts)
  bridge-side runtime orchestration across SSH, tmux, and Codex app-server
- [`apps/server/src/control.ts`](../apps/server/src/control.ts)
  local control socket that powers the CLI against the daemon
- [`apps/server/src/daemon.ts`](../apps/server/src/daemon.ts)
  daemon bootstrap and shutdown path
- [`apps/server/src/host-key.ts`](../apps/server/src/host-key.ts)
  SSH host-key verification and confirmation flow

### `apps/web/src`

Browser dashboard.

Primary responsibilities:

- login screen
- host and thread UI
- settings UI
- notifications, unread state, and browser interaction
- terminal and screenshot UI

Start here for:

- dashboard rendering bugs
- wrong request payloads from the browser
- form defaults and browser-side validation
- notification/toast behavior
- terminal input/output UI behavior

Important files:

- [`apps/web/src/App.tsx`](../apps/web/src/App.tsx)
  main dashboard state, forms, notifications, thread interactions
- [`apps/web/src/api.ts`](../apps/web/src/api.ts)
  browser request wrapper and request payloads
- [`apps/web/src/useThreadEvents.ts`](../apps/web/src/useThreadEvents.ts)
  event socket lifecycle
- [`apps/web/src/Terminal.tsx`](../apps/web/src/Terminal.tsx)
  terminal widget integration

### `packages/remote-runtime/src`

Remote execution primitives over SSH and tmux.

Primary responsibilities:

- SSH command execution
- PATH prefix injection
- tmux session creation and teardown
- Codex app-server and viewer pane startup
- terminal streaming and screenshots

Start here for:

- remote program lookup failures
- PATH / prepend-path behavior
- tmux startup failures
- `codex app-server` startup failures
- terminal capture and screenshot issues

Important files:

- [`packages/remote-runtime/src/index.ts`](../packages/remote-runtime/src/index.ts)
  SSH execution, tmux runtime, remote process startup
- [`packages/remote-runtime/src/terminal-snapshot.ts`](../packages/remote-runtime/src/terminal-snapshot.ts)
  screenshot rendering

### `packages/storage/src`

Bridge persistence layer.

Primary responsibilities:

- SQLite schema
- migrations
- host/thread/message/request/session persistence

Start here for:

- data not being saved or loaded correctly
- migration issues
- SQLite driver behavior
- host/thread record shape mismatches

Important files:

- [`packages/storage/src/index.ts`](../packages/storage/src/index.ts)
  schema, migrations, read/write operations

### `packages/codex-client/src`

Typed JSON-RPC bridge to `codex app-server`.

Primary responsibilities:

- WebSocket connection to app-server
- JSON-RPC request/response handling
- thread/start, thread/resume, turn/start, interrupt, and approval responses

Start here for:

- Codex app-server protocol mismatches
- request timeout behavior
- event/request parsing from app-server

Important files:

- [`packages/codex-client/src/index.ts`](../packages/codex-client/src/index.ts)

### `packages/protocol/src`

Shared browser/server/control request and event types.

Start here for:

- payload shape mismatches between web and server
- event type changes that must stay consistent across layers

Important files:

- [`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts)

### `packages/config/src`

Daemon config file loading and validation.

Start here for:

- config parsing
- data directory layout
- public origin / bind host persistence

Important files:

- [`packages/config/src/index.ts`](../packages/config/src/index.ts)

## Common Tasks

### Add or change a CLI option

Usually touch:

- [`apps/server/src/cli-command.ts`](../apps/server/src/cli-command.ts)
- [`apps/server/src/cli.ts`](../apps/server/src/cli.ts)
- related API or runtime file if the option affects behavior

### Debug host add / host edit failures

Usually inspect in this order:

- [`apps/web/src/App.tsx`](../apps/web/src/App.tsx)
- [`apps/web/src/api.ts`](../apps/web/src/api.ts)
- [`apps/server/src/server.ts`](../apps/server/src/server.ts)
- [`packages/storage/src/index.ts`](../packages/storage/src/index.ts)
- [`apps/server/src/host-key.ts`](../apps/server/src/host-key.ts)

### Debug thread create / resume failures

Usually inspect in this order:

- [`apps/server/src/server.ts`](../apps/server/src/server.ts)
- [`apps/server/src/runtime-manager.ts`](../apps/server/src/runtime-manager.ts)
- [`packages/remote-runtime/src/index.ts`](../packages/remote-runtime/src/index.ts)
- [`packages/codex-client/src/index.ts`](../packages/codex-client/src/index.ts)

### Debug remote PATH / binary lookup issues

Usually inspect in this order:

- [`apps/server/src/runtime-manager.ts`](../apps/server/src/runtime-manager.ts)
- [`packages/remote-runtime/src/index.ts`](../packages/remote-runtime/src/index.ts)
- [`AGENTS.md`](../AGENTS.md)

### Debug browser notifications or unread badges

Usually inspect in this order:

- [`apps/web/src/App.tsx`](../apps/web/src/App.tsx)
- [`apps/web/src/useThreadEvents.ts`](../apps/web/src/useThreadEvents.ts)
- [`apps/server/src/server.ts`](../apps/server/src/server.ts)
- [`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts)

### Debug terminal input/output problems

Usually inspect in this order:

- [`apps/web/src/Terminal.tsx`](../apps/web/src/Terminal.tsx)
- [`apps/web/src/App.tsx`](../apps/web/src/App.tsx)
- [`apps/server/src/runtime-manager.ts`](../apps/server/src/runtime-manager.ts)
- [`packages/remote-runtime/src/index.ts`](../packages/remote-runtime/src/index.ts)

## Distinction Between Source and Build Output

- edit `src/` files
- treat `dist/` as generated output
- when behavior differs between Node tests and the standalone binary, inspect both:
  - source logic in `src/`
  - pkg snapshot and native-addon behavior in the binary build
