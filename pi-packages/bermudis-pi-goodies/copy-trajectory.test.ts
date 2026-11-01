import { describe, expect, test } from "bun:test";
import type {
  CustomEntry,
  CustomMessageEntry,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { buildTrajectory, renderTrajectory } from "./copy-trajectory.ts";

let nextId = 0;
const id = (): string => `e${nextId++}`;

type MessageEntry = Extract<SessionEntry, { type: "message" }>;

function userEntry(text: string, timestamp = 1): MessageEntry {
  return {
    type: "message",
    id: id(),
    parentId: "root",
    timestamp: new Date(timestamp).toISOString(),
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp,
    },
  };
}

function assistantEntry(
  text: string,
  model: string,
  timestamp = 2,
  extra?: { responseModel?: string; thinking?: string },
): MessageEntry {
  const content: Record<string, unknown>[] = [{ type: "text", text }];
  if (extra?.thinking !== undefined) {
    content.unshift({ type: "thinking", thinking: extra.thinking });
  }
  return {
    type: "message",
    id: id(),
    parentId: "root",
    timestamp: new Date(timestamp).toISOString(),
    message: {
      role: "assistant",
      content,
      model,
      ...(extra?.responseModel ? { responseModel: extra.responseModel } : {}),
      timestamp,
    },
  };
}

function injectedEntry(
  customType: string,
  content: string | Record<string, unknown>[],
  display = true,
  timestamp = 3,
): CustomMessageEntry {
  return {
    type: "custom_message",
    customType,
    content: content as CustomMessageEntry["content"],
    display,
    id: id(),
    parentId: "root",
    timestamp: new Date(timestamp).toISOString(),
  };
}

function branchSummaryEntry(summary: string, timestamp = 3): SessionEntry {
  return {
    type: "branch_summary",
    fromId: "e0",
    summary,
    id: id(),
    parentId: "root",
    timestamp: new Date(timestamp).toISOString(),
  };
}

describe("buildTrajectory: conversation turns", () => {
  test("projects user and assistant text with model attribution", () => {
    const turns = buildTrajectory(
      [userEntry("question"), assistantEntry("answer", "anthropic/sonnet")],
      false,
    );
    expect(turns).toEqual([
      { role: "User", model: undefined, body: "question" },
      { role: "Assistant", model: "anthropic/sonnet", body: "answer" },
    ]);
  });

  test("prefers responseModel over the requested model", () => {
    const turns = buildTrajectory(
      [
        assistantEntry("answer", "requested-model", 2, {
          responseModel: "resolved-model",
        }),
      ],
      false,
    );
    expect(turns[0]?.model).toBe("resolved-model");
  });

  test("excludes thinking by default and quotes it when asked", () => {
    const entry = assistantEntry("answer", "m", 2, {
      thinking: "inner monologue",
    });
    expect(buildTrajectory([entry], false)[0]?.body).toBe("answer");
    // Thinking is appended after the text parts, quoted line by line.
    expect(buildTrajectory([entry], true)[0]?.body).toBe(
      "answer\n> inner monologue",
    );
  });

  test("skips tool-result messages and empty bodies", () => {
    const toolResult: MessageEntry = {
      type: "message",
      id: id(),
      parentId: "root",
      timestamp: new Date(1).toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
        isError: false,
        timestamp: 1,
      },
    };
    expect(buildTrajectory([toolResult], false)).toEqual([]);
  });
});

describe("buildTrajectory: injected context", () => {
  test("includes displayed custom messages as attributed context turns", () => {
    const turns = buildTrajectory(
      [injectedEntry("side-transcript", "side summary body")],
      false,
    );
    expect(turns).toEqual([
      { role: "Context", source: "side-transcript", body: "side summary body" },
    ]);
  });

  test("extracts text from block-array custom message content", () => {
    const turns = buildTrajectory(
      [
        injectedEntry("external-changes", [
          { type: "text", text: "diff one" },
          { type: "text", text: "diff two" },
        ]),
      ],
      false,
    );
    expect(turns[0]?.body).toBe("diff one\ndiff two");
  });

  test("skips hidden (display: false) injections and image-only bodies", () => {
    expect(
      buildTrajectory([injectedEntry("machinery", "invisible", false)], false),
    ).toEqual([]);
    expect(
      buildTrajectory(
        [injectedEntry("pic", [{ type: "image", data: "…" }])],
        false,
      ),
    ).toEqual([]);
  });

  test("includes branch summaries — the only record of an abandoned limb", () => {
    const turns = buildTrajectory([branchSummaryEntry("what happened")], false);
    expect(turns).toEqual([
      { role: "Context", source: "branch summary", body: "what happened" },
    ]);
  });

  test("skips compaction summaries: raw originals stay on the branch", () => {
    const compaction: SessionEntry = {
      type: "compaction",
      summary: "summary of dropped turns",
      firstKeptEntryId: "e0",
      tokensBefore: 1000,
      id: id(),
      parentId: "root",
      timestamp: new Date(1).toISOString(),
    };
    expect(
      buildTrajectory([compaction, userEntry("kept question")], false),
    ).toEqual([{ role: "User", model: undefined, body: "kept question" }]);
  });

  test("skips side markers and other custom machinery entries", () => {
    const marker: CustomEntry = {
      type: "custom",
      customType: "side-session",
      data: { v: 1 },
      id: id(),
      parentId: "root",
      timestamp: new Date(1).toISOString(),
    };
    expect(buildTrajectory([marker], false)).toEqual([]);
  });
});

describe("renderTrajectory", () => {
  test("headers: roles, model attribution, injected context", () => {
    const text = renderTrajectory([
      { role: "User", body: "question" },
      { role: "Assistant", model: "anthropic/sonnet", body: "answer" },
      { role: "Context", source: "side-transcript", body: "consultant spoke" },
    ]);
    expect(text).toBe(
      "## User\n\nquestion\n\n" +
        "## Assistant (anthropic/sonnet)\n\nanswer\n\n" +
        "## Injected context (side-transcript)\n\nconsultant spoke",
    );
  });

  test("a delivered side handoff sits between the turns that reference it", () => {
    const turns = buildTrajectory(
      [
        userEntry("check the warmer"),
        assistantEntry("here is my verdict", "anthropic/sonnet"),
        injectedEntry(
          "side-transcript",
          "A side consultation ran alongside this session…",
        ),
        userEntry("wtf is wrong with you???"),
        assistantEntry("Fair question.", "anthropic/sonnet", 5, {
          thinking: "let me answer straight",
        }),
      ],
      false,
    );
    const text = renderTrajectory(turns);
    const handoffIdx = text.indexOf("## Injected context (side-transcript)");
    const userIdx = text.indexOf("wtf is wrong with you???");
    const answerIdx = text.indexOf("Fair question.");
    expect(handoffIdx).toBeGreaterThan(0);
    expect(userIdx).toBeGreaterThan(handoffIdx);
    expect(answerIdx).toBeGreaterThan(userIdx);
  });
});
