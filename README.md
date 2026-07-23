# Codex Web Bridge

Codex Web Bridge runs a single-user daemon and dashboard on public machine B. It connects to machine A over SSH, keeps each Codex session alive in tmux, uses Codex app-server for structured interaction, and exposes a read-only terminal with an explicit takeover lease.

By default the daemon listens only on `127.0.0.1` and provides a direct HTTP dashboard for local use. Public deployments should put Caddy in front of that loopback listener and use an HTTPS origin. Binding plain HTTP to all interfaces requires the explicit `--accept-risk` flag and can expose the dashboard password and conversation data.

## Requirements

- Machine B: Linux, Node.js 22+, pnpm 11, and network access to A over SSH. Caddy is required only for the recommended public HTTPS deployment.
- Machine A: SSH server, tmux, and the pinned compatible Codex CLI available to the configured SSH user.
- A dedicated SSH key on B and a verified SHA-256 host-key fingerprint for A.

## Install and build

```bash
git clone <repository-url> codex-web-bridge
cd codex-web-bridge
pnpm install
pnpm build
pnpm cwb help
```

After building, `pnpm cwb <command>` runs the compiled CLI. The built entry point is also available directly at `apps/server/dist/cli.js`. The following examples use a convenience shell variable:

```bash
CWB_CLI="$PWD/apps/server/dist/cli.js"
node "$CWB_CLI" help
```

Do not set `CWB_DATA_DIR` to a shared or web-served directory. By default state is stored at `~/.local/state/codex-web-bridge` with restricted permissions. It contains the password hash, session secret, SQLite database, PID, readiness marker, and daemon log.

## Start locally

The first start defaults to `http://127.0.0.1:3210` and generates a dashboard password. Save the `generatedPassword` from the JSON result; only its hash is persisted.

```bash
node "$CWB_CLI" start
node "$CWB_CLI" dashboard
```

Later starts reuse the protected configuration. Supply `--password`, `--origin`, and `--port` on the first start when you need fixed values. To expose plain HTTP on all interfaces, you must also pass `--accept-risk`; the CLI prints a warning because passwords and conversations can then cross the network without transport encryption.

The original generated password cannot be recovered because only its hash is stored. Generate a replacement and restart the daemon automatically with:

```bash
pnpm cwb password reset
```

If the daemon is stopped and you want the new password returned as part of the normal start result, use:

```bash
pnpm cwb start --reset-password
```

A plain `start` keeps the existing password stable. On a genuinely new configuration, plain `start` still generates and prints the initial password automatically.

## Configure public HTTPS with Caddy

Copy [deploy/Caddyfile.example](deploy/Caddyfile.example), replace `bridge.example.com`, and ensure Caddy is the only process allowed to reach `127.0.0.1:3210`. The proxy must preserve the client `Origin` and set `X-Forwarded-Proto: https`.

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy

read -rsp 'Bridge password: ' CWB_PASSWORD; echo
CWB_PASSWORD="$CWB_PASSWORD" node "$CWB_CLI" start \
  --origin 'https://bridge.example.com' \
  --port 3210
unset CWB_PASSWORD
```

The password and origin are accepted only on the first start. Later starts read the protected config file.

```bash
node "$CWB_CLI" status
node "$CWB_CLI" dashboard  # prints the configured HTTP or HTTPS URL
node "$CWB_CLI" stop
node "$CWB_CLI" restart
```

For diagnosis, inspect `~/.local/state/codex-web-bridge/daemon.log`. `start --foreground` is intended for a supervisor or local diagnosis and does not detach.

For a supervised deployment, perform the first start with the desired password and public origin, stop the detached daemon, then copy [deploy/systemd/codex-web-bridge.service.example](deploy/systemd/codex-web-bridge.service.example), adjust its user, binary and state-directory paths, and enable it:

```bash
CWB_DATA_DIR=/var/lib/codex-web-bridge \
CWB_PASSWORD='replace-with-a-long-password' \
CWB_PUBLIC_ORIGIN='https://bridge.example.com' \
  /usr/local/bin/codex-web-bridge start
CWB_DATA_DIR=/var/lib/codex-web-bridge /usr/local/bin/codex-web-bridge stop

