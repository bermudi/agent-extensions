import { describe, it, expect, afterEach } from "bun:test";
import {
  createTestSession,
  type TestSession,
} from "@marcfargas/pi-test-harness";
import { resolve } from "node:path";
import {
  resolveModel,
  extractOutput,
  fmtDuration,
  fmtTokens,
  trunc,
} from "./roundtable.ts";

const EXTENSION = resolve(import.meta.dirname, "./roundtable.ts");

const MOCKS = {
  bash: (p: Record<string, unknown>) => `mock: ${p.command}`,
  read: "mock contents",
};

describe("roundtable extension", () => {
  let t: TestSession;
  afterEach(() => t?.dispose());

  it("registers the roundtable tool", async () => {
    t = await createTestSession({
      extensions: [EXTENSION],
      mockTools: MOCKS,
    });

    const tools = t.session.getAllTools();
    const roundtableTool = tools.find((tool: { name: string }) => tool.name === "roundtable");
    expect(roundtableTool).toBeDefined();
    expect(roundtableTool.description).toContain("multi-project roundtable");
  });
});

// ── Pure helpers ────────────────────────────────────────────────────────

describe("fmtDuration", () => {
  it("formats milliseconds", () => expect(fmtDuration(500)).toBe("500ms"));
  it("formats seconds", () => expect(fmtDuration(2500)).toBe("2.5s"));
  it("formats minutes+seconds", () => expect(fmtDuration(125000)).toBe("2m5s"));
});

describe("fmtTokens", () => {
  it("formats small numbers", () => expect(fmtTokens(42)).toBe("42"));
  it("formats thousands", () => expect(fmtTokens(2500)).toBe("2.5k"));
  it("formats large thousands", () => expect(fmtTokens(25000)).toBe("25k"));
});

describe("trunc", () => {
  it("keeps short strings", () => expect(trunc("hi", 10)).toBe("hi"));
  it("truncates long strings", () => expect(trunc("hello world", 6)).toBe("hello…"));
});

describe("extractOutput", () => {
  it("extracts text from assistant messages", () => {
    const msgs = [
      { role: "assistant" as const, content: [{ type: "text" as const, text: "Hello" }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "World" }] },
    ];
    expect(extractOutput(msgs)).toBe("Hello\n\nWorld");
  });

  it("skips non-assistant messages", () => {
    const msgs = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "response" }] },
    ];
    expect(extractOutput(msgs)).toBe("response");
  });

  it("returns empty for no assistant messages", () => {
    expect(extractOutput([])).toBe("");
  });
});

describe("resolveModel", () => {
  it("returns parent model when no spec", () => {
    const mockModel = { provider: "test", id: "model-1" } as any;
    const mockRegistry = { getAvailable: () => [], find: () => undefined } as any;
    expect(resolveModel(undefined, mockRegistry, mockModel)).toBe(mockModel);
  });

  it("returns undefined when no parent and no spec match", () => {
    const mockRegistry = { getAvailable: () => [], find: () => undefined } as any;
    expect(resolveModel("nonexistent/model", mockRegistry, undefined)).toBeUndefined();
  });
});
