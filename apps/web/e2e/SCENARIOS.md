# Playwright end-to-end scenarios

Run these against the built server behind Caddy, with a disposable A host and a test Codex account. Seed no browser cookies. Each scenario must assert both the visible result and the corresponding server/remote side effect.

1. **HTTP information blackout**
   - Visit the public hostname over plain HTTP without following redirects.
   - Assert the response exposes no application, authentication, host, or thread information.
   - If Caddy redirects, follow it and assert the application appears only after HTTPS is established.

2. **Authentication and session security**
   - On HTTPS, verify an anonymous browser sees only the login form.
   - Submit a wrong password, then the correct password.
   - Assert the cookie is `Secure`, `HttpOnly`, and `SameSite=Strict`; assert authenticated mutations without the CSRF header fail.
   - Reload and verify the session resumes; log out and verify protected API calls fail.

3. **Create and survive disconnect**
   - Create a thread on A with a valid working directory.
   - Assert a tmux session and Codex thread are created, messages stream into the conversation, and the TUI appears in the terminal tab.
   - Disconnect B's SSH transport, assert the tmux/Codex process remains alive, reconnect, and assert both structured events and terminal output resume without duplicated messages.

4. **Resume and exit semantics**
   - Resume a known Codex thread ID and send a follow-up turn.
   - Exit the active session, assert the tmux process stops, and assert the Codex history remains resumable.

5. **Structured interaction requests**
   - Trigger a Plan-mode choice and select one option.
   - Trigger free-form user input and submit a response.
   - Trigger command/file and escalation approvals; test both allow and deny.
   - Assert each request resolves once, remains visible until acknowledged, and the selected value reaches Codex.

6. **Streaming and interruption**
   - Start a long response, assert incremental deltas are rendered and the running state appears.
   - Interrupt it, assert generation stops, the partial response remains, and another turn can be started.

7. **Terminal read-only and takeover lease**
   - Open the terminal and type before takeover; assert no bytes reach tmux.
   - Explicitly acquire takeover, type a unique marker, and assert it reaches the pane.
   - Open a second browser context and assert it remains read-only while the first owns the lease.
   - Release takeover (and separately close the owning browser), then assert the second browser can acquire it.

8. **Screenshot**
   - Request a screenshot after known ANSI/color/CJK output.
   - Assert a non-empty image is returned only to an authenticated session and that dimensions match the captured pane.

9. **Invalid boundary inputs**
   - Try an unknown host/thread, invalid working directory, malformed thread ID, oversized message, and stale request ID.
   - Assert clear errors, no daemon crash, and no unintended remote command/session creation.

10. **Daemon restart recovery**
    - Restart the B daemon while A has active tmux sessions.
    - Reload the dashboard and assert host/thread inventory, structured state, and terminal attachment recover; assert no duplicate tmux or Codex process is created.
