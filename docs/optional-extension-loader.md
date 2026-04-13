# Optional Extension Loader

A Pi extension that lets you manage which extensions load automatically and which stay optional — toggleable per-session without editing config files.

## What it does

Pi auto-discovers extensions from `~/.pi/agent/extensions/` (global) and `.pi/extensions/` (project-local). Everything in those directories loads on every session. This extension adds an optional layer:

- **Startup** extensions load automatically (the default)
- **Optional** extensions only load when you explicitly enable them for a session

The state persists across `/reload` within a session but doesn't carry to new sessions — optional extensions start disabled each time.

## Commands

### `/ext` — Interactive manager

Opens a picker listing all discovered extension resources. Select one to get actions:

- **Toggle load** — load or unload an optional extension for this session
- **Toggle autoload** — move an extension between startup (autoload) and optional (manual)

### `/ext list` — Text listing

Prints all extension resources with their current state:

```
[loaded, autoload on] chord-keybindings (global) — ~/.pi/agent/extensions/chord-keybindings.ts
[not loaded, autoload off] my-experiment (global) — ~/.pi/agent/optional-extensions/my-experiment.ts
[loaded, autoload on] thinking-compaction (project) — .pi/extensions/thinking-compaction.ts
```

### `/ext load <name>` — Per-session toggle

Enables or disables an optional extension for the current session. Triggers a `/reload`.

```bash
/ext load my-experiment    # enable for this session
/ext load my-experiment    # disable again (toggle)
```

### `/ext auto <name>` — Change autoload

Moves the extension between startup and optional modes. For auto-discovered files, this physically moves the file between `extensions/` and `optional-extensions/` directories.

```bash
/ext auto my-experiment    # toggle autoload on ↔ off
```

Tab completion works for all subcommands and extension names.

## Extension sources

The loader discovers extensions from multiple sources. Each can be startup or optional:

| Source | Startup location | Optional location |
|--------|-----------------|-------------------|
| Auto-discovered files | `~/.pi/agent/extensions/` | `~/.pi/agent/optional-extensions/` |
| Auto-discovered files (project) | `.pi/extensions/` | `.pi/optional-extensions/` |
| `settings.json` packages | `"packages": ["npm:foo"]` | `"packages": [{"source":"npm:foo","extensions":[]}]` |
| `settings.json` extensions | `"extensions": ["~/my-ext.ts"]` | removed from list, added to config |
| `optional-extensions.json` | — | `"entries": [{"name":"foo","path":"~/foo.ts"}]` |

### `optional-extensions.json` format

For extensions that live outside the auto-discovery directories:

```json
{
  "entries": [
    {
      "name": "my-cool-ext",
      "description": "Does cool stuff",
      "path": "~/projects/my-ext/index.ts"
    },
    {
      "name": "work-toolkit",
      "source": "npm:@company/pi-toolkit"
    },
    {
      "name": "multi-file",
      "paths": ["~/exts/a.ts", "~/exts/b.ts"]
    }
  ]
}
```

Placed at `~/.pi/agent/optional-extensions.json` (global) or `.pi/optional-extensions.json` (project).

## How it works

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Extension entry point (export default)                  │
│  ┌─────────────────────────────────────────────────────┐│
│  │  session_start handler                              ││
│  │  1. Build registry from all sources                 ││
│  │  2. Read enabled names from session state           ││
│  │  3. Load each enabled optional extension via jiti   ││
│  └─────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────┐│
│  │  /ext command handler                               ││
│  │  - list: format and display all items               ││
│  │  - load <name>: toggle session state, reload        ││
│  │  - auto <name>: mutate files/settings, reload       ││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

### State persistence

Session state uses `pi.appendEntry()` — the same mechanism Pi uses for conversation history. The enabled list survives `/reload` because it's part of the session branch. New sessions start fresh.

### Loading optional extensions

Optional extensions are loaded at `session_start` time, the same lifecycle point where Pi loads startup extensions. A `Proxy` around the Pi API intercepts `on("session_start", ...)` calls so that optional extensions' session start handlers fire correctly even though they missed the initial event.

### Mode transitions

When you toggle autoload:

- **Auto-discovered files**: the file is physically moved between `extensions/` and `optional-extensions/`
- **Settings packages**: `{ source: "npm:foo" }` ↔ `{ source: "npm:foo", extensions: [] }`
- **Settings extensions**: path moved between `extensions` array and `optional-extensions.json`
- **Config entries**: moved between `optional-extensions.json` and appropriate settings location

All mutations happen before the reload, so the new state is visible immediately.

## Code structure

| File | Purpose |
|------|---------|
| `optional-extension-loader.ts` | Extension entry point, fs operations, Pi API integration |
| `optional-extension-loader-utils.ts` | Pure functions — no fs, no Pi deps, fully tested |

The utils module exports all pure data transformations (path handling, package parsing, lookup, display formatting, autocomplete) so they can be tested without mocking Pi's module system.

## Self-protection

The loader refuses to disable its own autoload when the command comes from within a loaded session. This prevents you from accidentally locking yourself out — you'd need to edit files manually to fully remove it.

## Status bar

When optional extensions are loaded, the status bar shows them:

```
ext my-experiment, other-tool
```

This uses the Pi status bar API (`ctx.ui.setStatus`).
