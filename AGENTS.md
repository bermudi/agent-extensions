# AGENTS.md

Personal repo for coding agent extensions.

- Pi
- OpenCode

## Conventions

- `pi/reference/` — third-party extensions kept for study. **Read-only.** Not imported, not tested, not edited.
- `bun run test` — runs the test suite (excludes `pi/reference/`). Plain `bun test` also works but will include reference tests.

## Extension install locations

- `.pi/extensions/` — project-local: use for **testing** new or in-progress extensions. `ln -s` source into here.
- `~/.pi/agent/extensions/` — global: don't touch this. Already-deployed extensions live here. If something "was already loaded," check here first — this is where it's installed.
