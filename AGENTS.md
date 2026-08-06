# AGENTS.md

Personal repo for Pi coding agent extensions.

## Structure

```
pi-packages/
  bermudis-pi-goodies/   # ACTIVE (global): commands/hooks + bundled Kilo provider & balance footer
  critique/               # ACTIVE (opt-in): launch the Bun-only Critique TUI from Pi
  diff/                   # ACTIVE (project-local)
  external-changes/       # ACTIVE (project-local): inject diff of changes made between agent runs
  session-summarizer/     # ACTIVE (project-local)
  experiments/            # ARCHIVE — unused/exploratory. Not typechecked, not in default test run.
```

Two large projects were extracted into standalone sibling repos (full history
preserved via `git filter-repo`): **`../pi-delegate`** (was `pi/delegate`) and
**`../pi-session-search`** (was `pi/session-search` + `pi/compaction-engine`).
Develop those in their own repos — each has its own package.json/tests/typecheck.

## Per-extension packages

Each extension is a fully isolated package with its own `package.json`,
`tsconfig.json`, `node_modules/`, and `bun.lock`. There is **no root tooling at
all** — no root `package.json`, `bun.lock`, `bunfig.toml`, or `node_modules`.
Work within an extension directory:

```bash
cd pi-packages/<ext>  # ALWAYS — never run bun at the repo root
bun install        # first time only
bun run typecheck  # active extensions only (experiments has no typecheck script)
bun run test       # extensions that have tests
bun run format     # prettier on that extension's .ts files
bun run build      # bermudis-pi-goodies only (esbuild bundle)
```

Do not run `bun install` / `bun add` at the repo root — there is no root
package, and doing so recreates the ghost workspace this repo deliberately
removed (a stale root `bun.lock` + `node_modules` pinning drift behind every
extension). Shared peers (`@earendil-works/*`, `prettier`, `@types/bun`, …) are
declared independently in each package that needs them; that duplication is the
price of true isolation and is intentional.

## Conventions

- `pi-packages/experiments/` — archive of unused/exploratory extensions. Excluded from typecheck; tests run via `bun run test` inside `pi-packages/experiments/` but the dir is not gated as maintained code.
- Active extensions live at `pi-packages/<name>/`. New keepers go there; experiments go in `pi-packages/experiments/`.
- Multi-file extensions symlinked globally must ship a **bundle** (esbuild, `--packages=external`) — pi's Node loader resolves relative imports against the symlink path, breaking unbundled multi-file exts. Single-file extensions without package-local runtime dependencies can be symlinked directly. Dependency-owning packages such as `critique` should be loaded by their real path (`pi -e ...`) or installed as a local Pi package so their `node_modules` remains resolvable. See `bermudis-pi-goodies` `build` script for the bundle pattern.

- **Production installation rule:** Install maintained extensions into Pi from a pinned Git commit or release tag. Never point a running Pi at an agent's working tree or at a bundle that agents build in place. Build bundles only as disposable verification artifacts outside any live extension path; push/tag only when the extension is ready, then update the installed Pi package explicitly. Treat the current global goodies-bundle trial as legacy until this migration is complete.

- **The bundle is a build artifact, not tracked in git.** After a fresh clone, run `bun install && bun run build` in the extension directory before testing it. The `.gitignore` covers `*.bundle.{mjs,ts}`.
- Test your work: `bun run typecheck` and `bun run test` inside the extension dir.
- Do not symlink/install globally without bermudi's explicit request. The current WIP trial has only the goodies bundle installed globally; the standalone Kilo and provider-balance links are retired (both features ship in the goodies bundle).
- Extensions load at session start. Use `/reload` to pick up changes mid-session.

## Extension install locations

Both are auto-discovered by pi at session start. Symlink source files into the desired scope:

| Location | Scope | Install |
|----------|-------|--------|
| `.pi/extensions/*.ts` | Project-local (only this repo) | `ln -s pi-packages/<ext>/<file>.ts .pi/extensions/<file>.ts` |
| `~/.pi/agent/extensions/*.ts` | Global (all projects) | `ln -s pi-packages/<ext>/<file>.ts ~/.pi/agent/extensions/<file>.ts` |

if you install again globally without me telling you to, I WILL FUCKING END YOU
