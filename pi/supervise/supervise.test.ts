import { afterEach, describe, expect, test } from "bun:test";
import { createTestSession } from "@marcfargas/pi-test-harness";
import { resolve } from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const EXTENSION = resolve(import.meta.dirname, "./supervise.ts");

type TestSession = Awaited<ReturnType<typeof createTestSession>>;

function getToolDef(ts: TestSession, name: string) {
  const runner = ts.session.extensionRunner;
  if (!runner) throw new Error("No extensionRunner on session");
  return runner.getToolDefinition(name);
}

function makeTempDir(prefix = "supervise-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function mockTheme() {
  return {
    fg: (_key: string, text: string) => text,
    bold: (text: string) => `**${text}**`,
  } as any;
}

function createMockText() {
  let captured = "";
  return {
    setText: (text: string) => { captured = text; },
    getText: () => captured,
    invalidate: () => {},
  };
}

function mockRenderCtx(overrides: Record<string, unknown> = {}) {
  return {
    state: {},
    executionStarted: false,
    lastComponent: createMockText(),
    invalidate: () => {},
    ...overrides,
  } as any;
}

// ── Tool registration ─────────────────────────────────────────────────────

describe("supervise extension", () => {
  let ts: TestSession | undefined;

  afterEach(() => {
    ts?.dispose();
    ts = undefined;
  });

  test("registers the supervise tool", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "supervise");
    expect(toolDef).toBeDefined();
    expect(toolDef!.name).toBe("supervise");
    expect(toolDef!.label).toBe("Supervise");
    expect(toolDef!.description).toContain("turn-by-turn");
  });

  test("has all parameter groups", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "supervise");
    const schema = toolDef!.parameters as any;
    // Start mode
    expect(schema.properties.task).toBeDefined();
    expect(schema.properties.cwd).toBeDefined();
    expect(schema.properties.agent).toBeDefined();
    expect(schema.properties.model).toBeDefined();
    expect(schema.properties.skills).toBeDefined();
    expect(schema.properties.tools).toBeDefined();
    expect(schema.properties.thinking).toBeDefined();
    expect(schema.properties.systemPrompt).toBeDefined();
    // Continue mode
    expect(schema.properties.session).toBeDefined();
    expect(schema.properties.command).toBeDefined();
    expect(schema.properties.commandType).toBeDefined();
    // Inspect mode
    expect(schema.properties.inspect).toBeDefined();
    // Done mode
    expect(schema.properties.done).toBeDefined();
  });

  test("promptSnippet and promptGuidelines are set", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "supervise");
    expect(toolDef!.promptSnippet).toBeDefined();
    expect(toolDef!.promptSnippet).toContain("turn-by-turn");
    expect(toolDef!.promptGuidelines).toBeDefined();
    expect(toolDef!.promptGuidelines.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Execute: error cases ──────────────────────────────────────────────────

describe("supervise execute — error cases", () => {
  let ts: TestSession | undefined;

  afterEach(() => {
    ts?.dispose();
    ts = undefined;
  });

  test("first call without task returns guidance", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "supervise");

    const result = await toolDef!.execute(
      "tc-1", {},
      undefined, undefined,
      ts.session.extensionRunner as any,
    );

    expect(result.content[0].text).toContain("First call requires");
    expect(result.content[0].text).toContain("task");
  });

  test("inspect without session returns guidance", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "supervise");

    const result = await toolDef!.execute(
      "tc-inspect-no-session", { inspect: true },
      undefined, undefined,
      ts.session.extensionRunner as any,
    );

    expect(result.content[0].text).toContain("session");
  });

  test("inspect on unknown session returns not found", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "supervise");

    const result = await toolDef!.execute(
      "tc-2", { session: "nonexistent", inspect: true },
      undefined, undefined,
      ts.session.extensionRunner as any,
    );

    expect(result.content[0].text).toContain("not found");
  });

  test("done without session returns guidance", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "supervise");

    const result = await toolDef!.execute(
      "tc-done-no-session", { done: true },
      undefined, undefined,
      ts.session.extensionRunner as any,
    );

    expect(result.content[0].text).toContain("session");
  });

  test("done on unknown session is graceful", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "supervise");

    const result = await toolDef!.execute(
      "tc-3", { session: "nonexistent", done: true },
      undefined, undefined,
      ts.session.extensionRunner as any,
    );

    expect(result.content[0].text).toContain("not found");
  });

  test("command without session returns guidance", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "supervise");

    const result = await toolDef!.execute(
      "tc-4", { command: "do something" },
      undefined, undefined,
      ts.session.extensionRunner as any,
    );

    expect(result.content[0].text).toContain("First call requires");
  });

  test("start without systemPrompt or agent returns configuration error", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "supervise");

    const result = await toolDef!.execute(
      "tc-5", { task: "do something" },
      undefined, undefined,
      ts.session.extensionRunner as any,
    );

    // Either missing systemPrompt or missing model (test harness has no model)
    expect(result.content[0].text).toContain("Configuration error");
  });

  test("failed session is not stored and cannot be continued", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "supervise");

    // Start fails because no model
    const startResult = await toolDef!.execute(
      "tc-fail-start", { task: "hello", systemPrompt: "test" },
      undefined, undefined,
      ts.session.extensionRunner as any,
    );

    expect(startResult.content[0].text).toContain("Configuration error");
    const sid = (startResult.details as any).sessionId;
    expect(sid).toBeDefined();

    // Try to continue the failed session
    const continueResult = await toolDef!.execute(
      "tc-fail-continue", { session: sid, command: "try again" },
      undefined, undefined,
      ts.session.extensionRunner as any,
    );

    // Session was never stored, so it looks like "not found" / "first call"
    expect(continueResult.content[0].text).toMatch(/not found|First call requires/);
  });
});

