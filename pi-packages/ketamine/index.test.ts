import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { KetamineCheckpoint } from "./core.ts";

let tempHome: string;
let originalHome: string | undefined;
let indexModule: typeof import("./index.ts");

function user(text: string, timestamp: number): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  };
}

beforeAll(async () => {
  originalHome = process.env.HOME;
  tempHome = await mkdtemp(join(tmpdir(), "ketamine-home-"));
  process.env.HOME = tempHome;
  indexModule = await import("./index.ts");
});

afterAll(async () => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  await rm(tempHome, { recursive: true, force: true });
});

describe("timeout and retention parsing", () => {
  test("invalid timeout values use the default", () => {
    const { parseKetamineTimeoutMs } = indexModule;
    expect(parseKetamineTimeoutMs(undefined)).toBe(600_000);
    expect(parseKetamineTimeoutMs("")).toBe(600_000);
    expect(parseKetamineTimeoutMs("0")).toBe(600_000);
    expect(parseKetamineTimeoutMs("-1")).toBe(600_000);
    expect(parseKetamineTimeoutMs("1.5")).toBe(600_000);
    expect(parseKetamineTimeoutMs("NaN")).toBe(600_000);
    expect(parseKetamineTimeoutMs("3600001")).toBe(600_000);
    expect(parseKetamineTimeoutMs("120000")).toBe(120_000);
    expect(parseKetamineTimeoutMs("3600000")).toBe(3_600_000);
  });

  test("invalid retention values use the default, high values clamp", () => {
    const { parseRunRetention } = indexModule;
    expect(parseRunRetention(undefined)).toBe(5);
    expect(parseRunRetention("")).toBe(5);
    expect(parseRunRetention("0")).toBe(5);
    expect(parseRunRetention("-1")).toBe(5);
    expect(parseRunRetention("1.5")).toBe(5);
    expect(parseRunRetention("NaN")).toBe(5);
    expect(parseRunRetention("2")).toBe(2);
    expect(parseRunRetention("100")).toBe(100);
    expect(parseRunRetention("200")).toBe(100);
  });
});

describe("run retention", () => {
  test("a live active-run marker is not pruned, while a stale/dead one can be", async () => {
    const { pruneRunDirectories, writeActiveMarker } = indexModule;
    const runsDir = join(tempHome, ".pi", "agent", "ketamine", "runs");
    await mkdir(runsDir, { recursive: true });

    const names = [
      "2026-08-11T00-00-00-000Z-00000001",
      "2026-08-11T00-00-00-000Z-00000002",
      "2026-08-11T00-00-00-000Z-00000003",
    ] as const;
    for (const name of names) {
      await mkdir(join(runsDir, name), { recursive: true });
    }

    // Oldest run has a live marker (this process).
    await writeActiveMarker(join(runsDir, names[0]!));
    // Middle run has a dead marker.
    await writeFile(
      join(runsDir, names[1]!, "active.lock"),
      JSON.stringify({ pid: 999_999 }),
      { mode: 0o600 },
    );

    await pruneRunDirectories(runsDir, 1);

    const remaining = await readdir(runsDir);
    expect(remaining).toContain(names[0]);
    expect(remaining).toContain(names[2]);
    expect(remaining).not.toContain(names[1]);
  });
});

