import { describe, expect, test } from "bun:test";

import {
  buildSessionSummary,
  clampPositiveInteger,
  compareTimestampDesc,
  extractText,
  extractToolCalls,
  filterByCwd,
  findSessionMatch,
  formatConversation,
  formatSessionChoiceLabel,
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
    const withTools = formatConversation(parsed, { includeTools: true, maxTurns: 10 });
    expect(withTools.text).toContain("[Result (bash): super-secret-needle]");

    const withoutTools = formatConversation(parsed, { includeTools: false, maxTurns: 10 });
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
    const formatted = formatConversation(parsed, { includeTools: true, maxTurns: 10 });
    expect(formatted.text).toContain("[Tool: bash(");
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

describe("formatSessionChoiceLabel", () => {
  test("includes name when present", () => {
    const summary: SessionSummary = {
      file: "/tmp/s.jsonl",
      id: "abc-123-def",
      timestamp: "2026-04-15T00:00:00.000Z",
      cwd: "/project",
      firstUserMessage: "hello",
      name: "My Session",
      latestLeafId: null,
      segments: [],
    };
    const label = formatSessionChoiceLabel(summary);
    expect(label).toContain("My Session");
    expect(label).toContain("abc-123");
  });

  test("falls back to firstUserMessage when name is absent", () => {
    const summary: SessionSummary = {
      file: "/tmp/s.jsonl",
      id: "abc-123-def",
      timestamp: "2026-04-15T00:00:00.000Z",
      cwd: "/project",
      firstUserMessage: "hello world",
      name: null,
      latestLeafId: null,
      segments: [],
    };
    const label = formatSessionChoiceLabel(summary);
    expect(label).toContain("hello world");
  });

  test("falls back to (empty) when both name and firstUserMessage are absent", () => {
    const summary: SessionSummary = {
      file: "/tmp/s.jsonl",
      id: "abc-123-def",
      timestamp: "2026-04-15T00:00:00.000Z",
      cwd: "/project",
      firstUserMessage: "",
      name: null,
      latestLeafId: null,
      segments: [],
    };
    const label = formatSessionChoiceLabel(summary);
    expect(label).toContain("(empty)");
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
