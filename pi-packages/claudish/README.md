# claudish

A Pi extension that shows a **plain-English rewrite of each assistant message**,
produced by a local LLM via ollama (default), the Anthropic API, or any
OpenAI-compatible API. A port of the Claude Code plugin
[`gvzdv/claudish-to-english`](https://github.com/gvzdv/claudish-to-english).

For chat it is **display-only**: the rewrite appears as a `💬 In plain English:`
block under the original message, and because it is rendered as a custom session
entry it never participates in LLM context — the assistant message and the saved
transcript keep the original text.

An optional second hook rewrites **Markdown files** into plain English when they
are written or edited (opt-in via `CLAUDISH_MD_DIR`, off by default). That hook
does change bytes on disk.

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

## Requirements (read this first)

With the default ollama provider the extension talks to a local model, and
nothing works until these are in place:

1. **ollama, running** — `brew install ollama && ollama serve` (or
   `winget install Ollama.Ollama` on Windows; it serves on `localhost:11434`).
2. **A pulled model** — `ollama pull <tag>` (e.g. `llama3.2:3b`,
   `gemma3:12b`). The default model tag (`gemma4:26b-mlx`) is what the upstream
   plugin ships with and is **Apple-silicon only** — set `CLAUDISH_MODEL` to a
   tag you actually have.
3. Warm the model once after starting ollama (the first call is a slow cold
   load): `ollama run <tag> "hi"`.

If the local model isn't ready, nothing happens to your text — pi's output shows
normally, unchanged. That is by design, not a bug: it skips (fails open) when
ollama is down, the request times out, or the model isn't pulled. The first time
that happens in a session a one-line notice explains why (disable with
`CLAUDISH_NOTICE=0`).

## Configuring the extension

All behavior is controlled by `CLAUDISH_*` environment variables (full list
below). Set them wherever pi reads env for the session — e.g. in your shell
profile, or a per-project `.env` loaded into the launching shell. Env is read
**once at session start**, so restart pi (or `/reload`) after editing.

Quick one-off:

```bash
CLAUDISH_MODEL=llama3.2:3b CLAUDISH_STUB=1 pi
```

To confirm the hook is firing, set `CLAUDISH_DEBUG=1` and watch
`$TMPDIR/claudish-to-english/debug.log`.

## How the display hook works

`message_end` fires once per finalized assistant message. The extension takes
the message text (skipping pure tool-calling and error messages, and anything
whose prose — code stripped — is shorter than `CLAUDISH_MIN_CHARS`), finds the
preceding user question from the session for context, and fires the rewrite in
the background so the stream and the agent loop are never blocked. When the
rewrite lands, it is appended as a custom entry that renders as:

```
💬 In plain English:
<rewrite>
```

The original message and the saved transcript are untouched. There is no
`replace` mode: Pi has no display/storage separation, so suppressing the
original on screen would also corrupt the transcript and pollute LLM context.

## Markdown file rewrite (optional second hook)

Opt-in by directory. It does nothing unless `CLAUDISH_MD_DIR` is set, and it
only touches `*.md` files written or edited (via the write/edit tools) whose
resolved path is inside that directory. Every other README, `CLAUDE.md`, or doc
you edit is left alone.

| `CLAUDISH_MD_MODE` | Result | Notes |
|---|---|---|
| `sibling` (default) | Writes `NAME.<suffix>.md` next to `NAME.md`. | Non-destructive; the original is never touched. |
| `overwrite` | Replaces `NAME.md` in place. | Adds a `<!-- claudish-to-english:rewritten -->` marker so a re-write is skipped (idempotent). Use with care — a weak model can degrade real docs. |

In both modes: YAML frontmatter is split off and re-attached verbatim, short
files are skipped, and the write is atomic (temp file + rename). Fail-open here
means the file is left exactly as the agent wrote it. Large files are slow —
raise `CLAUDISH_MD_TIMEOUT` or use a smaller model.

## Providers

Selected with `CLAUDISH_PROVIDER` (both hooks share the setting). Default is
unchanged from upstream: local ollama, nothing leaves your machine.

| Provider | Endpoint | Key | Default model |
|---|---|---|---|
| `ollama` (default) | `CLAUDISH_OLLAMA` (`http://localhost:11434`) | none | `gemma4:26b-mlx` |
| `anthropic` | `CLAUDISH_ANTHROPIC_URL` (`https://api.anthropic.com`) + `/v1/messages` | `CLAUDISH_ANTHROPIC_KEY` or `ANTHROPIC_API_KEY` | `claude-haiku-4-5` |
| `openai` | `CLAUDISH_OPENAI_URL` + `/chat/completions` | `CLAUDISH_OPENAI_KEY` or `OPENAI_API_KEY` | `gpt-5.6-luna` |

```bash
# ollama (default) — local, nothing leaves your machine
export CLAUDISH_PROVIDER=ollama
export CLAUDISH_MODEL=llama3.2:3b

# Anthropic — Claude Haiku
export CLAUDISH_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
export CLAUDISH_MODEL=claude-haiku-4-5

# Any OpenAI-compatible server (LM Studio, llama.cpp, vLLM, OpenRouter) — keyless locally
export CLAUDISH_PROVIDER=openai
export CLAUDISH_OPENAI_URL=http://localhost:1234/v1
export CLAUDISH_MODEL=qwen3-30b
```

Notes:

- `CLAUDISH_MODEL` overrides any provider's default model.
- Requests to `api.openai.com` send `reasoning_effort: "none"` (reasoning models
  otherwise spend tokens on a plain rewrite). Custom OpenAI-compatible URLs get
  no such field — force one with `CLAUDISH_OPENAI_EFFORT`, or set it explicitly
  empty (`CLAUDISH_OPENAI_EFFORT=`) to omit the field even for `api.openai.com`.
- The anthropic provider caps completions at `CLAUDISH_MAX_TOKENS` (default
  4096). A rewrite that hits an output-token cap is **discarded, not shown** on
  all three providers (ollama's `done_reason: "length"` included) — a half
  finished rewrite is confusing, and in the Markdown hook's overwrite mode it
  would replace your real document. You get the original text plus the
  once-per-session notice suggesting a higher cap.
- **Privacy / egress:** the cloud providers send each assistant message (and,
  with the Markdown hook, file contents) to an external API, and they pick up
  ambient keys (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`). Selecting a cloud
  provider IS the consent switch — set it only when you mean it, and use the
  `CLAUDISH_*_KEY` variables when you want the plugin on a dedicated key.

## Toggling mid-session

Env vars are read once at session start, so they can't pause rewrites in a
running session. For that, both hooks also check a flag file on every event:

```bash
touch ~/.claude/claudish-off  # pause rewrites, effective on the next message
rm ~/.claude/claudish-off     # resume
```

You create and remove this file yourself; nothing creates it on install, and its
absence is the normal "on" state. Override the path with `CLAUDISH_OFF_FILE`.
Pi-native alternative: `/claudish on|off|status`.

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `CLAUDISH_ENABLED` | `1` | Master switch. `0` = pass everything through. Read once at session start. |
| `CLAUDISH_OFF_FILE` | `~/.claude/claudish-off` | Runtime kill switch. While this file exists, rewrites pause — re-checked every message. |
| `CLAUDISH_PROVIDER` | `ollama` | `ollama`, `anthropic`, or `openai` — which LLM serves rewrites (both hooks). |
| `CLAUDISH_MODEL` | (per provider) | Model name; overrides the provider default. |
| `CLAUDISH_OLLAMA` | `http://localhost:11434` | ollama base URL. |
| `CLAUDISH_ANTHROPIC_URL` | `https://api.anthropic.com` | Base URL for the anthropic provider (proxy/gateway overrides). |
| `CLAUDISH_ANTHROPIC_KEY` | (unset) | Anthropic key; falls back to `ANTHROPIC_API_KEY`. |
| `CLAUDISH_OPENAI_URL` | `https://api.openai.com/v1` | Base URL for any OpenAI-compatible endpoint. Trailing slashes ignored. |
| `CLAUDISH_OPENAI_KEY` | (unset) | OpenAI-compatible key; falls back to `OPENAI_API_KEY`. Only required for `api.openai.com`. |
| `CLAUDISH_OPENAI_EFFORT` | `none` on api.openai.com, else (unset) | `reasoning_effort` sent with openai-provider requests. Set explicitly empty to omit. |
| `CLAUDISH_MAX_TOKENS` | `4096` | Completion cap for the anthropic provider. Capped rewrites are discarded. |
| `CLAUDISH_MIN_CHARS` | `200` | Skip messages/files whose prose (code stripped) is shorter. |
| `CLAUDISH_STUB` | `0` | `1` = deterministic stub instead of the model (for testing display mechanics). |
| `CLAUDISH_TIMEOUT` | `45` | LLM client timeout for the display hook (seconds). |
| `CLAUDISH_MD_TIMEOUT` | `150` | LLM client timeout for the Markdown file hook (seconds). |
| `CLAUDISH_DEBUG` | `0` | `1` = write a debug log to `$TMPDIR/claudish-to-english/`. |
| `CLAUDISH_NOTICE` | `1` | `1` = show a once-per-session notice when a rewrite is skipped. `0` = stay fully silent (pure fail-open). |
| `CLAUDISH_MD_DIR` | (unset) | Markdown hook opt-in. Only `*.md` under this directory is rewritten. |
| `CLAUDISH_MD_MODE` | `sibling` | `sibling` (`NAME.plain.md`) or `overwrite` (in place). |
| `CLAUDISH_MD_SUFFIX` | `plain` | Sibling infix: `NAME.<suffix>.md`. |

## Differences from the Claude Code plugin

- **No `replace` display mode** — Pi's transcript is what you see, so replacing
  on screen would rewrite what's stored and sent to the model. This extension is
  always append-style.
- Hooks are TypeScript with `fetch` — no `jq`/`curl`/Git Bash dependency, and
  the ollama `think: false` / openai `reasoning_effort: "none"` switches are
  applied for you.
- The Markdown hook covers Pi's write/edit tools (the plugin's
  NotebookEdit equivalent doesn't exist here).
- `/claudish on|off|status` is a pi-native toggle for the kill-switch file.

## Development

```bash
cd pi-packages/claudish
bun install
bun run typecheck
bun run test
bun run format
```
