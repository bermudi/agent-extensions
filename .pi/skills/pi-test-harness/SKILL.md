---
name: pi-test-harness
description: Test pi extensions with @marcfargas/pi-test-harness. Use when writing tests for pi extensions, testing tool registration, hook behavior, plan mode blocking, or subprocess spawning. Triggers on "test my extension", "write a test for this extension", "how to test pi extensions", "extension test", "pi-test-harness", "createTestSession", "mockTools", "playbook DSL".
compatibility: Requires @marcfargas/pi-test-harness, @mariozechner/pi-coding-agent >= 0.50.0, @mariozechner/pi-ai, @mariozechner/pi-agent-core
---

# pi-test-harness

In-process test harness for pi extensions — real pi runtime, fake LLM. Write tests in ~10 lines that exercise real code paths with zero LLM calls.

## Philosophy

**Let pi be pi.** Extensions load through pi's real loader. Tools go through pi's real wrapping pipeline. Hooks fire through pi's real ExtensionRunner. Only the LLM boundary (`streamFn`) is replaced by a playbook.

## Setup

```bash
npm install --save-dev @marcfargas/pi-test-harness
```

Peer deps: `@mariozechner/pi-coding-agent >= 0.50.0`, `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`

## Core API

### createTestSession(options?)

Creates a test session with a real pi environment. Returns `Promise<TestSession>`.

```typescript
import { createTestSession, when, calls, says, type TestSession } from "@marcfargas/pi-test-harness";
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `extensions` | `string[]` | `[]` | Extension file paths to load |
| `extensionFactories` | `Function[]` | `[]` | Inline extension factory functions |
| `cwd` | `string` | auto temp dir | Working directory (cleaned on dispose if auto) |
| `systemPrompt` | `string` | — | Override the system prompt |
| `mockTools` | `Record<string, MockToolHandler>` | — | Tool execution interceptors |
| `mockUI` | `MockUIConfig` | defaults | UI mock configuration |
| `propagateErrors` | `boolean` | `true` | Abort test on real tool throw |

### TestSession

| Property/Method | Description |
|----------------|-------------|
| `run(...turns)` | Run the conversation script |
| `session` | The real pi AgentSession underneath |
| `cwd` | Working directory |
| `events` | All collected events (see Event Collection) |
| `playbook` | `{ consumed, remaining }` state |
| `dispose()` | Cleanup temp dir and session |

## Playbook DSL

The playbook replaces the LLM. Actions are consumed in order.

### when(prompt, actions) — single turn

```typescript
when("List files in the project", [
  calls("bash", { command: "ls" }),
  says("Found 2 files."),
])
```

### calls(tool, params) — model calls a tool

```typescript
calls("bash", { command: "ls -la" })
calls("plan_mode", { enable: true })
```

### says(text) — model emits text, ends turn

```typescript
says("All done.")
```

### Multi-turn conversations

Pass multiple `when()` turns to `run()`:

```typescript
await t.run(
  when("What files are here?", [
    calls("bash", { command: "ls" }),
    says("Found 3 files."),
  ]),
  when("Read the README", [
    calls("read", { path: "README.md" }),
    says("Here's what it says..."),
  ]),
);
```

### Late-bound params with .then()

Capture output from one call and feed it to the next:

```typescript
let planId = "";

await t.run(
  when("Create and approve a plan", [
    calls("plan_propose", { title: "Deploy" }).then((result) => {
      planId = result.text.match(/PLAN-[a-f0-9]+/)![0];
    }),
    calls("plan_approve", () => ({ id: planId })),
    says("Plan approved."),
  ]),
);
```

## Mock Tools

Intercepts `tool.execute()` for specific tools. Hooks (`tool_call`, `tool_result`) still fire for mocked tools — so hook-based logic like plan mode blocking works correctly.

```typescript
mockTools: {
  // Static string
  bash: "file1.txt\nfile2.txt",

  // Dynamic function
  read: (params) => `contents of ${params.path}`,

  // Full ToolResult
  write: {
    content: [{ type: "text", text: "Written" }],
    details: { bytesWritten: 42 },
  },
},
```

**Extension-registered tools execute for real** unless they appear in `mockTools`.

## Mock UI

Extensions that call `ctx.ui.confirm()`, `ctx.ui.select()`, etc. get mock responses.

```typescript
mockUI: {
  confirm: false,                    // deny all
  select: 0,                         // pick first
  input: "user input text",          // fixed string
  editor: "edited content",          // fixed string
},
```

Dynamic handlers:

```typescript
mockUI: {
  confirm: (title, _msg) => !title.includes("Delete"),
  select: (_title, items) => items.find(i => i.includes("staging")),
},
```

Defaults (when omitted): `confirm → true`, `select → first item`, `input → ""`, `editor → ""`.

## Event Collection

Every session event is recorded for assertions:

```typescript
// Tool events
t.events.toolCallsFor("bash")        // ToolCallRecord[]
t.events.toolResultsFor("bash")      // ToolResultRecord[]
t.events.blockedCalls()              // tools blocked by hooks

// UI events
t.events.uiCallsFor("confirm")       // UICallRecord[]
t.events.uiCallsFor("notify")        // UICallRecord[]

// Messages and raw events
t.events.messages                    // AgentMessage[]
t.events.all                         // AgentSessionEvent[]
```

### ToolResultRecord shape

```typescript
interface ToolResultRecord {
  step: number;
  toolName: string;
  toolCallId: string;
  text: string;
  content: Array<{ type: string; text?: string }>;
  isError: boolean;
  mocked: boolean;    // true if mockTools handled it
}
```

## Error Propagation

By default (`propagateErrors: true`), real tool errors abort the test with a diagnostic pointing to the exact playbook step. Set `propagateErrors: false` to capture errors as `isError: true` results instead.

`ToolBlockedError` is thrown (and exported) when an extension hook blocks a mocked tool call. Use `instanceof` to distinguish from real errors:

```typescript
import { ToolBlockedError } from "@marcfargas/pi-test-harness";
try {
  await t.run(when("Try delete", [calls("bash", { command: "rm -rf /" }), says("Done.")]));
} catch (err) {
  if (err instanceof ToolBlockedError) { /* expected */ }
  else throw err;
}
```

## Test Template

Use this as a starting point for extension tests:

```typescript
import { describe, it, expect, afterEach } from "bun:test";
import {
  createTestSession,
  when, calls, says,
  type TestSession,
} from "@marcfargas/pi-test-harness";
import { resolve } from "node:path";

const EXTENSION = resolve(import.meta.dirname, "./index.ts");
const MOCKS = {
  bash: (p: Record<string, unknown>) => `mock: ${p.command}`,
  read: "mock contents",
  write: "mock written",
  edit: "mock edited",
};

describe("my-extension", () => {
  let t: TestSession;
  afterEach(() => t?.dispose());

  it("does something", async () => {
    t = await createTestSession({
      extensions: [EXTENSION],
      mockTools: MOCKS,
    });

    await t.run(
      when("Do the thing", [
        calls("my_tool", { value: "test" }),
        says("Done."),
      ]),
    );

    expect(t.events.toolResultsFor("my_tool")).toHaveLength(1);
  });
});
```

## Additional APIs

Read `references/advanced.md` for:
- `verifySandboxInstall()` — catch broken packages before publish
- `createMockPi()` — mock the pi CLI binary for subprocess-spawning extensions
- `safeRmSync()` — safe file cleanup for Windows SQLite locks
- Playbook diagnostics (auto-asserts all actions consumed)
- Platform notes (Windows + SQLite EPERM workarounds)