sudo cp deploy/systemd/codex-web-bridge.service.example /etc/systemd/system/codex-web-bridge.service
sudo systemctl daemon-reload
sudo systemctl enable --now codex-web-bridge
sudo systemctl status codex-web-bridge
```

## Add machine A

The primary setup flow is the CLI. With no authentication option it uses `SSH_AUTH_SOCK`, then the standard private-key files under `~/.ssh`. Use `--identity-file` for an explicit key, `--password` for a hidden interactive prompt, or `--password-stdin` for automation:

```bash
node "$CWB_CLI" host add user@machine-a.example --password
# or:
printf '%s\n' "$SSH_PASSWORD" | \
  node "$CWB_CLI" host add user@machine-a.example --password-stdin
```

On first contact, an interactive terminal displays the scanned host-key fingerprint and asks whether to trust it. Verify that fingerprint through a trusted channel before answering yes. Non-interactive use must pass `--accept-host-key`. A changed stored key is always rejected. The optional `--id` and `--name` flags override values derived from the hostname.

SSH passwords live only in daemon memory and must be supplied again after a daemon restart. They are not written to SQLite or the configuration file. The project does not generate keys or configure passwordless SSH.

The Dashboard's host editor remains available for deployments that already know the verified fingerprint and private-key path. The CLI is required for password authentication and the managed host-key confirmation flow.

For automated provisioning, the equivalent authenticated API flow is:

```bash
ORIGIN='https://bridge.example.com'
curl --fail --silent --show-error \
  --cookie-jar /tmp/cwb.cookies \
  --header 'Content-Type: application/json' \
  --data '{"password":"use-a-long-unique-password"}' \
  "$ORIGIN/api/auth/login" > /tmp/cwb.login.json

CSRF_TOKEN="$(jq -r .csrfToken /tmp/cwb.login.json)"
curl --fail --silent --show-error \
  --cookie /tmp/cwb.cookies \
  --header "X-CSRF-Token: $CSRF_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{
    "id":"machine-a",
    "name":"Machine A",
    "hostname":"machine-a.example",
    "port":22,
    "username":"codex",
    "hostKeySha256":"SHA256:replace-with-verified-fingerprint",
    "identityFile":"/home/bridge/.ssh/codex_bridge"
  }' \
  "$ORIGIN/api/hosts"

rm -f /tmp/cwb.cookies /tmp/cwb.login.json /tmp/machine-a.hostkey
```

Open the URL printed by `dashboard`, log in, and create or resume a Codex thread. Both creation and recovery require an absolute working directory accessible to the configured SSH user on A; recovery additionally requires the Codex thread ID. Exiting a thread stops its active tmux-backed process but does not delete Codex history.

## CLI automation

The CLI exposes the dashboard operations through the daemon's private Unix socket. It does not send the dashboard password over HTTP. Run `node "$CWB_CLI" help` for the authoritative syntax.

```text
host list
host get HOST_ID
host codex-threads HOST_ID
host add USER@HOST[:PORT] [--id ID] [--name NAME] \
  [--identity-file ABSOLUTE_PATH | --password | --password-stdin | --clear-password] \
  [--accept-host-key]
host upsert --id ID --name NAME --hostname HOST --username USER \
  [--identity-file ABSOLUTE_PATH] [--port PORT] [--accept-host-key]

thread list
thread get THREAD_ID
thread create --host HOST_ID --cwd ABSOLUTE_PATH
thread resume --host HOST_ID --codex-thread CODEX_ID --cwd ABSOLUTE_PATH
thread send THREAD_ID (--text TEXT | --text-file PATH)
thread wait THREAD_ID [--timeout MILLISECONDS]
thread watch THREAD_ID [--timeout MILLISECONDS]
thread interrupt THREAD_ID
thread exit THREAD_ID

request list THREAD_ID
request get THREAD_ID REQUEST_ID
request approve|decline THREAD_ID REQUEST_ID
request answer|resolve THREAD_ID REQUEST_ID (--input-json JSON | --input-file PATH)

