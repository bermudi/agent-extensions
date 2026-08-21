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
| `model-thinking`   | hook + `/levels`              | Per-model thinking levels stored in an extension sidecar (pi's /scoped-models rewrites `enabledModels` bare, wiping `:level` suffixes); `/levels` edits them, hooks apply them whenever a model becomes active. |
| `kilo`             | provider                      | Access Kilo Gateway models via `/login kilo` or `KILO_API_KEY`.                                                                                 |
| `provider-balance` | footer (no command)           | Show remaining Kilo or OpenRouter credits, z.ai token-plan quota, or OpenAI Codex quota on the right side of the working-directory footer line. |
| `tps`              | hook (no command)             | Notify tokens/sec and in/out/cache token usage at the end of each agent turn.                                                                   |

## Install

After publishing the package to npm:

```bash
pi install npm:bermudis-pi-goodies@0.5.5
```

Remove any old `bermudis-pi-goodies.ts` symlink before reloading Pi. Each
feature is independent — disabling one is a one-line edit in `index.ts`.
Kilo's provider and its balance footer are bundled here.

## Model selection and thinking

Pi's native scoped-models config would put per-model thinking levels in
`enabledModels` entries like `"zai/glm-5.3:high"`, but the `/scoped-models`
screen (which maintains that list) rewrites it with bare model ids on every
save, destroying any `:level` suffix. So this package stores levels in its
own sidecar file:

```
~/.pi/agent/data/bermudis-pi-goodies/thinking-levels.json
```

The split of ownership is clean: `/scoped-models` owns which models are
enabled and their Ctrl+P cycle order; `/levels` owns the per-model thinking
level and can never be wiped by the other screen.

Use `/levels` to edit: ↑↓ moves between scoped models, ←→ cycles each
model's level through the ladder it actually supports plus `inherit`
(which leaves pi's global default in charge), Enter saves atomically and
applies to the active model immediately, Esc cancels.

Hooks apply the stored level whenever a model becomes active: full-picker
selection, Ctrl+P cycling, startup, and `/new` (which pi starts on the
saved default model). A native scoped level for the session — via
`--models "x:high"` or a hand-suffixed enabledModels entry — always wins;
the sidecar only fills in where pi itself has no level. Explicit
`--thinking` or `--model ...:<level>` still
wins for that launched session — a model whose registered id genuinely ends
in `:<level>` is indistinguishable from that shorthand without the registry,
so it opts out of its stored level for that startup; switch or cycle to
re-apply. Resumed and forked sessions keep the level restored by pi.

One gap is inherent to Pi: it emits no `model_select` when you pick the
model that is already active, so re-selecting it in the full picker leaves
a manual thinking level in place — switch models (or cycle) to snap back.
Saving the `/scoped-models` screen in pi 0.84.2 writes bare model ids, which
is now harmless: bare ids are exactly what this design expects.

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
