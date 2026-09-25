# AGENTS.md

Personal repo for Pi coding agent extensions.

## Structure

```
pi-packages/
  bermudis-pi-goodies/   # ACTIVE (npm/global): commands/hooks + Kilo provider & balance footer + vision tool (query-driven
                         # image Q&A for visionless models: /vision set model, self-hides via setActiveTools when the active
                         # model declares image input, followUp=true threads keyed by path+size+mtime, answers raw text —
                         # provenance in details; vision-model system prompt keeps the injection refusal).
                         # Renders via clean-tui's burst skeleton (createBurstRenderer, gated on the
                         # CLEAN_TUI_ACTIVE flag at registration — same contract pi-codex mirrors).
                         # Needs pi ^0.85.x at runtime (vision uses createReadToolDefinition); peers bumped in lockstep.
                         # clean-tui render paths MUST follow the render-safety rules in its
                         # README (pi-tui fullRender escalation: clearOnShrink + above-viewport
                         # changes wipe the screen in regular mode; fullscreen has neither)
                         # kilo drift detection: footer badge (`kilo: stale …`) + kilo_warning
                         # lines in goodies.log + `bun run kilo-smoke` (live catalog check; run
                         # before releasing — DRIFT lines = kilo.ts hardcoded knowledge needs review)
  critique/               # ACTIVE (opt-in): launch the Bun-only Critique TUI from Pi
  diff/                   # ACTIVE (project-local)
  external-changes/       # ACTIVE (project-local): inject diff of changes made between agent runs
  ketamine/               # ACTIVE (development): replace compaction with a separate observer-curated context
  pi-harness/             # ACTIVE (dev-only): test harness for TUI extensions; faithful ToolExecutionComponent render semantics
  pilab/                  # ACTIVE (standalone, not a pi extension): sandboxed pi launcher. Named sandboxes in
                         # ~/.pi/sandboxes/<name>/ run via PI_CODING_AGENT_DIR, so test providers/extensions/system
                         # prompts never touch the real config. Borrows from ~/.pi/agent are symlinks (auth.json is
                         # LIVE-linked on purpose — pi rewrites it on OAuth refresh); settings.json is an allowlist
                         # copy that never carries packages/extensions/skills/prompts. Tests use PILAB_ROOT +
                         # PILAB_REAL_AGENT_DIR temp dirs; Bun.which reads the process-start env snapshot, hence the
                         # whichLive() PATH scan (don't "simplify" it back to Bun.which).
  session-summarizer/     # INACTIVE (source kept; not linked in .pi/extensions — verify install state before claiming it runs)
  zen-relay/              # ACTIVE (standalone, not a pi extension): all-local multi-IP relay for OpenCode Zen. Per-gateway SSH SOCKS tunnels + one local relay; pi uses it via models.json baseUrl override.
  experiments/            # ARCHIVE — unused/exploratory. Not typechecked, not in default test run.
                         #   claudish/: port of the Claude Code claudish-to-english plugin (display-only
                         #   plain-English rewrite of assistant messages). Standalone package, never
                         #   published, not installed anywhere; own tests (58, run green).
herdr-plugins/           # Herdr plugins (python3, stdlib-only), linked via `herdr plugin link`
  pane-layouts/           # ACTIVE: apply pane layouts (columns/rows/quad/main+stack) from a popup picker
  pi-reload/              # ACTIVE: send /reload to every pi instance in the session (skips busy/blocked/draft panes)
```

## Herdr plugins

`herdr-plugins/<name>/` each hold a `herdr-plugin.toml` + scripts; install with
`herdr plugin link <path>` (reversible via `herdr plugin unlink <id>`). Actions
run with `HERDR_BIN_PATH`, `HERDR_SOCKET_PATH`, and cwd = plugin root; stdout
lands in `herdr plugin log list --plugin <id>`. `HERDR_BIN_PATH` is the
RUNNING server's own binary path and goes stale ("<path> (deleted)") after a
`herdr update` while the server stays up — verify it before use, fall back to
PATH (pi-reload does). Every `agent prompt` also costs ~300ms: herdr
intentionally sleeps between typing the text and pressing Enter
(AGENT_PROMPT_SUBMIT_DELAY, paste-boundary guard) — serial per-pane loops pay
it N times, so run per-pane work concurrently when targeting many panes.

