# bermudis-pi-goodies

A bundle of small, frequently-used [Pi](https://github.com/earendil-works/pi)
extensions. One entry point, nine independent features.

| Feature            | Command / hook                | What it does                                                                                                                                    |
| ------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `copy-with-model`  | `/copy-with-model`            | Copy last assistant message to the clipboard in a code fence tagged with the model name.                                                        |
| `copy-trajectory`  | `/copy-trajectory [thinking]` | Copy the whole conversation (user + assistant text, tool calls stripped) to the clipboard; `thinking` also includes assistant thinking blocks.  |
| `name-with-ai`     | `/name-with-ai [name]`        | Generate a short session name from the first user message (or set one manually).                                                                |
| `zed`              | `/z`                          | Open Zed editor on the current working directory.                                                                                               |
| `prefer-tools`     | hook (no command)             | Nudge toward modern CLIs: `rg` over `grep`, `fd` over `find`, `uv` over bare `python`/`pip`/`pytest`/`mypy`.                                    |
| `model-thinking`   | hook (no command)             | Apply native scoped-model thinking levels consistently when selecting a model through the full picker.                                          |
| `kilo`             | provider                      | Access Kilo Gateway models via `/login kilo` or `KILO_API_KEY`.                                                                                 |
| `provider-balance` | footer (no command)           | Show remaining Kilo or OpenRouter credits, z.ai token-plan quota, or OpenAI Codex quota on the right side of the working-directory footer line. |
| `tps`              | hook (no command)             | Notify tokens/sec and in/out/cache token usage at the end of each agent turn.                                                                   |

## Install

After publishing the package to npm:

```bash
pi install npm:bermudis-pi-goodies@0.5.3
```

Remove any old `bermudis-pi-goodies.ts` symlink before reloading Pi. Each
feature is independent — disabling one is a one-line edit in `index.ts`.
Kilo's provider and its balance footer are bundled here.

## Model selection and thinking

Pi's native model settings are the single source of truth. Add models to
`enabledModels` in `~/.pi/agent/settings.json` in cycle order. Add an optional
thinking level after a colon:

```json
{
  "enabledModels": [
    "opencode/hy3-free:high",
    "zai/glm-5.2:high",
    "openai-codex/gpt-5.6-terra:medium"
  ]
}
```

Pi applies those levels while cycling with Ctrl+P and Ctrl+Shift+P. This
package fills the small consistency gaps: choosing a scoped model through the
full model picker and starting with a plain explicit `--model` apply its
configured level. Explicit `--thinking` and `--model ...:<level>` still win.
One gap is inherent to Pi: it emits no selection event when you pick the
model that is already active, so re-selecting it in the full picker leaves a
manual thinking level in place — switch models (or cycle) to snap back.
Resumed and forked sessions retain the level restored by Pi; `/new` carries the
previous session's model and active thinking level into the new session.

Use `/scoped-models` to search, enable, disable, and reorder the cycle list.
Be aware that pi 0.84.2 currently writes bare model IDs when that screen is
saved, so saving there removes any `:level` suffixes; restore them in
`settings.json` afterward.

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
