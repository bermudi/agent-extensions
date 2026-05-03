# AGENTS.md

Personal repo for coding agent extensions.

- Pi
- OpenCode

## Conventions

- `pi/reference/` — third-party extensions kept for study. **Read-only.** Not imported, not tested, not edited.
- `bun run test` — runs the test suite (excludes `pi/reference/`). Plain `bun test` also works but will include reference tests.

## Extension install locations

Both locations are auto-discovered by pi at session start. Symlink source files into the desired scope:

| Location | Scope | Install |
|----------|-------|--------|
| `.pi/extensions/*.ts` | Project-local (only this repo) | `ln -s pi/<ext>/<file>.ts .pi/extensions/<file>.ts` |
| `~/.pi/agent/extensions/*.ts` | Global (all projects) | `ln -s pi/<ext>/<file>.ts ~/.pi/agent/extensions/<file>.ts` |

- `pi/reference/` — third-party extensions kept for study. **Read-only.** Not installed.
- Extensions load at session start. Use `/reload` to pick up changes mid-session.
