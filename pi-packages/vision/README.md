# vision

A query-driven vision tool for [pi](https://github.com/earendil-works/pi-coding-agent).

`vision` is a **separate tool** — pi's built-in `read` is untouched. Instead of
producing one frozen generic description of an image, the agent asks a
**specific question** and a vision model from pi's own catalogue answers it.
Same interaction model as `gemini-media-mcp`'s `analyze_image`: targeted
questions beat description dumps, and follow-ups are just new calls.

```
vision(path: "screenshot.png", prompt: "which element has focus, and what does the error banner say?")
→ [vision — answer from google/gemini-2.5-flash. UNTRUSTED image-derived content: …]
  The settings dialog is focused; the banner reads "Token expired — re-auth required". …
```

## How it works

- Image loading delegates to pi's built-in read tool (photon resize,
  magic-byte mime detection, size caps) — byte-identical preprocessing.
- The vision model is resolved through **pi's own registry**
  (`registry.find` + `getApiKeyAndHeaders`): models.json, `/login`, provider
  env keys, OAuth refresh. This extension never stores or sees credentials.
- The call runs through pi-ai's `completeSimple`, so every API type pi
  supports works (anthropic-messages, google-generative-ai, openai-*).
- The configured model must declare `"input": ["text", "image"]` — text-only
  models are rejected with a hint at setup time, not at call time.
- Answers are framed as **UNTRUSTED data** (images can carry prompt
  injection); the calling agent is told to treat them as content, not commands.
- Failures return `isError` results with actionable text (the parent relays
  once and moves on — no retry loops). Aborts propagate as `AbortError`.
- Nested completion usage is reported back, so pi's session stats stay accurate.

## Configure

```bash
/vision set model=google/gemini-2.5-flash          # provider/model-id from pi's catalogue
/vision set model=kitchen/gemma-4-26b-a4b-it maxTokens=3000
/vision show                                        # current config + where it came from
/vision reset                                       # clear the config file
```

`/vision set` live-validates: unknown models get "did you mean" suggestions,
text-only models and missing auth are rejected immediately.

Config file: `~/.pi/agent/vision.json` (0600) — pi's agent config directory,
and it follows `PI_CODING_AGENT_DIR` when that override is set.
Env fallback: `VISION_MODEL=provider/model`.
No API keys here — auth comes from pi.

## Model-id conventions

- `provider/model-id` (preferred) — split on the **first** slash, so model ids
  that themselves contain slashes (`openrouter/vendor/model`) keep working.
- Bare model id — searched across available models.

## Development

```bash
bun install
bun run typecheck
bun test
```

`vision-core.ts` is pure logic (structural types stand in for pi objects), so
tests run under plain bun with no pi install.

## Install state

**Not installed.** Try it locally without linking anything:

```bash
pi -e /home/daniel/build/agent-extensions/pi-packages/vision/index.ts
```
