# zen-relay — all-local multi-IP relay for OpenCode Zen

zen-relay is a standalone local proxy for pi. Nothing custom runs on the gateway servers: three persistent SSH SOCKS tunnels use Neon, Lithium, and Silicon as egress routes, and one local relay chooses a route + matching Zen account key for each request.

```text
pi ──► localhost:4096 (zen-relay)
         ├── SOCKS :1080 ──SSH──► Neon    ──► opencode.ai/zen (key A)
         ├── SOCKS :1081 ──SSH──► Lithium ──► opencode.ai/zen (key B)
         └── SOCKS :1082 ──SSH──► Silicon ──► opencode.ai/zen (key C)
```

Zen sees the gateway's public IP. On a clean 429 the route cools for about 60 seconds and the same request is retried through the next route. A dead tunnel or 5xx marks the route down for about 30 seconds. Other 4xx responses pass through unchanged; errors after streaming starts cannot be retried transparently.

All three Zen keys live locally in one mode-600 environment file. No keys or request bodies are logged.

## Files

| file | role |
|---|---|
| `zen-relay.ts` | local HTTP relay: SOCKS egress, per-route keys, rotation + retry |
| `zen-relay.test.ts` | e2e tests using a mock Zen and real SOCKS5 mock tunnels |
| `zen-relay.service` | local user service for the relay |
| `zen-relay-tunnel@.service` | local user service template for each SSH SOCKS tunnel |

## 1. Build and verify

Run only inside this package:

```bash
cd ~/build/agent-extensions/pi-packages/zen-relay
bun install
bun run typecheck
bun run test
mkdir -p ~/.local/bin ~/.config/zen-relay ~/.config/systemd/user
bun build --compile zen-relay.ts --outfile ~/.local/bin/zen-relay
```

## 2. Verify SSH access over Tailscale

The tunnel services are non-interactive (`BatchMode=yes`), so test each connection once first. This also records host keys in `known_hosts`:

```bash
ssh -o BatchMode=yes root@100.111.190.51 true  # Neon
ssh -o BatchMode=yes root@100.113.1.122 true   # Lithium
ssh -o BatchMode=yes root@100.113.160.13 true  # Silicon
```

If a box uses a different SSH user, use that user in both this test and its tunnel env file below.

## 3. Configure the three local SOCKS tunnels

```bash
cat > ~/.config/zen-relay/tunnel-neon.env <<'EOF'
GATEWAY=root@100.111.190.51
LOCAL_PORT=1080
EOF

cat > ~/.config/zen-relay/tunnel-lithium.env <<'EOF'
GATEWAY=root@100.113.1.122
LOCAL_PORT=1081
EOF

cat > ~/.config/zen-relay/tunnel-silicon.env <<'EOF'
GATEWAY=root@100.113.160.13
LOCAL_PORT=1082
EOF

chmod 600 ~/.config/zen-relay/tunnel-*.env
cp zen-relay-tunnel@.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now \
  zen-relay-tunnel@neon \
  zen-relay-tunnel@lithium \
  zen-relay-tunnel@silicon
```

Verify each tunnel's actual egress before adding keys:

```bash
curl --socks5-hostname 127.0.0.1:1080 https://api.ipify.org; echo  # expect 184.75.240.17
curl --socks5-hostname 127.0.0.1:1081 https://api.ipify.org; echo  # expect 185.148.3.53
curl --socks5-hostname 127.0.0.1:1082 https://api.ipify.org; echo  # expect 23.94.182.147
```

## 4. Configure and start the relay

Use one Zen key from a different account per route:

```bash
cat > ~/.config/zen-relay/zen-relay.env <<'EOF'
HOST=127.0.0.1
PORT=4096
ZEN_URL=https://opencode.ai/zen/v1

ROUTE_1_SOCKS=socks5://127.0.0.1:1080
ROUTE_1_KEY=PASTE_NEON_ACCOUNT_KEY
ROUTE_2_SOCKS=socks5://127.0.0.1:1081
ROUTE_2_KEY=PASTE_LITHIUM_ACCOUNT_KEY
ROUTE_3_SOCKS=socks5://127.0.0.1:1082
ROUTE_3_KEY=PASTE_SILICON_ACCOUNT_KEY
EOF
chmod 600 ~/.config/zen-relay/zen-relay.env

cp zen-relay.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now zen-relay
curl -s http://127.0.0.1:4096/healthz
```

Expected health output lists three routes with `cooling: false` and `down: false`.

## 5. Point pi's native OpenCode provider at the relay

Pi's built-in provider id is `opencode`. A provider-level base URL override preserves all 60 built-in models, their OpenAI/Responses/Anthropic API types, compatibility flags, and existing auth. Add this to `~/.pi/agent/models.json` under `providers`:

```json
"opencode": {
  "baseUrl": "http://127.0.0.1:4096"
}
```

The base URL deliberately has **no `/v1` suffix**. Pi appends the correct path for each model API; zen-relay maps it onto Zen's canonical endpoint. The native opencode key that pi sends is ignored and replaced with the selected route's key.

A safe merge command (preserves all existing providers) is:

```bash
bun -e '
const fs = require("fs");
const p = process.env.HOME + "/.pi/agent/models.json";
const o = JSON.parse(fs.readFileSync(p, "utf8"));
o.providers ??= {};
o.providers.opencode = { ...(o.providers.opencode ?? {}), baseUrl: "http://127.0.0.1:4096" };
fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n");
'
```

Restart pi, then select the same `opencode/<model>` you already use. To bypass the relay temporarily, stop `zen-relay` and remove the `opencode` override from `models.json`.

## Operations

```bash
# status
systemctl --user status zen-relay 'zen-relay-tunnel@*'

# logs
journalctl --user -u zen-relay -f
journalctl --user -u 'zen-relay-tunnel@*' -f

# restart everything
systemctl --user restart \
  zen-relay-tunnel@neon \
  zen-relay-tunnel@lithium \
  zen-relay-tunnel@silicon \
  zen-relay
```

Router tuning in `zen-relay.env`:

- `COOLDOWN_MS` — 429 cooldown, default `60000`
- `DOWN_MS` — dead tunnel / 5xx cooldown, default `30000`
- `MAX_WAIT_MS` — longest wait when every route is cooling, default `90000`

## ASN note

- Neon: AS6939 Hurricane Electric
- Lithium: AS203003 Magna Capax
- Silicon: AS36352 ColoCrossing

They are three different ASNs. Silicon shares AS36352 with the retired Dubnium; that does not matter now that Dubnium is not a route.
