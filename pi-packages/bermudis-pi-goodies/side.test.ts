import { describe, expect, test } from "bun:test";
import type {
  CustomEntry,
  CustomMessageEntry,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  buildLensMessages,
  buildSummaryHandoff,
  buildTrajectoryHandoff,
  collectCoveredUpTo,
  deltaSideEntries,
  filterExitCompletions,
  findSideBoundary,
  parseExitMode,
  parseModelArg,
  parseSideMarkerData,
} from "./side.ts";

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
): MessageEntry {
  return {
    type: "message",
    id: id(),
    parentId: "root",
    timestamp: new Date(timestamp).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      model,
      timestamp,
    },
  };
}

function markerEntry(data: unknown, timestamp = 3): CustomEntry {
  return {
    type: "custom",
    customType: "side-session",
    data,
    id: id(),
    parentId: "root",
    timestamp: new Date(timestamp).toISOString(),
  };
}

function handoffEntry(details: unknown, timestamp = 4): CustomMessageEntry {
  return {
    type: "custom_message",
    customType: "side-transcript",
    content: "delivered",
    display: true,
    details,
    id: id(),
    parentId: "root",
    timestamp: new Date(timestamp).toISOString(),
  };
}

const markerData = {
  v: 1 as const,
  sideModel: { provider: "kilo", id: "glm-5.3" },
  mainModel: { provider: "anthropic", id: "sonnet-4.5" },
  mainTipId: "tip-1",
};

function branchWithSide(): SessionEntry[] {
  return [
    userEntry("do you agree with the findings in docs/v1-usage-findings.md?"),
    assistantEntry("Let me verify before I opine.", "anthropic/sonnet-4.5"),
    markerEntry(markerData),
    userEntry("what are your thoughts on this?"),
    assistantEntry("Three reservations.", "kilo/glm-5.3"),
  ];
}

describe("findSideBoundary / parseSideMarkerData", () => {
  test("no marker on a plain branch", () => {
    expect(findSideBoundary([userEntry("hi")])).toBe(-1);
  });

  test("finds the marker index and ignores unrelated custom entries", () => {
    const unrelated: CustomEntry = {
      ...markerEntry({ v: 1 }),
      customType: "something-else",
    };
    const entries = [
      userEntry("hi"),
      unrelated,
      markerEntry(markerData),
      userEntry("q"),
    ];
    expect(findSideBoundary(entries)).toBe(2);
  });

  test("parses valid marker data and rejects malformed", () => {
    expect(parseSideMarkerData(markerData)).toEqual(markerData);
    expect(parseSideMarkerData(null)).toBeNull();
    expect(parseSideMarkerData({ v: 1 })).toBeNull();
    expect(
      parseSideMarkerData({ sideModel: { provider: "kilo" }, mainTipId: "t" }),
    ).toBeNull();
    // mainModel is optional
    expect(
      parseSideMarkerData({
        sideModel: { provider: "k", id: "g" },
        mainTipId: "t",
      }),
    ).toEqual({ v: 1, sideModel: { provider: "k", id: "g" }, mainTipId: "t" });
  });
});

describe("buildLensMessages", () => {
  test("null when not a side session", () => {
    expect(buildLensMessages([userEntry("hi")], [])).toBeNull();
  });

  test("collapses the main trajectory into one attributed quote and keeps side turns native", () => {
    const messages = buildLensMessages(branchWithSide(), [])!;
    expect(messages).not.toBeNull();

    // One quote message + the side limb's two messages.
    expect(messages.length).toBe(3);

    const quote = messages[0]!;
    expect(quote.role).toBe("user");
    const text = JSON.stringify(quote.content);
    expect(text).toContain("side consultant");
    expect(text).toContain("were NOT a participant");
    expect(text).toContain("untrusted quoted evidence");
    expect(text).toContain("## User");
    expect(text).toContain("## Assistant (anthropic/sonnet-4.5)");
    expect(text).toContain("do you agree with the findings");
    // Side turns must not be duplicated inside the quote.
    expect(text).not.toContain("what are your thoughts on this?");

    // Side limb turns pass through unchanged, before the new prompt guard.
    expect(messages[1]).toMatchObject({ role: "user" });
    expect(messages[2]).toMatchObject({ role: "assistant" });
  });

  test("keeps an unlanded in-flight prompt on the first side turn", () => {
    const entries = branchWithSide().slice(0, 3); // marker is the leaf
    const inFlight = {
      role: "user",
      content: [{ type: "text", text: "what are your thoughts?" }],
      timestamp: 9,
    } as unknown as Parameters<typeof buildLensMessages>[1][number];
    const messages = buildLensMessages(entries, [inFlight])!;
    expect(messages.length).toBe(2);
    expect(messages[messages.length - 1]).toBe(inFlight);
  });

  test("empty main trajectory still yields a coherent quote", () => {
    const entries = [markerEntry(markerData), userEntry("q")];
    const messages = buildLensMessages(entries, [])!;
    expect(JSON.stringify(messages[0])).toContain(
      "(the main session has no messages yet)",
    );
  });
});

