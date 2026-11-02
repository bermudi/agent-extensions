# pi-fusion

Personal replica of Devin's Fusion: the pi session's model is the **lead**; it
hands hands-on work to one **persistent sidekick** running in a separate
harness, through a `sidekick(message, block?)` tool. Design:
`~/reports/fusion-replica/DESIGN.md`.

Dev-only. Load it explicitly, never install:

```
pi -ne -e /home/daniel/build/agent-extensions/pi-packages/fusion/index.ts
```

## Use

- `/fusion` — pick a harness, then a model (piz only). Enables the `sidekick` tool.
- `/fusion status` — current sidekick, session id, last reported context use.
- `/fusion off` — stops the sidekick and removes the tool.

Without `/fusion` the tool is not active (`defaultActive: false`) and refuses calls.

| Harness | Model(s) | Transport | Permissions |
|---|---|---|---|
| piz | `GLM-5.3`, `GLM-5.3-Flash` | private `zcode.cjs app-server` core on a temp Unix socket (ZCode NDJSON) | mode `yolo` |
| devin | `swe-2-medium` | `devin acp --model swe-2-medium` (ACP over stdio) | mode `bypass` |

Push and PR restrictions are prompt-only (the sidekick doctrine). `fusion.log`
records lifecycle and usage metadata only — never shell commands, briefs, or
tool inputs; tool activity reaches the lead as transient progress and is not
persisted.

## Behavior

- **One sidekick per pi session.** Its harness, model, and session id are saved
  as a `fusion-state` entry; resume reattaches to the same sidekick session.
  Fork → fresh sidekick. Failed reattach → fresh sidekick plus a "NEW sidekick,
  re-brief fully" note to the lead.
- **Lead prompt stays fixed** (cache). Which sidekick is attached goes in an
  appended `fusion-note` message, never the system prompt.
- **Doctrine** goes to the sidekick on its first handoff only.
- **`block: false`** returns immediately; the report later arrives as a
  `fusion-report` message that triggers a lead turn.
- **Calling while a handoff is running** injects the message into that turn
  as `<lead_update>…</lead_update>` (Devin: mid-turn `session/prompt`; piz:
  `session/send` with `delivery: "steer"`). It never starts a second handoff.
- **Direct-edit nudge**: when the lead itself uses edit/write/apply_patch, the
  tool result gets one reminder per run to delegate instead.
- **Footer badge**: an attached sidekick publishes `side: <label>` as its
  extension status (`⏳` appended while a handoff runs). The provider-balance
  footer (bermudis-pi-goodies) folds `side:`-prefixed statuses into the
  stats line's right-aligned model readout —
  `side: SWE-2 Medium/(openai) gpt-6.1-terra • high` — and drops the status
  line; without that footer the badge stays a plain status line.
- **Context**: both sidekicks are capped at 262K and compact themselves. piz
  gets the cap through `compactContextWindow` on create/resume (fork patch
  in `~/build/piz`, promoted to `dist-runtime`).

## Environment

- `FUSION_PIZ_CORE` — path to `zcode.cjs` (default: `~/build/piz/apps/zcode-cli/packages/cli/dist-runtime/zcode.cjs`).
- `FUSION_LOG_DIR` — log dir (default `<agentDir>/fusion/`); `fusion.log` is JSONL.

The private piz core gets `ZCODE_ATTACH_CORE=1` and no `HERDR_*` vars, so it
never touches herdr panes or the user's own cores.

## Protocol facts (observed 2026-11-02)

- **Devin ACP**: the CLI name `swe-2-medium` is not a valid ACP model value.
  ACP shows model `swe-2-high` (label "SWE-2") plus `thought_level: medium`.
  The connector sets both and refuses to start if either is not in effect
  (Devin's default is a paid model).
- **piz**: `model` inside `session/create` is ignored. Call `session/setModel`
  afterwards. `state.updated` carries no `contextUsed`, so context use comes
  from the last `model_complete` usage `inputTokens`.

## Test

```
bun run typecheck
bun run test                                   # unit: fake connectors, no network
bun run scripts/live-smoke.ts piz GLM-5.3-Flash <scratch-git-dir>
bun run scripts/live-smoke.ts devin swe-2-medium <scratch-git-dir>
```

The live smoke uses real model turns. It checks: a tool turn, a mid-turn
inject that the sidekick acts on, memory across handoffs, then dispose,
reattach to the same session id, and memory after reattach.
