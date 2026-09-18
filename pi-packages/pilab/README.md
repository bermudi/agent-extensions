# pilab — sandboxed pi launcher

Run the real `pi` CLI against a disposable config dir, so test providers,
test extensions ("hooks" — pi has no separate hooks config, hooks live inside
extensions), test system prompts and test settings never touch your real
`~/.pi/agent`.

Isolation is pi's own mechanism: `PI_CODING_AGENT_DIR`. pilab keeps one
sandbox dir per experiment under `~/.pi/sandboxes/<name>/` and launches pi
with that env var set. pi then reads settings/auth/models/extensions/skills/
themes **only** from the sandbox — nothing else.

```
~/.pi/sandboxes/<name>/
  sandbox.json      manifest (what is borrowed)
  agent/            <- handed to pi as PI_CODING_AGENT_DIR
    settings.json   generated at creation: allowlist copy of real settings
                    (defaultProvider, defaultModel, defaultThinkingLevel,
                    theme, tuiMode). packages/extensions/skills/prompts are
                    NEVER copied, so npm-installed extensions cannot leak in.
    auth.json       -> ~/.pi/agent/auth.json      (borrow "auth", default ON)
    keybindings.json -> real                      (borrow "keybindings", default ON)
    themes/*        -> real entries                (borrow "themes", default ON)
    models.json     -> real models.json            (borrow "models", default OFF)
    AGENTS.md       -> real global AGENTS.md       (borrow "agents", default OFF);
                     when off, a sandbox-local file lives here
    extensions/     empty — drop test extensions here (or pass --ext)
```

## Quickstart

```sh
bun run build                     # -> dist/pilab (single binary)
./dist/pilab                      # interactive picker
./dist/pilab mytest --model kilo/claude-sonnet-4        # create + run
./dist/pilab mytest -- --system-prompt 'You are a test dummy.' -nc
./dist/pilab edit mytest models   # add a test provider, then point --model at it
./dist/pilab borrow mytest models # borrow real models.json into the sandbox
./dist/pilab rm mytest            # trash it
```

Everything after `--` goes to pi verbatim, so any pi flag works: `-e ./ext.ts`,
`--system-prompt`, `--append-system-prompt`, `-nc` (no context files),
`--no-extensions`, `--tools`, ... `--ext`/`--model` before the `--` are just
convenience shorthands (`-e` with path checks, `--model`).

## Borrowing

| borrow        | default | what                                                                |
| ------------- | ------- | ------------------------------------------------------------------- |
| `auth`        | ON      | `auth.json` as a **live symlink** into the real store               |
| `keybindings` | ON      | `keybindings.json`                                                  |
| `themes`      | ON      | every file in the real `themes/` dir                                |
| `models`      | off     | `models.json` (your custom providers: kilo, commandcode, ...)       |
| `agents`      | off     | the global `AGENTS.md`                                              |

`auth` is symlinked, not copied, on purpose: pi rewrites `auth.json` in place
on OAuth refresh. A live link keeps one source of truth instead of forking
refresh tokens across copies. `pilab edit <name> models` edits through the
symlink too — check the path it prints before typing.

`pilab unborrow` only ever removes symlinks pilab created; real files you put
in the sandbox yourself are left alone (pilab's own generated scaffolds carry
a `pilab sandbox` marker and are the only regular files it will replace).

## Testing things

- **Test providers**: `pilab edit <name> models`, add a provider (the schema
  matches models.json; `apiKey` supports `$ENV` / `${ENV}` templates — use
  those instead of pasting keys), then `pilab <name> --model myprov/mymodel`.
- **Test extensions / hooks**: pass `--ext ./my-ext.ts` or drop files into the
  sandbox `extensions/` dir. Since pi hooks are extensions, that covers hooks.
  `--no-extensions` still works if you want zero extensions.
- **Test system prompts**: `pilab <name> -- --system-prompt '...'`; for a
  fully clean context also pass `-nc` (skips AGENTS.md chain) — or unborrow
  `agents` and edit the sandbox-local AGENTS.md.
- **Test settings/themes**: `pilab edit <name> settings|manifest`, or borrow
  themes and edit your real theme file through the link.

## Caveats

- Project-scoped config still applies, by design: pi loads `<cwd>/.pi/*` and
  the cwd `AGENTS.md` chain from whatever directory you launch in. Test in a
  scratch dir if that matters, or pass `-nc`.
- Sessions are per-sandbox (they live inside the sandbox agent dir), so they
  never mix with your real session history.
- The sandbox `trust.json` is separate: first launch in a project will ask for
  trust again.

## Env

- `PILAB_ROOT` — sandbox root (default `~/.pi/sandboxes`)
- `PILAB_REAL_AGENT_DIR` — "real" agent dir to borrow from (default `~/.pi/agent`)
- `EDITOR` / `VISUAL` — used by `pilab edit`

## Dev

```sh
bun install && bun run typecheck && bun run test
bun run build   # single-file binary in dist/ (copy it wherever you want it)
```

Tests never touch the real config: they point `PILAB_ROOT` /
`PILAB_REAL_AGENT_DIR` at temp dirs and use PATH shims for `pi`/`trash`.
