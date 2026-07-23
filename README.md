# Codex Web Bridge

Codex Web Bridge runs a single-user daemon and dashboard on public machine B. It connects to machine A over SSH, keeps each Codex session alive in tmux, uses Codex app-server for structured interaction, and exposes a read-only terminal with an explicit takeover lease.

The application deliberately returns no information over plain HTTP. Put Caddy in front of the daemon and access it only through the configured HTTPS origin.

## Requirements

- Machine B: Linux, Node.js 22+, pnpm 11, Caddy, curl and jq, and network access to A over SSH.
- Machine A: SSH server, tmux, and the pinned compatible Codex CLI available to the configured SSH user.
- A dedicated SSH key on B and a verified SHA-256 host-key fingerprint for A.

## Install and build

```bash
git clone <repository-url> codex-web-bridge
cd codex-web-bridge
pnpm install
pnpm build
```

The built CLI is `apps/server/dist/cli.js`. The following examples use a convenience shell variable:

```bash
CWB_CLI="$PWD/apps/server/dist/cli.js"
node "$CWB_CLI" help
```

Do not set `CWB_DATA_DIR` to a shared or web-served directory. By default state is stored at `~/.local/state/codex-web-bridge` with restricted permissions. It contains the password hash, session secret, SQLite database, PID, readiness marker, and daemon log.

## Configure Caddy and start

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
node "$CWB_CLI" dashboard  # prints the configured HTTPS URL
node "$CWB_CLI" stop
node "$CWB_CLI" restart
```

For diagnosis, inspect `~/.local/state/codex-web-bridge/daemon.log`. `start --foreground` is intended for a supervisor or local diagnosis and does not detach.

For a supervised deployment, copy [deploy/systemd/codex-web-bridge.service.example](deploy/systemd/codex-web-bridge.service.example), adjust its user, binary and state-directory paths, then enable it:

```bash
sudo cp deploy/systemd/codex-web-bridge.service.example /etc/systemd/system/codex-web-bridge.service
sudo systemctl daemon-reload
sudo systemctl enable --now codex-web-bridge
sudo systemctl status codex-web-bridge
```

## Add machine A

First verify A's host key through a trusted channel. The value stored by the bridge is the OpenSSH SHA-256 fingerprint, without making a trust-on-first-use decision:

```bash
ssh-keyscan -p 22 machine-a.example > /tmp/machine-a.hostkey
ssh-keygen -lf /tmp/machine-a.hostkey -E sha256
ssh -i ~/.ssh/codex_bridge user@machine-a.example 'tmux -V && codex --version'
```

After login, choose **主机配置**, then **新增主机**. Enter the verified fingerprint and the absolute private-key path on B. The dashboard never uploads or reads private-key contents in the browser. Existing hosts can be selected from the same panel and saved again under their stable ID. The status indicator shows `online`, `connecting`, or `offline` as reported by the daemon.

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
