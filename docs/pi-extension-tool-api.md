# Pi Extension Tool API (`registerTool`)

Reference for writing custom LLM-callable tools inside pi extensions. Distilled
from a DeepWiki Q&A run against `earendil-works/pi`; overlapping claims verified
against the installed `@earendil-works/pi-agent-core` types
(`AgentTool`, `AgentToolResult`, `prepareArguments`, `terminate` batch semantics
all check out).

> **Source line refs are a snapshot.** They point into the upstream pi monorepo
> (`packages/coding-agent/...`, `packages/agent/...`), **not** this repo. They will
> rot as pi evolves — trust the prose, use the refs only to re-confirm. See
> [Sources](#sources) at the bottom.

---

## `registerTool`

`ExtensionAPI.registerTool(tool: ToolDefinition)` registers a custom tool the LLM
can call during a run. Registered tools appear alongside built-ins (`read`, `bash`,
`edit`, …) and are invoked the same way.

- **Dynamic registration** — can be called at any time, not only during extension
  load. Call it from `session_start`, command handlers, or other event handlers.
  New tools are picked up in the **same session** — no `/reload` needed, and they
  immediately show up in `getAllTools()` / `getActiveToolNames()`.
- **Override built-ins** — register a tool whose `name` matches a built-in
  (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) to override it. **First
  registration wins**; interactive mode warns when a collision happens. Execution
  override and rendering override are independent (see [Rendering](#rendering)).

### Minimal example

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "greet",
    label: "Greet",
    description: "Greet someone by name",
    promptSnippet: "Greet a user by name",
    parameters: Type.Object({
      name: Type.String({ description: "Name to greet" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: {},
      };
    },
  });
}
```

---

## `ToolDefinition` fields

| Field | Type | Purpose |
|-------|------|---------|
| `name` | `string` | Tool identifier used in LLM tool calls |
| `label` | `string` | Human-readable label for UI display |
| `description` | `string` | Description sent to the LLM in the tool's JSON schema |
| `promptSnippet` | `string?` | One-line entry in the **Available tools** section of the system prompt |
| `promptGuidelines` | `string[]?` | Bullets appended to the **Guidelines** section when the tool is active |
| `parameters` | `TSchema` | TypeBox parameter schema (validated before `execute`) |
| `execute` | `function` | Async tool implementation |
| `prepareArguments` | `function?` | Pre-validation argument transform (compat shim) |
| `renderCall` | `function?` | Custom TUI rendering for the tool-call display |
| `renderResult` | `function?` | Custom TUI rendering for the tool-result display |
| `renderShell` | `"default" \| "self"?` | Whether the standard colored shell is rendered |
| `executionMode` | `"sequential" \| "parallel"?` | Per-tool override of default execution mode |

### `execute` signature

```typescript
async execute(
  toolCallId: string,
  params: Static<TParams>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<TDetails>>
```

`ctx` exposes: `ctx.ui` (confirm/select/notify/custom components),
`ctx.sessionManager` (history/branching), `ctx.cwd`, `ctx.exec` (shell),
`ctx.modelRegistry` (model + API key resolution).

---

## The three prompt-surface fields (the part everyone gets wrong)

These three fields all "describe the tool to the LLM" but land in **different
places** with **different visibility rules**. Getting them confused is the #1 way
to ship a tool the model never calls.

| Field | Goes where | When visible | Says what |
|-------|-----------|--------------|-----------|
| `description` | Tool's JSON schema (sent via the provider API) | **Always** — every active tool | **What** the tool does |
| `promptSnippet` | "Available tools" list in system prompt text | Only if provided | One-line summary for the list |
| `promptGuidelines` | "Guidelines" bullets in system prompt text | Only while the tool is **active** | **When/how** to use the tool |

### `description` (schema, always sent)

Part of the tool definition converted to the provider's tool format. Required.
Can be longer. The LLM always sees it as part of the tool schema, **even when the
tool is not listed in "Available tools"**.

### `promptSnippet` (Available tools list, opt-in)

Controls one thing: whether the tool appears as `- name: snippet` in the
"Available tools" section of the system prompt text.

- If **omitted** → the tool is **omitted from that list entirely**.
  - It is **still registered, still active, still callable**, and its
    `description` is **still sent** to the LLM via the tool schema. It just
    doesn't get a one-line bullet in the system prompt summary.
  - Use this for helper tools you want available but don't need to highlight.
- If **provided** → appears as `- tool_name: snippet` in the list.

The system-prompt builder filters to only tools that have a snippet:

```typescript
const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
const toolsList =
  visibleTools.length > 0
    ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n")
    : "(none)";
```

> ⚠️ **Breaking change in 0.59.0.** Before this, omitting `promptSnippet` fell
> back to `description` in the "Available tools" section. Now the tool is left out
> unless you explicitly provide a snippet. If a custom tool that "used to show up"
> silently disappeared from the system prompt after an upgrade, this is why.

### `promptGuidelines` (Guidelines bullets, active-only)

Optional bullets appended flat to the "Guidelines" section of the system prompt —
**but only while the tool is active** (see ["active" ≠ "about to be called"](#active--about-to-be-called)).
Tells the LLM **when/how** to reach for the tool.

```typescript
promptGuidelines: [
  "Use my_tool when the user asks to summarize previously generated text.",
],
```

> **Each bullet must name the tool explicitly.** Bullets are appended flat with no
> tool-name prefix, so the LLM can't tell what "this tool" means. Write
> `"Use my_tool when…"` — never `"Use this tool when…"`.

### Putting it together

```typescript
pi.registerTool({
  name: "my_tool",
  description: "Summarizes or transforms text according to action", // schema: WHAT
  promptSnippet: "Summarize or transform text according to action", // list entry
  promptGuidelines: [                                           // when to use it
    "Use my_tool when the user asks to summarize previously generated text.",
  ],
  // …parameters, execute…
});
```

---

## "active" ≠ "about to be called"

`promptGuidelines` docs say "appended when the tool is active." A natural (wrong)
read: "pi waits until the model is about to call the tool, then injects the
guideline." That can't work — the model needs a system prompt **before** its first
call, and it can't call a tool it hasn't been told about.

What "active" actually means: **the tool is in the `selectedTools` set used to
build the system prompt.** The system prompt is always built **before** the LLM
call, so:

1. The first LLM call **does** include `promptGuidelines` — for whatever tools are
   active when the session/prompt starts.
2. Guidelines are included for **all** active tools, not just ones the model ends
   up calling.
3. Change the active set mid-session with `pi.setActiveTools([...])` /
   `setActiveToolsByName([...])` — that rebuilds the system prompt (collecting
   guidelines from the new active set) before the next LLM call.

Flow when the active set changes:

```
setActiveToolsByName(["tool1","tool2"])
  → _rebuildSystemPrompt(validToolNames)
      → collect promptSnippet + promptGuidelines for each active tool
      → buildSystemPrompt(...)
  → agent.state.systemPrompt = rebuilt prompt
  → next LLM call uses the new prompt
```

---

## `prepareArguments` vs `parameters`

Different roles, different timing:

| Aspect | `parameters` (schema) | `prepareArguments` |
|--------|----------------------|---------------------|
| Purpose | Declares the accepted argument shape | Transforms raw args **before** validation |
| When it runs | During validation | **Before** validation, before `execute` |
| Visible to LLM? | Yes (sent as the tool schema) | No |
| Required? | Yes | Optional |

Execution order per tool call:

```
raw args (from LLM or resumed session)
  → prepareArguments(args)        // optional shim; returns current-shape object
  → validate against parameters   // schema check
  → execute(toolCallId, params, …)
```

Use `prepareArguments` as a **backward-compat shim** when you change `parameters`
in a breaking way and need to resume old sessions whose stored tool-call args no
longer match the new schema. The canonical example is the built-in `edit` tool:
old sessions stored top-level `oldText`/`newText`; the current schema only accepts
`edits: [{ oldText, newText }]`. `prepareArguments` folds the legacy fields into
the new shape:

```typescript
prepareArguments(args) {
  if (!args || typeof args !== "object") return args;
  const input = args as {
    path?: string;
    edits?: Array<{ oldText: string; newText: string }>;
    oldText?: unknown; // legacy
    newText?: unknown; // legacy
  };
  if (typeof input.oldText !== "string" || typeof input.newText !== "string") {
    return args;
  }
  return {
    ...input,
    edits: [...(input.edits ?? []), { oldText: input.oldText, newText: input.newText }],
  };
}
```

Rules:

- Keep the **public schema strict** — do **not** add deprecated fields to
  `parameters` just to keep old resumed sessions working. Let `prepareArguments`
  absorb them.
- Return the object you want validated against `parameters`.
- Returning the same object reference skips a mutation for efficiency.

---

## `execute`: errors, termination, file mutation

### Signaling errors

**Throw** from `execute` to mark the execution failed (`isError: true` on the
result, reported to the LLM). **Returning** a value never sets the error flag,
regardless of what you put in the return object.

```typescript
async execute(toolCallId, params) {
  if (!isValid(params.input)) {
    throw new Error(`Invalid input: ${params.input}`); // → isError: true
  }
  return { content: [{ type: "text", text: "OK" }], details: {} };
}
```

### Early termination

Return `terminate: true` from `execute()` to hint that the automatic follow-up
LLM call should be skipped after the current tool batch. **Only takes effect when
every finalized tool result in that batch is terminating.** See pi's
`examples/extensions/structured-output.ts` for a minimal "agent ends on a final
structured-output tool call" pattern.

### File mutation queue

Tool calls run in **parallel** by default. If your custom tool mutates files, wrap
the entire read-modify-write window in `withFileMutationQueue(targetPath)` so it
shares the same per-file queue as built-in `edit`/`write`. Otherwise two tools can
read the same stale contents, apply different updates, and the last write wins
(silently dropping the other change).

- Pass the **real resolved target path** (resolve to absolute relative to
  `ctx.cwd` first), not the raw user argument.
- For existing files the helper canonicalizes via `realpath()`, so symlink aliases
  for the same file share one queue. For new files it falls back to the resolved
  absolute path (nothing to `realpath` yet).
- Queue the **whole mutation window** (read + modify + write), not just the write.

```typescript
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
  const absolutePath = resolve(ctx.cwd, params.path);
  return withFileMutationQueue(absolutePath, async () => {
    await mkdir(dirname(absolutePath), { recursive: true });
    const current = await readFile(absolutePath, "utf8");
    const next = current.replace(params.oldText, params.newText);
    await writeFile(absolutePath, next, "utf8");
    return {
      content: [{ type: "text", text: `Updated ${params.path}` }],
      details: {},
    };
  });
}
```

---

## Rendering

`renderCall` / `renderResult` are optional. Inheritance from the built-in
renderer is resolved **per slot** and is **independent of the execution override**:

- Override omits `renderCall` → built-in `renderCall` is used.
- Override omits `renderResult` → built-in `renderResult` is used.
- Override omits both → full built-in renderer (syntax highlighting, diffs, …).

This lets you wrap a built-in tool for logging or access control without
reimplementing its UI.

---

## Other gotchas

- **String enums for Google.** Use `StringEnum` from `@earendil-works/pi-ai` for
  string enums. `Type.Union`/`Type.Literal` does not work with Google's API.
- **Guidelines must name the tool** (repeated because it's the most common slip):
  the bullets are appended flat with no prefix.
- **`description` is always sent** to the LLM via the schema, even when the tool is
  absent from "Available tools." Don't duplicate it verbatim as a `promptSnippet`
  unless you want it in both places.

---

## Sources

All paths are in the upstream `earendil-works/pi` monorepo (snapshot; line numbers
as of the DeepWiki run, will drift over time):

- `packages/coding-agent/src/core/extensions/types.ts` — `ToolDefinition`,
  `ExtensionContext`, `registerTool`, `ToolRenderContext`.
- `packages/coding-agent/src/core/system-prompt.ts` — `Available tools` filtering,
  `promptGuidelines` injection into Guidelines.
- `packages/coding-agent/src/core/agent-session.ts` — `setActiveToolsByName`,
  `_rebuildSystemPrompt`, `_refreshToolRegistry` (snippet/guideline map build).
- `packages/agent/src/agent-loop.ts` — `prepareToolCallArguments` →
  `validateToolArguments` ordering.
- `packages/coding-agent/src/core/tools/edit.ts` —
  `createEditToolDefinition` + `prepareEditArguments` (the legacy-arg shim).
- `packages/ai/src/providers/google-shared.ts` — `convertTools` (description →
  provider schema).
- `packages/coding-agent/docs/extensions.md` — narrative docs for all of the above.
- `packages/coding-agent/CHANGELOG.md` — 0.59.0 breaking change
  (`promptSnippet` no longer falls back to `description`).
- Tests: `test/extensions-runner.test.ts` (first-registration-wins),
  `test/system-prompt.test.ts` (omission when no snippet),
  `test/agent-session-dynamic-tools.test.ts` (tool stays callable when omitted
  from the list; `promptGuidelines` appear in prompt),
  `test/edit-tool-legacy-input.test.ts` (`prepareArguments` folding).
