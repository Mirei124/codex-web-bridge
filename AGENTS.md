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
