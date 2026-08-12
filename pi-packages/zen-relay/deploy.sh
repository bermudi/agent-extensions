#!/usr/bin/env bash
# deploy.sh — build the zen-relay leaf binary and install it on a gateway.
#
# Usage:  ./deploy.sh <user@host> [--arch auto|x64|arm64]
# Example: ./deploy.sh root@184.75.240.17
#
# Secrets are prompted (read -s), never passed as argv, never written to
# shell history. They end up only in /srv/zen-relay/zen-relay.env (mode 600)
# on the target, which systemd loads as EnvironmentFile.
set -euo pipefail
cd "$(dirname "$0")"

TARGET="${1:?usage: ./deploy.sh <user@host> [--arch auto|x64|arm64]}"
ARCH="${2:-auto}"

if [ "$ARCH" = "auto" ]; then
  if ssh "$TARGET" 'uname -m' 2>/dev/null | grep -q aarch64; then
    ARCH=arm64
  else
    ARCH=x64
  fi
  echo "→ remote arch: $ARCH"
fi

echo "→ building zen-relay (bun-linux-$ARCH-baseline)..."
bun build --compile --target="bun-linux-$ARCH-baseline" zen-relay.ts --outfile /tmp/zen-relay >/dev/null

echo "→ reading secrets (kept out of shell history)..."
read -rsp "  ZEN_API_KEY for $TARGET (this gateway's Zen account key): " KEY; echo
read -rsp "  SHARED_TOKEN (must match the router and every other leaf): " TOKEN; echo
[ -n "$KEY" ] || { echo "empty key — aborting"; exit 1; }
[ -n "$TOKEN" ] || { echo "empty token — aborting"; exit 1; }

HOST="$(ssh "$TARGET" 'tailscale ip -4 2>/dev/null | head -1' || true)"
if [ -z "$HOST" ]; then
  read -rp "  tailscale ip -4 failed — enter this box's tailnet IP: " HOST
fi
echo "→ leaf will bind to tailnet IP $HOST (not reachable from the public internet)"

ssh "$TARGET" 'mkdir -p /srv/zen-relay'
scp -q /tmp/zen-relay "$TARGET:/srv/zen-relay/zen-relay"
scp -q zen-relay.leaf.service "$TARGET:/etc/systemd/system/zen-relay-leaf.service"

ssh "$TARGET" "cat > /srv/zen-relay/zen-relay.env <<EOF
ZEN_API_KEY=$KEY
SHARED_TOKEN=$TOKEN
HOST=$HOST
PORT=8787
EOF
chmod 600 /srv/zen-relay/zen-relay.env
chmod 755 /srv/zen-relay/zen-relay
systemctl daemon-reload
systemctl enable --now zen-relay-leaf
sleep 1
systemctl is-active zen-relay-leaf"

echo "→ verifying healthz over the tailnet..."
curl -s --max-time 5 -H "x-zen-relay-token: $TOKEN" "http://$HOST:8787/healthz"
echo
echo "✓ deployed. The 'publicIp' above is what Zen sees — record it for the ASN test."