// ── Renderers ─────────────────────────────────────────────────────────────

describe("supervise renderers", () => {
  let ts: TestSession | undefined;

  afterEach(() => {
    ts?.dispose();
    ts = undefined;
  });

  test("renderCall shows task for start mode", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "supervise");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const text = toolDef!.renderCall({ task: "ingest this source file" }, theme, ctx);
    expect((text as any).getText()).toContain("supervise");
    expect((text as any).getText()).toContain("ingest this source file");
  });

  test("renderCall shows session + command for continue mode", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "supervise");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const text = toolDef!.renderCall(
      { session: "abc-123", command: "go to Phase 2" },
      theme, ctx,
    );
    expect((text as any).getText()).toContain("abc-123");
    expect((text as any).getText()).toContain("go to Phase 2");
  });

  test("renderCall shows inspect label", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "supervise");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const text = toolDef!.renderCall(
      { session: "abc-123", inspect: true },
      theme, ctx,
    );
    expect((text as any).getText()).toContain("inspect");
    expect((text as any).getText()).toContain("abc-123");
  });

  test("renderCall shows done label", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "supervise");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const text = toolDef!.renderCall(
      { session: "abc-123", done: true },
      theme, ctx,
    );
    expect((text as any).getText()).toContain("done");
  });

  test("renderResult shows session ID and turn for waiting status", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "supervise");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const text = toolDef!.renderResult(
      {
        content: [{ type: "text", text: "" }],
        details: {
          sessionId: "supervise-1",
          turn: 2,
          status: "waiting",
          durationMs: 3500,
          tokens: 1200,
          toolCalls: [],
        },
      },
      { isPartial: false, expanded: false },
      theme, ctx,
    );
    const rendered = (text as any).getText();
    expect(rendered).toContain("supervise-1");
    expect(rendered).toContain("turn 2");
  });

  test("renderResult shows error icon for error status", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "supervise");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const text = toolDef!.renderResult(
      {
        content: [{ type: "text", text: "" }],
        details: {
          sessionId: "supervise-1",
          turn: 1,
          status: "error",
          durationMs: 1000,
          tokens: 500,
          toolCalls: [],
        },
      },
      { isPartial: false, expanded: false },
      theme, ctx,
    );
    expect((text as any).getText()).toContain("✗");
  });

  test("renderResult shows running state when partial", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "supervise");
    const theme = mockTheme();
    const ctx = mockRenderCtx({ turnStartedAt: Date.now() - 5000 });

    const text = toolDef!.renderResult(
      {
        content: [{ type: "text", text: "" }],
        details: {
          sessionId: "supervise-1",
          turn: 3,
          status: "running",
        },
      },
      { isPartial: true, expanded: false },
      theme, ctx,
    );
    const rendered = (text as any).getText();
    expect(rendered).toContain("running");
    expect(rendered).toContain("turn 3");
  });

  test("renderResult shows expanded text when expanded", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "supervise");
    const theme = mockTheme();
    const ctx = mockRenderCtx();

    const text = toolDef!.renderResult(
      {
        content: [{ type: "text", text: "" }],
        details: {
          sessionId: "supervise-1",
          turn: 1,
          status: "waiting",
          durationMs: 2000,
          tokens: 800,
          text: "I read the file and found 3 issues.",
          toolCalls: [{ id: "tc-1", name: "read", resultPreview: "file contents...", isError: false }],
        },
      },
      { isPartial: false, expanded: true },
      theme, ctx,
    );
    const rendered = (text as any).getText();
    expect(rendered).toContain("I read the file and found 3 issues.");
    expect(rendered).toContain("read");
  });
});

