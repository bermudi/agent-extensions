# AGENTS.md

Personal repo for Pi coding agent extensions.

## Structure

```
pi-packages/
  bermudis-pi-goodies/   # ACTIVE (npm/global): commands/hooks + Kilo provider & balance footer
  critique/               # ACTIVE (opt-in): launch the Bun-only Critique TUI from Pi
  diff/                   # ACTIVE (project-local)
  external-changes/       # ACTIVE (project-local): inject diff of changes made between agent runs
  ketamine/               # ACTIVE (development): replace compaction with a separate observer-curated context
  pi-harness/             # ACTIVE (dev-only): test harness for TUI extensions; faithful ToolExecutionComponent render semantics
  session-summarizer/     # ACTIVE (project-local)
  zen-relay/              # ACTIVE (standalone, not a pi extension): all-local multi-IP relay for OpenCode Zen. Per-gateway SSH SOCKS tunnels + one local relay; pi uses it via models.json baseUrl override.
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
- Load multi-file extensions as Pi packages (prefer the published npm package) or from their real path with `pi -e ...`; do not use source-file symlinks as a production install. This keeps relative imports and package-local dependencies resolving against the intended package.

- **Production installation rule:** Install maintained extensions into Pi from a published, pinned npm version (for example, `pi install npm:bermudis-pi-goodies@0.2.0`) or another pinned release/commit. Never point a running Pi at an agent's mutable working tree. Source changes take effect in the installed extension only after publishing/updating the package, or when deliberately using a local development load.

- Test your work: `bun run typecheck` and `bun run test` inside the extension dir.
- Do not symlink/install globally without bermudi's explicit request. The maintained goodies installation is the published npm package, not this working tree.
- Extensions load at session start. Use `/reload` to pick up changes mid-session.

## Extension install locations

Both are auto-discovered by pi at session start. Symlink source files into the desired scope:

| Location | Scope | Install |
|----------|-------|--------|
| `.pi/extensions/*.ts` | Project-local (only this repo) | `ln -s pi-packages/<ext>/<file>.ts .pi/extensions/<file>.ts` |
| `~/.pi/agent/extensions/*.ts` | Global (all projects) | `ln -s pi-packages/<ext>/<file>.ts ~/.pi/agent/extensions/<file>.ts` |

## Releasing bermudis-pi-goodies

Release = tag push → GitHub Actions publishes to npm via OIDC trusted publishing (no npm token in CI). Steps:

1. Bump `version` in `pi-packages/bermudis-pi-goodies/package.json` (keep compact JSON style; `npm version` rewrites arrays to multiline — avoid), update the `pi install npm:bermudis-pi-goodies@X.Y.Z` line in its README, commit.
2. Push to `main`, then `git tag bermudis-pi-goodies-vX.Y.Z && git push origin bermudis-pi-goodies-vX.Y.Z`. (Or use the workflow's manual `Run workflow` dispatch to re-publish the current main without tag churn.)
3. The workflow `.github/workflows/publish-bermudis-pi-goodies.yml` verifies tag == package version (tag pushes only), typechecks, tests, publishes. Watch with `gh run watch <run-id> --exit-status`.

Known blocker: npm-side **trusted publisher must be configured on the package page** (npmjs.com/package/bermudis-pi-goodies → Trusted Publisher → GitHub Actions): repo `bermudi/agent-extensions`, workflow filename `publish-bermudis-pi-goodies.yml`, **Environment name `npm-publish`** (must match the job's `environment:` in the workflow — GitHub's OIDC token only carries the environment claim when the job declares it), allowed action `npm publish`. Fields are exact-match/case-sensitive and npm does not validate on save — a mismatch surfaces only as `404 Not Found - PUT` at publish time (identity authenticated but not authorized). 0.1.0 was published manually; the CI pipeline had never run until the 0.2.0 attempt.

if you install again globally without me telling you to, I WILL FUCKING END YOU
