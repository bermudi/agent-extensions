# bermudis-pi-goodies

A bundle of small, frequently-used [Pi](https://github.com/earendil-works/pi)
extensions. One entry point, three independent features.

| Feature | Command / hook | What it does |
|---------|----------------|--------------|
| `copy-with-model` | `/copy-with-model` | Copy last assistant message to the clipboard in a code fence tagged with the model name. |
| `name-with-ai` | `/name-with-ai [name]` | Generate a short session name from the first user message (or set one manually). |
| `zed` | `/z` | Open Zed editor on the current working directory. |
| `prefer-tools` | hook (no command) | Nudge toward modern CLIs: `rg` over `grep`, `fd` over `find`, `uv` over bare `python`/`pip`/`pytest`/`mypy`. |

## Install

```bash
# Multi-file extension: symlink the BUNDLE, not index.ts — pi's Node loader
# resolves relative imports against the symlink path, which would otherwise
# break the per-module imports.
ln -s "$PWD/bermudis-pi-goodies.bundle.ts" ~/.pi/agent/extensions/bermudis-pi-goodies.ts
```

Then `/reload` in Pi. Each feature is independent — disabling one is a one-line
edit in `index.ts`.
