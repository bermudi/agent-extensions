# agent-extensions

My coding agent extensions — pi, opencode, and whatever else comes next.

## Structure

```
agent-extensions/
├── pi/           # Pi coding agent extensions
│   └── thinking-compaction.ts
├── opencode/     # Opencode extensions (future)
└── shared/       # Shared utilities (if needed)
```

## Pi Extensions

Pi auto-discovers extensions in `~/.pi/agent/extensions/`. Symlink from this repo:

```bash
ln -sf $(pwd)/pi/thinking-compaction.ts ~/.pi/agent/extensions/thinking-compaction.ts
```

Reload with `/reload` in pi.

## Adding a new extension

1. Create `pi/my-extension.ts` (or `opencode/my-extension.ts`)
2. Symlink into the agent's discovery path
3. Done
