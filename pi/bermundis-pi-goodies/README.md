# bermundis-pi-goodies

A bundle of small, frequently-used [Pi](https://github.com/earendil-works/pi)
extensions. One entry point, four independent features.

| Feature | Command / hook | What it does |
|---------|----------------|--------------|
| `copy-with-model` | `/copy-with-model` | Copy last assistant message to the clipboard in a code fence tagged with the model name. |
| `name-with-ai` | `/name-with-ai [name]` | Generate a short session name from the first user message (or set one manually). |
| `notify` | `agent_end` hook | Desktop notification (macOS/Linux/WSL) or terminal bell when Pi finishes and is ready for input. |
| `zed` | `/z` | Open Zed editor on the current working directory. |

## Install

```bash
ln -s "$PWD/index.ts" ~/.pi/agent/extensions/bermundis-pi-goodies.ts
```

Then `/reload` in Pi. Each feature is independent — disabling one is a one-line
edit in `index.ts`.
