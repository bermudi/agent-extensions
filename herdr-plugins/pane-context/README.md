# Pane Context

Copies the focused pane's Herdr context to the clipboard and raises a toast.

Clipboard contents, in order:

```sh
HERDR_PANE_ID=...
HERDR_SOCKET_PATH=...
HERDR_TAB_ID=...
HERDR_WORKSPACE_ID=...
```

## Install and bind

```bash
herdr plugin link /home/daniel/build/agent-extensions/herdr-plugins/pane-context
```

Then bind `prefix+alt+i` in `config.toml` (the symlinked source lives in
`~/dots/herdr/config.toml`):

```toml
[[keys.command]]
key = "prefix+alt+i"
type = "plugin_action"
command = "pane.context.copy"
description = "copy pane context"
```

Run `herdr server reload-config` after editing the config.

## Test

```bash
uv run --no-project -m unittest test_copy_pane_context -v
```
