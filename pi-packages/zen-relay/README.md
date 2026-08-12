# zen-relay — multi-IP relay for OpenCode Zen

OpenCode Zen's free tier rate-limits **per source IP** (same key works from a
different IP — that's the observed behavior). One gateway server = one quota
bucket. zen-relay spreads your requests across N gateway servers, each holding
**its own Zen account key**, and hides the rotation from the client:

```
pi ──► router (localhost:4096) ──┬──► leaf: Neon    (AS6939 Hurricane Electric)
                                 ├──► leaf: Lithium (AS203003 Magna Capax)
                                 └──► leaf: Silicon (AS36352 ColoCrossing)
                                      each leaf ──► https://opencode.ai/zen/v1
                                      with that server's key, from that
                                      server's public IP
```

- **leaf** — runs on each gateway. Forwards to Zen with *that server's key*,
  so Zen sees that server's IP. Listens on the tailnet IP only.
- **router** — runs where pi runs. Round-robins across leaves; on a clean 429
  marks the leaf cooling (~60s) and retries the same request on the next leaf;
  on 5xx/unreachable marks it down (~30s) and retries; other 4xx pass through
  untouched (no rotation). If *every* leaf is cooling it waits for the soonest
  revive (capped, default 90s) then retries once; if still exhausted it returns
  the last 429 honestly.

Security model: Zen keys live **only** in `/srv/zen-relay/zen-relay.env`
(mode 600) on each gateway — never on the pi machine, never in this repo.
Leaves require a shared token (`x-zen-relay-token` header, env `SHARED_TOKEN`)
that must match on the router and all leaves. No bodies or keys are logged.

## Files

| file | role |
|---|---|
| `zen-relay.ts` | the whole tool (`leaf` / `router` modes), zero deps |
| `zen-relay.test.ts` | e2e tests: mock Zen + real leaf/router processes |
| `zen-relay.leaf.service` | systemd unit for gateways (installed by deploy.sh) |
| `zen-relay.router.service` | systemd **user** unit for the pi machine |
| `deploy.sh` | build + ship + install a leaf on one gateway |
| `tsconfig.json` | typecheck (`bunx tsc -p .`) |

## Local dev

```bash
bun run test             # e2e suite (spawns mock Zen + leaves + routers)
bun run typecheck        # tsc --noEmit
bun run zen-relay.ts leaf   --port 8787                 # local leaf (keyless → passes client Authorization)
bun run zen-relay.ts router --port 4096                 # local router
```

## Deploying the leaves

For each gateway, run from this directory (this machine must be on the tailnet):

```bash
./deploy.sh root@184.75.240.17   # Neon    (ssh -p 3800 if key auth needs it: ./deploy.sh "root@184.75.240.17 -p 3800")
./deploy.sh root@185.148.3.53    # Lithium (ssh -p 6700)
./deploy.sh root@silicon.dabg.uk # Silicon
```

deploy.sh builds a static binary (`--target=bun-linux-<arch>-baseline`, built
for the box's arch), prompts for the **ZEN_API_KEY** (that gateway's account)
and the **SHARED_TOKEN** (same value everywhere), detects the box's tailnet IP
and writes the env file mode-600, installs + starts `zen-relay-leaf.service`,
then verifies `/healthz` over the tailnet and prints the public IP Zen will see.
The leaf binds to the tailnet IP — it is **not** reachable from the internet.

The three gateways must sit on **different networks** for rotation to multiply
quota under every counting model (see "The ASN question" below).

## Router on the pi machine

The router holds no Zen keys — just the shared token and the leaf URLs.

```bash
# one-time: build a binary and drop it where the user unit expects it
bun build --compile zen-relay.ts --outfile ~/.local/bin/zen-relay
mkdir -p ~/.config/zen-relay
cat > ~/.config/zen-relay/router.env <<EOF
GATEWAYS=http://100.111.190.51:8787,http://<lithium-tailnet-ip>:8787,http://100.113.160.13:8787
SHARED_TOKEN=<same token as the leaves>
PORT=4096
EOF
chmod 600 ~/.config/zen-relay/router.env
cp zen-relay.router.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now zen-relay-router
```

(Get Lithium's tailnet IP with `ssh root@185.148.3.53 'tailscale ip -4'`.)

Sanity check: `curl -s http://localhost:4096/healthz` → lists each gateway with
`cooling`/`down` booleans.

### Pointing pi at it

Duplicate your existing Zen provider in pi (same model ids, e.g. `zen`) but
change the base URL to `http://localhost:4096/v1`. The leaf strips the
duplicate `/v1` when mapping onto `https://opencode.ai/zen/v1`. A placeholder
API key is fine (leaves replace it with their own; if a leaf has no key, your
client Authorization is passed through).

## Behavior reference

| upstream answer | router action |
|---|---|
| `429` (FreeUsageLimitError) | leaf cooling (~60s, ±20% jitter), retry next leaf |
| `5xx` / unreachable | leaf down (~30s), retry next leaf |
| other `4xx` (401/403/400) | pass through as-is — no rotation |
| all leaves cooling | wait for soonest revive (≤90s), retry once, else return last 429 |
| all leaves down | `502` |
| mid-stream error | surfaces to the client (no transparent failover after the first token) |

Tunables (env on the router): `COOLDOWN_MS`, `DOWN_MS`, `MAX_WAIT_MS`.

## The ASN question

Quota buckets can be counted per-key, per-IP, per-(key, IP), or — the
escalation — per-(key, ASN): all IPs inside one network share a bucket, so
IP rotation within a single provider stops multiplying quota.

| gateway | IP | ASN |
|---|---|---|
| Neon | 184.75.240.17 | AS6939 Hurricane Electric |
| Lithium | 185.148.3.53 | AS203003 Magna Capax |
| Silicon | 23.94.182.147 | AS36352 ColoCrossing (same ASN as the retired Dubnium!) |

Current evidence (same key + new IP works) says Zen counts per-(key, IP) —
fine. **If it ever switches to per-ASN counting, Silicon shares its bucket
with any other 23.94.x box, so a replacement gateway must come from a
different provider.** Check any candidate box with
`curl -s https://ipinfo.io/<ip>/json | rg -o 'AS[0-9]+'`.

**15-minute test to learn what Zen actually counts** (once ≥2 leaves are up):
hammer one key on leaf A until it 429s, then immediately try

1. same key, leaf B (different ASN) — works ⇒ per-(key,IP)/per-(key,ASN);
   also 429 ⇒ per-key or per-account cap (keys are the only lever).
2. different key, leaf A (same IP) — works ⇒ the limit binds the key; also
   429 ⇒ the limit binds the network (IP diversity is the only lever).

## Design notes for future edits

- **Leaves buffer request bodies before replying.** Upstreams may answer early
  (429s, fast errors) without consuming the body; responding before the
  request is fully drained makes Bun.serve misread the *next* request on that
  keep-alive connection as leftover body and answer spurious 400s. This was a
  real bug, caught by the e2e suite. Don't "optimize" it back to streaming.
- The router buffers too (it must, to replay on retry). Bodies are
  JSON-sized; fine.
- Only clean 429s (before any token) are retried — safe for POST chat
  completions.
- Logs are one line per request: method, path, gateway chain, status,
  duration. No bodies, no keys.
