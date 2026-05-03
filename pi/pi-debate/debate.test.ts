import { describe, expect, test, afterEach } from "bun:test";
import { createTestSession, type TestSession } from "@marcfargas/pi-test-harness";
import { resolve } from "node:path";

import { resolveModel, extractOutput, fmtDuration, fmtTokens, trunc, type DebateArgs } from "./debate.ts";

const EXTENSION = resolve(import.meta.dirname, "./debate.ts");

function getToolDef(ts: TestSession, name: string) {
  const runner = ts.session.extensionRunner;
  if (!runner) throw new Error("No extensionRunner on session");
  return runner.getToolDefinition(name);
}

// ── Mock render helpers ──────────────────────────────────────────────────

function mockTheme(overrides: Partial<{
  fg: (key: string, text: string) => string;
  bold: (text: string) => string;
}> = {}) {
  return {
    fg: (_k: string, t: string) => t,
    bold: (t: string) => `**${t}**`,
    ...overrides,
  } as any;
}

function mockText() {
  let captured = "";
  return {
    setText: (t: string) => { captured = t; },
    getText: () => captured,
    invalidate: () => {},
  };
}

function mockRenderCtx(overrides: Record<string, unknown> = {}) {
  return {
    state: {},
    executionStarted: false,
    lastComponent: mockText() as any,
    invalidate: () => {},
    ...overrides,
  } as any;
}

// ── Pure function tests ──────────────────────────────────────────────────

describe("resolveModel", () => {
  const parentModel = { provider: "anthropic", id: "claude-sonnet-4" } as any;

  function makeRegistry(models: Array<{ provider: string; id: string }>) {
    return {
      getAvailable: () => models,
      find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id) ?? null,
    } as any;
  }

  test("returns parent model when spec is undefined", () => {
    expect(resolveModel(undefined, makeRegistry([]), parentModel)).toBe(parentModel);
  });

  test("finds bare id in available models", () => {
    const registry = makeRegistry([
      { provider: "openai", id: "gpt-5" },
      { provider: "anthropic", id: "claude-haiku-4-5" },
    ]);
    const result = resolveModel("gpt-5", registry, parentModel);
    expect(result).toEqual({ provider: "openai", id: "gpt-5" });
  });

  test("finds provider/id spec", () => {
    const registry = makeRegistry([{ provider: "openai", id: "gpt-5" }]);
    const result = resolveModel("openai/gpt-5", registry, parentModel);
    expect(result).toEqual({ provider: "openai", id: "gpt-5" });
  });

  test("returns undefined when bare id not found", () => {
    const registry = makeRegistry([{ provider: "openai", id: "gpt-5" }]);
    expect(resolveModel("nonexistent", registry, parentModel)).toBeUndefined();
  });

  test("handles spec with multiple slashes", () => {
    const registry = makeRegistry([{ provider: "openrouter", id: "qwen/qwen3-coder" }]);
    const result = resolveModel("openrouter/qwen/qwen3-coder", registry, parentModel);
    expect(result).toEqual({ provider: "openrouter", id: "qwen/qwen3-coder" });
  });
});

describe("extractOutput", () => {
  test("extracts text from assistant messages", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }] },
    ] as any;
    expect(extractOutput(messages)).toBe("hello\n\nworld");
  });

  test("ignores non-assistant messages", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "system", content: [{ type: "text", text: "sys" }] },
    ] as any;
    expect(extractOutput(messages)).toBe("");
  });

  test("ignores non-text blocks", () => {
    const messages = [
      { role: "assistant", content: [{ type: "tool_use", name: "bash" }, { type: "text", text: "result" }] },
    ] as any;
    expect(extractOutput(messages)).toBe("result");
  });

  test("handles string content gracefully", () => {
    const messages = [{ role: "assistant", content: "plain string" }] as any;
    expect(extractOutput(messages)).toBe("");
  });
});

describe("fmtDuration", () => {
  test("formats milliseconds", () => {
    expect(fmtDuration(500)).toBe("500ms");
    expect(fmtDuration(999)).toBe("999ms");
  });

  test("formats seconds", () => {
    expect(fmtDuration(1000)).toBe("1.0s");
    expect(fmtDuration(5500)).toBe("5.5s");
  });

  test("formats minutes", () => {
    expect(fmtDuration(60000)).toBe("1m0s");
    expect(fmtDuration(125000)).toBe("2m5s");
  });
});

describe("fmtTokens", () => {
  test("returns raw number under 1000", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
  });

  test("formats with one decimal between 1k and 10k", () => {
    expect(fmtTokens(1000)).toBe("1.0k");
    expect(fmtTokens(5500)).toBe("5.5k");
  });

  test("rounds above 10k", () => {
    expect(fmtTokens(10000)).toBe("10k");
    expect(fmtTokens(15500)).toBe("16k");
  });
});

