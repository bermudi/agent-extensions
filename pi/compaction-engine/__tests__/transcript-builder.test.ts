import { describe, expect, it } from "bun:test";
import {
  buildTranscript,
  computeCharBudget,
  formatTurn,
  indentBullet,
  CHARS_PER_TOKEN,
} from "../transcript-builder";
import type { Turn } from "../turn-grouper";
import { createTurn, finalizeTurn } from "../turn-grouper";

// ── helpers ───────────────────────────────────────────────────────────

function makeTurn(label: string, request: string, extras?: Partial<Turn>): Turn {
  const base = createTurn(label, request);
  if (extras?.reasoning) base.reasoning = extras.reasoning;
  if (extras?.responses) base.responses = extras.responses;
  if (extras?.evidence) base.evidence = extras.evidence;
  return finalizeTurn(base, 1);
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("computeCharBudget", () => {
  it("computes budget for known values", () => {
    // contextWindow=128000, maxOutputTokens=16384, systemPrompt=1000 chars
    const systemPrompt = "x".repeat(1000);
    const budget = computeCharBudget(128_000, 16384, systemPrompt);

    // systemPromptTokens = ceil(1000/3.5) = 286
    // availableTokens = 128000 - 16384 - 286 = 111330
    // chars = floor(111330 * 3.5) = 389655
    expect(budget).toBe(389_655);
  });

  it("defaults to 128k context when undefined", () => {
    const budget = computeCharBudget(undefined, 16384, "");
    // systemPromptTokens = 0
    // availableTokens = 128000 - 16384 = 111616
    // chars = floor(111616 * 3.5) = 390656
    expect(budget).toBe(390_656);
  });

  it("respects CHARS_PER_TOKEN constant", () => {
    expect(CHARS_PER_TOKEN).toBe(3.5);
  });

  it("gives smaller budget with larger system prompt", () => {
    const small = computeCharBudget(128_000, 16384, "short");
    const large = computeCharBudget(128_000, 16384, "x".repeat(10_000));
    expect(large).toBeLessThan(small);
  });
});

describe("buildTranscript", () => {
  it("returns all turns when they fit within budget", () => {
    const turns = [
      makeTurn("Turn 1", "First request", { responses: ["First response"] }),
      makeTurn("Turn 2", "Second request", { responses: ["Second response"] }),
    ];

    const result = buildTranscript(turns, 10_000);
    expect(result).toContain("Turn 1");
    expect(result).toContain("First request");
    expect(result).toContain("Turn 2");
    expect(result).toContain("Second request");
  });

  it("drops middle turns when transcript exceeds budget", () => {
    const turns: Turn[] = [];
    for (let i = 1; i <= 10; i++) {
      turns.push(makeTurn(`Turn ${i}`, `Request ${i}`, {
        responses: [`Response ${i} with enough text to make this turn a decent size.`],
      }));
    }

    // Format all turns and find a budget that's tight enough to drop some
    const fullLength = turns.map(formatTurn).join("\n\n").length;

    // Use budget = ~40% of full length — should keep first + some last turns
    const budget = Math.floor(fullLength * 0.4);
    const result = buildTranscript(turns, budget);

    // Should contain first turn
    expect(result).toContain("### Turn 1");
    // Should contain gap marker
    expect(result).toContain("earlier turns omitted");
    // Should contain at least the last turn
    expect(result).toContain("### Turn 10");
    // Should NOT contain middle turns (e.g. turn 5)
    expect(result).not.toContain("Request 5");
  });

  it("preserves first and last turns preferentially", () => {
    // Build turns where middle ones are large enough to overflow
    const raw = [
      createTurn("Context", "Context request"),
      createTurn("Turn", "Middle A"),
      createTurn("Turn", "Middle B"),
      createTurn("Turn", "Last request"),
    ];
    // Add padding to middle turns so they can't fit
    raw[1].responses = ["x".repeat(500)];
    raw[2].responses = ["y".repeat(500)];
    const turns = raw.map((t, i) => finalizeTurn(t, i + 1));

    // Budget that only fits first + last
    const firstFormatted = formatTurn(turns[0]);
    const lastFormatted = formatTurn(turns[3]);
    const budget = firstFormatted.length + lastFormatted.length + 100;

    const result = buildTranscript(turns, budget);
    expect(result).toContain("Context request");
    expect(result).toContain("Last request");
    expect(result).toContain("2 earlier turns omitted");
  });

  it("handles empty turns array", () => {
    const result = buildTranscript([], 10_000);
    expect(result).toBe("");
  });

  it("handles single turn", () => {
    const turns = [makeTurn("Turn 1", "Only turn")];
    const result = buildTranscript(turns, 10_000);
    expect(result).toContain("### Turn 1");
    expect(result).toContain("Only turn");
  });
});

describe("formatTurn", () => {
  it("formats a turn with all sections", () => {
    const turn: Turn = {
      label: "Turn 1",
      request: "Fix the auth bug",
      reasoning: ["The bug is in token validation"],
      responses: ["Updated the validation logic"],
      evidence: ["edit succeeded on src/auth.ts"],
      toolCalls: new Map(),
    };

    const result = formatTurn(turn);

    expect(result).toContain("### Turn 1");
    expect(result).toContain("Request: Fix the auth bug");
    expect(result).toContain("Reasoning:");
    expect(result).toContain("The bug is in token validation");
    expect(result).toContain("Stated conclusions:");
    expect(result).toContain("Updated the validation logic");
    expect(result).toContain("Relevant evidence:");
    expect(result).toContain("edit succeeded on src/auth.ts");
  });

  it("omits empty sections", () => {
    const turn: Turn = {
      label: "Turn 1",
      request: "Simple request",
      reasoning: [],
      responses: [],
      evidence: [],
      toolCalls: new Map(),
    };

    const result = formatTurn(turn);

    expect(result).toContain("### Turn 1");
    expect(result).toContain("Request: Simple request");
    expect(result).not.toContain("Reasoning:");
    expect(result).not.toContain("Stated conclusions:");
    expect(result).not.toContain("Relevant evidence:");
  });
});

describe("indentBullet", () => {
  it("indents newlines within bullet text", () => {
    expect(indentBullet("line1\nline2\nline3")).toBe("line1\n  line2\n  line3");
  });

  it("returns single-line text unchanged", () => {
    expect(indentBullet("no newlines")).toBe("no newlines");
  });
});
