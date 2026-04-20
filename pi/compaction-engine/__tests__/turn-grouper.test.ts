import { describe, expect, it } from "bun:test";
import {
  groupIntoTurns,
  createTurn,
  finalizeTurn,
  hasUsefulTurnContent,
  isTurnStartRole,
  labelForRole,
  describeTurnRequest,
  ingestAssistantMessage,
  ingestToolResult,
  summarizeBashEvidence,
  pickInterestingLines,
  looksLikeFiller,
} from "../turn-grouper";
import type { Turn } from "../turn-grouper";

// ── helpers ───────────────────────────────────────────────────────────

function makeUserMessage(text: string) {
  return {
    role: "user",
    content: [{ type: "text", text }],
  };
}

function makeAssistantMessage(opts: {
  thinking?: string;
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments?: Record<string, any> }>;
}) {
  const content: any[] = [];
  if (opts.thinking) content.push({ type: "thinking", thinking: opts.thinking });
  if (opts.text) content.push({ type: "text", text: opts.text });
  for (const tc of opts.toolCalls ?? []) {
    content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: tc.arguments ?? {} });
  }
  return { role: "assistant", content };
}

function makeToolResult(opts: {
  toolCallId: string;
  toolName: string;
  content: string;
  isError?: boolean;
}) {
  return {
    role: "toolResult",
    toolCallId: opts.toolCallId,
    toolName: opts.toolName,
    content: [{ type: "text", text: opts.content }],
    isError: opts.isError ?? false,
  };
}

function makeBashExecution(command: string) {
  return { role: "bashExecution", command };
}

