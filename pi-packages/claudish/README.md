# claudish

A Pi extension that shows a **plain-English rewrite of each assistant message**,
produced by the same model you're chatting with (default), a local LLM via
ollama, the Anthropic API, or any OpenAI-compatible API. A port of the Claude
Code plugin [`gvzdv/claudish-to-english`](https://github.com/gvzdv/claudish-to-english).

For chat it is **display-only**: the rewrite appears as a `💬 In plain English:`
block under the original message, and because it is rendered as a custom session
entry it never participates in LLM context — the assistant message and the saved
transcript keep the original text.

An optional second hook rewrites **Markdown files** into plain English when they
are written or edited (opt-in via `mdDir` in the config file, off by default).
That hook does change bytes on disk.

Everything **fails open** — if anything goes wrong (provider down, timeout,
missing key or model), you simply see the original text. The plugin can never
swallow or corrupt an answer.

## Install

This is a normal Pi extension package. From the repo:

```bash
# project-local (this repo only)
ln -s pi-packages/claudish/index.ts .pi/extensions/claudish.ts

# global (all projects)
ln -s pi-packages/claudish/index.ts ~/.pi/agent/extensions/claudish.ts
```

Once published, install the pinned package the usual way:

```
pi install npm:claudish@X.Y.Z
```

Extensions load at session start; use `/reload` to pick up changes mid-session.

## Configuration

All behavior is controlled by a JSON file at `<agentDir>/claudish.json` (the
same directory pi uses for `settings.json`, `fixed-defaults.json`, etc.). No
environment variables. The file is read at session start and on `/reload`; hand
edits are picked up without a restart.

**Auth is not configured here.** Claudish resolves API keys from pi's model
registry — it reuses the same key pi already has for the provider. If pi can
talk to your model, claudish can too.

**`model` and `provider` default to the session's active model.** When absent
from the config file, claudish rewrites through the same model you're chatting
with. Pin a cheaper model in the config file to save tokens:

```json
{
  "model": "claude-3-5-haiku-latest",
  "provider": "anthropic"
}
```

Or just leave them out and let it follow your session model.

### Quick start

With no config file, claudish uses the session model and its provider's API
shape. If you're chatting with Claude, rewrites go through the Anthropic API
using pi's stored Anthropic key. If you're on GPT, they go through the OpenAI
API. For any other provider, it defaults to ollama (local).

To use ollama explicitly:

```json
{
  "provider": "ollama",
  "model": "llama3.2:3b"
}
```

### Ollama requirements

With the ollama provider the extension talks to a local model, and nothing
works until these are in place:

1. **ollama, running** — `ollama serve` (serves on `localhost:11434`).
2. **A pulled model** — `ollama pull <tag>` (e.g. `llama3.2:3b`), then set
   `model` in the config file to that tag.
3. Warm the model once after starting ollama (the first call is a slow cold
   load): `ollama run <tag> "hi"`.

If the local model isn't ready, nothing happens to your text — pi's output shows
normally, unchanged. That is by design, not a bug: it skips (fails open) when
ollama is down, the request times out, or the model isn't pulled. The first time
that happens in a session a one-line notice explains why (disable with
`"notice": false`).

## How the display hook works

`message_end` fires once per finalized assistant message. The extension takes
the message text (skipping pure tool-calling and error messages, and anything
whose prose — code stripped — is shorter than `minChars`), finds the preceding
user question from the session for context, and fires the rewrite in the
background so the stream and the agent loop are never blocked. When the rewrite
lands, it is appended as a custom entry that renders as:

```
💬 In plain English:
<rewrite>
```

The original message and the saved transcript are untouched. There is no
`replace` mode: Pi has no display/storage separation, so suppressing the
original on screen would also corrupt the transcript and pollute LLM context.

## Markdown file rewrite (optional second hook)

Opt-in by directory. It does nothing unless `mdDir` is set in the config file,
and it only touches `*.md` files written or edited (via the write/edit tools)
whose resolved path is inside that directory. Every other README, `CLAUDE.md`,
or doc you edit is left alone.

| `mdMode` | Result | Notes |
|---|---|---|
| `sibling` (default) | Writes `NAME.<suffix>.md` next to `NAME.md`. | Non-destructive; the original is never touched. |
| `overwrite` | Replaces `NAME.md` in place. | Adds a `<!-- claudish-to-english:rewritten -->` marker so a re-write is skipped (idempotent). Use with care — a weak model can degrade real docs. |

In both modes: YAML frontmatter is split off and re-attached verbatim, short
files are skipped, and the write is atomic (temp file + rename). Fail-open here
means the file is left exactly as the agent wrote it. Large files are slow —
raise `mdTimeoutMs` or use a smaller model.

## Providers

Selected with `provider` in the config file. When absent, derived from the
session model's provider (`anthropic` → anthropic API, `openai` → openai API,
anything else → ollama).

| Provider | Endpoint | Auth |
|---|---|---|
| `ollama` (fallback default) | `ollamaUrl` (`http://localhost:11434`) | none (local) |
| `anthropic` | `anthropicUrl` (`https://api.anthropic.com`) + `/v1/messages` | pi model registry (`getApiKeyForProvider("anthropic")`) |
| `openai` | `openaiUrl` + `/chat/completions` | pi model registry (`getApiKeyForProvider("openai")`) |

