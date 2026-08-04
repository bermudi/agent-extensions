# Pane Layouts

A Herdr plugin that applies common pane layouts to a tab. Two ways to use it:

- **Interactive picker** (the main UI): one key opens a popup listing the layouts;
  arrow to one, adjust its count, Enter to apply. Never leave the TUI.
- **One-shot actions**: each preset is also a plugin action you can bind or run.

## Layouts

| Picker entry        | Layout                                                |
|---------------------|-------------------------------------------------------|
| columns             | N panes side by side (count adjustable)              |
| rows                | N panes stacked (count adjustable)                   |
| quad                | 2x2 grid                                              |
| main-left           | large pane left + N stacked right (tmux main-vertical)|
| main-right          | N stacked left + large pane right                     |
| main-top            | large pane top + N below                              |
| main-bottom         | N above + large pane bottom                           |

In the picker, `-`/`+` or `\`/`/` adjust the count for the highlighted layout
(1-6). `quad` ignores the count.

## Install

```bash
herdr plugin link .local/plugins/pane-layouts
herdr plugin list                 # confirm it is enabled
```

Uninstall with `herdr plugin unlink layouts.pane-layouts`.

## Open the picker with one key

Bind a key to open the popup pane. Add to your Herdr config:

```toml
[[keys.command]]
key = "prefix+l"
type = "shell"
command = "herdr plugin pane open --plugin layouts.pane-layouts --entrypoint picker"
description = "choose a pane layout"
```

Press `prefix+l`, pick a layout, Enter. The layout opens as a new tab (existing
panes are untouched) and the popup closes. `prefix+?` shows the description in
the keybind panel.

## One-shot actions (if you prefer fixed keybinds)

Each preset is a plugin action, bindable directly:

```toml
[[keys.command]]
key = "prefix+2"
type = "plugin_action"
command = "columns-2"
description = "layout: 2 columns"
```

Action ids: `columns-2`, `columns-3`, `rows-2`, `rows-3`, `quad`, `main-left`,
`main-right`, `main-top`, `main-bottom`.

## Behavior

- **Default: opens a new tab** with the layout. Existing panes and running
  processes are never touched.
- The underlying `layouts.py` also supports `--replace` (reshape the current tab
  in place; closes its existing panes), `--cwd`, `--count`, and `--main-ratio`
  for scripting.
- New panes spawn the default shell in the workspace's cwd.

## How it works

Herdr layouts are binary split trees. Each `split` has a `direction`
(`right` = side-by-side, `down` = stacked) and a `ratio` = the **first** child's
share of the area, clamped by Herdr to `[0.1, 0.9]`. `layouts.py` builds these
trees and calls `layout.apply` over the socket; `picker.py` is a no-dependency
terminal menu (raw-mode key handling, ANSI render) that reuses the same engine
and runs inside a plugin popup pane.

Verified live: the picker navigates, adjusts counts, and applies layouts against
a real Herdr server (quad and main-left x3 confirmed by reading the resulting
layout trees), and runs correctly inside an actual popup pane.
