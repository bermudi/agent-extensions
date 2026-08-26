# bermudis-pi-goodies

A bundle of small, frequently-used [Pi](https://github.com/earendil-works/pi)
extensions. One entry point, eleven independent features.

| Feature            | Command / hook                | What it does                                                                                                                                    |
| ------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `copy-with-model`  | `/copy-with-model`            | Copy last assistant message to the clipboard in a code fence tagged with the model name.                                                        |
| `copy-trajectory`  | `/copy-trajectory [thinking]` | Copy the whole conversation (user + assistant text, tool calls stripped) to the clipboard; `thinking` also includes assistant thinking blocks.  |
| `name-with-ai`     | `/name-with-ai [name]`        | Generate a short session name from the first user message (or set one manually).                                                                |
| `zed`              | `/z`                          | Open Zed editor on the current working directory.                                                                                               |
| `prefer-tools`     | hook (no command)             | Nudge toward modern CLIs: `rg` over `grep`, `fd` over `find`, `uv` over bare `python`/`pip`/`pytest`/`mypy`.                                    |
| `keep-model-on-new` | hook (no command)            | Keep the active model when `/new` starts a fresh session instead of reverting to pi's saved default model.                                    |
| `clean-tui`        | tool overrides (no command)   | Collapse built-in tool output for a cleaner TUI: same-tool calls within one assistant message share one block (e.g. `read ×2`), assistant messages always break the block, images stay visible without expanding, expand a row with ctrl+o to see results/diffs. Long bash commands get an AI-generated summary (configurable via `/goodies summary-model`). |
| `review`           | `/review`, `/end-review`      | Code review workflow: review uncommitted changes, a branch, a commit, a GitHub PR, or folders. Prioritized findings with actionable follow-ups. |
| `kilo`             | provider                      | Access Kilo Gateway models via `/login kilo` or `KILO_API_KEY`.                                                                                 |
| `provider-balance` | footer (no command)           | Show remaining Kilo or OpenRouter credits, z.ai token-plan quota, or OpenAI Codex quota on the right side of the working-directory footer line. |
| `tps`              | hook (no command)             | Notify tokens/sec and in/out/cache token usage at the end of each agent turn.                                                                   |
| `goodies`          | `/goodies`                    | Toggle individual features on/off without losing the rest. Also supports `/goodies summary-model [model]` to configure the AI summarization model. State persists to `~/.pi/agent/goodies.json`. |

## Install

After publishing the package to npm:

```bash
pi install npm:bermudis-pi-goodies@0.11.4
```

Remove any old `bermudis-pi-goodies.ts` symlink before reloading Pi. Each
feature is independent — use `/goodies disable <name>` to turn one off
without losing the rest (e.g. `/goodies disable clean-tui` keeps kilo and
the balance footer). State persists to `~/.pi/agent/goodies.json`.
Kilo's provider and its balance footer are bundled here.

## Per-model thinking levels (retired in favor of Pi 0.84.3)

This package previously shipped a `model-thinking` module with a `/levels`
command and an extension-owned sidecar at
`~/.pi/agent/data/bermudis-pi-goodies/thinking-levels.json`. It existed
because Pi's `/scoped-models` screen rewrote `enabledModels` with bare model
ids (wiping any `:level` suffix) and because every `setThinkingLevel()` call
persisted as the global default.

Pi [0.84.3](https://github.com/earendil-works/pi/releases/tag/v0.84.3) fixed
both: in-session model and thinking changes are now ephemeral by default
(persist only via `/settings` or Ctrl+S, [#5263](https://github.com/earendil-works/pi/issues/5263)),
and Pi added a native per-model thinking-level override keyed by
`provider/modelId`, stored in `settings.json` `modelThinkingLevels` and
edited via `/settings` → "Default thinking level per model". That is exactly
what `model-thinking` provided, so the module is retired.

If you had levels in the old sidecar
(`~/.pi/agent/data/bermudis-pi-goodies/thinking-levels.json`), re-enter them
via `/settings` → "Default thinking level per model".

## Provider and balance details

Kilo registration is network-free: it starts with `kilo-auto/free`, restores
an authenticated catalog from Pi's model store, and normally revalidates that
catalog no more than every four hours. Balance and quota requests run in the background so they
never delay session startup, model selection, or post-run input readiness.
The footer also reads OpenRouter remaining credits for `openrouter`, z.ai GLM
Coding Plan token quota for `zai` (Global) and `zai-coding-cn` (BigModel China),
and OpenAI Codex's ChatGPT subscription quota when using `openai-codex` OAuth;
it skips platform API-key auth because that has no ChatGPT subscription quota.
OpenRouter uses `GET /api/v1/credits`; z.ai uses
`GET /api/monitor/usage/quota/limit`; Codex uses `GET /wham/usage`. z.ai and
Codex show both each quota's window length and its `nextResetTime`/`reset_at`
countdown (when supplied), and `CODEX_API_URL` or `CHATGPT_BASE_URL` can
override the Codex base URL.

All providers share one renderer: every balance is projected to a list of
segments and formatted the same way. Credits render as `$1.5k`; each usage
window renders as `[label ]<window> <remaining>%[ ↻<countdown>]`, e.g.
`7d 72% ↻4d4h` (`↻` = resets in). Multiple windows are joined with `·`, and
named extra limits like Codex Spark get a label: `7d 72% ↻4d4h · Spark 7d 74% ↻5d4h`.
The footer refreshes on session start, model
switch, and after each completed run (`agent_settled`), so it tracks both
consumption and external tier changes for whatever provider is active —
providers without a balance adapter are skipped, so this costs nothing for
unrelated sessions. Do not also load the standalone `kilo.ts` or
`provider-balance.ts` entries once this bundle is installed. If you previously
symlinked the standalone `provider-balance.ts`, remove that link — the feature
now ships in this bundle.
