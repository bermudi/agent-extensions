# AGENTS.md

Personal repo for Pi coding agent extensions.

## Structure

```
pi/
  bermundis-pi-goodies/   # ACTIVE (global): copy-with-model, name-with-ai, notify, zed
  cc-cwd/                 # ACTIVE (global): CommandCode context injection
  diff/                   # ACTIVE (project-local)
  session-summarizer/     # ACTIVE (project-local)
  experiments/            # ARCHIVE — unused/exploratory. Not typechecked, not in default test run.
reference/                # third-party extensions, READ-ONLY. Study only, never edit/import/test.
```

Two large projects were extracted into standalone sibling repos (full history
preserved via `git filter-repo`): **`../pi-delegate`** (was `pi/delegate`) and
**`../pi-session-search`** (was `pi/session-search` + `pi/compaction-engine`).
Develop those in their own repos — each has its own package.json/tests/typecheck.

## Conventions

- `reference/` — third-party extensions kept for study. **Read-only.** Not imported, not tested, not edited. Excluded from typecheck + tests.
- `pi/experiments/` — archive of unused/exploratory extensions. Excluded from typecheck; tests run via `bun run test` / `bun run test:experiments` but the dir is not gated as maintained code.
- Active extensions live at `pi/<name>/`. New keepers go there; experiments go in `pi/experiments/`.
- Multi-file extensions symlinked globally must ship a **bundle** (esbuild, `--packages=external`) — pi's Node loader resolves relative imports against the symlink path, breaking unbundled multi-file exts. Single-file extensions can be symlinked directly. See `build:goodies` for the pattern.
- Test your work: `bun run typecheck` and `bun run test`. `.agents/skills/pi-test-harness` has the harness docs.
- **Do not** symlink/install globally until bermudi says it's ready.
- Extensions load at session start. Use `/reload` to pick up changes mid-session.

## Commands

```bash
bun run typecheck     # active extensions only (experiments + reference excluded)
bun run test          # active + experiments, no short-circuit (one bun invocation)
bun run test:active   # active extensions only
bun run test:experiments
bun run format        # prettier on pi/
```

## Extension install locations

Both are auto-discovered by pi at session start. Symlink source files into the desired scope:

| Location | Scope | Install |
|----------|-------|--------|
| `.pi/extensions/*.ts` | Project-local (only this repo) | `ln -s pi/<ext>/<file>.ts .pi/extensions/<file>.ts` |
| `~/.pi/agent/extensions/*.ts` | Global (all projects) | `ln -s pi/<ext>/<file>.ts ~/.pi/agent/extensions/<file>.ts` |

if you install again globally without me telling you to, I WILL FUCKING END YOU