function makeCompactionSummary(summary: string) {
  return { role: "compactionSummary", summary };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("groupIntoTurns", () => {
  it("groups a user + assistant + toolResult into a single turn", () => {
    const messages = [
      makeUserMessage("Fix the auth bug in login.ts"),
      makeAssistantMessage({
        thinking: "The auth bug is likely in the token validation logic.",
        text: "I'll check the token validation code.",
        toolCalls: [{ id: "tc1", name: "read", arguments: { path: "src/login.ts" } }],
      }),
      makeToolResult({ toolCallId: "tc1", toolName: "read", content: "file contents..." }),
    ];

    const turns = groupIntoTurns(messages);

    expect(turns.length).toBe(1);
    expect(turns[0].label).toBe("Turn 1");
    expect(turns[0].request).toBe("Fix the auth bug in login.ts");
    expect(turns[0].reasoning).toEqual(["The auth bug is likely in the token validation logic."]);
    // "I'll check the token validation code." is filler — starts with "I'll" + check
    expect(turns[0].responses).toEqual([]);
    // read tool result with no error is filtered out
    expect(turns[0].evidence).toEqual([]);
  });

  it("separates turns on user messages", () => {
    const messages = [
      makeUserMessage("First task"),
      makeAssistantMessage({ text: "Done with first task." }),
      makeUserMessage("Second task"),
      makeAssistantMessage({ text: "Done with second task." }),
    ];

    const turns = groupIntoTurns(messages);

    expect(turns.length).toBe(2);
    expect(turns[0].request).toBe("First task");
    expect(turns[0].responses).toEqual(["Done with first task."]);
    expect(turns[1].request).toBe("Second task");
    expect(turns[1].responses).toEqual(["Done with second task."]);
  });

  it("handles bashExecution as a turn start", () => {
    const messages = [
      makeUserMessage("Start the server"),
      makeAssistantMessage({ text: "Starting server." }),
      makeBashExecution("npm run dev"),
      makeAssistantMessage({ text: "Server is running." }),
    ];

    const turns = groupIntoTurns(messages);

    expect(turns.length).toBe(2);
    expect(turns[0].label).toBe("Turn 1");
    expect(turns[1].label).toBe("User Bash 2");
    expect(turns[1].request).toContain("npm run dev");
  });

  it("includes compactionSummary in responses", () => {
    const messages = [
      makeCompactionSummary("## Goal\nPrevious session summary content"),
      makeUserMessage("Continue from where we left off"),
      makeAssistantMessage({ text: "Continuing work." }),
    ];

    const turns = groupIntoTurns(messages);

    expect(turns.length).toBeGreaterThanOrEqual(1);
    // The compaction summary should appear in the first context turn's responses
    const firstTurn = turns.find((t) => t.responses.some((r) => r.includes("Previous session")));
    expect(firstTurn).toBeDefined();
  });

  it("categorizes tool results correctly — edit success", () => {
    const turn = createTurn("Turn", "test");
    ingestAssistantMessage(turn, makeAssistantMessage({
      toolCalls: [{ id: "tc1", name: "edit", arguments: { path: "src/auth.ts" } }],
    }));
    ingestToolResult(turn, makeToolResult({
      toolCallId: "tc1",
      toolName: "edit",
      content: "File updated",
    }));

    expect(turn.evidence).toEqual(["edit succeeded on src/auth.ts"]);
  });

  it("categorizes tool results correctly — error results", () => {
    const turn = createTurn("Turn", "test");
    ingestAssistantMessage(turn, makeAssistantMessage({
      toolCalls: [{ id: "tc1", name: "write", arguments: { path: "/root/forbidden.ts" } }],
    }));
    ingestToolResult(turn, makeToolResult({
      toolCallId: "tc1",
      toolName: "write",
      content: "Permission denied",
      isError: true,
    }));

    expect(turn.evidence[0]).toContain("error");
    expect(turn.evidence[0]).toContain("Permission denied");
  });

  it("categorizes tool results correctly — bash with test command", () => {
    const turn = createTurn("Turn", "test");
    ingestToolResult(turn, {
      role: "toolResult",
      toolCallId: "tc99",
      toolName: "bash",
      content: [{ type: "text", text: "PASS: test_auth\nFAIL: test_login\n2 failures" }],
      isError: false,
    });

    expect(turn.evidence.length).toBeGreaterThanOrEqual(1);
    expect(turn.evidence[0]).toContain("test");
  });

  it("filters filler assistant text", () => {
    const turn = createTurn("Turn", "test");
    ingestAssistantMessage(turn, makeAssistantMessage({ text: "Let me check the file." }));
    expect(turn.responses).toEqual([]);

    ingestAssistantMessage(turn, makeAssistantMessage({ text: "The authentication module uses JWT tokens with a 24-hour expiry window." }));
    expect(turn.responses).toEqual(["The authentication module uses JWT tokens with a 24-hour expiry window."]);
  });

  it("does not filter long filler-ish text", () => {
    const longText = "Let me check the file and see what's going on with the authentication module. ".repeat(4);
    const turn = createTurn("Turn", "test");
    ingestAssistantMessage(turn, makeAssistantMessage({ text: longText }));
    expect(turn.responses.length).toBe(1);
  });
});

describe("summarizeBashEvidence", () => {
  it("returns undefined for unimportant command + output", () => {
    const result = summarizeBashEvidence("echo hello", "hello", false);
    expect(result).toBeUndefined();
  });

  it("returns test summary for test commands", () => {
    const result = summarizeBashEvidence("go test ./...", "PASS\nok  pkg/auth  0.012s", false);
    expect(result).toContain("Test");
    expect(result).toContain("passed");
  });

  it("returns test failure summary", () => {
    const result = summarizeBashEvidence("pytest", "FAIL test_auth.py - AssertionError", false);
    expect(result).toContain("Test");
    expect(result).toContain("failed");
  });

  it("returns check summary for build commands", () => {
    const result = summarizeBashEvidence("tsc --noEmit", "", false);
    expect(result).toContain("Check");
    expect(result).toContain("completed");
  });

  it("returns check problems when errors present", () => {
    const result = summarizeBashEvidence("eslint src/", "error: Unexpected any", true);
    expect(result).toContain("reported problems");
  });

  it("returns git diff summary", () => {
    const result = summarizeBashEvidence("git diff HEAD", "+new line\n-old line", false);
    expect(result).toContain("Git diff");
  });

  it("returns bash summary for error on generic command", () => {
    const result = summarizeBashEvidence("ls /nonexistent", "No such file or directory", true);
    expect(result).toContain("Bash");
    expect(result).toContain("errored");
  });
});

describe("pickInterestingLines", () => {
  it("returns all lines when under maxLines", () => {
    const result = pickInterestingLines("line1\nline2\nline3", 5);
    expect(result).toEqual(["line1", "line2", "line3"]);
  });

  it("picks lines with keywords", () => {
    const result = pickInterestingLines("ok\nPASS: test1\ninfo\nFAIL: test2\ninfo2", 8);
    expect(result).toEqual(["PASS: test1", "FAIL: test2"]);
  });

  it("truncates uninteresting long output with head+tail", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const result = pickInterestingLines(lines.join("\n"), 4);
    expect(result.length).toBe(4);
    expect(result[0]).toBe("line 1");
    expect(result[1]).toBe("line 2");
    expect(result[2]).toBe("line 19");
    expect(result[3]).toBe("line 20");
  });
});

