# Glossary

Project-specific terms used in this repo. Industry-standard terms (API, SDK, OAuth, …)
are not defined here.

- **code mode** — an agent pattern where the model writes one program that calls the
  agent's tools as functions, instead of one model turn per tool call. Pi's built-in
  `codemode` tool does this with JavaScript (QuickJS); the [`monty-code-mode`](pi-packages/experiments/monty-code-mode/)
  experiment does it with Python in the Monty sandbox.
- **Monty** — [pydantic's sandboxed Python runtime](https://github.com/pydantic/monty).
  A safe Python-subset interpreter running in crash-isolated worker subprocesses. This
  repo uses it through the `@pydantic/monty` npm binding (native napi module) in
  `monty-code-mode`.
- **run_code** — the model-facing tool registered by `monty-code-mode`: takes raw
  Python source, runs it in Monty, returns the trailing expression's value.
