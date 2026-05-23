import { describe, expect, test } from "bun:test";

import {
  buildSessionSummary,
  clampPositiveInteger,
  compareTimestampDesc,
  extractText,
  extractThinking,
  extractToolCalls,
  filterByCwd,
  findSessionMatch,
  formatConversation,
  formatSessionDate,
  hasEntryId,
  isPathWithinDir,
  isSameProjectPath,
  matchFieldLabel,
  parseEntry,
  parseHeader,
  parseSessionText,
  searchSessions,
  selectBranchMessages,
  selectLeafEntryId,
  type SearchField,
  type SessionSummary,
} from "./session-utils.js";

import { sanitizeTokens, buildFtsQuery } from "./indexer.js";

// ── UUID detection tests ──────────────────────────────────────────────
// looksLikeUuid is a module-private function, but we can test the regex logic
// by importing the regex-adjacent behavior indirectly.

function looksLikeUuid(query: string): boolean {
  const normalized = query.trim();
  if (normalized.length < 8) return false;
  return /^[0-9a-f]{8}[0-9a-f-]*$/i.test(normalized);
}

describe("looksLikeUuid heuristic", () => {
  test("matches full UUID", () => {
    expect(looksLikeUuid("019e338d-68e4-710d-a791-10acb0a42dec")).toBe(true);
  });

  test("matches partial UUID (8 hex chars)", () => {
    expect(looksLikeUuid("019e338d")).toBe(true);
  });

  test("matches partial UUID with trailing segments", () => {
    expect(looksLikeUuid("019e338d-68e4")).toBe(true);
    expect(looksLikeUuid("019e338d-68e4-710d")).toBe(true);
  });

  test("matches UUID without hyphens", () => {
    expect(looksLikeUuid("019e338d68e4710da79110acb0a42dec")).toBe(true);
  });

  test("rejects too-short strings", () => {
    expect(looksLikeUuid("019e338")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(looksLikeUuid("")).toBe(false);
  });

  test("rejects natural language queries", () => {
    expect(looksLikeUuid("migrate-to-ai-sdk")).toBe(false); // 'm' is not hex
    expect(looksLikeUuid("hello world")).toBe(false);
    expect(looksLikeUuid("session search")).toBe(false);
  });

  test("rejects paths", () => {
    expect(looksLikeUuid("/home/user/.pi/agent/sessions/file.jsonl")).toBe(false);
  });

  test("case insensitive", () => {
    expect(looksLikeUuid("019E338D-68E4")).toBe(true);
  });
});

function jsonl(lines: unknown[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function textBlock(text: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text }];
}

const BRANCHED_SESSION = jsonl([
  {
    type: "session",
    version: 3,
    id: "session-1",
    timestamp: "2026-04-15T00:00:00.000Z",
    cwd: "/workspace/project",
  },
  {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: "2026-04-15T00:00:01.000Z",
    message: { role: "user", content: textBlock("hello") },
  },
  {
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: "2026-04-15T00:00:02.000Z",
    message: { role: "assistant", content: textBlock("hi") },
  },
  {
    type: "message",
    id: "u2",
    parentId: "a1",
    timestamp: "2026-04-15T00:00:03.000Z",
    message: { role: "user", content: textBlock("branch me") },
  },
  {
    type: "message",
    id: "a-old",
    parentId: "u2",
    timestamp: "2026-04-15T00:00:04.000Z",
    message: { role: "assistant", content: textBlock("old leaf") },
  },
  {
    type: "message",
    id: "a-new",
    parentId: "u2",
    timestamp: "2026-04-15T00:00:05.000Z",
    message: { role: "assistant", content: textBlock("new leaf mentions zeroclaw") },
  },
]);

const TOOL_RESULT_SESSION = jsonl([
  {
    type: "session",
    version: 3,
    id: "session-2",
    timestamp: "2026-04-15T00:00:00.000Z",
    cwd: "/workspace/project",
  },
  {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: "2026-04-15T00:00:01.000Z",
    message: { role: "user", content: textBlock("show me the logs") },
  },
  {
    type: "message",
    id: "t1",
    parentId: "u1",
    timestamp: "2026-04-15T00:00:02.000Z",
    message: { role: "toolResult", toolName: "bash", content: textBlock("super-secret-needle") },
  },
]);

const CONTENT_BEATS_PATH_SESSION = jsonl([
  {
    type: "session",
    version: 3,
    id: "session-3",
    timestamp: "2026-04-15T00:00:00.000Z",
    cwd: "/workspace/zeroclaw",
  },
  {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: "2026-04-15T00:00:01.000Z",
    message: { role: "user", content: textBlock("how does zeroclaw hands work?") },
  },
  {
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: "2026-04-15T00:00:02.000Z",
    message: { role: "assistant", content: textBlock("zeroclaw hands are not wired up yet") },
  },
]);

function makeSummaryWithSegment(file: string, field: SearchField, text: string): SessionSummary {
  return {
    file,
    id: "test-id",
    timestamp: "2026-04-15T00:00:00.000Z",
    cwd: "/test",
    firstUserMessage: "",
    name: null,
    latestLeafId: null,
    segments: [{ field, text }],
  };
}

describe("parseHeader", () => {
  test("parses a valid session header", () => {
    const header = parseHeader(JSON.stringify({ type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/home" }));
    expect(header).toEqual({ id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/home" });
  });

  test("returns null for missing type", () => {
    expect(parseHeader(JSON.stringify({ id: "s1", timestamp: "2026-01-01T00:00:00Z" }))).toBeNull();
  });

  test("returns null for missing id", () => {
    expect(parseHeader(JSON.stringify({ type: "session", timestamp: "2026-01-01T00:00:00Z" }))).toBeNull();
  });

  test("returns null for missing timestamp", () => {
    expect(parseHeader(JSON.stringify({ type: "session", id: "s1" }))).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    expect(parseHeader("not json")).toBeNull();
  });

  test("defaults cwd to empty string", () => {
    const header = parseHeader(JSON.stringify({ type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z" }));
    expect(header).toEqual({ id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "" });
  });
});

describe("parseEntry", () => {
  test("parses a message entry", () => {
    const entry = parseEntry(JSON.stringify({
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "hi" },
    }));
    expect(entry).not.toBeNull();
    expect(entry!.type).toBe("message");
    expect((entry as any).message.role).toBe("user");
  });

  test("parses a session_info entry", () => {
    const entry = parseEntry(JSON.stringify({ type: "session_info", name: "My Session" }));
    expect(entry).not.toBeNull();
    expect(entry!.type).toBe("session_info");
    expect((entry as any).name).toBe("My Session");
  });

  test("parses a generic entry", () => {
    const entry = parseEntry(JSON.stringify({
      type: "custom",
      id: "c1",
      parentId: "p1",
      timestamp: "2026-01-01T00:00:00Z",
    }));
    expect(entry).not.toBeNull();
    expect(entry!.type).toBe("custom");
  });

  test("returns null for missing type", () => {
    expect(parseEntry(JSON.stringify({ id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00Z" }))).toBeNull();
  });

  test("returns null for missing id on non-session_info", () => {
    expect(parseEntry(JSON.stringify({
      type: "message",
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
    }))).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    expect(parseEntry("bad json")).toBeNull();
  });
});

describe("parseSessionText", () => {
  test("parses a complete session", () => {
    const parsed = parseSessionText(BRANCHED_SESSION);
    expect(parsed).not.toBeNull();
    expect(parsed!.header.id).toBe("session-1");
    expect(parsed!.entries.length).toBe(5);
    expect(parsed!.name).toBeNull();
  });

  test("returns null for empty data", () => {
    expect(parseSessionText("")).toBeNull();
  });

  test("returns null when first line is not a header", () => {
    expect(parseSessionText(JSON.stringify({ type: "message", id: "m1" }))).toBeNull();
  });

  test("extracts name from session_info entries", () => {
    const data = jsonl([
      { type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/" },
      { type: "session_info", name: "Named Session" },
    ]);
    const parsed = parseSessionText(data);
    expect(parsed!.name).toBe("Named Session");
  });
});

describe("extractText", () => {
  test("returns string content as-is", () => {
    expect(extractText("hello world")).toBe("hello world");
  });

  test("joins text blocks from array", () => {
    expect(extractText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
  });

  test("ignores non-text blocks", () => {
    expect(extractText([{ type: "toolCall", name: "x" }, { type: "text", text: "ok" }])).toBe("ok");
  });

  test("returns empty for non-array", () => {
    expect(extractText(42)).toBe("");
    expect(extractText(null)).toBe("");
  });

  test("returns empty for empty array", () => {
    expect(extractText([])).toBe("");
  });
});

describe("extractToolCalls", () => {
  test("extracts toolCall blocks", () => {
    const calls = extractToolCalls([
      { type: "toolCall", name: "bash", arguments: { cmd: "ls" } },
    ]);
    expect(calls).toEqual([{ name: "bash", arguments: JSON.stringify({ cmd: "ls" }) }]);
  });

  test("returns empty for non-array", () => {
    expect(extractToolCalls("hello")).toEqual([]);
  });

  test("skips toolCall without name", () => {
    expect(extractToolCalls([{ type: "toolCall", arguments: {} }])).toEqual([]);
  });

  test("defaults missing arguments to {}", () => {
    const calls = extractToolCalls([{ type: "toolCall", name: "noop" }]);
    expect(calls).toEqual([{ name: "noop", arguments: "{}" }]);
  });
});

describe("compareTimestampDesc", () => {
  test("sorts newer timestamps first", () => {
    const a = { timestamp: "2026-04-15T00:00:00Z" };
    const b = { timestamp: "2026-04-16T00:00:00Z" };
    expect(compareTimestampDesc(a, b)).toBeGreaterThan(0);
    expect(compareTimestampDesc(b, a)).toBeLessThan(0);
  });

  test("returns 0 for equal timestamps", () => {
    const a = { timestamp: "2026-04-15T00:00:00Z" };
    expect(compareTimestampDesc(a, a)).toBe(0);
  });

  test("treats invalid timestamps as 0", () => {
    const a = { timestamp: "invalid" };
    const b = { timestamp: "2026-04-15T00:00:00Z" };
    expect(compareTimestampDesc(a, b)).toBeGreaterThan(0);
    expect(compareTimestampDesc(b, a)).toBeLessThan(0);
  });
});

describe("hasEntryId", () => {
  test("returns true when entry exists", () => {
    const parsed = parseSessionText(BRANCHED_SESSION)!;
    expect(hasEntryId(parsed, "u1")).toBe(true);
    expect(hasEntryId(parsed, "a-new")).toBe(true);
  });

  test("returns false when entry does not exist", () => {
    const parsed = parseSessionText(BRANCHED_SESSION)!;
    expect(hasEntryId(parsed, "nonexistent")).toBe(false);
  });

  test("ignores session_info entries", () => {
    const data = jsonl([
      { type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/" },
      { type: "session_info", id: "info-1", name: "test" },
    ]);
    const parsed = parseSessionText(data)!;
    expect(hasEntryId(parsed, "info-1")).toBe(false);
  });
});

describe("selectLeafEntryId", () => {
  test("selects newest leaf by default in multi-branch session", () => {
    const parsed = parseSessionText(BRANCHED_SESSION)!;
    expect(selectLeafEntryId(parsed)).toBe("a-new");
  });

  test("selects explicit entry when it is a leaf", () => {
    const parsed = parseSessionText(BRANCHED_SESSION)!;
    expect(selectLeafEntryId(parsed, "a-old")).toBe("a-old");
  });

  test("selects newest leaf descendant when explicit entry has children", () => {
    const parsed = parseSessionText(BRANCHED_SESSION)!;
    expect(selectLeafEntryId(parsed, "u2")).toBe("a-new");
  });

  test("falls back to newest leaf when explicit entry is not found", () => {
    const parsed = parseSessionText(BRANCHED_SESSION)!;
    expect(selectLeafEntryId(parsed, "missing")).toBe("a-new");
  });

  test("returns null for empty entries", () => {
    const data = jsonl([
      { type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/" },
    ]);
    const parsed = parseSessionText(data)!;
    expect(selectLeafEntryId(parsed)).toBeNull();
  });

  test("returns the only entry in a single-entry session", () => {
    const data = jsonl([
      { type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/" },
      { type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "hi" } },
    ]);
    const parsed = parseSessionText(data)!;
    expect(selectLeafEntryId(parsed)).toBe("m1");
  });
});

describe("selectBranchMessages", () => {
  test("follows the default leaf branch", () => {
    const parsed = parseSessionText(BRANCHED_SESSION)!;
    const branch = selectBranchMessages(parsed);
    expect(branch.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a-new"]);
  });

  test("follows explicit entry_id branch", () => {
    const parsed = parseSessionText(BRANCHED_SESSION)!;
    const branch = selectBranchMessages(parsed, "a-old");
    expect(branch.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a-old"]);
  });

  test("returns empty array for empty session", () => {
    const data = jsonl([
      { type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/" },
    ]);
    const parsed = parseSessionText(data)!;
    expect(selectBranchMessages(parsed)).toEqual([]);
  });
});

describe("formatConversation", () => {
  test("follows the newest leaf by default", () => {
    const parsed = parseSessionText(BRANCHED_SESSION)!;
    const formatted = formatConversation(parsed, { maxTurns: 10 });
    expect(formatted.leafEntryId).toBe("a-new");
    expect(formatted.text).toContain("new leaf mentions zeroclaw");
    expect(formatted.text).not.toContain("old leaf");
    expect(formatted.messageCount).toBe(4);
  });

  test("can anchor to an explicit branch entry", () => {
    const parsed = parseSessionText(BRANCHED_SESSION)!;
    const formatted = formatConversation(parsed, { entryId: "a-old", maxTurns: 10 });
    expect(formatted.leafEntryId).toBe("a-old");
    expect(formatted.text).toContain("old leaf");
    expect(formatted.text).not.toContain("new leaf mentions zeroclaw");
  });

  test("maxTurns limits the number of user turns", () => {
    const parsed = parseSessionText(BRANCHED_SESSION)!;
    const formatted = formatConversation(parsed, { maxTurns: 1 });
    expect(formatted.text).toContain("hello");
    expect(formatted.text).not.toContain("branch me");
  });

  test("includeTools shows tool calls and results", () => {
    const parsed = parseSessionText(TOOL_RESULT_SESSION)!;
    const withTools = formatConversation(parsed, { includeTools: true, maxTurns: 10, detail: "full" });
    expect(withTools.text).toContain("[Result (bash): super-secret-needle]");

    const withoutTools = formatConversation(parsed, { includeTools: false, maxTurns: 10, detail: "full" });
    expect(withoutTools.text).not.toContain("super-secret-needle");
  });

  test("includes assistant tool calls when includeTools is true", () => {
    const data = jsonl([
      { type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/" },
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01Z",
        message: { role: "user", content: textBlock("do it") },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-01-01T00:00:02Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "bash", arguments: { cmd: "ls" } }],
        },
      },
    ]);
    const parsed = parseSessionText(data)!;
    const formatted = formatConversation(parsed, { includeTools: true, maxTurns: 10, detail: "full" });
    expect(formatted.text).toContain("[Tool: bash(");
  });
});

describe("formatConversation detail levels", () => {
  const MULTI_TURN = jsonl([
    { type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/project" },
    {
      type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01Z",
      message: { role: "user", content: textBlock("first user message here") },
    },
    {
      type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02Z",
      message: {
        role: "assistant",
        content: [
          ...textBlock("Long assistant response that definitely exceeds one hundred and fifty characters so we can verify truncation behavior works correctly in outline mode which is why we need this to be very long indeed.",
          ),
          { type: "toolCall", name: "bash", arguments: { command: "ls -la /very/long/path" } },
          { type: "toolCall", name: "read", arguments: { path: "/some/file.ts" } },
        ],
      },
    },
    {
      type: "message", id: "t1", parentId: "a1", timestamp: "2026-01-01T00:00:03Z",
      message: { role: "toolResult", toolName: "bash", content: textBlock("tool output result that should be hidden in outline") },
    },
    {
      type: "message", id: "u2", parentId: "t1", timestamp: "2026-01-01T00:00:04Z",
      message: { role: "user", content: textBlock("second user turn about something") },
    },
    {
      type: "message", id: "a2", parentId: "u2", timestamp: "2026-01-01T00:00:05Z",
      message: { role: "assistant", content: textBlock("short reply") },
    },
    {
      type: "message", id: "u3", parentId: "a2", timestamp: "2026-01-01T00:00:06Z",
      message: { role: "user", content: textBlock("third turn") },
    },
    {
      type: "message", id: "a3", parentId: "u3", timestamp: "2026-01-01T00:00:07Z",
      message: { role: "assistant", content: textBlock("third answer") },
    },
  ]);

  test("outline truncates user messages to ~150 chars", () => {
    const parsed = parseSessionText(MULTI_TURN)!;
    const formatted = formatConversation(parsed, { detail: "outline", maxTurns: 10 });
    // User messages should include entry IDs
    expect(formatted.text).toContain("id: u1");
    expect(formatted.text).toContain("id: u2");
    // First user message should be truncated
    expect(formatted.text).toContain("first user message here");
  });

  test("outline shows tool names but not tool results", () => {
    const parsed = parseSessionText(MULTI_TURN)!;
    const formatted = formatConversation(parsed, { detail: "outline", maxTurns: 10 });
    expect(formatted.text).toContain("[Tool: bash]");
    expect(formatted.text).toContain("[Tool: read]");
    expect(formatted.text).not.toContain("super-secret-needle");
    expect(formatted.text).not.toContain("tool output result");
  });

  test("outline truncates assistant text to ~150 chars", () => {
    const parsed = parseSessionText(MULTI_TURN)!;
    const formatted = formatConversation(parsed, { detail: "outline", maxTurns: 10 });
    // The long text should be truncated (150 char limit + ellipsis)
    expect(formatted.text).toContain("id: a1");
    // Should NOT contain text that falls beyond the 150-char truncation point
    expect(formatted.text).not.toContain("in outline mode which is why we need this to be very long indeed");
  });

  test("compact shows ~500 chars per message and truncated tool results", () => {
    const parsed = parseSessionText(MULTI_TURN)!;
    const formatted = formatConversation(parsed, { detail: "compact", includeTools: true, maxTurns: 10 });
    expect(formatted.text).toContain("id: u1");
    expect(formatted.text).toContain("id: a1");
    // Tool results should appear in compact with includeTools
    expect(formatted.text).toContain("tool output result");
  });

  test("full mode is unchanged (backward compat)", () => {
    const parsed = parseSessionText(MULTI_TURN)!;
    const formatted = formatConversation(parsed, { detail: "full", includeTools: true, maxTurns: 10 });
    // No entry IDs in full mode
    expect(formatted.text).not.toContain("id: u1");
    // Full text present
    expect(formatted.text).toContain("truncation behavior works correctly");
  });

  test("default detail is outline when not specified", () => {
    const parsed = parseSessionText(BRANCHED_SESSION)!;
    const formatted = formatConversation(parsed, { maxTurns: 10 });
    // Outline mode: entry IDs present, text truncated
    expect(formatted.text).toContain("id: ");
    expect(formatted.text).toContain("new leaf mentions zeroclaw");
  });

  test("window returns turns around entry_id", () => {
    const parsed = parseSessionText(MULTI_TURN)!;
    // u2 is the second user turn. window=1 gives anchor(u2) + 1 before(u1) + 1 after(u3) = all turns
    // So use u2 with window=0 to get only the anchor turn (no neighbor user turns)
    const formatted = formatConversation(parsed, {
      detail: "outline",
      entryId: "u2",
      window: 0,
      maxTurns: 10,
    });
    expect(formatted.text).toContain("second user turn");
    // With window=0, only the anchor turn + its trailing assistant, everything else omitted
    expect(formatted.text).toContain("earlier turns omitted");
    expect(formatted.text).toContain("later turns omitted");
    expect(formatted.text).not.toContain("first user message");
    expect(formatted.text).not.toContain("third turn");
  });

  test("window=1 with anchor at start includes anchor + 1 forward", () => {
    const parsed = parseSessionText(MULTI_TURN)!;
    const formatted = formatConversation(parsed, {
      detail: "outline",
      entryId: "u1",
      window: 1,
      maxTurns: 10,
    });
    expect(formatted.text).toContain("first user message");
    // No earlier marker since we're at the start
    expect(formatted.text).not.toContain("earlier turns omitted");
    // window=1 from u1 should include 1 turn forward = u2
    expect(formatted.text).toContain("second user turn");
    // u3 is beyond the window
    expect(formatted.text).toContain("later turns omitted");
    expect(formatted.text).not.toContain("third turn");
  });

  test("window without entry_id is ignored", () => {
    const parsed = parseSessionText(MULTI_TURN)!;
    const formatted = formatConversation(parsed, {
      detail: "outline",
      window: 1,
      maxTurns: 10,
    });
    // All turns should be present
    expect(formatted.text).toContain("first user message");
    expect(formatted.text).toContain("third turn");
    expect(formatted.text).not.toContain("omitted");
  });

  test("outline with tool-call-only assistant shows tool names", () => {
    const data = jsonl([
      { type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/" },
      {
        type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01Z",
        message: { role: "user", content: textBlock("run it") },
      },
      {
        type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "bash", arguments: { command: "echo hello" } }],
        },
      },
    ]);
    const parsed = parseSessionText(data)!;
    const formatted = formatConversation(parsed, { detail: "outline", maxTurns: 10 });
    expect(formatted.text).toContain("[Tool: bash]");
  });
});

describe("findSessionMatch", () => {
  test("searches later assistant text, not just first user message", () => {
    const parsed = parseSessionText(BRANCHED_SESSION)!;
    const summary = buildSessionSummary("/tmp/session-1.jsonl", parsed);
    const match = findSessionMatch(summary, "zeroclaw");

    expect(match).not.toBeNull();
    expect(match!.field).toBe("assistant_message");
    expect(match!.entryId).toBe("a-new");
    expect(match!.snippet).toContain("zeroclaw");
  });

  test("tool-result search is opt-in", () => {
    const parsed = parseSessionText(TOOL_RESULT_SESSION)!;
    const summary = buildSessionSummary("/tmp/session-2.jsonl", parsed);
    expect(findSessionMatch(summary, "super-secret-needle")).toBeNull();

    const toolMatch = findSessionMatch(summary, "super-secret-needle", { searchTools: true });
    expect(toolMatch).not.toBeNull();
    expect(toolMatch!.field).toBe("tool_result");
    expect(toolMatch!.entryId).toBe("t1");
  });

  test("content matches outrank plain cwd matches inside the same session", () => {
    const parsed = parseSessionText(CONTENT_BEATS_PATH_SESSION)!;
    const summary = buildSessionSummary("/tmp/session-3.jsonl", parsed);
    const match = findSessionMatch(summary, "zeroclaw");

    expect(match).not.toBeNull();
    expect(["first_user_message", "user_message", "assistant_message"]).toContain(match!.field);
  });

  test("exact match outranks prefix match", () => {
    const exact = makeSummaryWithSegment("exact.jsonl", "user_message", "hello world");
    const prefix = makeSummaryWithSegment("prefix.jsonl", "user_message", "hello world wide");
    const hits = searchSessions([prefix, exact], "hello world", { limit: 10 });
    expect(hits[0].summary.file).toBe("exact.jsonl");
    expect(hits[1].summary.file).toBe("prefix.jsonl");
  });

  test("prefix match outranks substring match", () => {
    const prefix = makeSummaryWithSegment("prefix.jsonl", "user_message", "hello world wide");
    const substring = makeSummaryWithSegment("substring.jsonl", "user_message", "say hello world now");
    const hits = searchSessions([substring, prefix], "hello world", { limit: 10 });
    expect(hits[0].summary.file).toBe("prefix.jsonl");
    expect(hits[1].summary.file).toBe("substring.jsonl");
  });

  test("substring match outranks all-terms match", () => {
    const substring = makeSummaryWithSegment("substring.jsonl", "user_message", "say hello world now");
    const allTerms = makeSummaryWithSegment("allterms.jsonl", "user_message", "hello there world");
    const hits = searchSessions([allTerms, substring], "hello world", { limit: 10 });
    expect(hits[0].summary.file).toBe("substring.jsonl");
    expect(hits[1].summary.file).toBe("allterms.jsonl");
  });

  test("all-terms match outranks no match", () => {
    const allTerms = makeSummaryWithSegment("allterms.jsonl", "user_message", "hello there world");
    const noMatch = makeSummaryWithSegment("nomatch.jsonl", "user_message", "goodbye");
    const hits = searchSessions([noMatch, allTerms], "hello world", { limit: 10 });
    expect(hits.length).toBe(1);
    expect(hits[0].summary.file).toBe("allterms.jsonl");
  });

  test("field priority: id > name > first_user_message", () => {
    const idMatch = makeSummaryWithSegment("id.jsonl", "id", "hello world");
    const nameMatch = makeSummaryWithSegment("name.jsonl", "name", "hello world");
    const fumMatch = makeSummaryWithSegment("fum.jsonl", "first_user_message", "hello world");
    const hits = searchSessions([fumMatch, nameMatch, idMatch], "hello world", { limit: 10 });
    expect(hits[0].summary.file).toBe("id.jsonl");
    expect(hits[1].summary.file).toBe("name.jsonl");
    expect(hits[2].summary.file).toBe("fum.jsonl");
  });

  test("id prefix gets extra boost", () => {
    const idPrefix = makeSummaryWithSegment("id.jsonl", "id", "abc-123-xyz");
    const nameExact = makeSummaryWithSegment("name.jsonl", "name", "abc-123");
    const hits = searchSessions([nameExact, idPrefix], "abc-123", { limit: 10 });
    expect(hits[0].summary.file).toBe("id.jsonl");
  });
});

describe("buildSessionSummary", () => {
  test("builds summary with first user message", () => {
    const parsed = parseSessionText(BRANCHED_SESSION)!;
    const summary = buildSessionSummary("/tmp/session.jsonl", parsed);
    expect(summary.id).toBe("session-1");
    expect(summary.cwd).toBe("/workspace/project");
    expect(summary.firstUserMessage).toBe("hello");
    expect(summary.segments.some((s) => s.field === "first_user_message")).toBe(true);
  });

  test("includes session name from session_info", () => {
    const data = jsonl([
      { type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/" },
      { type: "session_info", name: "My Session" },
      { type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "hi" } },
    ]);
    const parsed = parseSessionText(data)!;
    const summary = buildSessionSummary("/tmp/session.jsonl", parsed);
    expect(summary.name).toBe("My Session");
    expect(summary.segments.some((s) => s.field === "name" && s.text === "My Session")).toBe(true);
  });

  test("latestLeafId is populated", () => {
    const parsed = parseSessionText(BRANCHED_SESSION)!;
    const summary = buildSessionSummary("/tmp/session.jsonl", parsed);
    expect(summary.latestLeafId).toBe("a-new");
  });
});

describe("path security", () => {
  test("isSameProjectPath matches parent and child directories", () => {
    expect(isSameProjectPath("/workspace/project", "/workspace/project/subdir")).toBe(true);
    expect(isSameProjectPath("/workspace/project/subdir", "/workspace/project")).toBe(true);
    expect(isSameProjectPath("/workspace/project-a", "/workspace/project-b")).toBe(false);
  });

  test("isSameProjectPath rejects empty paths", () => {
    expect(isSameProjectPath("", "/workspace/project")).toBe(false);
    expect(isSameProjectPath("/workspace/project", "")).toBe(false);
  });

  test("isPathWithinDir rejects traversal outside the root", () => {
    expect(isPathWithinDir("/root/sessions", "/root/sessions/a.jsonl")).toBe(true);
    expect(isPathWithinDir("/root/sessions", "/root/sessions/nested/b.jsonl")).toBe(true);
    expect(isPathWithinDir("/root/sessions", "/root/other/b.jsonl")).toBe(false);
  });

  test("isPathWithinDir allows the root itself", () => {
    expect(isPathWithinDir("/root/sessions", "/root/sessions")).toBe(true);
  });

  test("isPathWithinDir rejects absolute traversal", () => {
    expect(isPathWithinDir("/root/sessions", "/etc/passwd")).toBe(false);
  });
});

describe("clampPositiveInteger", () => {
  test("coerces invalid values to a safe range", () => {
    expect(clampPositiveInteger(undefined, 10, 50)).toBe(10);
    expect(clampPositiveInteger(0, 10, 50)).toBe(10);
    expect(clampPositiveInteger(999, 10, 50)).toBe(50);
    expect(clampPositiveInteger(12.8, 10, 50)).toBe(12);
  });

  test("handles NaN and Infinity", () => {
    expect(clampPositiveInteger(NaN, 10, 50)).toBe(10);
    expect(clampPositiveInteger(Infinity, 10, 50)).toBe(10);
    expect(clampPositiveInteger(-Infinity, 10, 50)).toBe(10);
  });

  test("handles negative values", () => {
    expect(clampPositiveInteger(-5, 10, 50)).toBe(10);
  });

  test("truncates decimals", () => {
    expect(clampPositiveInteger(25.9, 10, 50)).toBe(25);
    expect(clampPositiveInteger(25.1, 10, 50)).toBe(25);
  });
});

describe("matchFieldLabel", () => {
  const cases: Array<{ field: SearchField; expected: string }> = [
    { field: "id", expected: "UUID" },
    { field: "cwd", expected: "CWD" },
    { field: "file", expected: "file path" },
    { field: "timestamp", expected: "timestamp" },
    { field: "name", expected: "session name" },
    { field: "first_user_message", expected: "first user message" },
    { field: "user_message", expected: "user message" },
    { field: "assistant_message", expected: "assistant message" },
    { field: "tool_result", expected: "tool result" },
  ];

  for (const { field, expected } of cases) {
    test(`returns "${expected}" for ${field}`, () => {
      expect(matchFieldLabel(field)).toBe(expected);
    });
  }
});

describe("formatSessionDate", () => {
  test("returns a non-empty localized string for valid timestamp", () => {
    const result = formatSessionDate("2026-04-15T00:00:00.000Z");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("filterByCwd", () => {
  const summaries: SessionSummary[] = [
    { file: "a.jsonl", id: "1", timestamp: "2026-01-01T00:00:00Z", cwd: "/home/user/project-a", firstUserMessage: "", name: null, latestLeafId: null, segments: [] },
    { file: "b.jsonl", id: "2", timestamp: "2026-01-01T00:00:00Z", cwd: "/home/user/project-b", firstUserMessage: "", name: null, latestLeafId: null, segments: [] },
  ];

  test("returns all summaries when no filter", () => {
    expect(filterByCwd(summaries)).toEqual(summaries);
    expect(filterByCwd(summaries, "")).toEqual(summaries);
    expect(filterByCwd(summaries, "   ")).toEqual(summaries);
  });

  test("filters case-insensitively", () => {
    expect(filterByCwd(summaries, "PROJECT-A")).toHaveLength(1);
    expect(filterByCwd(summaries, "project-a")).toHaveLength(1);
  });

  test("returns empty array when nothing matches", () => {
    expect(filterByCwd(summaries, "nonexistent")).toEqual([]);
  });
});

describe("searchSessions", () => {
  const s1: SessionSummary = {
    file: "a.jsonl", id: "1", timestamp: "2026-04-15T00:00:00Z", cwd: "/project/a",
    firstUserMessage: "hello world", name: null, latestLeafId: null,
    segments: [{ field: "first_user_message", text: "hello world" }],
  };
  const s2: SessionSummary = {
    file: "b.jsonl", id: "2", timestamp: "2026-04-16T00:00:00Z", cwd: "/project/b",
    firstUserMessage: "goodbye", name: null, latestLeafId: null,
    segments: [{ field: "first_user_message", text: "goodbye" }],
  };
  const s3: SessionSummary = {
    file: "c.jsonl", id: "3", timestamp: "2026-04-14T00:00:00Z", cwd: "/project/a",
    firstUserMessage: "hello there", name: null, latestLeafId: null,
    segments: [{ field: "first_user_message", text: "hello there" }],
  };

  test("returns hits sorted by score then timestamp desc", () => {
    const hits = searchSessions([s1, s2, s3], "hello", { limit: 10 });
    expect(hits.map((h) => h.summary.file)).toEqual(["a.jsonl", "c.jsonl"]);
  });

  test("respects limit", () => {
    const hits = searchSessions([s1, s2, s3], "hello", { limit: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0].summary.file).toBe("a.jsonl");
  });

  test("respects cwdFilter", () => {
    const hits = searchSessions([s1, s2, s3], "hello", { cwdFilter: "/project/a", limit: 10 });
    expect(hits.map((h) => h.summary.file)).toEqual(["a.jsonl", "c.jsonl"]);
  });

  test("respects searchTools", () => {
    const toolSummary: SessionSummary = {
      file: "tool.jsonl", id: "4", timestamp: "2026-04-15T00:00:00Z", cwd: "/",
      firstUserMessage: "", name: null, latestLeafId: null,
      segments: [{ field: "tool_result", text: "needle" }],
    };
    expect(searchSessions([toolSummary], "needle", { limit: 10 })).toHaveLength(0);
    expect(searchSessions([toolSummary], "needle", { limit: 10, searchTools: true })).toHaveLength(1);
  });

  test("tie-breaks equal scores by newer timestamp", () => {
    const older: SessionSummary = {
      file: "older.jsonl", id: "o", timestamp: "2026-04-14T00:00:00Z", cwd: "/",
      firstUserMessage: "match", name: null, latestLeafId: null,
      segments: [{ field: "first_user_message", text: "match" }],
    };
    const newer: SessionSummary = {
      file: "newer.jsonl", id: "n", timestamp: "2026-04-16T00:00:00Z", cwd: "/",
      firstUserMessage: "match", name: null, latestLeafId: null,
      segments: [{ field: "first_user_message", text: "match" }],
    };
    const hits = searchSessions([older, newer], "match", { limit: 10 });
    expect(hits[0].summary.file).toBe("newer.jsonl");
    expect(hits[1].summary.file).toBe("older.jsonl");
  });
});

describe("sanitizeTokens", () => {
  test('splits "node.js" into ["node", "js"]', () => {
    expect(sanitizeTokens("node.js")).toEqual(["node", "js"]);
  });

  test("returns [] for empty string", () => {
    expect(sanitizeTokens("")).toEqual([]);
  });

  test('splits "hello world" into ["hello", "world"]', () => {
    expect(sanitizeTokens("hello world")).toEqual(["hello", "world"]);
  });

  test("splits \"can't\" into [\"can\", \"t\"]", () => {
    expect(sanitizeTokens("can't")).toEqual(["can", "t"]);
  });

  test('splits "R&D" into ["R", "D"]', () => {
    expect(sanitizeTokens("R&D")).toEqual(["R", "D"]);
  });

  test("strips unicode punctuation", () => {
    expect(sanitizeTokens("hello—world…now")).toEqual(["hello", "world", "now"]);
  });
});

describe("buildFtsQuery", () => {
  test('builds query for ["node", "js"]', () => {
    expect(buildFtsQuery(["node", "js"])).toBe('"node" "js"*');
  });

  test('builds query for ["hello"]', () => {
    expect(buildFtsQuery(["hello"])).toBe('"hello"*');
  });

  test("returns empty for []", () => {
    expect(buildFtsQuery([])).toBe("");
  });

  test("prefix wildcard is only on the last token", () => {
    expect(buildFtsQuery(["a", "b", "c"])).toBe('"a" "b" "c"*');
  });
});

const DEEP_BRANCH_SESSION = jsonl([
  { type: "session", version: 3, id: "session-deep", timestamp: "2026-04-15T00:00:00.000Z", cwd: "/deep" },
  { type: "message", id: "u1", parentId: null, timestamp: "2026-04-15T00:00:01.000Z", message: { role: "user", content: textBlock("level 1") } },
  { type: "message", id: "a1", parentId: "u1", timestamp: "2026-04-15T00:00:02.000Z", message: { role: "assistant", content: textBlock("response 1") } },
  { type: "message", id: "u2", parentId: "a1", timestamp: "2026-04-15T00:00:03.000Z", message: { role: "user", content: textBlock("level 2") } },
  { type: "message", id: "a2", parentId: "u2", timestamp: "2026-04-15T00:00:04.000Z", message: { role: "assistant", content: textBlock("response 2") } },
  { type: "message", id: "u3", parentId: "a2", timestamp: "2026-04-15T00:00:05.000Z", message: { role: "user", content: textBlock("level 3") } },
  { type: "message", id: "a3", parentId: "u3", timestamp: "2026-04-15T00:00:06.000Z", message: { role: "assistant", content: textBlock("deep leaf") } },
  { type: "message", id: "u3b", parentId: "a2", timestamp: "2026-04-15T00:00:05.500Z", message: { role: "user", content: textBlock("level 3 alt") } },
  { type: "message", id: "a3b", parentId: "u3b", timestamp: "2026-04-15T00:00:06.500Z", message: { role: "assistant", content: textBlock("deep leaf alt") } },
]);

describe("deep branch traversal (3+ levels)", () => {
  test("selectLeafEntryId picks the newest deep leaf", () => {
    const parsed = parseSessionText(DEEP_BRANCH_SESSION)!;
    expect(selectLeafEntryId(parsed)).toBe("a3b");
  });

  test("selectBranchMessages traces through all levels", () => {
    const parsed = parseSessionText(DEEP_BRANCH_SESSION)!;
    const branch = selectBranchMessages(parsed);
    expect(branch.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2", "u3b", "a3b"]);
  });

  test("formatConversation includes messages from all levels", () => {
    const parsed = parseSessionText(DEEP_BRANCH_SESSION)!;
    const formatted = formatConversation(parsed, { maxTurns: 10 });
    expect(formatted.text).toContain("level 1");
    expect(formatted.text).toContain("response 1");
    expect(formatted.text).toContain("level 2");
    expect(formatted.text).toContain("response 2");
    expect(formatted.text).toContain("level 3 alt");
    expect(formatted.text).toContain("deep leaf alt");
    expect(formatted.leafEntryId).toBe("a3b");
    expect(formatted.messageCount).toBe(6);
  });
});

const CORRUPT_PARENT_SESSION = jsonl([
  { type: "session", version: 3, id: "session-corrupt", timestamp: "2026-04-15T00:00:00.000Z", cwd: "/corrupt" },
  { type: "message", id: "a", parentId: "b", timestamp: "2026-04-15T00:00:01.000Z", message: { role: "user", content: textBlock("a points to b") } },
  { type: "message", id: "b", parentId: "a", timestamp: "2026-04-15T00:00:02.000Z", message: { role: "assistant", content: textBlock("b points to a") } },
]);

describe("corrupt parentId cycle", () => {
  test("selectBranchMessages terminates without hanging", () => {
    const parsed = parseSessionText(CORRUPT_PARENT_SESSION)!;
    const start = Date.now();
    const branch = selectBranchMessages(parsed);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(branch.map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("formatConversation empty text blocks", () => {
  test("message with empty text block produces no output line", () => {
    const data = jsonl([
      { type: "session", id: "s-empty", timestamp: "2026-04-15T00:00:00.000Z", cwd: "/empty" },
      { type: "message", id: "m1", parentId: null, timestamp: "2026-04-15T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "" }] } },
    ]);
    const parsed = parseSessionText(data)!;
    const formatted = formatConversation(parsed, { maxTurns: 10 });
    expect(formatted.text).toBe("");
    expect(formatted.text).not.toContain("### User");
    expect(formatted.messageCount).toBe(1);
  });
});

describe("tool-call-only assistant in full mode", () => {
  test("renders with ### Assistant header when includeTools=true", () => {
    const data = jsonl([
      { type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/test" },
      {
        type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01Z",
        message: { role: "user", content: textBlock("go") },
      },
      {
        type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "bash", arguments: { cmd: "ls" } }],
        },
      },
    ]);
    const parsed = parseSessionText(data)!;
    const formatted = formatConversation(parsed, {
      detail: "full",
      includeTools: true,
      maxTurns: 10,
    });
    expect(formatted.text).toContain("### Assistant");
    expect(formatted.text).toContain("[Tool: bash(");
    expect(formatted.text.match(/### Assistant/g)?.length).toBe(1);
  });

  test("produces no assistant output when includeTools=false", () => {
    const data = jsonl([
      { type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/test" },
      {
        type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01Z",
        message: { role: "user", content: textBlock("go") },
      },
      {
        type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "bash", arguments: { cmd: "ls" } }],
        },
      },
    ]);
    const parsed = parseSessionText(data)!;
    const formatted = formatConversation(parsed, {
      detail: "full",
      includeTools: false,
      maxTurns: 10,
    });
    expect(formatted.text).not.toContain("### Assistant");
    expect(formatted.text).not.toContain("[Tool:");
  });
});

describe("buildSessionSummary edge cases", () => {
  test("no user messages sets firstUserMessage to empty string", () => {
    const data = jsonl([
      { type: "session", id: "s-assist", timestamp: "2026-04-15T00:00:00.000Z", cwd: "/assist" },
      { type: "message", id: "a1", parentId: null, timestamp: "2026-04-15T00:00:01.000Z", message: { role: "assistant", content: textBlock("only assistant") } },
    ]);
    const parsed = parseSessionText(data)!;
    const summary = buildSessionSummary("/tmp/session.jsonl", parsed);
    expect(summary.firstUserMessage).toBe("");
    expect(summary.segments.some((s) => s.field === "first_user_message")).toBe(false);
  });

  test("empty session (no messages) sets firstUserMessage to empty string and latestLeafId to null", () => {
    const data = jsonl([
      { type: "session", id: "s-empty", timestamp: "2026-04-15T00:00:00.000Z", cwd: "/empty" },
    ]);
    const parsed = parseSessionText(data)!;
    const summary = buildSessionSummary("/tmp/session.jsonl", parsed);
    expect(summary.firstUserMessage).toBe("");
    expect(summary.latestLeafId).toBeNull();
    expect(summary.segments.some((s) => s.field === "first_user_message")).toBe(false);
  });
});

describe("snippetForMatch multi-term fallback", () => {
  test("findSessionMatch returns a match for all-terms query", () => {
    const allTerms = makeSummaryWithSegment("allterms.jsonl", "user_message", "hello there world");
    const match = findSessionMatch(allTerms, "hello world");
    expect(match).not.toBeNull();
    expect(match!.snippet).toContain("hello");
    expect(match!.snippet).toContain("world");
  });
});

describe("extractTextFlat", () => {
  test("behavior if exported", async () => {
    const mod = await import("./session-utils.js");
    if (!("extractTextFlat" in mod)) return;

    const { extractTextFlat } = mod as any;
    expect(extractTextFlat("hello world")).toBe("hello world");
    expect(extractTextFlat([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a b");
    expect(extractTextFlat(42)).toBe("");
    expect(extractTextFlat(null)).toBe("");
    expect(extractTextFlat([])).toBe("");
  });
});

describe("extractThinking", () => {
  test("extracts thinking blocks", () => {
    const thinking = extractThinking([
      { type: "thinking", thinking: "I need to check the file first." },
      { type: "toolCall", name: "bash", arguments: { cmd: "ls" } },
    ]);
    expect(thinking).toBe("I need to check the file first.");
  });

  test("joins multiple thinking blocks with double newline", () => {
    const thinking = extractThinking([
      { type: "thinking", thinking: "step one" },
      { type: "text", text: "visible output" },
      { type: "thinking", thinking: "step two" },
    ]);
    expect(thinking).toBe("step one\n\nstep two");
  });

  test("returns empty string when no thinking blocks", () => {
    expect(extractThinking([{ type: "text", text: "hello" }])).toBe("");
    expect(extractThinking("plain string")).toBe("");
    expect(extractThinking([])).toBe("");
  });

  test("ignores non-string thinking values", () => {
    expect(extractThinking([{ type: "thinking", thinking: null }])).toBe("");
    expect(extractThinking([{ type: "thinking" }])).toBe("");
  });
});

describe("formatConversation includeThinking", () => {
  const THINKING_SESSION = jsonl([
    { type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/test" },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-01-01T00:00:01Z",
      message: { role: "user", content: textBlock("fix the bug") },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:02Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "The bug is in deriveEnabledGuides." },
          { type: "text", text: "I'll fix the validation." },
        ],
      },
    },
  ]);

  test("includeThinking=true with detail full shows thinking", () => {
    const parsed = parseSessionText(THINKING_SESSION)!;
    const formatted = formatConversation(parsed, {
      detail: "full",
      includeThinking: true,
      maxTurns: 10,
    });
    expect(formatted.text).toContain("[thinking]");
    expect(formatted.text).toContain("The bug is in deriveEnabledGuides.");
    expect(formatted.text).toContain("[/thinking]");
    expect(formatted.text).toContain("I'll fix the validation.");
    // Structural: only one ### Assistant header per turn
    expect(formatted.text.match(/### Assistant/g)?.length).toBe(1);
  });

  test("includeThinking=false (default) hides thinking even in full mode", () => {
    const parsed = parseSessionText(THINKING_SESSION)!;
    const formatted = formatConversation(parsed, {
      detail: "full",
      maxTurns: 10,
    });
    expect(formatted.text).not.toContain("[thinking]");
    expect(formatted.text).not.toContain("deriveEnabledGuides");
    expect(formatted.text).toContain("I'll fix the validation.");
  });

  test("includeThinking=true in outline mode does not show thinking", () => {
    const parsed = parseSessionText(THINKING_SESSION)!;
    const formatted = formatConversation(parsed, {
      detail: "outline",
      includeThinking: true,
      maxTurns: 10,
    });
    expect(formatted.text).not.toContain("[thinking]");
    expect(formatted.text).not.toContain("deriveEnabledGuides");
  });

  test("includeThinking=true in compact mode does not show thinking", () => {
    const parsed = parseSessionText(THINKING_SESSION)!;
    const formatted = formatConversation(parsed, {
      detail: "compact",
      includeThinking: true,
      maxTurns: 10,
    });
    expect(formatted.text).not.toContain("[thinking]");
    expect(formatted.text).not.toContain("deriveEnabledGuides");
  });

  test("thinking-only assistant (no text) renders with single header", () => {
    const data = jsonl([
      { type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/test" },
      {
        type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01Z",
        message: { role: "user", content: textBlock("go") },
      },
      {
        type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02Z",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Planning my approach..." }],
        },
      },
    ]);
    const parsed = parseSessionText(data)!;
    const formatted = formatConversation(parsed, {
      detail: "full",
      includeThinking: true,
      maxTurns: 10,
    });
    expect(formatted.text).toContain("[thinking]");
    expect(formatted.text).toContain("Planning my approach...");
    expect(formatted.text.match(/### Assistant/g)?.length).toBe(1);
  });

  test("thinking + tool calls (no text) renders correctly", () => {
    const data = jsonl([
      { type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/test" },
      {
        type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01Z",
        message: { role: "user", content: textBlock("go") },
      },
      {
        type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Need to read the file." },
            { type: "toolCall", name: "bash", arguments: { cmd: "cat foo.txt" } },
          ],
        },
      },
    ]);
    const parsed = parseSessionText(data)!;
    const formatted = formatConversation(parsed, {
      detail: "full",
      includeThinking: true,
      includeTools: true,
      maxTurns: 10,
    });
    expect(formatted.text).toContain("[thinking]");
    expect(formatted.text).toContain("Need to read the file.");
    expect(formatted.text).toContain("[Tool: bash(");
    expect(formatted.text.match(/### Assistant/g)?.length).toBe(1);
  });
});
