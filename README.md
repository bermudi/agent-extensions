# agent-extensions

Personal repo for [Pi](https://github.com/earendil-works/pi) coding agent extensions.

Over time this grew into a few substantial projects, which have since been
**extracted into standalone sibling repos** (history preserved via `git filter-repo`):

| Sibling repo | Was here as | What it is |
|--------------|-------------|------------|
| [`../pi-delegate`](../pi-delegate) | `pi/delegate` | Parallel subagent delegation with async ticketing, session pooling, retries |
| [`../pi-session-search`](../pi-session-search) | `pi/session-search` + `pi/compaction-engine` | Full-text search across sessions (FTS5) + its transcript/compaction engine |

## Structure

```
agent-extensions/
├── pi/
│   ├── bermudis-pi-goodies/   # ACTIVE — copy-with-model, name-with-ai, notify, zed (one bundle)
│   ├── cc-cwd/                 # ACTIVE — injects project context into CommandCode proxy requests
│   ├── diff/                   # ACTIVE — (project-local install)
│   ├── session-summarizer/     # ACTIVE — (project-local install)
│   └── experiments/            # ARCHIVE — exploratory/unused extensions (see below)
├── reference/                  # third-party extensions, read-only (study only)
├── docs/                       # notes + ADRs (incl. pi-extension-tool-api.md — registerTool reference)
├── scripts/                    # one-off utilities
└── mcp/                        # MCP server experiments
```

### Active extensions

The four extensions I actually use, kept at `pi/` root:

- **bermudis-pi-goodies** — `/copy-with-model`, `/name-with-ai`, `/z`, and an
  `agent_end` desktop notification. Installed globally (as a bundle — see below).
- **cc-cwd** — injects working dir, git state, AGENTS.md, and skills into
  CommandCode proxy requests. Installed globally.
- **diff** / **session-summarizer** — installed project-local (`.pi/extensions/`).

### Experiments (`pi/experiments/`)

Everything else — exploratory builds, abandoned ideas, research notes. Not gated
by typecheck or the default test run. A few still have passing tests; revive at
will. Notable: `arena`, `roundtable`, `trim-context`, `pi-debate`, `session-reference`.
`supervise` depends on the extracted `../pi-delegate` via a cross-repo import.

## Install

Pi loads extensions via Node, which resolves relative imports against the
symlink path — so multi-file extensions must ship as a **bundle**. The
`bermudis-pi-goodies` bundle is committed; rebuild it after editing the source:

```bash
bun run build:goodies   # regenerates pi/bermudis-pi-goodies/bermudis-pi-goodies.bundle.ts
```

Symlink into the desired scope:

```bash
# Global (all projects) — multi-file ext: point at the bundle
ln -sf "$PWD/pi/bermudis-pi-goodies/bermudis-pi-goodies.bundle.ts" ~/.pi/agent/extensions/bermudis-pi-goodies.ts

# Global — single-file ext: point at the source directly
ln -sf "$PWD/pi/cc-cwd/cc-cwd.ts" ~/.pi/agent/extensions/cc-cwd.ts

# Project-local (this repo only)
ln -sf "$PWD/pi/diff/diff.ts" .pi/extensions/diff.ts
```

Then `/reload` in Pi.

## Develop

```bash
bun install
bun run typecheck     # active extensions (experiments excluded)
bun run test          # active + experiments (129 tests, no short-circuit)
bun run test:active   # active extensions only
bun run format        # prettier
```

For the extracted projects, develop in their own repos (`../pi-delegate`,
`../pi-session-search`) — each has its own `package.json`, tests, and typecheck.

## Adding a new extension

1. Create `pi/<name>/<name>.ts` (or a dir with an `index.ts`).
2. If it's a keeper, leave it at `pi/` root. If experimental, drop it in `pi/experiments/`.
3. Symlink into Pi's discovery path when ready (don't install globally without asking).
4. `bun run typecheck` and `bun run test` to verify.
