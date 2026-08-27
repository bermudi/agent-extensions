# Pi Reload

A Herdr plugin that sends `/reload` to the pi coding agents in the current
Herdr session, so every instance picks up extension/skill/theme changes
without visiting each pane.

## Use

- **Keybind** (recommended): bind the action once, then hit it after editing
  extension source:

  ```toml
  [[keys.command]]
  key = "prefix+R"
  type = "plugin_action"
  command = "pi.reload.reload-all"
  description = "send /reload to all pi instances"
  ```

- **CLI**: `herdr plugin action invoke pi.reload.reload-all`

A toast summarizes the result (`reloaded 7/9 pi instances · …`) and the
per-pane detail lands in `herdr plugin log list --plugin pi.reload`.

## Which panes get reloaded

pi reports its own lifecycle state to Herdr (via the `herdr:pi` extension
hook), so the plugin knows exactly what each pane is doing and only types
into panes that are safe:

| pi state      | action                                                                     |
|---------------|----------------------------------------------------------------------------|
| `idle` / `done` | `/reload` is typed into the editor and submitted                          |
| `working`     | skipped — pi refuses `/reload` mid-turn ("Wait for the current response…") |
| `blocked`     | skipped — an approval dialog is open; pressing Enter would **confirm the highlighted option**, so blocked panes are never typed into |
| `unknown`     | skipped — state hook not authoritative, a dialog cannot be ruled out       |

Busy/blocked panes are listed in the toast and log; run the action again once
they settle. There is deliberately no "send anyway" mode: typing into a pi
pane that is showing a dialog can answer it.

## Install

```bash
herdr plugin link /path/to/agent-extensions/herdr-plugins/pi-reload
herdr plugin list                  # confirm it is enabled
```

Uninstall with `herdr plugin unlink pi.reload`.

## Testing

`python3 reload_pi.py --dry-run` lists every pi instance in the session with
the action that would be taken, changing nothing. It needs `herdr` on `PATH`
(or `HERDR_BIN_PATH`) pointed at the session.
