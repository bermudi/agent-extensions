# Advanced: Sandbox Install, Mock Pi CLI, Platform Notes

## verifySandboxInstall()

Catches broken packages before publish — verifies `npm pack` → install → load works:

```typescript
import { verifySandboxInstall } from "@marcfargas/pi-test-harness";

const result = await verifySandboxInstall({
  packageDir: "./packages/my-extension",
  expect: {
    extensions: 1,
    tools: ["my_tool", "my_other_tool"],
    skills: 0,
  },
});

expect(result.loaded.extensionErrors).toEqual([]);
expect(result.loaded.tools).toContain("my_tool");
```

Optional smoke test inside the sandbox:

```typescript
const result = await verifySandboxInstall({
  packageDir: "./packages/my-extension",
  expect: { extensions: 1 },
  smoke: {
    mockTools: { bash: "ok", read: "contents", write: "written", edit: "edited" },
    script: [
      when("Test", [
        calls("my_tool", { value: "test" }),
        says("Works."),
      ]),
    ],
  },
});
```

## createMockPi()

For extensions that spawn `pi --mode json -p` as a subprocess. Puts a fake `pi` binary in PATH:

```typescript
import { createMockPi } from "@marcfargas/pi-test-harness";

const mockPi = createMockPi();
mockPi.install();  // creates temp dir with pi shim, prepends PATH

// Queue responses (consumed in order, last one repeats)
mockPi.onCall({ output: "Hello from agent", exitCode: 0 });
mockPi.onCall({ stderr: "agent crashed", exitCode: 1 });

// JSONL events
mockPi.onCall({
  jsonl: [
    { type: "tool_execution_start", toolName: "bash" },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
  ],
});

// Write files during execution
mockPi.onCall({
  output: "Result written",
  writeFiles: { "/tmp/output.md": "# Result\nDone." },
});

mockPi.reset();       // clear queue between tests
mockPi.uninstall();   // restore PATH, delete temp dir
```

### Response options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `output` | `string` | echo task | Text in `message_end` event |
| `exitCode` | `number` | `0` | Process exit code |
| `stderr` | `string` | — | Written to stderr |
| `delay` | `number` | `0` | Delay in ms before responding |
| `jsonl` | `object[]` | — | Raw JSONL events (replaces default `message_end`) |
| `writeFiles` | `Record<string, string>` | — | Files to create (path → content) |

Safety: PATH is restored on process exit even if `uninstall()` isn't called. Key validation catches typos. 30s timeout prevents hanging tests.

Designed for serial subprocess spawns within a single test.

## Playbook Diagnostics

The harness auto-asserts all playbook actions are consumed after `run()`. If not:

- **Exhausted early**: agent loop called `streamFn` but no actions remain — usually means a tool produced unexpected results causing additional calls.
- **Not fully consumed**: agent loop ended before all actions were used — usually means a tool was blocked or returned early.

## safeRmSync(filePath)

Removes a file, swallowing only `EPERM`/`EBUSY` errors. For `afterEach` cleanup of SQLite files on Windows:

```typescript
import { safeRmSync } from "@marcfargas/pi-test-harness";

afterEach(() => {
  t?.dispose();
  safeRmSync(dbPath);
  safeRmSync(dbPath + "-wal");
  safeRmSync(dbPath + "-shm");
});
```

Files are cleaned by the OS when the process exits. Use unique DB paths per test for isolation.

## Test Layer Summary

| Layer | What it mocks | Use when |
|-------|--------------|----------|
| `createTestSession` | LLM (`streamFn`) | Testing extension logic in-process |
| `verifySandboxInstall` | Nothing (real install) | Verifying npm package works |
| `createMockPi` | pi CLI binary | Testing subprocess-spawning extensions |
