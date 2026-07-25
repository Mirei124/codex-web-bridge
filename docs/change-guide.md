# Change Guide

This file is a routing aid, not an implementation manual.

## Start Here By Concern

- HTTP API, state projection, pending requests: `apps/server/src/server.ts`
- SSH, tmux, terminal plumbing, remote command execution: `packages/remote-runtime/src/index.ts`
- runtime lifecycle, reconnect, host/session attachment: `apps/server/src/runtime-manager.ts`
- persistence and schema: `packages/storage/src/index.ts`
- dashboard behavior: `apps/web/src/App.tsx`
- CLI behavior: `apps/server/src/cli.ts` and `apps/server/src/cli-command.ts`
- shared API or event shapes: `packages/protocol/src/index.ts`

## Areas That Usually Need Coordinated Changes

- new persisted fields
- new user-visible statuses
- new API or event shapes
- thread lifecycle changes
- terminal behavior changes
- approval or request-user-input changes

When touching one of those, expect both server and web updates, and often storage or protocol updates as well.

## Before Editing

- Read `AGENTS.md`
- Read the main file for the area you are changing
- Identify whether the change affects storage, protocol, runtime lifecycle, or UI projection

## Before Finishing

- Run the narrowest relevant checks
- Re-read `AGENTS.md` if the change touches lifecycle, SSH, tmux, terminal input, or event routing