describe("session compact cleanup", () => {
  function makeFakePi() {
    const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> =
      {};
    return {
      handlers,
      on: (
        event: string,
        handler: (event: unknown, ctx: unknown) => unknown,
      ) => {
        handlers[event] = handler;
      },
      appendEntry: () => {},
    };
  }

  function makeFakeContext(sessionId: string) {
    const notifications: { message: string; level?: string }[] = [];
    return {
      sessionId,
      notifications,
      ctx: {
        cwd: tempHome,
        model: {
          provider: "anthropic",
          id: "claude-sonnet-4-6",
          contextWindow: 100_000,
        },
        thinkingLevel: undefined,
        sessionManager: {
          getSessionId: () => sessionId,
          getSessionFile: () => join(tempHome, "session.json"),
          getLeafId: () => "boundary-1",
          getBranch: () => [],
        },
        ui: {
          notify: (message: string, level?: string) => {
            notifications.push({ message, level });
          },
          setStatus: () => {},
        },
      },
    };
  }

  test("cleanup is performed from the post-commit session_compact path", async () => {
    const { default: ketamineExtension, getRunDirectory } = indexModule;
    const fakePi = makeFakePi();
    const { ctx, notifications } = makeFakeContext("test-cleanup");
    ketamineExtension(fakePi as never);

    const runId = "2026-08-11T00-00-00-000Z-cleanup01";
    const runDir = getRunDirectory(
      join(tempHome, ".pi", "agent", "ketamine", "runs"),
      runId,
    );
    if (!runDir) throw new Error("test run directory is unsafe");
    await mkdir(runDir, { recursive: true });
    const snapshotPath = join(runDir, "trajectory.json");
    await writeFile(snapshotPath, "{}", { mode: 0o600 });

    const checkpoint = {
      strategy: "ketamine" as const,
      version: 1 as const,
      runId,
      observerSessionDir: join(runDir, "observer-session"),
      plan: {
        rationale: "test",
        decisions: [{ action: "keep" as const, unitIds: ["turn:a"] }],
      },
      curatedMessages: [user("kept", 1)],
    };

    await fakePi.handlers["session_compact"]!(
      {
        type: "session_compact",
        compactionEntry: { details: checkpoint },
        fromExtension: true,
        reason: "threshold",
        willRetry: false,
      },
      ctx,
    );

    expect(existsSync(snapshotPath)).toBeFalse();
    expect(notifications.some((n) => n.message.includes(runId))).toBeTrue();
  });

  test("session_before_compact returns before cleanup and session_compact removes the snapshot", async () => {
    const { default: ketamineExtension } = indexModule;
    const fakePi = makeFakePi();
    const { ctx } = makeFakeContext("test-before-compact");
    ketamineExtension(fakePi as never);

    const script = join(tempHome, "fake-observer.sh");
    const planLine = JSON.stringify({
      type: "tool_execution_end",
      toolName: "ketamine_submit",
      isError: false,
      result: {
        details: {
          rationale: "test",
          decisions: [
            {
              action: "summarize",
              unitIds: ["turn:a"],
              summary: "k",
            },
          ],
        },
      },
    });
    await writeFile(
      script,
      `#!/usr/bin/env sh\nprintf '%s\\n' '${planLine}'\n`,
    );
    await chmod(script, 0o755);

    const originalCommand = process.env.KETAMINE_PI_COMMAND;
    process.env.KETAMINE_RUN_RETENTION = "10";
    process.env.KETAMINE_PI_COMMAND = script;

    const branchEntries: SessionEntry[] = [
      {
        type: "message",
        id: "a",
        parentId: null,
        timestamp: new Date(1).toISOString(),
        message: user("x".repeat(1_000), 1),
      },
    ];

    const event = {
      type: "session_before_compact",
      preparation: {
        tokensBefore: 1_000,
        settings: { reserveTokens: 0 },
      },
      branchEntries,
      customInstructions: undefined,
      reason: "threshold" as const,
      willRetry: false,
      signal: new AbortController().signal,
    };

    try {
      const result = (await fakePi.handlers["session_before_compact"]!(
        event,
        ctx,
      )) as { compaction: { details: KetamineCheckpoint } };
      expect(result?.compaction).toBeDefined();
      const checkpoint = result.compaction.details;

      const runDir = join(
        tempHome,
        ".pi",
        "agent",
        "ketamine",
        "runs",
        checkpoint.runId,
      );
      const snapshotPath = join(runDir, "trajectory.json");
      const markerPath = join(runDir, "active.lock");

      // The snapshot must still exist after session_before_compact returns.
      expect(existsSync(snapshotPath)).toBeTrue();
      expect(existsSync(markerPath)).toBeFalse();

      await fakePi.handlers["session_compact"]!(
        {
          type: "session_compact",
          compactionEntry: { details: checkpoint },
          fromExtension: true,
          reason: "threshold",
          willRetry: false,
        },
        ctx,
      );

      expect(existsSync(snapshotPath)).toBeFalse();
    } finally {
      process.env.KETAMINE_PI_COMMAND = originalCommand;
      delete process.env.KETAMINE_RUN_RETENTION;
    }
  }, 15_000);
});
