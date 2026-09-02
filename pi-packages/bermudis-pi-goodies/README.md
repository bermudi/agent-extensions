# bermudis-pi-goodies

A bundle of small, frequently-used [Pi](https://github.com/earendil-works/pi)
extensions. One entry point, twelve independent features.

| Feature            | Command / hook                | What it does                                                                                                                                    |
| ------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `copy-with-model`  | `/copy-with-model`            | Copy last assistant message to the clipboard in a code fence tagged with the model name.                                                        |
| `copy-trajectory`  | `/copy-trajectory [thinking]` | Copy the whole conversation (user + assistant text, tool calls stripped) to the clipboard; `thinking` also includes assistant thinking blocks.  |
| `name-with-ai`     | `/name-with-ai [name]`        | Generate a short session name from the first user message (or set one manually).                                                                |
| `zed`              | `/z`                          | Open Zed editor on the current working directory.                                                                                               |
| `prefer-tools`     | hook (no command)             | Nudge toward modern CLIs: `rg` over `grep`, `fd` over `find`, `uv` over bare `python`/`pip`/`pytest`/`mypy`.                                    |
| `keep-model-on-new` | hook (no command)            | Keep the active model when `/new` starts a fresh session instead of reverting to pi's saved default model.                                    |
| `model-thinking`   | `/model-thinking`             | Per-model default thinking levels: save the current level as this model's default and get it back on every switch to that model, instead of pi's global default. |
| `clean-tui`        | tool overrides (no command)   | Collapse built-in tool output for a cleaner TUI: back-to-back same-tool calls with no prose in between share one block (e.g. `read ×2`); visible text (assistant prose or a typed user message) always breaks the block, so textless tool-only messages chain. Images stay visible without expanding, expand a row with ctrl+o to see the full command and results/diffs. Long bash commands get an AI-generated summary once you pick a model with `/goodies summary-model <provider/model>` (see "Smart summaries" below) — expanding a row swaps the summary back out for the raw command. While enabled, also flips `@bermudi/pi-codex`'s `apply_patch`/`web_search` into the same burst style. |
| `review`           | `/review`, `/end-review`      | Code review workflow: review uncommitted changes, a branch, a commit, a GitHub PR, or folders. Prioritized findings with actionable follow-ups. |
| `kilo`             | provider                      | Access Kilo Gateway models via `/login kilo` or `KILO_API_KEY`.                                                                                 |
| `provider-balance` | footer (no command)           | Show remaining Kilo or OpenRouter credits, z.ai token-plan quota, or OpenAI Codex quota on the right side of the working-directory footer line. |
| `tps`              | hook (no command)             | Notify tokens/sec and in/out/cache token usage at the end of each agent turn.                                                                   |
| `goodies`          | `/goodies`                    | Toggle individual features on/off without losing the rest. Also supports `/goodies summary-model [provider/model]` to pick the model used for AI bash-command summaries. State persists to `~/.pi/agent/goodies.json`. |

## Install

After publishing the package to npm:

```bash
pi install npm:bermudis-pi-goodies@0.15.0
```

Remove any old `bermudis-pi-goodies.ts` symlink before reloading Pi. Each
feature is independent — use `/goodies disable <name>` to turn one off
without losing the rest (e.g. `/goodies disable clean-tui` keeps kilo and
the balance footer). State persists to `~/.pi/agent/goodies.json`.
Kilo's provider and its balance footer are bundled here.

## Smart summaries for long bash commands

clean-tui can replace long bash command lines with a short plain-English
summary (`cat >> log << 'EOF' ...` → `Appends reboot log to migration
file`). The feature is **off by default**: it must not cost anything, share
your session model's rate limits, or send data anywhere until you ask for
it.

To enable it, point it at any model your Pi installation already serves:

```text
/goodies summary-model kilo/xai/grok-4-fast   # or any provider/model you have
```

The command validates the model against your registry and suggests close
matches on typos. Summaries ride your existing auth completely — API keys
from the environment or `models.json`, OAuth token refresh included — there
are no extra endpoints or keys to configure. `/goodies list` shows whether
summaries are on or off, and `/goodies summary-model off` disables them
again.

While summaries are paused by a failure, a `⏸ summaries paused Ns — …`
widget line above the editor shows the cause and clears itself on the first
success. The log at `~/.pi/agent/goodies.log` (capped at 256 KB, oldest
lines dropped) records one structured JSONL event per summary request —
success or failure, with duration and the command prefix — plus `load`,
`kilo_warning`, and `config_error` events. If summaries silently stop, look
there first; e.g. `jq -r 'select(.type == "summary_request") | .outcome'
~/.pi/agent/goodies.log | sort | uniq -c` gives request counts by outcome.

Two practical notes:

- **Thinking models are handled, non-thinking ones are cheaper.** Requests
  pin the model's lowest reasoning effort and carry a 512-token budget that
  covers thinking plus the answer, so reasoning models work; a quick
  chat-class model still costs the least.
- **Privacy:** qualifying commands (longer than 80 characters) are sent —
  first ~2000 characters — to whichever provider hosts the model you chose.
  That is the same trust decision as running an agent session against that
  provider, made explicit here because it happens outside normal turns.

Failures degrade gracefully: the raw command stays visible as a heuristic
hint, each distinct failure is logged once (naming the model), and repeated
failures back off exponentially instead of hammering the provider.

### Render-safety rules (why summaries only refresh running rows)

These rules apply to pi's **regular** TUI mode (`tuiMode: "regular"`, the
default — `TuiMainScreen`, the scrolling scrollback renderer). Pi also has a
**fullscreen** mode (`TuiAltScreen`): no scrollback, a fixed `height`-line
slice of the transcript diffed row-by-row, full clears only on first
render/resize/image redraws. Neither escalation below exists there — a
summary arrival re-rendering an old row is either invisible (scrolled off
the slice) or a one-line rewrite. Check `~/.pi/agent/settings.json`
`tuiMode` before reasoning about render escalation.

