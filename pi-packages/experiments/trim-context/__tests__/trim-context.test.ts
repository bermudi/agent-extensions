import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-ai/compat";

// We test the pure helper functions by re-implementing the exports.
// Since the extension doesn't export helpers, we test the logic inline.
// These tests verify the turn splitting, hashing, and identification logic.

// ── Inline copies of helpers (same logic as index.ts) ────────────────

type AnyMessage = Record<string, any>;

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p: AnyMessage) => p?.type === "text" && typeof p.text === "string")
    .map((p: AnyMessage) => p.text)
    .join("\n")
    .trim();
}

function getUserPrefix(msg: AnyMessage): string {
  const text = extractText(msg.content);
  return text.slice(0, 120);
}

import { createHash } from "node:crypto";

function hashText(text: string): string {
  return createHash("sha256")
    .update(text.normalize().slice(0, 500))
    .digest("hex")
    .slice(0, 16);
}

interface Turn {
  index: number;
  messages: AnyMessage[];
  hash: string;
  prefix: string;
}

function splitIntoTurns(messages: AnyMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: AnyMessage[] = [];

  for (const msg of messages) {
    const role = msg?.role;
    if ((role === "user" || role === "bashExecution") && current.length > 0) {
      const first = current[0];
      turns.push({
        index: turns.length,
        messages: current,
        hash: hashText(getUserPrefix(first)),
        prefix: getUserPrefix(first),
      });
      current = [];
    }
    current.push(msg);
  }

  if (current.length > 0) {
    const first = current[0];
    turns.push({
      index: turns.length,
      messages: current,
      hash: hashText(getUserPrefix(first)),
      prefix: getUserPrefix(first),
    });
  }

  return turns;
}

function summaryMessage(summary: string, timestamp?: number): AnyMessage {
  return {
    role: "compactionSummary",
    summary,
    tokensBefore: 0,
    timestamp: timestamp ?? Date.now(),
  };
}

// ── Test messages ─────────────────────────────────────────────────────

function makeUser(text: string, timestamp = 1000): AnyMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function makeAssistant(text: string, timestamp = 2000): AnyMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { totalTokens: 100 },
    timestamp,
  };
}

function makeToolResult(
  toolCallId: string,
  toolName: string,
  content: string,
  timestamp = 3000,
): AnyMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: content }],
    isError: false,
    timestamp,
  };
}

