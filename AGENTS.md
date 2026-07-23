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
