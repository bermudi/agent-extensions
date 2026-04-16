# agent-extensions

My coding agent extensions — pi, opencode, and whatever else comes next.

## Structure

```
agent-extensions/
├── docs/                              # Extension documentation
│   ├── optional-extension-loader.md
│   └── opencode-plugins.md
├── pi/                                # Pi coding agent extensions
│   ├── optional-extension-loader.ts   # Extension lifecycle manager
│   ├── optional-extension-loader-utils.ts  # Pure logic (tested)
│   ├── optional-extension-loader-utils.test.ts
│   ├── session-reference.ts           # Cross-session search & read
│   ├── chord-keybindings.ts           # Ctrl+X chord prefix (M/L/N/E/R)
│   └── thinking-compaction.ts         # LLM-powered context compaction
└── opencode/                          # Opencode extensions
    └── thinking-compaction.ts
```

## Pi Extensions

Pi auto-discovers extensions in `~/.pi/agent/extensions/`.

Reload with `/reload` in pi.

### optional-extension-loader

Manages extension loading — startup vs optional, per-session toggling, tab-completed `/ext` command.

→ [Full docs](docs/optional-extension-loader.md)

### session-reference

Three tools (`session_search`, `session_read`, `session_list`) that let the agent reference past conversations. When you say "remember that session where we built X", the agent searches `~/.pi/agent/sessions/` and pulls in context.

### chord-keybindings

Adds an Emacs-style `Ctrl+X` prefix:

| Chord | Action |
|-------|--------|
| `Ctrl+X M` | Model picker |
| `Ctrl+X L` | Session resume |
| `Ctrl+X N` | New session |
| `Ctrl+X E` | Open `/ext` manager |
| `Ctrl+X R` | `/reload` |

### thinking-compaction

Replaces Pi's default context compaction with an LLM-generated summary that preserves the assistant's reasoning trail, mental model, and decision history. Uses Gemini Flash as the summary model.

#### How it works

The extension hooks into `session_before_compact` and builds its own summary instead of letting Pi use its default compaction.

1. **Group messages into turns.** Raw messages are bucketed by turn-starting roles (`user`, `bashExecution`, `custom`). Each turn collects:
   - **reasoning** — extracted from assistant `thinking` blocks (capped at 2,500 chars/message)
   - **responses** — assistant text, filtered to skip filler like "let me check" (capped at 700 chars)
   - **evidence** — tool results, but aggressively: `read` output is dropped entirely, `bash` output is only kept if it looks important (tests, builds, errors), `edit`/`write` results become one-liners

2. **Build a transcript.** Turns are serialized into structured markdown (`Request`, `Reasoning`, `Stated conclusions`, `Relevant evidence`) with per-section character budgets via greedy fill + middle-truncation.

3. **Call a summary model.** Tries `gemini-2.5-flash` first, then falls back to the session's current model.

4. **Structured output.** The LLM produces a summary in a fixed format:

   ```
   ## Goal
   ## Constraints & Preferences
   ## Units of Work (each with Understanding / Issues / Attempts / Outcome)
   ## Current Mental Model
   ## Open Questions / Risks
   ## Next Steps
   ```

5. **Incremental updates.** When re-compacting, the previous summary is passed in `<previous-summary>` tags alongside new work in `<new-work>` tags. The model merges rather than re-summarizing.

6. **File tracking.** `<read-files>` and `<modified-files>` XML tags are computed from file operation metadata and appended to the summary.

If anything fails (model unavailable, empty output, timeout), it falls back silently to Pi's default compaction.

## OpenCode Plugins

Per `docs/opencode-plugins.md`, OpenCode auto-loads local plugins from:

- `~/.config/opencode/plugins/`
- `.opencode/plugins/`

To use the thinking compaction plugin globally:

```bash
mkdir -p ~/.config/opencode/plugins
ln -sf $(pwd)/opencode/thinking-compaction.ts ~/.config/opencode/plugins/thinking-compaction.ts
```

## Testing

```bash
bun test
```

Tests cover the pure utility functions extracted from `optional-extension-loader`. No Pi dependencies needed — the utils module has zero external imports beyond Node built-ins.

## Adding a new extension

1. Create `pi/my-extension.ts` (or `opencode/my-extension.ts`)
2. Symlink into the agent's discovery path
3. If you want it optional by default, put it in `~/.pi/agent/optional-extensions/` instead
4. Done