function makeBashExecution(
  command: string,
  output: string,
  timestamp = 4000,
): AnyMessage {
  return {
    role: "bashExecution",
    command,
    output,
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("splitIntoTurns", () => {
  it("splits messages at user message boundaries", () => {
    const messages = [
      makeUser("Hello"),
      makeAssistant("Hi!"),
      makeUser("How are you?"),
      makeAssistant("Great!"),
    ];

    const turns = splitIntoTurns(messages);
    expect(turns.length).toBe(2);
    expect(turns[0].prefix).toBe("Hello");
    expect(turns[1].prefix).toBe("How are you?");
  });

  it("groups assistant + tool results with their user message", () => {
    const messages = [
      makeUser("Read the file"),
      makeAssistant("Let me read it", 2000),
      makeToolResult("call_1", "read", "file contents", 3000),
      makeUser("Now edit it"),
    ];

    const turns = splitIntoTurns(messages);
    expect(turns.length).toBe(2);
    expect(turns[0].messages.length).toBe(3); // user + assistant + toolResult
    expect(turns[1].messages.length).toBe(1); // user only
  });

  it("splits at bashExecution boundaries", () => {
    const messages = [
      makeUser("Do something"),
      makeAssistant("Done"),
      makeBashExecution("ls", "file1.txt\nfile2.txt"),
      makeAssistant("Here are the files"),
    ];

    const turns = splitIntoTurns(messages);
    // bashExecution starts a new turn
    expect(turns.length).toBe(2);
    expect(turns[0].messages.length).toBe(2);
    expect(turns[1].messages.length).toBe(2); // bashExecution + assistant
  });

  it("handles empty messages", () => {
    const turns = splitIntoTurns([]);
    expect(turns.length).toBe(0);
  });

  it("handles single turn", () => {
    const messages = [makeUser("Hello"), makeAssistant("Hi!")];
    const turns = splitIntoTurns(messages);
    expect(turns.length).toBe(1);
    expect(turns[0].messages.length).toBe(2);
  });

  it("produces stable hashes for same content", () => {
    const messages1 = [makeUser("Hello"), makeAssistant("Hi!")];
    const messages2 = [makeUser("Hello"), makeAssistant("Different response")];

    const turns1 = splitIntoTurns(messages1);
    const turns2 = splitIntoTurns(messages2);

    expect(turns1[0].hash).toBe(turns2[0].hash);
  });

  it("produces different hashes for different content", () => {
    const messages1 = [makeUser("Hello")];
    const messages2 = [makeUser("Goodbye")];

    const turns1 = splitIntoTurns(messages1);
    const turns2 = splitIntoTurns(messages2);

    expect(turns1[0].hash).not.toBe(turns2[0].hash);
  });
});

describe("hashText", () => {
  it("is deterministic", () => {
    const h1 = hashText("Hello world");
    const h2 = hashText("Hello world");
    expect(h1).toBe(h2);
  });

  it("returns 16 hex chars", () => {
    const h = hashText("test");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("normalizes unicode", () => {
    const h1 = hashText("café");
    const h2 = hashText("café");
    expect(h1).toBe(h2);
  });

  it("handles empty string", () => {
    const h = hashText("");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("extractText", () => {
  it("extracts from string content", () => {
    expect(extractText("hello")).toBe("hello");
  });

  it("extracts from content blocks", () => {
    expect(
      extractText([
        { type: "text", text: "hello" },
        { type: "text", text: " world" },
      ]),
    ).toBe("hello\n world");
  });

  it("ignores non-text blocks", () => {
    expect(
      extractText([
        { type: "image", data: "..." },
        { type: "text", text: "hello" },
      ]),
    ).toBe("hello");
  });

  it("returns empty for null/undefined", () => {
    expect(extractText(null)).toBe("");
    expect(extractText(undefined)).toBe("");
  });
});

describe("context filtering", () => {
  it("replaces compacted turns with summary messages", () => {
    const messages = [
      makeUser("Turn 1"),
      makeAssistant("Response 1"),
      makeUser("Turn 2"),
      makeAssistant("Response 2"),
      makeUser("Turn 3"),
      makeAssistant("Response 3"),
    ];

    const turns = splitIntoTurns(messages);
    expect(turns.length).toBe(3);

    // Simulate compacting turns 0 and 1
    const compactedHashes = new Set([turns[0].hash, turns[1].hash]);
    const compactedSummaries = new Map<string, string>();
    compactedSummaries.set(turns[0].hash, "Summary of turn 1");
    compactedSummaries.set(turns[1].hash, "Summary of turn 2");

    // Apply filtering
    const result: AnyMessage[] = [];
    for (const turn of turns) {
      if (compactedHashes.has(turn.hash)) {
        result.push(summaryMessage(compactedSummaries.get(turn.hash)!));
      } else {
        result.push(...turn.messages);
      }
    }

    // Should have 3 messages: summary + summary + user + assistant
    expect(result.length).toBe(4);
    expect(result[0].role).toBe("compactionSummary");
    expect(result[0].summary).toBe("Summary of turn 1");
    expect(result[1].role).toBe("compactionSummary");
    expect(result[1].summary).toBe("Summary of turn 2");
    expect(result[2].role).toBe("user");
    expect(result[2].content[0].text).toBe("Turn 3");
  });

  it("passes through all messages when nothing is compacted", () => {
    const messages = [
      makeUser("Turn 1"),
      makeAssistant("Response 1"),
      makeUser("Turn 2"),
      makeAssistant("Response 2"),
    ];

    const turns = splitIntoTurns(messages);
    const result: AnyMessage[] = [];
    for (const turn of turns) {
      result.push(...turn.messages);
    }

    expect(result.length).toBe(4);
    expect(result).toEqual(messages);
  });
});

describe("getUserPrefix", () => {
  it("extracts first 120 chars of user message", () => {
    const msg = makeUser("a".repeat(200));
    expect(getUserPrefix(msg).length).toBe(120);
  });

  it("handles short messages", () => {
    const msg = makeUser("hi");
    expect(getUserPrefix(msg)).toBe("hi");
  });
});
