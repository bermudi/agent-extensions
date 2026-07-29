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
├── pi-packages/
│   ├── bermudis-pi-goodies/   # ACTIVE (global bundle): copy-with-model, name-with-ai,
│   │                          #   zed, prefer-tools, kilo provider, provider-balance
│   ├── diff/                  # ACTIVE (project-local install)
│   ├── external-changes/      # ACTIVE (project-local install): diff of changes between agent runs
│   ├── session-summarizer/    # ACTIVE (project-local install)
│   └── experiments/           # ARCHIVE — exploratory/unused extensions (see below)
└── mcp/                       # MCP server experiments
```

Each extension is a **fully isolated package** — its own `package.json`,
`tsconfig.json`, `node_modules/`, and `bun.lock`. There is no root `package.json`
or root tooling; always work inside an extension directory.

### Active extensions

- **bermudis-pi-goodies** — `/copy-with-model`, `/name-with-ai`, `/z`, the
  `prefer-tools` hook, the Kilo provider, and the provider-balance footer.
  Installed globally as an esbuild bundle (multi-file ext — see Install).
- **diff** / **external-changes** / **session-summarizer** — installed
  project-local (`.pi/extensions/`).

### Experiments (`pi-packages/experiments/`)

Everything else — exploratory builds, abandoned ideas, research notes. Not gated
by typecheck or the default test run. A few still have passing tests; revive at
will. Notable: `arena`, `roundtable`, `trim-context`, `pi-debate`, `session-reference`.
`supervise` depends on the extracted `../pi-delegate` via a cross-repo import.

## Install

Pi loads extensions via Node, which resolves relative imports against the
symlink path — so multi-file extensions must ship as a **bundle**. The
`bermudis-pi-goodies` bundle is committed; rebuild it after editing the source:

```bash
cd pi-packages/bermudis-pi-goodies && bun run build
# regenerates bermudis-pi-goodies.bundle.ts
```

Symlink into the desired scope:

```bash
# Global (all projects) — multi-file ext: point at the bundle
ln -sf "$PWD/pi-packages/bermudis-pi-goodies/bermudis-pi-goodies.bundle.ts" ~/.pi/agent/extensions/bermudis-pi-goodies.ts

# Project-local (this repo only) — single-file ext: point at the source
ln -sf "$PWD/pi-packages/diff/diff.ts" .pi/extensions/diff.ts
ln -sf "$PWD/pi-packages/external-changes/external-changes.ts" .pi/extensions/external-changes.ts
ln -sf "$PWD/pi-packages/session-summarizer/index.ts" .pi/extensions/session-summarizer.ts
```

Then `/reload` in Pi. Don't install globally without asking.

## Develop

There are no root scripts — run everything inside the extension you're touching:

```bash
cd pi-packages/<ext>
bun install        # first time only
bun run typecheck  # active extensions (experiments has no typecheck script)
bun run test       # extensions that have tests
bun run format     # prettier on that extension's .ts files
bun run build      # bermudis-pi-goodies only (esbuild bundle)
```

For the extracted projects, develop in their own repos (`../pi-delegate`,
`../pi-session-search`) — each has its own `package.json`, tests, and typecheck.

## Adding a new extension

1. Create `pi-packages/<name>/<name>.ts` (or a dir with an `index.ts`) plus its
   own `package.json` / `tsconfig.json`.
2. If it's a keeper, leave it at `pi-packages/` root. If experimental, drop it
   in `pi-packages/experiments/`.
3. `cd` in and run `bun install`, then `bun run typecheck` / `bun run test`.
4. Symlink into Pi's discovery path when ready (don't install globally without asking).