```json
// ollama — local, nothing leaves your machine
{ "provider": "ollama", "model": "llama3.2:3b" }

// Anthropic — reuses pi's stored Anthropic key
{ "provider": "anthropic", "model": "claude-3-5-haiku-latest" }

// Any OpenAI-compatible server (LM Studio, llama.cpp, vLLM, OpenRouter)
{ "provider": "openai", "openaiUrl": "http://localhost:1234/v1", "model": "qwen3-30b" }

// Follow the session model — no provider/model in the config file
{}
```

Notes:

- `model` selects the model for all providers. When absent, defaults to the
  session model's id.
- No `reasoning_effort` is sent by default. `"none"` is not a valid OpenAI
  value (the API accepts `low`/`medium`/`high`, or `minimal` on some models)
  and would 400. If you point the openai provider at a reasoning model, set
  `openaiEffort` to `"minimal"` (or `"low"`) explicitly.
- All three providers cap completions at `maxTokens` (default 4096):
  anthropic's `max_tokens`, openai's `max_tokens`, and ollama's
  `num_predict`. A rewrite that hits an output-token cap is **discarded, not
  shown** on all three providers — a half-finished rewrite is confusing, and
  in the Markdown hook's overwrite mode it would replace your real document.
  You get the original text plus the once-per-session notice suggesting a
  higher cap.
- **Privacy / egress:** the cloud providers send each assistant message (and,
  with the Markdown hook, file contents) to an external API. Auth comes from
  pi's model registry, so selecting a cloud provider IS the consent switch —
  if pi has a key for it, claudish will use it.

## Toggling mid-session

The config file is read at session start, so it can't pause rewrites in a
running session. For that, both hooks also check a flag file on every event:

```bash
touch ~/.claude/claudish-off  # pause rewrites, effective on the next message
rm ~/.claude/claudish-off     # resume
```

You create and remove this file yourself; nothing creates it on install, and its
absence is the normal "on" state. Override the path with `offFile` in the config
file. Pi-native alternative: `/claudish on|off|status`.

## Configuration reference

All fields are optional. An absent file or empty `{}` uses all defaults.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. `false` = pass everything through. |
| `offFile` | `~/.claude/claudish-off` | Runtime kill switch. While this file exists, rewrites pause — re-checked every message. |
| `provider` | (from session model) | `ollama`, `anthropic`, or `openai` — which API shape serves rewrites. Falls back to `ollama` when the session provider doesn't map. |
| `model` | (from session model) | Model name; defaults to the session model's id. |
| `ollamaUrl` | `http://localhost:11434` | ollama base URL. |
| `anthropicUrl` | `https://api.anthropic.com` | Base URL for the anthropic provider (proxy/gateway overrides). |
| `openaiUrl` | `https://api.openai.com/v1` | Base URL for any OpenAI-compatible endpoint. Trailing slashes ignored. |
| `openaiEffort` | (unset) | `reasoning_effort` sent with openai-provider requests. No default (`"none"` is invalid). Set to `minimal`/`low`/`medium`/`high` for reasoning models. |
| `maxTokens` | `4096` | Completion cap applied to all providers. Capped rewrites are discarded. |
| `minChars` | `200` | Skip messages/files whose prose (code stripped) is shorter. |
| `stub` | `false` | `true` = deterministic stub instead of the model (for testing display mechanics). |
| `displayTimeoutMs` | `45000` | LLM client timeout for the display hook (millis, max 60000). |
| `mdTimeoutMs` | `150000` | LLM client timeout for the Markdown file hook (millis, max 180000). |
| `debug` | `false` | `true` = write a debug log to `$TMPDIR/claudish-to-english/`. |
| `notice` | `true` | `true` = show a once-per-session notice when a rewrite is skipped. `false` = stay fully silent. |
| `mdDir` | (unset) | Markdown hook opt-in. Only `*.md` under this directory is rewritten. `~` is expanded. |
| `mdMode` | `sibling` | `sibling` (`NAME.plain.md`) or `overwrite` (in place). |
| `mdSuffix` | `plain` | Sibling infix: `NAME.<suffix>.md`. |

## Differences from the Claude Code plugin

- **No `replace` display mode** — Pi's transcript is what you see, so replacing
  on screen would rewrite what's stored and sent to the model. This extension is
  always append-style.
- **No env vars** — configuration is a JSON file at `<agentDir>/claudish.json`,
  mirroring the bermudis-pi-goodies pattern.
- **Auth from pi** — API keys are resolved from pi's model registry, not from
  env vars or config. If pi can talk to your provider, claudish can too.
- **Model defaults to the session model** — when not pinned in the config file,
  claudish rewrites through the same model you're chatting with.
- Hooks are TypeScript with `fetch` — no `jq`/`curl`/Git Bash dependency, and
  the ollama `think: false` / openai `reasoning_effort` switches are applied
  for you.
- The Markdown hook covers Pi's write/edit tools (the plugin's NotebookEdit
  equivalent doesn't exist here).
- `/claudish on|off|status` is a pi-native toggle for the kill-switch file.

## Development

```bash
cd pi-packages/claudish
bun install
bun run typecheck
bun run test
bun run format
```
