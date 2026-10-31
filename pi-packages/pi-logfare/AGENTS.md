# AGENTS.md — pi-logfare

Package-scoped rules for working on this repo. See README.md for behavior.

## Invariants

- `API_KEY_READER` must stay the `!pass-keys get pi LOGFARE_API_KEY` command
  reader. Never inline, cache, or log a resolved key. `fetchCatalog` must never
  send credentials — `/v1/models` is public.
- `src/baseline.json` is a frozen snapshot (2026-10-22) of the last
  hand-maintained `models.json` block. It only matters before the first
  successful refresh persists to pi's models-store. Regenerate it from real
  catalog data, never by hand.
- `MODEL_OVERRIDES` entries must state the reason in a comment. The headline
  test (`test/transform.test.ts`) pins transform output to the baseline
  exactly — when you change the transform intentionally, re-pin the fixture
  (`test/fixtures/logfare-catalog.json`) and re-derive the baseline, and say
  why in the commit.
- The catalog publishes no output-token limits or USD prices: `maxTokens` and
  zero `cost` are placeholders by design. Do not invent values.
- Extension code must not import `@earendil-works/pi-ai` subpaths other than
  the sanctioned aliases (root, `/compat`, `/models`, `/oauth`,
  `/providers/all`). The extension loader's jiti aliases rewrite any other
  subpath onto `dist/compat.js` and the package fails to load
  ("Cannot find module .../compat.js/api/..."). The CLI can mask this when a
  local `node_modules` dev copy resolves the specifier first — the SDK
  loader exposes it. `src/decisions.ts` is self-contained for that reason;
  its wire format is pinned by probes + recorded-body unit tests, not by
  reuse of pi-ai's `/api/*` System One core.

## Verification

```
bun x tsc --noEmit
node --test test/transform.test.ts test/refresh.test.ts
```

Live checks (order matters):

1. `pi --list-models logfare` — extension loads, provider registers.
2. `PI_LOGFARE_DEBUG=1` + an interactive pi session (print mode never
   network-refreshes) — `/tmp/pi-logfare-debug.log` shows the refresh phases.
3. `jq -r 'keys' ~/.pi/agent/models-store.json` — flat provider-id keys;
   `logfare` appears after the first network refresh. Keys only — the store
   also holds auth data.
4. `pi -p "Reply with exactly: ok" --model logfare/glm-5.3-flash` — real
   request through the pass-keys reader.
