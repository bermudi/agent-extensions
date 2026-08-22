# Council

A prototype Pi extension that asks several configured models to independently
investigate a design problem, critique and revise the anonymized proposals, vote
on normalized design decisions, and produce one final design.

Council members are structurally limited to `read`, `grep`, `find`, and `ls`.
They cannot run commands or modify the repository. The extension writes only to
`.pi/council/`, which it makes private and ignored by Git.

## Configure

Create `~/.pi/agent/council.json` or a trusted project's `.pi/council.json`:

```json
{
  "version": 1,
  "members": [
    { "model": "provider/model-a", "thinking": "high" },
    { "model": "provider/model-b", "thinking": "high" },
    { "model": "provider/model-c", "thinking": "high" }
  ],
  "chair": {
    "mode": "model",
    "model": "provider/model-chair",
    "thinking": "high"
  }
}
```

Use exact model IDs already available in Pi. Project config fields override
global fields.

For a human chair:

```json
{
  "version": 1,
  "members": [
    { "model": "provider/model-a" },
    { "model": "provider/model-b" }
  ],
  "chair": {
    "mode": "user",
    "secretary": { "model": "provider/model-a" }
  }
}
```

## Run

Load this package in a development Pi session, then:

```text
/council
/council Focus particularly on backward compatibility.
```

The command snapshots Pi's active, compaction-aware conversation. It does not
inject its result back into the conversation. It writes:

```text
.pi/council/<timestamp>-<focus>/
├── DESIGN.md
└── council.jsonl
```

`council.jsonl` is intentionally lossless enough for debugging and can contain
conversation and repository content. Do not share it casually.

## Development

```bash
cd pi-packages/council
bun run typecheck
bun run test
```