describe("delta tracking", () => {
  test("collectCoveredUpTo keys on markerId and takes the latest in file order", () => {
    const other = handoffEntry({
      markerId: "other-marker",
      coveredUpTo: "e99",
      model: markerData.sideModel,
      kind: "trajectory",
      turnCount: 2,
    });
    const first = handoffEntry({
      markerId: "m1",
      coveredUpTo: "e5",
      model: markerData.sideModel,
      kind: "trajectory",
      turnCount: 2,
    });
    const second = handoffEntry({
      markerId: "m1",
      coveredUpTo: "e9",
      model: markerData.sideModel,
      kind: "summary",
      turnCount: 4,
    });
    expect(collectCoveredUpTo([other, first, second], "m1")).toBe("e9");
    expect(
      collectCoveredUpTo([other, first, second], "missing"),
    ).toBeUndefined();
  });

  test("deltaSideEntries returns everything when nothing was covered", () => {
    const side = [userEntry("a"), assistantEntry("b", "kilo/glm-5.3")];
    expect(deltaSideEntries(side, undefined)).toEqual(side);
  });

  test("deltaSideEntries slices after the covered id", () => {
    const side = [
      userEntry("a"),
      assistantEntry("b", "kilo/glm-5.3"),
      userEntry("c"),
    ];
    const covered = side[1]!.id;
    expect(deltaSideEntries(side, covered)).toEqual([side[2]]);
  });

  test("deltaSideEntries re-delivers on a stale covered id rather than dropping", () => {
    const side = [userEntry("a")];
    expect(deltaSideEntries(side, "gone")).toEqual(side);
  });
});

describe("handoff content", () => {
  const turns = [
    { role: "User" as const, body: "what are your thoughts?" },
    {
      role: "Assistant" as const,
      model: "kilo/glm-5.3",
      body: "Three reservations.",
    },
  ];

  test("trajectory handoff frames the quote with attribution", () => {
    const text = buildTrajectoryHandoff(turns, markerData.sideModel);
    expect(text).toContain("were NOT a participant");
    expect(text).toContain("untrusted quoted evidence");
    expect(text).toContain("## Side transcript (kilo/glm-5.3, 2 turns)");
    expect(text).toContain("## Assistant (kilo/glm-5.3)");
  });

  test("summary handoff labels the summarizer and coverage", () => {
    const text = buildSummaryHandoff(
      "Consultant disagrees on finding #1.",
      5,
      markerData.sideModel,
    );
    expect(text).toContain("covering 5 turns");
    expect(text).toContain("Consultant disagrees on finding #1.");
  });
});

describe("arguments and completions", () => {
  test("parseExitMode: empty → dialog, valid → mode, invalid → null", () => {
    expect(parseExitMode("")).toBeUndefined();
    expect(parseExitMode("  ")).toBeUndefined();
    expect(parseExitMode("trajectory")).toBe("trajectory");
    expect(parseExitMode(" summary ")).toBe("summary");
    expect(parseExitMode("nothing")).toBe("nothing");
    expect(parseExitMode("summarize")).toBeNull();
  });

  test("filterExitCompletions matches by prefix and nulls out when empty", () => {
    expect(filterExitCompletions("")).toEqual([
      { value: "trajectory", label: "trajectory" },
      { value: "summary", label: "summary" },
      { value: "nothing", label: "nothing" },
    ]);
    expect(filterExitCompletions("s")).toEqual([
      { value: "summary", label: "summary" },
    ]);
    expect(filterExitCompletions("su")).toEqual([
      { value: "summary", label: "summary" },
    ]);
    expect(filterExitCompletions("xyz")).toBeNull();
  });

  test("parseModelArg splits on the first slash only", () => {
    expect(parseModelArg("kilo/glm-5.3")).toEqual({
      provider: "kilo",
      id: "glm-5.3",
    });
    expect(parseModelArg("openai/org/model-id")).toEqual({
      provider: "openai",
      id: "org/model-id",
    });
    expect(parseModelArg("noslash")).toBeUndefined();
    expect(parseModelArg("/leading")).toBeUndefined();
    expect(parseModelArg("trailing/")).toBeUndefined();
  });
});