Pi's regular-mode diff renderer answers two situations with
`fullRender(true)` — clear screen, wipe scrollback, repaint everything —
which reads as a full-screen flash:

1. total rendered height dropping below the session high-water mark
   (`clearOnShrink`), and
2. any content change to a line **above the scrolled viewport**
   (`firstChanged < prevViewportTop` — width-independent; on a long
   transcript this is any row more than a screenful above the input box).

clean-tui therefore follows two rules in its render paths:

- **Grow-only swaps:** the raw command text a summary may later replace is
  capped at 99 characters plus an ellipsis (`BASH_BULLET_WIDTH`); summaries
  render uncapped. A landing summary can add a wrapped line — a cheap tail
  update — but never collapses one (rule 1) wherever the raw line fits on a
  single terminal row.
- **Tail-only refresh:** when a summary lands, only rows that are still
  executing, or that finished while their summary was in flight (bounded by
  a ~10s freshness window), are re-rendered — at landing such rows sit at
  the transcript tail, inside the viewport, so the swap is a cheap
  differential update. This is what lets fast commands — finished before
  the ~2s summary arrives — show their summary at all. Older finished rows
  (including replayed ones from before a `/resume`) keep the raw command
  text for the rest of the session; the summary stays cached, and future
  rows of the same command render it from the start (rule 2).
- **Queued, not dropped:** burst rows beyond the two-concurrent-requests
  cap, and requests deferred by failure backoff, are queued and drained
  when a slot frees — never silently dropped (their rows may never
  re-render to retry).

To catch a flash red-handed, run `PI_DEBUG_REDRAW=1 pi`, reproduce, then
`grep fullRender ~/.pi/agent/pi-debug.log` — every line is one screen wipe
with its reason (`clearOnShrink`, `firstChanged < viewportTop`, resize, …).
Note the log is append-only across sessions; check timestamps.

## Per-model default thinking levels

Pi's `/thinking` is session-scoped: picking a level applies for now, and
Ctrl+S persists only the **global** default (`defaultThinkingLevel`), which
pi then applies on every model switch that has no entry in the native
`modelThinkingLevels` map — a map reachable only through the generic
`/settings` screen. If you want `glm → high` but `grok → low` and switch
between them all day, the global default fights you on every switch.

`model-thinking` is the missing per-model save:

```text
/model-thinking            save the CURRENT level as this model's default
/model-thinking high       save (and apply now) an explicit level
/model-thinking off        drop this model's default (back to pi's behavior)
/model-thinking list       show every saved default
```

Saved levels apply whenever the model becomes active — `/model` picker,
`/model <name>`, Ctrl+P cycling, `/new`, and startup. Switching to a model
with no saved entry leaves pi's own choice untouched (native per-model map →
global default), so the feature is strictly additive. It composes with
`keep-model-on-new` automatically: after `/new` restores the model, its own
default thinking level lands with it (a `Thinking: max → high` toast
confirms).

Priority and escape hatches:

- A scoped-model pin (`enabledModels` / `--models "provider/id:high"`)
  outranks the sidecar. Pi applies pins when cycling and at startup but not
  on full-picker selection — that gap is patched too, so a pin holds on
  every path.
- `--thinking <level>` or `--model x:<level>` at launch suppress the saved
  default for that session; explicit CLI intent wins.
- Resumed/forked sessions keep the level stored in the session file
  (`pi --continue` included), unless a bare `--model x` explicitly picks a
  model for the resumed session.

Levels persist in the extension-owned sidecar at
`~/.pi/agent/data/bermudis-pi-goodies/thinking-levels.json` — the same path
and shape this package's pre-0.7.0 `model-thinking` module used, so entries
saved then revive untouched (the old `thinking-default.json` sibling is
obsolete and ignored). The file is read fresh on every apply, so a level
saved in one pi session takes effect in the others immediately. Nothing is
auto-recorded: a level becomes a default only when you run the command,
which is why in-session `/thinking` changes stay as ephemeral as pi intends.

### History: why this module left and came back

The pre-0.7.0 module auto-recorded every `/thinking` change per model,
which required classifying pi-internal re-clamp events from user intent
(branch reconstruction, expected-level checklists, timer races) — 1156 lines
and the source of every bug it ever had. It was retired for Pi 0.84.3's
native per-model overrides, but the native map never got a quick setter and
0.84.3's new `/thinking` made the *global* default more assertive on every
switch. This module is the same idea rebuilt around explicit saves: no
event classification, no `/levels` dialog, no lock file — just a sidecar,
a command, and two event hooks.

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