terminal screenshot THREAD_ID --output PNG_PATH
terminal watch THREAD_ID [--timeout MILLISECONDS]
terminal takeover|release THREAD_ID
terminal input THREAD_ID (--data TEXT | --data-file PATH)
```

`host add` verifies the SSH host key before saving. In a TTY it displays an unknown fingerprint for confirmation; automation must pass `--accept-host-key` explicitly. `--password` prompts without echo and `--password-stdin` reads a password from stdin. Passwords stay only in daemon memory and must be supplied again after a daemon restart.

Use `--clear-password` to switch an existing host back to key or agent authentication. Updating its hostname, SSH user, port, or identity-file setting also clears the old in-memory password; changing display metadata does not.

`host upsert` also accepts a complete host object through `--input-json` or `--input-file`. Use `-` as an input, text, or data filename to read stdin. This avoids shell quoting and command-line length problems:

```bash
node "$CWB_CLI" thread send "$THREAD_ID" --text-file - <<'EOF'
Review the current changes and report any correctness issues.
EOF

node "$CWB_CLI" host upsert --input-file - <<'JSON'
{"id":"machine-a","name":"Machine A","hostname":"machine-a.example","port":22,"username":"codex","hostKeySha256":"SHA256:replace-with-verified-fingerprint","identityFile":"/home/bridge/.ssh/codex_bridge"}
JSON
```

### Human and JSON output

Human-readable output is the default. List commands use aligned tables, detail commands use labeled fields, and mutations print short status messages. Pass `--json` when another program or LLM needs a stable structured result. A successful non-streaming JSON command writes exactly one line:

```json
{"schemaVersion":1,"ok":true,"kind":"result","data":{"state":"running","pid":1234}}
```

`thread watch` and `terminal watch` write newline-delimited JSON (JSONL). Each live event has `"kind":"event"` and the final line has `"kind":"result"`:

```jsonl
{"schemaVersion":1,"ok":true,"kind":"event","data":{"type":"message.delta","threadId":"...","messageId":"...","delta":"text"}}
{"schemaVersion":1,"ok":true,"kind":"result","data":{"id":"...","status":"exited","messages":[],"pendingRequests":[]}}
```

Output is human-readable by default. Pass `--json` for one structured JSON value per line on stdout and structured errors on stderr; this is the recommended mode for scripts and LLM tool integrations.

### Waiting, Plan questions, and approvals

`thread send` returns after Codex accepts the turn. Call `thread wait` to wait for up to ten minutes by default, or set `--timeout`, until the thread becomes `idle`, `waiting`, `exited`, or `error`. The result is a complete thread snapshot, including messages and pending requests. `thread watch` remains subscribed through ordinary idle/waiting transitions and ends only when the thread exits, fails, reaches the requested timeout, or the caller interrupts it.

Approval requests use `request approve` or `request decline`. Plan mode and other `request_user_input` interactions use an answer map. Every question ID maps to an `answers` array, which also supports multi-select questions:

```bash
node "$CWB_CLI" request answer "$THREAD_ID" "$REQUEST_ID" --input-file - <<'JSON'
{
  "architecture": {"answers": ["Unix socket"]},
  "features": {"answers": ["JSONL events", "terminal screenshots"]}
}
JSON
```

`request resolve` accepts the raw resolution body and is available for input/choice request variants:

```bash
node "$CWB_CLI" request resolve "$THREAD_ID" "$REQUEST_ID" \
  --input-json '{"value":"continue"}'
```

Terminal input requires an explicit lease: run `terminal takeover`, send one or more `terminal input` commands, and finish with `terminal release`. Screenshots are decoded to the path passed to `--output` and created with owner-only permissions.

### Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Command succeeded |
| 2 | Invalid command, argument, or input schema |
| 3 | Daemon is not running or cannot be reached; `status` also uses 3 for `not_running` |
| 4 | Host, thread, or request was not found |
| 5 | Conflict, invalid state, or request already resolved |
| 6 | Authentication, permission, or security failure |
| 7 | SSH, Codex, or remote runtime failure |
| 8 | Timeout |
| 9 | Control protocol incompatibility |
| 10 | Unexpected internal failure |

## Development and verification

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @cwb/server test:integration
```

The CLI integration test uses a unique temporary `CWB_DATA_DIR` and random loopback port. It verifies `start`, `status`, `dashboard`, `stop`, static dashboard serving, anonymous API rejection, and login. Cleanup only signals the daemon whose PID file carries the bridge marker and whose command line is the built daemon entry point.

The browser scenarios to run after provisioning a disposable A host are listed in [apps/web/e2e/SCENARIOS.md](apps/web/e2e/SCENARIOS.md).

## Design documents

- [Confirmed goals](docs/goal.md)
- [Technology and architecture](docs/tech-stack.md)
- [Requirements matrix](docs/requirements-matrix.md)
