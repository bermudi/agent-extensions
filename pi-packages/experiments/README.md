# Pi experiments

This directory is the **archive and laboratory** for Pi extensions that are useful for
trying an idea, measuring a behavior, or preserving a prototype—but are not currently
maintained as production packages.

Expect sharp edges. An experiment may be incomplete, tied to a particular Pi version,
assume a local service or directory, write debug data, spend tokens, or deliberately
change core session behavior. Read the source before loading one into a real session.

Production extensions belong in one of the active packages under `pi-packages/`, not
here. The larger delegation and session-search projects were also extracted from this
archive into [`pi-delegate`](../../../pi-delegate) and
[`pi-session-search`](../../../pi-session-search); use those repositories for current
work on those features.

## Contents at a glance

| Experiment | Entry point | Surface | What it explores |
| --- | --- | --- | --- |
| [arena](./arena/arena.ts) | `arena.ts` | `/arena`, `arena` tool | Blind A/B/C model comparison and voting |
| [command-center](./command-center/command-center.ts) | `command-center.ts` | `/cc`, `session_stats` | Session, project, token, and cost dashboard |
| [extension-timer](./extension-timer/extension-timer.ts) | `extension-timer.ts` | session hook | Per-extension load and evaluation timing |
| [forge-compaction](./forge-compaction/forge-compaction.ts) | `forge-compaction.ts` | compaction hook | Deterministic, structural context compression |
| [fusion](./fusion/fusion.ts) | `fusion.ts` | `/fusion`, `/fusion-continue` | Parallel model responses followed by synthesis |
| [gemini-youtube](./gemini-youtube/index.ts) | `index.ts` | provider hooks | Pass YouTube video data to Gemini |
| [gemini-youtube-cached](./gemini-youtube-cached/index.ts) | `index.ts` | provider hooks | Gemini YouTube input with explicit context caching |
| [hotkeys](./hotkeys/hotkeys.ts) | `hotkeys.ts` | `Ctrl+\\` | In-session Pi keyboard cheat sheet |
| [llm-dump](./llm-dump/index.ts) | `index.ts` | `/dump` | Inspect the exact context and provider payload |
| [mcp](./mcp/index.ts) | `index.ts` | `mcp`, `mcp_list` tools | Call configured MCP servers through `mcporter` |
| [oracle](./oracle/oracle.ts) | `oracle.ts` | `oracle` tool | Ask a standalone Qwen reasoning endpoint for a second opinion |
| [pi-debate](./pi-debate/debate.ts) | `debate.ts` | `/debate`, `debate` tool | Sequential pro/con model debate with optional judge |
| [pi-telegram](./pi-telegram/index.ts) | `index.ts` | Telegram bridge | Drive a Pi session from Telegram and send attachments |
| [retry](./retry/retry.ts) | `retry.ts` | `/retry` | Continue a failed turn without showing “continue” to the model |
| [roundtable](./roundtable/roundtable.ts) | `roundtable.ts` | `/roundtable`, `roundtable` tool | Round-robin discussion across project-rooted agents |
| [session-reference](./session-reference/session-reference.ts) | `session-reference.ts` | `/sessions`, 3 tools | Search, list, and read other Pi sessions |
| [subagent-landscape](./subagent-landscape/) | Markdown notes | none | Comparative research on public subagent extensions |
| [supervise](./supervise/supervise.ts) | `supervise.ts` | `supervise` tool | Turn-by-turn control of a persistent subagent |
| [thinking-compaction](./thinking-compaction/thinking-compaction.ts) | `thinking-compaction.ts` | compaction hook | LLM-generated summaries during automatic compaction |
| [trim-context](./trim-context/index.ts) | `index.ts` | `/trim`, `/untrim`, `selective_trim` | Non-destructive, selective turn compaction |
| [xonsh](./xonsh/xonsh.ts) | `xonsh.ts` | `xonsh` tool | Run Python-powered xonsh commands with on-demand packages |

The `patches/` directory contains the package-manager patch required by the local test
harness dependency. It is build/test plumbing, not an extension.

## Running an experiment

From this directory:

