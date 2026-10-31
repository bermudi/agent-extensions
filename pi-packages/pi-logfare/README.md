# pi-logfare

Pi provider package for [Logfare](https://logfare.ai) — replaces the
hand-maintained `logfare` block in `models.json` with a provider registered
from Logfare's **live public catalog**.

## How it works

On every session the extension registers the `logfare` provider with:

- `baseUrl` `https://logfare.ai/v1`, `openai-completions` API
- `apiKey` `!pass-keys get pi LOGFARE_API_KEY` (resolves at request time; no key is ever stored or logged here)
- the frozen baseline list (`src/baseline.json`) so the provider works offline before the first refresh
- a `refreshModels` hook following pi's built-in remote-catalog contract:
  1. restore the last persisted catalog from pi's models-store (works offline),
  2. skip the network if the stored catalog was checked < 4h ago (`force` bypasses),
  3. otherwise fetch `GET /v1/models` (public, no auth), transform, and
     `context.publish({ persist })` so pi keeps the last-good list across sessions.
  4. on fetch failure the previous list stays in place and the error surfaces
     through pi's refresh result.

When refreshes actually run (pi 1.4.0):

- **interactive session start**: pi force-runs a catalog refresh 15s-bounded
  (skipped with `PI_OFFLINE=1`) — this is the main freshness path.
- **model picker open**: refreshes again (bounded by the 4h window).
- **print mode (`pi -p`) and `pi update --models` never refresh extension
  providers** — they run without extensions or with a bare runtime, so those
  sessions see the last persisted (or baseline) list.

For the specifically reported Logfare capacity error (code 4006 and the reported
message with a request identifier), the `message_end` hook preserves the original
error and adds a marker Pi recognizes for its normal assistant retry. Other
errors and providers are untouched. Retries depend on Pi's retry settings and
budget; the extension cannot set a per-error delay through this hook, so Pi's
configured backoff applies. This does not cover calls outside the assistant
message lifecycle, such as classifier calls.

Set `PI_LOGFARE_DEBUG=1` to trace refresh phases to
`/tmp/pi-logfare-debug.log`.

## What stays manual

- `maxTokens` (16384) and `cost` (zeros) are placeholders — the catalog
  publishes neither output limits nor USD prices.
- Chat-reachability is not probed; a catalog-listed model can still 404.
- `enabledModels` entries in `~/.pi/agent/settings.json` are hand-picked.
- Policy tables in `src/transform.ts`: per-family `thinkingLevelMap`s and the
  per-id `MODEL_OVERRIDES` (each entry needs a stated reason).

## Development

```
bun x tsc --noEmit        # typecheck
node --test test/*.test.ts
```

`test/fixtures/logfare-catalog.json` is a pinned live catalog response; the
headline test asserts the transform reproduces the frozen hand-maintained
baseline from it exactly. When the transform changes intentionally, re-pin the
fixture and re-derive the baseline.

Install: add `../../build/pi-logfare` to `packages` in pi's `settings.json`
(relative to `~/.pi/agent`).
