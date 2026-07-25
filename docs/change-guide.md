# Change Guide

This file answers one question: if you need to change behavior, where should you start reading and editing?

## First Read Path

For most tasks, read these files first:

1. `apps/server/src/server.ts`
2. `apps/server/src/runtime-manager.ts`
3. `packages/remote-runtime/src/index.ts`
4. `packages/storage/src/index.ts`
5. `apps/web/src/App.tsx`

That path covers the main request flow, runtime flow, persistence, and dashboard behavior.

## Common Changes

### Add or change an HTTP endpoint

Start here:

- `apps/server/src/server.ts`
- `packages/protocol/src/index.ts`
- `apps/web/src/api.ts`

Also check:

- `apps/web/src/App.tsx` if the dashboard uses the endpoint
- CLI control flow if the same action should be available from `cwb`

## Add a new persisted field

Start here:

- `packages/storage/src/index.ts`
- `packages/protocol/src/index.ts`
- `apps/server/src/server.ts`

Then check all lifecycle paths that create or reload the entity:

- create
- resume
- reconnect
- list
- detail view

If the field belongs to threads or hosts, verify both storage projection and web API serialization.

## Change remote tmux or SSH behavior

Start here:

- `packages/remote-runtime/src/index.ts`
- `apps/server/src/runtime-manager.ts`

Typical examples:

- prerequisite checks
- tmux pane creation
- viewer attach behavior
- terminal input handling
- PATH prepend behavior
- proxy argument handling
- reconnect and disposal rules

Be careful with quoting boundaries. External values must go through `commandLine()` and `shellQuote()` paths, not manual string interpolation.

## Change thread lifecycle behavior

Start here:

- `apps/server/src/server.ts`
- `apps/server/src/runtime-manager.ts`
- `packages/storage/src/index.ts`

Relevant operations:

- create a fresh thread
- resume a historical Codex thread
- reconnect after daemon restart
- exit a running thread
- delete a bridge thread without deleting remote Codex history

If the behavior changes terminal availability, also inspect `packages/remote-runtime/src/index.ts` and `apps/web/src/App.tsx`.

## Change event routing or live updates

Start here:

- `packages/protocol/src/index.ts`
- `apps/server/src/server.ts`
- `apps/web/src/useThreadEvents.ts`
- `apps/web/src/App.tsx`

Be careful with thread routing. `ServerEvent` delivery depends on shared thread-ID extraction logic. If you add an event shape and do not update that logic, CLI and WebSocket subscribers diverge.

## Change approvals or request-user-input handling

Start here:

- `apps/server/src/server.ts`
- `apps/server/src/runtime-manager.ts`
- `apps/web/src/App.tsx`

You are touching:

- Codex RPC request projection into pending requests
- persistence of unresolved requests
- dashboard rendering
- request resolution back into Codex RPC responses

Verify reconnect and snapshot behavior so pending requests remain visible after browser reload.

## Change terminal behavior

Start here:

- `packages/remote-runtime/src/index.ts`
- `apps/server/src/runtime-manager.ts`
- `apps/web/src/Terminal.tsx`
- `apps/web/src/App.tsx`

Watch for these constraints:

- fresh threads can be headless before first rollout
- viewer pane attach is lazy
- standalone control bytes should map to tmux keys
- normal text and multibyte escape sequences should stay intact
- paste buffers must be unique per input event

## Change dashboard settings or authentication

Start here:

- `apps/server/src/server.ts`
- `apps/server/src/auth.ts`
- `packages/config/src/index.ts`
- `apps/web/src/App.tsx`

Be careful with:

- origin enforcement
- cookie and CSRF behavior
- password reset semantics
- persistence of runtime settings versus restart-required behavior

## Change CLI behavior

Start here:

- `apps/server/src/cli-command.ts`
- `apps/server/src/cli.ts`
- `apps/server/src/cli-renderer.ts`
- `apps/server/src/control-client.ts`

If the command mirrors a web action, also inspect:

- `apps/server/src/control.ts`
- `apps/server/src/server.ts`

## Add a new user-visible concept

For example a new status, request type, or host/thread setting.

Typical touch points:

- `packages/protocol/src/index.ts`
- `packages/storage/src/index.ts`
- `apps/server/src/server.ts`
- `apps/web/src/api.ts`
- `apps/web/src/App.tsx`
- tests for server, runtime, and UI where applicable

## Before You Finish

Run the narrowest checks that cover your change, then widen if needed.

Useful commands:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @cwb/server test:integration
```

If your change touches runtime orchestration, also review `AGENTS.md` for repo-specific lifecycle and SSH invariants.
