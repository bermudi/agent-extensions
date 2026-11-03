# bermudis-pi-model-picker

Instant model picker for Pi: the stock ctrl+l picker minus the on-open catalog
refresh.

The built-in picker re-fetches every provider's model catalog every time it
opens (`refreshModelCatalogs()`, 15s timeout, network). This extension renders
the identical UI purely from the session's model snapshot
(`ctx.modelRegistry.getAvailable()` — synchronous, zero network, zero
`refreshModels` calls), so opening it is instant and offline-safe. Freshness
comes from pi's existing refresh points (session start cache-load, `/login`,
`pi update --models`, stock picker opens) instead of every picker open.

Ported from pi-mono `packages/coding-agent` (model-selector.ts and companions).
MIT, Copyright (c) 2025 Mario Zechner.

## Binding

`ctrl+l` is reserved while the built-in `app.model.select` action claims it.
Free it by remapping the built-in in `~/.pi/agent/keybindings.json`:

```json
{ "app.model.select": ["ctrl+shift+l"] }
```

(Or disable the built-in entirely with `"app.model.select": []`.) The
conflict check runs against the *effective* config
(`runner.getShortcuts(getEffectiveConfig())`), and `CustomEditor.handleInput`
consults extension shortcuts before built-in actions — once the built-in
moves off ctrl+l, the extension shortcut takes it. The remapped key keeps the
stock picker reachable for the one thing this extension does not do:
saving a default model (`app.models.save`).

An empty `keybindings.json` (no such entry) means ctrl+l stays with the stock
picker and this extension's shortcut is skipped with a conflict diagnostic.

## What it provides

- **ctrl+l** — opens the picker (after the remap above).
- **/model-picker [filter]** — same picker, optional argument pre-fills the
  search box.
- Same UI as stock: fuzzy filter, `default` query pins the default model,
  tab toggles all/scoped scope, up/down wrap, enter applies, escape cancels.
- Selection is **session-only** (`pi.setModel` — never touches the saved
  default). The default model is shown as a badge.

Differences from stock: no refresh status/error lines (there is no refresh),
no `app.models.save` (extensions have no settings-write API).

## Development

```bash
cd pi-packages/model-picker  # never run bun at the repo root
bun install                  # first time only
bun run typecheck
bun run test
bun run format
```

Dev-load (from a scratch cwd, no other extensions):

```bash
pi -ne -e /home/daniel/build/agent-extensions/pi-packages/model-picker/index.ts
```

The package pins `@earendil-works/*` ^1.5.0 (matches the installed pi
1.5.0). Not published to npm; not installed globally.
