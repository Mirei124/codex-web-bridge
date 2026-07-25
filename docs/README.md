# Documentation Index

This directory is for agents and developers who need a fast, accurate mental model of the repository before making changes.

Read in this order:

1. [Architecture](./architecture.md)
2. [Module Map](./module-map.md)
3. [Engineering Conventions](./engineering-conventions.md)

## What This Documentation Covers

- process and runtime model
- end-to-end data flow
- persistence model
- ownership of major modules
- common change entry points
- project-specific rules that are easy to break

## Sources of Truth

- Runtime and API behavior: `apps/server/src`
- Remote orchestration: `packages/remote-runtime/src`
- Persistence schema: `packages/storage/src`
- Shared protocol types: `packages/protocol/src`
- Config and state paths: `packages/config/src`
- Codex app-server client behavior: `packages/codex-client`

## Read This Alongside

- [AGENTS.md](../AGENTS.md)
- [packages/codex-client/PROTOCOL.md](../packages/codex-client/PROTOCOL.md)
