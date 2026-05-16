# session-search

Full-text search across all pi sessions — for agents and humans.

Merges the best of [session-reference](https://github.com/bermudi/agent-extensions) (branch-aware tree parsing, field-weighted scoring, path security, agent tools) with a SQLite FTS5 index, TUI overlay, and LLM summarizer.

## Install

```bash
pi install /path/to/session-search
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "/path/to/session-search"
  ]
}
```

Then restart pi or run `/reload`.

## Features

### Agent tools

The extension registers three tools the LLM can call directly:

| Tool | Description |
|---|---|
| `session_search` | Search sessions by keyword, partial UUID, date, CWD, or transcript content. Returns ranked matches with snippets and `entry_id` for branch anchoring. |
| `session_read` | Read a session's conversation. Follows branch trees via `parentId`. Optionally anchor to a specific entry from search results. |
| `session_list` | List recent sessions, optionally filtered by project path. |

`session_search` uses FTS5 as a fast pre-filter when the index is ready, then loads actual session files and runs field-weighted scoring (`id > name > content > cwd > tool_result`). Falls back to full file scan when the index is cold.

`session_read` validates paths through `realpath` + `isPathWithinDir` — no traversal attacks.

### Human commands

| Command | Action |
|---|---|
| `/search` | Open TUI search overlay |
| `/search resume <path>` | Resume a session by file path |
| `/search reindex` | Rebuild FTS5 index from scratch |
| `/search stats` | Show index statistics |
| `/handoff [goal]` | Goal-directed context extraction to a new session |
| `/sessions` | Browse recent sessions in a picker |

### Other features

- **FTS5 index** — SQLite FTS5 with Porter stemming. Sub-100ms queries. Incremental indexing on startup.
- **Branch awareness** — understands pi's `parentId` tree. Reads the correct conversation branch, not a flat concatenation.
- **Preview & actions** — overlay shows matched snippets, then Resume / Summarize / New + Context.
- **LLM summarization** — summarize a past session into your current context with optional focus prompt.
- **Handoff** — goal-directed context extraction from the current session into a new one. Uses the compaction engine's transcript builder with a handoff-specific prompt. The new session is linked to the original via `parentSession` (appears as a cascade in the session selector). The handoff summary includes the session ID so the model can revisit the source session with `session_read`.
- **Path security** — `realpath` + traversal guards on all agent-facing file reads.
- **TypeBox schemas** — all tool parameters validated at runtime.

## Keyboard shortcuts (TUI overlay)

### Search screen

| Key | Action |
|---|---|
| Type | Search query (debounced) |
| `↑` / `↓` | Navigate results |
| `Enter` | Open preview |
| `Esc` | Close |

### Preview screen

| Key | Action |
|---|---|
| `Tab` / `←` `→` | Cycle actions: Resume · Summarize · New + Context · Back |
| `Enter` | Execute selected action |
| `Esc` | Back to search |

### Focus prompt

| Key | Action |
|---|---|
| `Enter` | Summarize with default focus |
| Type + `Enter` | Summarize with custom focus prompt |
| `Esc` | Back to preview |

## Architecture

```
extensions/
  session-search.ts       ← main entry (tools, commands, hooks, renderer)
  session-utils.ts        ← pure domain logic (types, tree parsing, scoring, security)
  indexer.ts              ← SQLite FTS5 engine (incremental indexing, WAL mode)
  summarizer.ts           ← LLM-powered session summarization
  handoff.ts              ← /handoff command (goal-directed context extraction)
  jsonl-parser.ts         ← JSONL parser for compaction engine
  resume.ts               ← /search resume argument parser
  types.ts                ← TUI types
  component.ts            ← TUI overlay component
  screens/                ← TUI screens (search, preview, prompt-input)
```

- `session-utils.ts` has zero `fs`/`Database`/extension API imports — pure functions, fully testable.
- Agent tools use FTS5 as a pre-filter, then enrich with branch-aware `SessionSummary` data.
- The TUI overlay uses `SearchResult` from the FTS5 indexer (different type, different code path).

## Development

```bash
# Run tests
cd pi/session-search && bun test

# Run locally
pi -e ./extensions/session-search.ts
```