```bash
cd pi-packages/experiments
bun install                    # first checkout only
bun run test                   # runs the archive's Bun tests
bun run format                 # formats tracked TypeScript sources
```

There is intentionally no `typecheck` script here. `tsconfig.json` is retained as
useful editor/compiler configuration, but this archive is not a typecheck gate for the
repository. Individual experiments can be stale even when the package-level tests are
green.

Load one entry point explicitly while experimenting:

```bash
pi -e "$PWD/arena/arena.ts"
# or, for a multi-file entry point:
pi -e "$PWD/session-reference/session-reference.ts"
```

Alternatively, symlink a reviewed entry point into a project's `.pi/extensions/`
directory. Do not install or symlink these globally by accident: extensions are loaded at
session start, and `/reload` is needed after changing the loaded set. Multi-file
experiments should be bundled before global-style installation; Pi resolves relative
imports from the loaded extension path, not necessarily from this repository.

Only load the experiment you are testing unless you have checked hook and command
interactions. In particular, compaction, provider-request, context, session, and
Telegram hooks can affect the whole session.

## Experiment notes

### Model comparison and multi-agent workflows

- **`arena`** sends one prompt to three selected models in parallel, randomizes the
  displayed responses, and reveals identities only after the user votes. It has both an
  interactive `/arena` wizard and an LLM-callable `arena` tool.
- **`fusion`** runs several selected models against the session context, sends their
  outputs to a separate fusion model for analysis and synthesis, and persists the last
  result. `/fusion-continue` injects that result back into the conversation.
- **`pi-debate`** runs sequential pro/con turns sharing a transcript. Models, number of
  rounds, positions, tools, thinking level, and an optional judge are configurable.
- **`roundtable`** runs participants in round-robin order. Each participant has a
  project `cwd`, may load that project's `AGENTS.md`, and can use a restricted tool set;
  an optional moderator produces a synthesis. The checked-in defaults contain local
  project paths, so prefer explicit participants.
- **`supervise`** keeps an in-process agent alive between calls. The first call starts a
  task; later calls can steer it, inspect its message tree, or dispose it with `done`.
  This is deliberately event/turn-driven rather than polling screen output.

These experiments make multiple model calls and can expose session context to every
selected provider. Treat them as potentially expensive and do not use them with secrets
or sensitive workspaces without checking the prompt construction first.

### Context, compaction, and inspection

- **`forge-compaction`** is a zero-LLM, deterministic compaction strategy. It extracts
  roles, text, tool calls, and file operations; removes selected redundancy; strips the
  working-directory prefix; and renders a structural summary. It changes the behavior
  of automatic compaction while loaded.
- **`thinking-compaction`** uses a summary model during `session_before_compact` and
  writes diagnostic inputs, prompts, and transcripts under
  `~/.pi/logs/thinking-compaction/`. The checked-in file dynamically imports a sibling
  `../compaction-engine`, which is not present in this archive after extraction; treat
  this entry point as a historical/stale prototype until its engine dependency is
  restored or the import is updated.
- **`trim-context`** offers `/trim`, `/untrim`, and the `selective_trim` tool. It stores
  compacted-turn state as custom session entries and changes only the LLM view; the
  original session history is not deleted. Summaries use the currently selected model.
- **`llm-dump`** writes the system prompt, post-context messages, serialized provider
  payload, and provider response into `.pi/llm-dump/`. `/dump clean` removes that dump
  directory. This is valuable for debugging hooks, but dumps may contain credentials,
  source code, and user data.
- **`extension-timer`** instruments Pi's extension-loading path via filesystem and VM
  hooks, then reports timing at session start. It must load before the extensions being
  measured. The implementation was designed to be loaded under an early filename such
  as `0-extension-timer.ts`; the checked-in source remains
  `extension-timer/extension-timer.ts`.
- **`retry`** uses a hidden custom message plus the `context` hook to trigger a new turn
  without adding a visible “continue” instruction to the model. It is a small recovery
  experiment, not a general retry policy.

### Providers, tools, and external services

