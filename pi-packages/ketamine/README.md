# Ketamine

Ketamine replaces Pi's simplistic summary-plus-recent-suffix compaction with an
outside observer that curates the working model's conversation context.

> **Status: experimental and still untested end to end.** Automated tests and
> typechecking pass, but Ketamine has not yet completed a successful real-world
> compaction using a supported non-OpenAI model. Do not rely on it for important
> sessions yet.

When Pi triggers compaction, the extension:

1. freezes the active trajectory;
2. starts a separate, persisted Pi observer process and session;
3. gives a non-OpenAI observer a compact trajectory map with exposed reasoning,
   tool-call metadata, errors, and output sizes;
4. lets it progressively disclose full turns or individual tool results only when
   they matter;
5. has it classify every protocol-safe turn as **keep**, **summarize**, or
   **drop**;
6. validates exhaustive, chronological coverage;
7. replaces the conversation messages sent on subsequent provider calls with
   that curated context plus work performed after the checkpoint.

The observer has no shell or general filesystem tools. It receives only
path-confined tools for a compact trajectory map, detailed turn text/reasoning,
on-demand paginated tool results, and one terminating structured-result tool. Its session and diagnostics are stored beneath:

```text
~/.pi/agent/ketamine/runs/<run-id>/
```

## Development

Load from source deliberately:

```bash
pi --extension ./pi-packages/ketamine/index.ts
```

Do not install a mutable working tree as a production extension. Publish and
install a pinned package version once this graduates from development.

Run checks from this package directory:

```bash
bun run typecheck
bun test
bun run format
```

## Observer model

Ketamine intentionally skips OpenAI-family models; those fall through to their
provider-native compaction. For non-OpenAI sessions, the observer uses the
working session's selected model by default. Override it with a non-secret,
non-OpenAI provider/model identifier when the working provider is registered by
another extension or you want a dedicated curator:

```bash
KETAMINE_MODEL=anthropic/claude-sonnet-4-6 pi --extension ./pi-packages/ketamine/index.ts
```

## Current constraints

- Providers registered only by another extension are unavailable in the
  isolated observer process; select a built-in provider with `KETAMINE_MODEL`.
- SDK hosts and wrappers whose `process.argv[1]` is not Pi's CLI must set
  `KETAMINE_PI_COMMAND` to the Pi executable path.
- Ketamine must be the effective compaction handler; a later compaction
  extension can override its result because Pi chains these hooks.
- Observer failure blocks compaction instead of silently falling back to Pi's
  native summarizer.
- `drop` removes material from the model context; it is not secure deletion.
  Target and observer session artifacts remain on disk with private permissions.
- Pi decides whether there is anything to compact before firing the extension
  hook. A future Pi API that directly accepts replacement messages would remove
  this remaining lifecycle edge case.
