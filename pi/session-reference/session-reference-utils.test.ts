import { describe, expect, test } from "bun:test";

import {
  buildSessionSummary,
  clampPositiveInteger,
  findSessionMatch,
  formatConversation,
  isPathWithinDir,
  isSameProjectPath,
  parseSessionText,
} from "./session-reference-utils.js";

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

describe("session reference utils", () => {
  test("formatConversation follows the newest leaf by default", () => {
    const parsed = parseSessionText(BRANCHED_SESSION);
    expect(parsed).not.toBeNull();

    const formatted = formatConversation(parsed!, { maxTurns: 10 });
    expect(formatted.leafEntryId).toBe("a-new");
    expect(formatted.text).toContain("new leaf mentions zeroclaw");
    expect(formatted.text).not.toContain("old leaf");
  });

  test("formatConversation can anchor to an explicit branch entry", () => {
    const parsed = parseSessionText(BRANCHED_SESSION);
    expect(parsed).not.toBeNull();

    const formatted = formatConversation(parsed!, { entryId: "a-old", maxTurns: 10 });
    expect(formatted.leafEntryId).toBe("a-old");
    expect(formatted.text).toContain("old leaf");
    expect(formatted.text).not.toContain("new leaf mentions zeroclaw");
  });

  test("buildSessionSummary + findSessionMatch search later assistant text, not just first user message", () => {
    const parsed = parseSessionText(BRANCHED_SESSION);
    expect(parsed).not.toBeNull();

    const summary = buildSessionSummary("/tmp/session-1.jsonl", parsed!);
    const match = findSessionMatch(summary, "zeroclaw");

    expect(match).not.toBeNull();
    expect(match!.field).toBe("assistant_message");
    expect(match!.entryId).toBe("a-new");
    expect(match!.snippet).toContain("zeroclaw");
  });

  test("tool-result search is opt-in", () => {
    const parsed = parseSessionText(TOOL_RESULT_SESSION);
    expect(parsed).not.toBeNull();

    const summary = buildSessionSummary("/tmp/session-2.jsonl", parsed!);
    expect(findSessionMatch(summary, "super-secret-needle")).toBeNull();

    const toolMatch = findSessionMatch(summary, "super-secret-needle", { searchTools: true });
    expect(toolMatch).not.toBeNull();
    expect(toolMatch!.field).toBe("tool_result");
    expect(toolMatch!.entryId).toBe("t1");
  });

  test("content matches outrank plain cwd matches inside the same session", () => {
    const parsed = parseSessionText(CONTENT_BEATS_PATH_SESSION);
    expect(parsed).not.toBeNull();

    const summary = buildSessionSummary("/tmp/session-3.jsonl", parsed!);
    const match = findSessionMatch(summary, "zeroclaw");

    expect(match).not.toBeNull();
    expect(["first_user_message", "user_message", "assistant_message"]).toContain(match!.field);
  });

  test("isSameProjectPath matches parent and child directories", () => {
    expect(isSameProjectPath("/workspace/project", "/workspace/project/subdir")).toBe(true);
    expect(isSameProjectPath("/workspace/project/subdir", "/workspace/project")).toBe(true);
    expect(isSameProjectPath("/workspace/project-a", "/workspace/project-b")).toBe(false);
  });

  test("isPathWithinDir rejects traversal outside the root", () => {
    expect(isPathWithinDir("/root/sessions", "/root/sessions/a.jsonl")).toBe(true);
    expect(isPathWithinDir("/root/sessions", "/root/sessions/nested/b.jsonl")).toBe(true);
    expect(isPathWithinDir("/root/sessions", "/root/other/b.jsonl")).toBe(false);
  });

  test("clampPositiveInteger coerces invalid values to a safe range", () => {
    expect(clampPositiveInteger(undefined, 10, 50)).toBe(10);
    expect(clampPositiveInteger(0, 10, 50)).toBe(10);
    expect(clampPositiveInteger(999, 10, 50)).toBe(50);
    expect(clampPositiveInteger(12.8, 10, 50)).toBe(12);
  });
});
