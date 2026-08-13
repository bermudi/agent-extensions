# bermudis-pi-goodies

A bundle of small, frequently-used [Pi](https://github.com/earendil-works/pi)
extensions. One entry point, ten independent features.

| Feature | Command / hook | What it does |
|---------|----------------|--------------|
| `copy-with-model` | `/copy-with-model` | Copy last assistant message to the clipboard in a code fence tagged with the model name. |
| `copy-trajectory` | `/copy-trajectory [thinking]` | Copy the whole conversation (user + assistant text, tool calls stripped) to the clipboard; `thinking` also includes assistant thinking blocks. |
| `name-with-ai` | `/name-with-ai [name]` | Generate a short session name from the first user message (or set one manually). |
| `zed` | `/z` | Open Zed editor on the current working directory. |
| `prefer-tools` | hook (no command) | Nudge toward modern CLIs: `rg` over `grep`, `fd` over `find`, `uv` over bare `python`/`pip`/`pytest`/`mypy`. |
| `model-thinking` | hook + `/model-thinking` | Apply provider/model thinking defaults and explicitly save per-model defaults. |
| `fixed-defaults` | hook + `/fixed-defaults` | Keep the global startup provider and model fixed while allowing in-session model changes; `/fixed-defaults set` pins the current model. |
| `kilo` | provider | Access Kilo Gateway models via `/login kilo` or `KILO_API_KEY`. |
| `provider-balance` | footer (no command) | Show remaining Kilo or OpenRouter credits, z.ai token-plan quota, or OpenAI Codex quota on the right side of the working-directory footer line. |
| `tps` | hook (no command) | Notify tokens/sec and in/out/cache token usage at the end of each agent turn. |

## Install

After publishing the package to npm:

```bash
pi install npm:bermudis-pi-goodies@0.4.1
```

Remove any old `bermudis-pi-goodies.ts` symlink before reloading Pi. Each
feature is independent — disabling one is a one-line edit in `index.ts`.
Kilo's provider and its balance footer are bundled here.

## Model-specific thinking

This feature is deliberately opt-in: models not covered by the config retain
Pi's native thinking-level behavior. Create `~/.pi/agent/model-thinking.json`
with provider defaults, exact model defaults, or both:

```json
{
  "providers": {
    "anthropic": "high",
    "openai-codex": "xhigh"
  },
  "models": {
    "anthropic/claude-haiku-4-5": "low"
  }
}
```

Exact `provider/model-id` entries take precedence over provider defaults. Use
`/model-thinking set` to explicitly save the current model's current thinking
level as an exact-model entry; it also bootstraps models not yet covered by the
config and overwrites an existing entry. Manual thinking-level changes in Pi do
not modify this file. All current Pi levels are accepted:
`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
`/model-thinking` shows the active resolution and config path;
`/model-thinking reset` deletes the whole config. A malformed config is reported
and ignored; `/model-thinking set` refuses to overwrite it until you repair the
file or reset it.

## Fixed startup model

Pi normally saves the last model and thinking level selected in the global
settings file. `fixed-defaults` pins only the cross-session provider and model;
`model-thinking` is the sole owner of model-specific thinking levels.

Create `~/.pi/agent/fixed-defaults.json` to pin a startup model:

```json
{
  "provider": "openai-codex",
  "model": "gpt-5.6-luna"
}
```

Selecting a different model still changes the active session and its transcript;
`fixed-defaults` restores the startup model after Pi persists a selection. Pi
chooses the initial model before extensions receive `session_start`, so if you
manually create or edit a pin for B while settings still name A, the current
session remains on A and B starts with the next fresh session. Resuming an
existing session restores that session's model instead.

Older config files may contain `thinkingLevel`; that field is accepted for
compatibility but ignored and should be managed in `model-thinking.json` instead.
`fixed-defaults` logs a warning and shows the migration in its status when it
finds the legacy field. The `/fixed-defaults set` command rewrites the file in
the provider/model-only format.

Manage the pin from Pi:

- `/fixed-defaults set` — pin the currently active model as the startup model
  (written to the override file and applied to `settings.json` immediately).
- `/fixed-defaults` — show the active model, pinned startup model, and override
  path.
- `/fixed-defaults reset` — save the currently active model as Pi's last
  selection, then delete the override file and stop pinning. With no active
  model, it refuses to remove the pin.

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