// ── Config resolution ─────────────────────────────────────────────────────

describe("supervise config resolution", () => {
  let ts: TestSession | undefined;
  let tmpDir: string;

  afterEach(() => {
    ts?.dispose();
    ts = undefined;
    if (tmpDir) cleanup(tmpDir);
  });

  test("start with unknown agent returns configuration error", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "supervise");

    const result = await toolDef!.execute(
      "tc-6",
      { task: "do work", agent: "nonexistent-agent-xyz", systemPrompt: "fallback" },
      undefined, undefined,
      ts.session.extensionRunner as any,
    );

    expect(result.content[0].text).toContain("Configuration error");
    expect(result.content[0].text).toContain("not found");
  });

  test("start with agent file resolves system prompt from file", async () => {
    tmpDir = makeTempDir();
    const agentsDir = path.join(tmpDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "tester.md"),
      `---
name: tester
description: Test agent
---
You are a test agent. Be concise.`,
    );

    ts = await createTestSession({
      extensions: [EXTENSION],
      cwd: tmpDir,
    });
    const toolDef = getToolDef(ts, "supervise");

    const result = await toolDef!.execute(
      "tc-7",
      { task: "hello", agent: "tester" },
      undefined, undefined,
      ts.session.extensionRunner as any,
    );

    // Agent file was found — no "not found" error. Will fail on model (no model in harness)
    // but the config resolution passed the agent lookup.
    expect(result.content[0].text).not.toContain("not found");
  });

  test("start with unknown tools does not crash", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "supervise");

    const result = await toolDef!.execute(
      "tc-8",
      { task: "do work", systemPrompt: "you are a helper", tools: ["read", "imaginary-tool"] },
      undefined, undefined,
      ts.session.extensionRunner as any,
    );

    // Config fails on model (no model in harness), not on unknown tools
    expect(result.content[0].text).toContain("Configuration error");
    expect(result.content[0].text).not.toContain("imaginary-tool");
  });

  test("start with skill that doesn't exist does not crash", async () => {
    ts = await createTestSession({ extensions: [EXTENSION] });
    const toolDef = getToolDef(ts, "supervise");

    const result = await toolDef!.execute(
      "tc-9",
      { task: "do work", systemPrompt: "you are a helper", skills: ["nonexistent-skill"] },
      undefined, undefined,
      ts.session.extensionRunner as any,
    );

    // Config fails on model (no model in harness), not on skill lookup
    expect(result.content[0].text).toContain("Configuration error");
    expect(result.content[0].text).not.toContain("nonexistent-skill");
  });

  test("start with skill injects skill content into system prompt", async () => {
    tmpDir = makeTempDir();
    const skillDir = path.join(tmpDir, ".agents", "skills", "test-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: test-skill\ndescription: A test skill\n---\nAlways say hello first.",
    );

    ts = await createTestSession({
      extensions: [EXTENSION],
      cwd: tmpDir,
    });
    const toolDef = getToolDef(ts, "supervise");

    const result = await toolDef!.execute(
      "tc-10",
      { task: "hello", systemPrompt: "You are a helper.", skills: ["test-skill"] },
      undefined, undefined,
      ts.session.extensionRunner as any,
    );

    // Skill was found — no warning about it. Will fail on model but config passed.
    expect(result.content[0].text).not.toContain("test-skill");
  });
});
