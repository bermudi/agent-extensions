import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  applyCheckpoint,
  assertCurationFits,
  buildTrajectoryUnits,
  buildTrajectoryUnitsFromMessages,
  formatToolResultWindow,
  formatUnit,
  formatUnitWindow,
  isKetamineCheckpoint,
  isOpenAiModel,
  materializePlan,
  validatePlan,
  type KetamineCheckpoint,
  type TrajectoryUnit,
} from "./core.ts";

function user(text: string, timestamp: number): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  };
}

const units: TrajectoryUnit[] = [
  { id: "turn:a", entryIds: ["a"], messages: [user("first", 1)] },
  { id: "turn:b", entryIds: ["b"], messages: [user("second", 2)] },
  { id: "turn:c", entryIds: ["c"], messages: [user("third", 3)] },
];

describe("curation plans", () => {
  test("require exhaustive chronological coverage", () => {
    expect(() =>
      validatePlan(
        {
          rationale: "bad order",
          decisions: [
            { action: "keep", unitIds: ["turn:b"] },
            { action: "drop", unitIds: ["turn:a", "turn:c"] },
          ],
        },
        units,
      ),
    ).toThrow("chronological order");
  });

  test("materialize exact keeps, summaries, and drops", () => {
    const plan = validatePlan(
      {
        rationale: "keep intent, compress work, drop noise",
        decisions: [
          { action: "keep", unitIds: ["turn:a"] },
          {
            action: "summarize",
            unitIds: ["turn:b"],
            summary: "Second turn, compressed.",
          },
          { action: "drop", unitIds: ["turn:c"] },
        ],
      },
      units,
    );

    const result = materializePlan(plan, units);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(user("first", 1));
    expect(result[1]?.role).toBe("custom");
    if (result[1]?.role === "custom") {
      expect(result[1].content).toEqual([
        { type: "text", text: "Second turn, compressed." },
      ]);
    }
  });
});

test("trajectory grouping keeps a tool call and result in one turn", () => {
  const usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const entries: SessionEntry[] = [
    {
      type: "message",
      id: "a",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: user("do it", 1),
    },
    {
      type: "message",
      id: "b",
      parentId: "a",
      timestamp: new Date(2).toISOString(),
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "read",
            arguments: { path: "x" },
          },
        ],
        api: "test",
        provider: "test",
        model: "test",
        usage,
        stopReason: "toolUse",
        timestamp: 2,
      },
    },
    {
      type: "message",
      id: "c",
      parentId: "b",
      timestamp: new Date(3).toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "contents" }],
        isError: false,
        timestamp: 3,
      },
    },
  ];

  const grouped = buildTrajectoryUnits(entries);
  expect(grouped).toHaveLength(1);
  expect(grouped[0]?.entryIds).toEqual(["a", "b", "c"]);
  expect(grouped[0]?.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "toolResult",
  ]);
});

test("effective-context regrouping cannot resurrect previously dropped text", () => {
  const effective = [user("kept", 1), user("new", 2)];
  const regrouped = buildTrajectoryUnitsFromMessages(effective);
  expect(JSON.stringify(regrouped)).not.toContain("dropped secret");
  expect(regrouped.flatMap((unit) => unit.messages)).toEqual(effective);
});

test("progressive disclosure omits tool bodies until explicitly requested", () => {
  const sentinel = "UNIQUE_TOOL_SENTINEL";
  const unit: TrajectoryUnit = {
    id: "turn:large",
    entryIds: ["large"],
    messages: [
      user("inspect only if reasoning says this matters", 1),
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: `${"x".repeat(3_000)}${sentinel}` }],
        isError: false,
        timestamp: 2,
      },
    ],
  };
  expect(formatUnit(unit)).not.toContain(sentinel);
  expect(formatUnit(unit)).toContain("Body omitted");
  expect(formatUnitWindow(unit, 0, 20_000).text).not.toContain(sentinel);
  expect(formatToolResultWindow(unit, 0, 2_900, 500).text).toContain(sentinel);
});

test("OpenAI-family models are excluded regardless of routing provider", () => {
  expect(isOpenAiModel("openai-codex", "gpt-5.6-sol")).toBeTrue();
  expect(isOpenAiModel("openrouter", "openai/gpt-5.4")).toBeTrue();
  expect(isOpenAiModel("opencode", "gpt-5.4-mini")).toBeTrue();
  expect(isOpenAiModel("openai-compatible", "llama-4")).toBeFalse();
  expect(isOpenAiModel("anthropic", "claude-opus-4-6")).toBeFalse();
  expect(isOpenAiModel("google", "gemini-3.1-pro")).toBeFalse();
});

test("curation budget rejects keep-all plans", () => {
  const plan = validatePlan(
    {
      rationale: "keep everything",
      decisions: [{ action: "keep", unitIds: units.map((unit) => unit.id) }],
    },
    units,
  );
  expect(() => assertCurationFits(plan, units, 1)).toThrow(
    "Summarize or drop more",
  );
});

test("malformed persisted checkpoint messages are rejected", () => {
  expect(
    isKetamineCheckpoint({
      strategy: "ketamine",
      version: 1,
      runId: "run",
      observerSessionDir: "/observer",
      plan: {
        rationale: "bad",
        decisions: [{ action: "keep", unitIds: ["turn:a"] }],
      },
      curatedMessages: [{ role: "user", timestamp: 1 }],
    }),
  ).toBeFalse();
});

test("checkpoint replacement preserves only post-checkpoint tail", () => {
  const checkpoint: KetamineCheckpoint = {
    strategy: "ketamine",
    version: 1,
    runId: "run",
    observerSessionDir: "/observer",
    plan: {
      rationale: "test",
      decisions: [{ action: "keep", unitIds: ["turn:a"] }],
    },
    curatedMessages: [user("curated", 10)],
  };
  const current: AgentMessage[] = [
    {
      role: "compactionSummary",
      summary: "carrier",
      tokensBefore: 100,
      timestamp: 20,
    },
    user("new work", 21),
  ];

  expect(applyCheckpoint(current, checkpoint, 20)).toEqual([
    user("curated", 10),
    user("new work", 21),
  ]);
});

test("missing carrier preserves Pi's fallback context instead of guessing", () => {
  const checkpoint: KetamineCheckpoint = {
    strategy: "ketamine",
    version: 1,
    runId: "run",
    observerSessionDir: "/observer",
    plan: {
      rationale: "test",
      decisions: [{ action: "keep", unitIds: ["turn:a"] }],
    },
    curatedMessages: [user("curated", 10)],
  };
  const current = [user("do not lose me", 20)];
  expect(applyCheckpoint(current, checkpoint, 20)).toEqual(current);
});
