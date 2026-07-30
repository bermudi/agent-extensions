# agent-extensions

Personal [Pi](https://github.com/earendil-works/pi) extensions and experiments.

This repository is intentionally **not** a monorepo with shared tooling. Every
maintained extension is an isolated package with its own dependencies,
`package.json`, and TypeScript configuration. Work inside the package you are
changing; there is no root install or root test command.

## Repository layout

```text
agent-extensions/
├── AGENTS.md
├── README.md
└── pi-packages/
    ├── bermudis-pi-goodies/  # maintained; global bundle
    ├── critique/             # maintained; opt-in Critique TUI launcher
    ├── diff/                 # maintained; project-local extension
    ├── external-changes/     # maintained; project-local extension
    ├── session-summarizer/   # maintained; project-local extension
    └── experiments/          # archived, opt-in experiments
```

Two larger projects were extracted into sibling repositories with their
history preserved:

| Repository | Former location | Purpose |
|---|---|---|
| [`../pi-delegate`](../pi-delegate) | `pi/delegate` | Parallel subagent delegation, async ticketing, session pooling, and retries |
| [`../pi-session-search`](../pi-session-search) | `pi/session-search` and `pi/compaction-engine` | Full-text search across sessions, branch-aware reading, and resume workflows |

Develop those projects in their own directories. They have their own package
manifests, lockfiles, tests, and typechecks.

## Maintained extensions

| Package | Scope | Entry point | Purpose |
|---|---|---|---|
| [`bermudis-pi-goodies`](pi-packages/bermudis-pi-goodies/) | Global | `bermudis-pi-goodies.bundle.ts` | Commands, hooks, the Kilo provider, and Kilo/OpenRouter/z.ai/Codex quota footer |
| [`critique`](pi-packages/critique/) | Opt-in | `index.ts` | Suspend Pi and open the repository diff in Critique's Bun TUI |
| [`diff`](pi-packages/diff/) | Project-local | `diff.ts` | Show files changed during the last agent run |
| [`external-changes`](pi-packages/external-changes/) | Project-local | `external-changes.ts` | Tell the next agent turn about edits, commits, and files made outside the session |
| [`session-summarizer`](pi-packages/session-summarizer/) | Project-local | `index.ts` | Summarize the current or another branched Pi session |

### `bermudis-pi-goodies`

This is a bundle of independent features sharing one Pi extension entry point:

| Feature | Interface | Behavior |
|---|---|---|
| `copy-with-model` | `/copy-with-model` | Copies the last assistant reply as a fenced code block tagged with the model name. Supports common Linux, macOS, and Windows clipboard paths, with an OSC 52 fallback. |
| `name-with-ai` | `/name-with-ai [name]` | Generates a short session name from the first user message, or sets a supplied name directly. Uses the current Pi model. |
| `zed` | `/z` | Opens the current working directory in a new Zed window. Uses `zeditor` on Linux and `zed` elsewhere. |
| `prefer-tools` | `tool_call` hook | Blocks `rm` in command position in favor of `trash`, and blocks bare `python`, `pip`, `pytest`, and `mypy` in favor of `uv`. Quoted text, heredocs, arguments, and similar non-command occurrences are ignored. |
| `kilo` | Provider / `/login kilo` | Adds the Kilo Gateway provider, including a free-router fallback, cached authenticated catalog refresh, device-code login, and OpenRouter-compatible routing. |
| `provider-balance` | Footer | Displays Kilo or OpenRouter credits, z.ai token-plan quota, or OpenAI Codex subscription quota beside the working-directory footer line when authenticated. |

Kilo authentication can use either Pi's `/login kilo` flow or `KILO_API_KEY`.
`KILO_API_URL` can point the provider at a compatible alternate API endpoint.
Do not put credentials in this repository.

The standalone source files remain in the package for development and tests,
but Pi should load the generated bundle once for the whole feature set. Do not
load `kilo.ts` or `provider-balance.ts` separately alongside the bundle.

### `critique`

Use `/critique [arguments]` to release Pi's terminal and open the current
repository in [Critique](https://github.com/remorses/critique). The extension
runs the pinned Bun-only CLI as a child process, then restores Pi after `q` or
`Esc`. It does not register an agent-callable upload tool.

```text
/critique
/critique --staged
/critique main HEAD
/critique --filter "src/**/*.ts"
/critique review          # AI review through Pi via pi-acp
/critique review --staged
```

### `diff`

The extension records the repository state when an agent run starts and
combines Git changes with files touched through Pi's `edit` and `write` tools.
At the end of the run it reports how many files changed.

Commands:

```text
/diff       Choose a changed file and view its Git diff
/diff list  List changed files
/diff clear Reset the tracked list and establish a new baseline
```

### `external-changes`

This is a silent lifecycle extension for Git repositories. After the agent has
fully settled, it records a baseline consisting of `HEAD`, the working tree,
and untracked files. Before the next agent turn it injects a bounded report for:

- uncommitted changes made outside the session;
- commits made outside the session; and
- newly created untracked files.

It does nothing outside a Git worktree and remains silent when there is no drift.

### `session-summarizer`

Use `/summarize` to produce a compact, model-generated summary of a current or
branched session:

```text
/summarize                    Summarize the current session
/summarize <session-path>     Summarize a specific JSONL session
/summarize <session-uuid>     Resolve a session UUID or prefix and summarize it
```

The summarizer understands branch ancestry, compaction and handoff boundaries,
tool activity, model usage, token statistics, and costs when those values are
available. It uses the currently selected Pi model and API credentials.

## Archived experiments

[`pi-packages/experiments/`](pi-packages/experiments/) contains exploratory or
unused extensions. It is not maintained production code and is not included in
the maintained typecheck gate. Some experiments have tests and can be run on
demand.

Examples include:

- `arena`, `roundtable`, and `pi-debate` — multi-agent discussion experiments;
- `supervise` — supervision tooling related to `../pi-delegate`;
- `session-reference` and `trim-context` — session and context experiments;
- `gemini-youtube` and `gemini-youtube-cached` — YouTube analysis experiments;
- `command-center`, `fusion`, `forge-compaction`, and `extension-timer` — UI and
  lifecycle experiments; and
- `subagent-landscape` — research notes and comparison documents.

Treat the directory as a laboratory, not an API promise.

## Installation

Pi discovers extensions from either of these locations:

| Location | Scope |
|---|---|
| `.pi/extensions/*.ts` | The current project only |
| `~/.pi/agent/extensions/*.ts` | All Pi projects for the current user |

The commands below assume they are run from the repository root.

### Global goodies bundle

`bermudis-pi-goodies` is a multi-file extension. Pi loads it through a symlink,
so the symlink must point to the committed bundle rather than `index.ts` or one
of the individual feature modules:

```bash
mkdir -p ~/.pi/agent/extensions
ln -sf "$PWD/pi-packages/bermudis-pi-goodies/bermudis-pi-goodies.bundle.ts" \
  ~/.pi/agent/extensions/bermudis-pi-goodies.ts
```

### Project-local extensions

Create the discovery directory if this project does not already have one, then
link the individual single-file extensions:

```bash
mkdir -p .pi/extensions
ln -sf "$PWD/pi-packages/diff/diff.ts" \
  .pi/extensions/diff.ts
ln -sf "$PWD/pi-packages/external-changes/external-changes.ts" \
  .pi/extensions/external-changes.ts
ln -sf "$PWD/pi-packages/session-summarizer/index.ts" \
  .pi/extensions/session-summarizer.ts
```

Use `/reload` in Pi after changing or installing an extension. Do not install
anything globally without explicit approval; the global link changes behavior
in every Pi project on the machine.

`critique` owns runtime dependencies, so test it from its real path rather than
symlinking `index.ts`:

```bash
cd pi-packages/critique
pi -e ./index.ts
```

## Development

Use [Bun](https://bun.sh/) inside an extension directory. Never run `bun
install` or `bun add` at this repository root: there is deliberately no root
`package.json`, lockfile, or `node_modules` directory.

```bash
cd pi-packages/<extension>
bun install                 # first setup, or after dependency changes
bun run typecheck           # packages with a typecheck script
bun run test                # packages with tests
bun run format              # package-specific Prettier command
```

Useful package commands:

| Package | Typecheck | Tests | Format | Build |
|---|---:|---:|---:|---:|
| `bermudis-pi-goodies` | `bun run typecheck` | `bun run test` | `bun run format` | `bun run build` |
| `critique` | `bun run typecheck` | `bun run test` | `bun run format` | — |
| `diff` | `bun run typecheck` | — | `bun run format` | — |
| `external-changes` | `bun run typecheck` | `bun run test` | `bun run format` | — |
| `session-summarizer` | `bun run typecheck` | — | `bun run format` | — |
| `experiments` | not gated | `bun run test` | `bun run format` | — |

For a normal goodies change:

```bash
cd pi-packages/bermudis-pi-goodies
bun run typecheck
bun run test
bun run build
```

The build regenerates `bermudis-pi-goodies.bundle.ts`; commit the regenerated
bundle with its source changes. The bundle deliberately leaves external Pi
packages unresolved because Pi supplies them at runtime.

For a maintained extension change, run the narrowest relevant typecheck and
test first. Broaden verification when shared APIs or package boundaries are
changed. Experiments are opt-in and may depend on extracted sibling projects.

## Adding an extension

1. Create a new directory under `pi-packages/` for maintained work, or under
   `pi-packages/experiments/` for exploratory work.
2. Add an isolated `package.json` and `tsconfig.json`; declare dependencies in
   that package rather than at the repository root.
3. Run `bun install` from the new package directory.
4. Add a focused typecheck and test command where practical.
5. For a multi-file extension, add an esbuild bundle and load the bundle from
   Pi. A directly symlinked multi-file source extension will resolve imports
   relative to the symlink location and is expected to fail.
6. Install or symlink it only when it is ready, then use `/reload` in Pi.

Keep extensions small, observable, and explicit about failures. Do not hide
errors or silently swallow external-process failures.