- **`mcp`** exposes `mcp` for calling a named server/tool and `mcp_list` for discovery.
  It shells out to `mcporter`, so the executable and its server configuration must be
  available in the environment. Default timeouts range from 15 seconds to 120 seconds,
  depending on the server.
- **`oracle`** registers a tool-only Qwen reasoning endpoint. It accepts a question and
  optional file attachments, has no tools or project awareness, and logs to
  `~/.pi/logs/oracle/` with seven-day retention. Configuration is controlled by
  `ORACLE_URL`, `ORACLE_TOKEN`, `ORACLE_MODEL`, and `ORACLE_TIMEOUT`; without a URL it
  probes a local endpoint and then a configured public fallback in the source. Review
  that behavior before sending private material.
- **`gemini-youtube`** detects YouTube URLs in user input, fetches title/description
  metadata, and injects Google provider `fileData` plus metadata into the request.
- **`gemini-youtube-cached`** provides the same basic workflow but creates a per-session
  Gemini explicit context cache, refreshes its two-hour TTL, and deletes it at shutdown.
  It requires `GEMINI_API_KEY` or matching Pi auth configuration. Caching reduces repeat
  processing but still sends video URLs and incurs provider-side usage.
- **`xonsh`** adds a `xonsh` tool. Its `deps` parameter passes Python packages to
  `uv run`, which resolves and caches them. Use `$()` for captured subprocess output and
  `@(expr)` to expand Python values in shell commands. Output is streamed, bounded, and
  saved to a temporary file when truncated. It executes commands in the session cwd and
  inherits the process environment, so it has the same trust boundary as a shell tool.
- **`pi-telegram`** is a full Telegram bridge. Use `/telegram-setup`,
  `/telegram-status`, `/telegram-connect`, and `/telegram-disconnect`; the
  `telegram_attach` tool queues local files for the next reply. Configuration is stored
  at `~/.pi/agent/telegram.json` and temporary media at
  `~/.pi/agent/tmp/telegram/`. See [`BUG-NOTE.md`](./pi-telegram/BUG-NOTE.md) for its
  historical fetch failure investigation.

### Session and UI utilities

- **`command-center`** provides `/cc`, a dashboard for aggregate token/cost data,
  projects, sessions, and session browsing. Its `session_stats` tool reads Pi's session
  store at `~/.pi/agent/sessions`.
- **`session-reference`** provides `session_search`, `session_read`, and `session_list`,
  plus `/sessions` for interactive browsing. It understands branched JSONL sessions and
  can anchor a read to a matching entry. It reads other sessions, so session contents
  should be considered exposed to the current model.
- **`hotkeys`** binds `Ctrl+\\` to a customizable Pi hotkey cheat sheet. Edit the
  `HOTKEYS` array in the source to change it.
- **`subagent-landscape`** is documentation only. It records an architectural survey
  of public packages such as apple-pi, pi-faithless-subagents, pi-messenger-swarm, and
  tintinweb/pi-subagents; it is not loaded by Pi.

## Tests and current coverage

The archive's tests concentrate on pure helpers and the extension harness rather than
end-to-end provider calls:

- `arena/arena.test.ts`
- `pi-debate/debate.test.ts`
- `roundtable/roundtable.test.ts`
- `session-reference/session-reference-utils.test.ts`
- `supervise/supervise.test.ts`
- `trim-context/__tests__/trim-context.test.ts`

Network calls, Telegram, MCP servers, model quality, TUI interaction, and most
compaction behavior are not covered by the default test command. A passing test run is
therefore evidence about a few local behaviors—not a production-readiness signal.

## Safety checklist

Before loading an experiment:

1. Read its entry point and all local imports.
2. Check where it sends prompts, files, URLs, and session history.
3. Check filesystem writes and cleanup paths, especially debug dumps and logs.
4. Confirm required binaries, API keys, model access, and external services.
5. Start with a disposable Pi session and a non-sensitive project.
6. Unload it after the experiment; do not leave hooks active accidentally.

The archive is intentionally honest about being unfinished. If an experiment becomes
reliable and generally useful, give it a focused package, tests for its boundary
contracts, explicit configuration, and an installation story before promoting it out of
this directory.
