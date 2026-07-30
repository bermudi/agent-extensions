# bermudis-pi-goodies

A bundle of small, frequently-used [Pi](https://github.com/earendil-works/pi)
extensions. One entry point, seven independent features.

| Feature | Command / hook | What it does |
|---------|----------------|--------------|
| `copy-with-model` | `/copy-with-model` | Copy last assistant message to the clipboard in a code fence tagged with the model name. |
| `name-with-ai` | `/name-with-ai [name]` | Generate a short session name from the first user message (or set one manually). |
| `zed` | `/z` | Open Zed editor on the current working directory. |
| `prefer-tools` | hook (no command) | Nudge toward modern CLIs: `rg` over `grep`, `fd` over `find`, `uv` over bare `python`/`pip`/`pytest`/`mypy`. |
| `model-thinking` | hook + `/model-thinking` | Apply provider/model thinking defaults and remember per-model changes. |
| `kilo` | provider | Access Kilo Gateway models via `/login kilo` or `KILO_API_KEY`. |
| `provider-balance` | footer (no command) | Show remaining Kilo or OpenRouter credits, z.ai token-plan quota, or OpenAI Codex quota on the right side of the working-directory footer line. |

## Install

```bash
# Multi-file extension: symlink the BUNDLE, not index.ts — pi's Node loader
# resolves relative imports against the symlink path, which would otherwise
# break the per-module imports.
ln -s "$PWD/bermudis-pi-goodies.bundle.ts" ~/.pi/agent/extensions/bermudis-pi-goodies.ts
```

Then `/reload` in Pi. Each feature is independent — disabling one is a one-line
edit in `index.ts`. Kilo's provider and its balance footer are bundled here.

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
`/model-thinking set` to save the current model's current thinking level as an
exact-model entry; it also bootstraps models not yet covered by the config and
overwrites an existing entry. Once a model is managed, changing its thinking
level in Pi records an exact-model override. Returning it to the provider
default removes that redundant override. All current Pi levels are accepted:
`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
`/model-thinking` shows the active resolution and config path;
`/model-thinking reset` deletes the whole config.

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
`GET /api/monitor/usage/quota/limit`; Codex uses `GET /wham/usage`,
and `CODEX_API_URL` or `CHATGPT_BASE_URL` can override the Codex base URL.
The footer refreshes on session start, model
switch, and after each completed run (`agent_settled`), so it tracks both
consumption and external tier changes for whatever provider is active —
providers without a balance adapter are skipped, so this costs nothing for
unrelated sessions. Do not also load the standalone `kilo.ts` or
`provider-balance.ts` entries once this bundle is installed. If you previously
symlinked the standalone `provider-balance.ts`, remove that link — the feature
now ships in this bundle.
