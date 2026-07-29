# Bug Note — `fetch failed` in `callTelegram`

**Date:** 2025-05-20
**Reporter:** bermudi
**Severity:** Unconfirmed — likely upstream, not our local fork

## Error

```
error: fetch failed
  at callTelegram (index.ts:340)
  at finalizePreview (index.ts:500)
  at index.ts:1069
```

Full stack trace in pi session log. The `fetch failed` comes from `undici` — no status code, no response body. Suggests the request never completed (DNS, timeout, TLS, or network-level failure).

## Context

- Happened during `finalizePreview` → `callTelegram` call chain.
- Extension was the **upstream** version at `/home/daniel/Desktop/Clients/recam-laser-international/.pi/git/github.com/badlogic/pi-telegram/index.ts`, **not** our local `pi/pi-telegram/`.
- No local changes had been applied yet.

## TODO

- [ ] Reproduce with our local fork and compare behavior.
- [ ] Check if it's a transient network issue (Telegram API rate limit / downtime).
- [ ] Add better error handling in `callTelegram` — catch fetch errors, log the URL and status, retry with backoff.
- [ ] Consider adding a health check or pre-flight before sending previews.
