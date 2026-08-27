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

A toast summarizes the result (`sent /reload to 7/9 pi instances · …`) and the
per-pane detail lands in `herdr plugin log list --plugin pi.reload`.

## Which panes get reloaded

pi reports its own lifecycle state to Herdr (via the `herdr:pi` extension
hook), and the plugin re-checks each pane (`herdr agent get`) immediately
before typing, because the listing is seconds stale by the time the pass
reaches it. There is a small residual window — state can change in the
time between the re-check and the keystrokes — which herdr's unguarded
`agent prompt` cannot close; the plugin gets as close as the CLI allows.

| pi state      | action                                                                     |
|---------------|----------------------------------------------------------------------------|
| `idle` / `done` | `/reload` is typed into the editor and takes effect immediately           |
| `working`     | sent anyway — pi warns ("Wait for the current response to finish before reloading.") and drops the text; run the action again after the turn ends |
| `blocked`     | skipped — an approval dialog is open; pressing Enter would **confirm the highlighted option**, so blocked panes are never typed into |
| `unknown`     | skipped — state hook not authoritative, a dialog cannot be ruled out       |

The toast calls out how many were mid-turn so you know whether a rerun is
needed. Blocked panes are the one hard skip: typing into a pi pane that is
showing a dialog can answer it.

## Draft guard

Before typing anywhere, the plugin reads each candidate pane's bottom region
(`herdr agent read --source detection`) and checks pi's input box — the lines
between the last two full-width border rules. If a draft is sitting in the
input box, the pane is skipped: `/reload` would be appended to the draft and
Enter would submit it. Panes whose bottom region can't be parsed (alternate-
screen app, unusual layout) are skipped too — when in doubt, don't type.
Queued messages, spinners, and transient warnings render outside the input
box and don't trigger the guard. One known blind spot: a draft whose visible
tail is itself a full-width `─` rule is indistinguishable from the editor's
top border and slips past the guard.

## Install

```bash
herdr plugin link /path/to/agent-extensions/herdr-plugins/pi-reload
herdr plugin list                  # confirm it is enabled
```

Uninstall with `herdr plugin unlink pi.reload`.

## Testing

`python3 reload_pi.py --dry-run` lists every pi instance in the session with
the action that would be taken, changing nothing. It needs a `herdr` binary
(`HERDR_BIN_PATH` or `PATH`) that can reach the session — from outside a
Herdr pane, set `HERDR_SOCKET_PATH` to the session socket.

Tests: `uv run -m unittest test_reload_pi` (pure logic only — parser,
classifier, toast truncation; no session needed).
