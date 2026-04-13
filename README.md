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

Pi auto-discovers extensions in `~/.pi/agent/extensions/`. Symlink from this repo:

```bash
for f in pi/*.ts; do
  [[ "$f" != *.test.ts ]] && ln -sf "$(pwd)/$f" ~/.pi/agent/extensions/"$(basename "$f")"
done
```

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