describe("looksLikeFiller", () => {
  it("detects common filler phrases", () => {
    expect(looksLikeFiller("Let me check the file.")).toBe(true);
    expect(looksLikeFiller("I'll inspect the module.")).toBe(true);
    expect(looksLikeFiller("I will examine the code.")).toBe(true);
    expect(looksLikeFiller("First, let me investigate.")).toBe(true);
    expect(looksLikeFiller("Now let me look at this.")).toBe(true);
  });

  it("does not flag substantive messages", () => {
    expect(looksLikeFiller("The auth module uses JWT tokens.")).toBe(false);
    expect(looksLikeFiller("I found the bug in line 42.")).toBe(false);
  });

  it("does not flag long messages", () => {
    expect(looksLikeFiller("Let me check the file and then implement the full solution.")).toBe(true);
    // >180 chars should not be flagged even if it starts with a filler phrase
    const longFiller = "Let me check " + "the authentication module ".repeat(10) + "for issues.";
    expect(longFiller.length).toBeGreaterThan(180);
    expect(looksLikeFiller(longFiller)).toBe(false);
  });
});

describe("isTurnStartRole", () => {
  it("recognizes turn-starting roles", () => {
    expect(isTurnStartRole("user")).toBe(true);
    expect(isTurnStartRole("bashExecution")).toBe(true);
    expect(isTurnStartRole("custom")).toBe(true);
    expect(isTurnStartRole("assistant")).toBe(false);
    expect(isTurnStartRole("toolResult")).toBe(false);
  });
});

describe("labelForRole", () => {
  it("returns correct labels", () => {
    expect(labelForRole("user")).toBe("Turn");
    expect(labelForRole("bashExecution")).toBe("User Bash");
    expect(labelForRole("custom")).toBe("Custom Input");
    expect(labelForRole("assistant")).toBe("Turn");
  });
});

describe("hasUsefulTurnContent", () => {
  it("returns true for turns with content", () => {
    const turn = createTurn("Turn", "do something");
    expect(hasUsefulTurnContent(turn)).toBe(true);
  });

  it("returns false for empty turns", () => {
    const turn = createTurn("Turn", "");
    turn.request = "";
    expect(hasUsefulTurnContent(turn)).toBe(false);
  });
});

describe("finalizeTurn", () => {
  it("appends index to label", () => {
    const turn = createTurn("Turn", "test");
    const finalized = finalizeTurn(turn, 3);
    expect(finalized.label).toBe("Turn 3");
  });
});

describe("describeTurnRequest", () => {
  it("extracts text from user messages", () => {
    const msg = makeUserMessage("Hello world");
    expect(describeTurnRequest(msg)).toBe("Hello world");
  });

  it("describes bash execution commands", () => {
    expect(describeTurnRequest(makeBashExecution("npm test"))).toContain("npm test");
  });

  it("handles null messages", () => {
    expect(describeTurnRequest(null as any)).toBe("(empty)");
  });
});