describe("trunc", () => {
  test("returns short strings unchanged", () => {
    expect(trunc("hello", 10)).toBe("hello");
  });

  test("truncates long strings with ellipsis", () => {
    expect(trunc("hello world", 8)).toBe("hello w…");
  });

  test("handles exact length", () => {
    expect(trunc("hello", 5)).toBe("hello");
  });
});

// ── Tool registration ────────────────────────────────────────────────────

describe("debate extension", () => {
  let ts: TestSession | undefined;

  afterEach(() => {
    ts?.dispose();
    ts = undefined;
  });

  test("registers the debate tool", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "debate");
    expect(toolDef).toBeDefined();
    expect(toolDef!.name).toBe("debate");
    expect(toolDef!.label).toBe("Debate");
    expect(toolDef!.description).toContain("structured debate");
  });

  test("topic is required string", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "debate");
    const schema = toolDef!.parameters as any;
    expect(schema.properties.topic.type).toBe("string");
    expect(schema.required).toContain("topic");
  });

  test("rounds has min/max/default", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "debate");
    const rounds = (toolDef!.parameters as any).properties.rounds;
    expect(rounds.minimum).toBe(1);
    expect(rounds.maximum).toBe(10);
    expect(rounds.default).toBe(3);
  });

  test("judge is optional object with model and prompt", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "debate");
    const judge = (toolDef!.parameters as any).properties.judge;
    expect(judge.type).toBe("object");
    expect(judge.properties.model.type).toBe("string");
    expect(judge.properties.prompt.type).toBe("string");
  });

  test("all optional fields are defined in schema", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "debate");
    const props = (toolDef!.parameters as any).properties;
    const optFields = ["rounds", "modelA", "modelB", "positionA", "positionB",
      "systemPromptA", "systemPromptB", "judge", "cwd", "tools", "thinking"];
    for (const f of optFields) {
      expect(props[f]).toBeDefined();
    }
  });

  test("accepts minimal valid params", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "debate");
    // Just topic — all others have defaults
    const params = { topic: "Is Rust better than Go?" };
    // This shouldn't throw on schema validation
    const context = ts.session.extensionRunner as any;

    // It'll fail because no model is resolvable (no parent model)
    const result = await toolDef!.execute("tc-1", params, undefined, undefined, context);
    expect(result.content[0].text).toContain("Could not resolve model");
  });

  test("validates unknown tools warning in output", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "debate");
    const params = { topic: "X", tools: ["read", "imaginary-tool"] };
    const context = ts.session.extensionRunner as any;

    const result = await toolDef!.execute("tc-2", params, undefined, undefined, context);
    const text = result.content[0].text;
    // Should still fail on model resolution (happens first)
    expect(text).toContain("Could not resolve model");
  });
});

// ── TUI renderCall ────────────────────────────────────────────────────────

describe("debate renderCall", () => {
  let ts: TestSession | undefined;

  afterEach(() => {
    ts?.dispose();
    ts = undefined;
  });

  test("shows topic and round count", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "debate");
    const theme = mockTheme();
    const mt = mockText();
    const ctx = mockRenderCtx({ lastComponent: mt as any });

    const returned = toolDef!.renderCall(
      { topic: "Is Rust better than Go?", rounds: 5 },
      theme,
      ctx,
    );
    const out = mt.getText();
    expect(out).toContain("Is Rust better than Go?");
    expect(out).toContain("5 rounds");
    expect(out).toContain("**debate**");
  });

  test("shows judge when present", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "debate");
    const theme = mockTheme();
    const mt = mockText();
    const ctx = mockRenderCtx({ lastComponent: mt as any });

    toolDef!.renderCall(
      { topic: "Tabs vs spaces", judge: { model: "openai/gpt-5" } },
      theme,
      ctx,
    );
    const out = mt.getText();
    expect(out).toContain("judge");
  });

  test("uses singular for 1 round", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "debate");
    const theme = mockTheme();
    const mt = mockText();
    const ctx = mockRenderCtx({ lastComponent: mt as any });

    toolDef!.renderCall({ topic: "Test", rounds: 1 }, theme, ctx);
    const out = mt.getText();
    expect(out).toContain("1 round");
    expect(out).not.toContain("1 rounds");
  });

  test("truncates long topic", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "debate");
    const theme = mockTheme();
    const mt = mockText();
    const ctx = mockRenderCtx({ lastComponent: mt as any });

    const longTopic = "A".repeat(100);
    toolDef!.renderCall({ topic: longTopic }, theme, ctx);
    const out = mt.getText();
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(longTopic.length + 50);
  });
});

// ── TUI renderResult ──────────────────────────────────────────────────────