SAFETY RULE for any plugin that types into agent panes: herdr 0.8.2
`agent prompt` does NOT refuse blocked agents (0.9.1-fork's --help claims a
blocked pane is now rejected with `agent_blocked` pre-send — UNVERIFIED,
don't rely on it; keep plugin-side guards). pi's dialogs confirm the
highlighted option on Enter, so typing into a `blocked` pane can answer an
approval dialog. Never send input to `blocked` or `unknown` panes.
`working` panes: pi refuses /reload typed mid-turn with a warning ("Wait for
the current response to finish before reloading.") and drops the text —
verified live and in pi 0.85.1 source (built-in commands are dispatched by
the TUI before the steer/followUp queue; only ordinary messages queue). So
pi-reload skips busy panes outright — typing /reload mid-turn just gets
dropped, and waiting them out delayed the whole action for up to 2 minutes
per pane (wait behavior removed in 0.2.0; recoverable at commit d452e7c).
pi's status is authoritative —
it self-reports
via the `herdr:pi` hook (`~/.pi/agent/extensions/herdr-agent-state.ts`).
pi-reload also skips panes with a draft in the input box: detected from
`agent read --source detection` — the editor is the lines between the last
two full-width `─` border rules; blank cursor line = empty, any text = skip,
unparseable = skip. It re-checks `agent get` right before each prompt
(listing status is seconds stale; a residual ms race remains — herdr has no
guarded prompt).

## Extracted sibling repos

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
- When appropriate, give bermudi the `pi -e ...` command to test — with an absolute path so it works from any cwd, and `-ne` so installed extensions stay out and the dev copy runs alone: `pi -ne -e /home/daniel/build/agent-extensions/pi-packages/<name>/index.ts` (pilab sandboxes are already clean and skip `-ne`); installs still follow the production rule above.
- Do not symlink/install globally without bermudi's explicit request. The maintained goodies installation is the published npm package, not this working tree.
- Extensions load at session start. Use `/reload` to pick up changes mid-session.

## Extension install locations

Both are auto-discovered by pi at session start. Symlink source files into the desired scope:

| Location | Scope | Install |
|----------|-------|--------|
| `.pi/extensions/*.ts` | Project-local (only this repo) | `ln -s pi-packages/<ext>/<file>.ts .pi/extensions/<file>.ts` |
| `~/.pi/agent/extensions/*.ts` | Global (all projects) | `ln -s pi-packages/<ext>/<file>.ts ~/.pi/agent/extensions/<file>.ts` |

## Personal global extensions (not part of this repo)

Files in `~/.pi/agent/extensions/` that are *not* symlinked from this repo are bermudi's local
infrastructure. Never move them into `pi-packages/`, publish them, or delete them.

- ~~`1min-provider.ts`~~ — removed 2026-09-18 at bermudi's request (the whole 1min
  proxy provider is gone; pi packages 0.23.5 have no 1min-specific code — the summary
  machinery is provider-agnostic). Leftovers, inert unless 1min returns: the Pass field
  `ONEMIN_API_KEY` in item "pi provider keys", the pi-keys tmpfs cache file, and the
  `extraNames` entry in the pass-keys pi profile.

## Releasing bermudis-pi-goodies

Release = tag push → GitHub Actions publishes to npm via OIDC trusted publishing (no npm token in CI). Steps:

0. From `pi-packages/bermudis-pi-goodies`, run `bun run kilo-smoke` — the live Kilo catalog check. Hard failures block; `DRIFT` lines mean kilo.ts's hardcoded model knowledge (Responses routing, anthropic cache control, `:free`) needs review first.
1. Bump `version` in `pi-packages/bermudis-pi-goodies/package.json` (keep compact JSON style; `npm version` rewrites arrays to multiline — avoid), update the `pi install npm:bermudis-pi-goodies@X.Y.Z` line in its README, commit.
2. Push to `main`, then `git tag bermudis-pi-goodies-vX.Y.Z && git push origin bermudis-pi-goodies-vX.Y.Z`. (Or use the workflow's manual `Run workflow` dispatch to re-publish the current main without tag churn.)
3. The workflow `.github/workflows/publish-bermudis-pi-goodies.yml` verifies tag == package version (tag pushes only), typechecks, tests, publishes. Watch with `gh run watch <run-id> --exit-status`.

Known blocker: npm-side **trusted publisher must be configured on the package page** (npmjs.com/package/bermudis-pi-goodies → Trusted Publisher → GitHub Actions): repo `bermudi/agent-extensions`, workflow filename `publish-bermudis-pi-goodies.yml`, **Environment name `npm-publish`** (must match the job's `environment:` in the workflow — GitHub's OIDC token only carries the environment claim when the job declares it), allowed action `npm publish`. Fields are exact-match/case-sensitive and npm does not validate on save — a mismatch surfaces only as `404 Not Found - PUT` at publish time (identity authenticated but not authorized). 0.1.0 was published manually; the CI pipeline had never run until the 0.2.0 attempt.

if you install again globally without me telling you to, I WILL FUCKING END YOU