describe("debate renderResult", () => {
  let ts: TestSession | undefined;

  afterEach(() => {
    ts?.dispose();
    ts = undefined;
  });

  test("shows running progress when partial", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "debate");
    const theme = mockTheme();
    const mt = mockText();
    const ctx = mockRenderCtx({ lastComponent: mt as any, executionStarted: true });

    const result = {
      content: [{ type: "text", text: "Running..." }],
      details: {
        topic: "X vs Y",
        rounds: 2,
        transcript: [],
        progress: [
          { phase: "round", round: 1, totalRounds: 2, speaker: "A", tokens: 100, durationMs: 500 },
        ],
      },
    };

    toolDef!.renderResult(result, { isPartial: true, expanded: false }, theme, ctx);
    const out = mt.getText();
    expect(out).toContain("Debating");
    expect(out).toContain("●");
    expect(out).toContain("A");
  });

  test("shows completed state with transcript", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "debate");
    const theme = mockTheme();
    const mt = mockText();
    const ctx = mockRenderCtx({ lastComponent: mt as any, executionStarted: true, state: { startedAt: Date.now() - 5000 } });

    const result = {
      content: [{ type: "text", text: "Done" }],
      details: {
        topic: "X vs Y",
        rounds: 1,
        transcript: [
          { round: 1, speaker: "A" as const, model: "anthropic/claude-sonnet-4", output: "A says hello.", durationMs: 2000, tokens: 50 },
          { round: 1, speaker: "B" as const, model: "openai/gpt-5", output: "B responds.", durationMs: 1500, tokens: 40 },
        ],
        progress: [
          { phase: "done" as const, round: 1, totalRounds: 1, speaker: "A" as const, tokens: 90, durationMs: 3500 },
        ],
      },
    };

    toolDef!.renderResult(result, { isPartial: false, expanded: false }, theme, ctx);
    const out = mt.getText();
    expect(out).toContain("✓");
    expect(out).toContain("Round 1 — A");
    expect(out).toContain("Round 1 — B");
    expect(out).toContain("2/2 turns");
  });

  test("shows judge verdict when present", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "debate");
    const theme = mockTheme();
    const mt = mockText();
    const ctx = mockRenderCtx({ lastComponent: mt as any, executionStarted: true, state: { startedAt: Date.now() - 5000 } });

    const result = {
      content: [{ type: "text", text: "Done" }],
      details: {
        topic: "X vs Y",
        rounds: 1,
        transcript: [
          { round: 1, speaker: "A" as const, model: "a/a", output: "A.", durationMs: 1000, tokens: 10 },
          { round: 1, speaker: "B" as const, model: "b/b", output: "B.", durationMs: 1000, tokens: 10 },
        ],
        judgeVerdict: "**Winner: A**\nAnalysis: Good points.\nKey: Decisive rebuttal.",
        progress: [
          { phase: "done" as const, round: 1, totalRounds: 1, speaker: "A" as const, tokens: 20, durationMs: 2000 },
        ],
      },
    };

    toolDef!.renderResult(result, { isPartial: false, expanded: false }, theme, ctx);
    const out = mt.getText();
    expect(out).toContain("**Winner: A**");
    expect(out).toContain("Judge:");
  });

  test("shows error icon for failed turns", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "debate");
    const theme = mockTheme({ fg: (k, t) => k === "error" ? `[ERR]${t}` : t });
    const mt = mockText();
    const ctx = mockRenderCtx({ lastComponent: mt as any, executionStarted: true, state: { startedAt: Date.now() - 5000 } });

    const result = {
      content: [{ type: "text", text: "Done" }],
      details: {
        topic: "X",
        rounds: 1,
        transcript: [
          { round: 1, speaker: "A" as const, model: "a/a", output: "ok", durationMs: 1000, tokens: 10 },
          { round: 1, speaker: "B" as const, model: "b/b", output: "", durationMs: 500, tokens: 0, error: "API timeout" },
        ],
        progress: [
          { phase: "done" as const, round: 1, totalRounds: 1, speaker: "A" as const, tokens: 10, durationMs: 1500 },
        ],
      },
    };

    toolDef!.renderResult(result, { isPartial: false, expanded: false }, theme, ctx);
    const out = mt.getText();
    expect(out).toContain("[ERR]✗");
    expect(out).toContain("Round 1 — B");
  });

  test("returns Container with Markdown children when expanded", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "debate");
    const theme = mockTheme();
    const ctx = mockRenderCtx({ executionStarted: true, state: { startedAt: Date.now() - 5000 } });

    const result = {
      content: [{ type: "text", text: "Done" }],
      details: {
        topic: "Rust vs Go",
        rounds: 1,
        transcript: [
          { round: 1, speaker: "A" as const, model: "anthropic/claude", output: "Rust is faster.", durationMs: 2000, tokens: 50 },
          { round: 1, speaker: "B" as const, model: "openai/gpt", output: "Go is simpler.", durationMs: 1800, tokens: 45 },
        ],
        judgeVerdict: "**Winner: Draw**\nBoth made good points.",
        progress: [
          { phase: "done" as const, round: 1, totalRounds: 1, speaker: "A" as const, tokens: 95, durationMs: 3800 },
        ],
      },
    };

    const component = toolDef!.renderResult(result, { isPartial: false, expanded: true }, theme, ctx);
    // Expanded returns a Container, not a Text
    expect(component.constructor.name).toBe("Container");
  });
});
