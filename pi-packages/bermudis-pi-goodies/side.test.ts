import { describe, expect, test } from "bun:test";
import type {
  CustomEntry,
  CustomMessageEntry,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  activeSideModel,
  buildLensMessages,
  buildSummaryHandoff,
  buildTrajectoryHandoff,
  collectCoveredUpTo,
  deltaSideEntries,
  filterExitCompletions,
  filterSideModelCompletions,
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
    expect(parseSideMarkerData(markerData)).toEqual({
      ...markerData,
      mainModel: markerData.mainModel,
      mainThinkingLevel: undefined,
      sideThinkingLevel: undefined,
    });
    expect(parseSideMarkerData(null)).toBeNull();
    expect(parseSideMarkerData({ v: 1 })).toBeNull();
    expect(
      parseSideMarkerData({ sideModel: { provider: "kilo" }, mainTipId: "t" }),
    ).toBeNull();
    // mainModel is optional
    expect(
      parseSideMarkerData({
        v: 1,
        sideModel: { provider: "k", id: "g" },
        mainTipId: "t",
      }),
    ).toEqual({
      v: 1,
      sideModel: { provider: "k", id: "g" },
      mainModel: undefined,
      mainThinkingLevel: undefined,
      sideThinkingLevel: undefined,
      mainTipId: "t",
    });
  });

  test("rejects unknown or missing format versions instead of misreading", () => {
    expect(parseSideMarkerData({ ...markerData, v: 2 })).toBeNull();
    const { v: _v, ...noVersion } = markerData;
    expect(parseSideMarkerData(noVersion)).toBeNull();
  });

  test("round-trips parked thinking levels, rejects unknown ones", () => {
    const withLevels = {
      ...markerData,
      mainThinkingLevel: "low",
      sideThinkingLevel: "max",
    };
    expect(parseSideMarkerData(withLevels)).toEqual(withLevels);
    expect(
      parseSideMarkerData({ ...markerData, mainThinkingLevel: "ultra" }),
    ).toEqual({
      ...markerData,
      mainThinkingLevel: undefined,
      sideThinkingLevel: undefined,
    });
  });
});

describe("buildLensMessages", () => {
  const lens = (
    aware: SessionEntry[],
    raw = aware,
    event: Parameters<typeof buildLensMessages>[3] = [],
  ) => buildLensMessages(aware, raw, findSideBoundary(raw), event);

  test("null when not a side session", () => {
    expect(lens([userEntry("hi")])).toBeNull();
  });

  test("collapses the main trajectory into one attributed quote and keeps side turns native", () => {
    const messages = lens(branchWithSide())!;
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

  test("compacted-away main history reaches the quote as a summary turn, not raw turns", () => {
    const raw = branchWithSide();
    // Aware view after compaction cut past the main history and the marker:
    // compaction entry + kept side entries only.
    const aware: SessionEntry[] = [
      {
        type: "compaction",
        summary: "The user asked about v1 findings; the agent verified them.",
        firstKeptEntryId: raw[3]!.id,
        tokensBefore: 90000,
        id: id(),
        parentId: "root",
        timestamp: new Date(5).toISOString(),
      },
      raw[3]!,
      raw[4]!,
    ];
    const messages = lens(aware, raw)!;

    expect(messages.length).toBe(3); // quote + two side messages
    const text = JSON.stringify(messages[0]);
    expect(text).toContain("compaction summary of earlier history");
    expect(text).toContain("The user asked about v1 findings");
    // Compacted-away raw main turns must not be resent.
    expect(text).not.toContain("do you agree with the findings");
    // Side entries stay native outside the quote.
    expect(messages[1]).toMatchObject({ role: "user" });
  });

  test("prior handoffs on the main limb are visible to a later side consult", () => {
    const priorHandoff = handoffEntry({
      markerId: "old-marker",
      coveredUpTo: "e0",
      model: { provider: "kilo", id: "glm-5.3" },
      kind: "summary",
      turnCount: 4,
    });
    (priorHandoff as { content: string }).content =
      "The consultant disagreed with finding #1 (full-schema emission, not intent).";
    const raw: SessionEntry[] = [
      userEntry("question"),
      priorHandoff,
      markerEntry(markerData),
      userEntry("second consult"),
    ];
    const messages = lens(raw)!;
    const text = JSON.stringify(messages[0]);
    expect(text).toContain("prior side summary handoff");
    expect(text).toContain("disagreed with finding #1");
    expect(text).toContain("## Assistant (kilo/glm-5.3)");
  });

  test("keeps an unlanded in-flight prompt on the first side turn", () => {
    const entries = branchWithSide().slice(0, 3); // marker is the leaf
    const inFlight = {
      role: "user",
      content: [{ type: "text", text: "what are your thoughts?" }],
      timestamp: 9,
    } as unknown as Parameters<typeof buildLensMessages>[3][number];
    const messages = lens(entries, entries, [inFlight])!;
    expect(messages.length).toBe(2);
    expect(messages[messages.length - 1]).toBe(inFlight);
  });

  test("side-limb compaction is quoted with a who-is-who caveat, not native history", () => {
    const raw: SessionEntry[] = [
      userEntry("main question"),
      assistantEntry("main answer", "anthropic/sonnet-4.5"),
      markerEntry(markerData),
      userEntry("side q1"),
      assistantEntry("side a1", "kilo/glm-5.3"),
      {
        type: "compaction",
        summary:
          "The user consulted a side model; the assistant verified findings and disagreed on finding #1.",
        firstKeptEntryId: "gone",
        tokensBefore: 50000,
        id: id(),
        parentId: "root",
        timestamp: new Date(8).toISOString(),
      },
      userEntry("side q2"),
    ];
    // Aware view: the latest compaction + entries after it only.
    const compaction = raw[5]!;
    const aware: SessionEntry[] = [compaction, raw[6]!];
    const messages = lens(aware, raw)!;

    expect(messages.length).toBe(2); // quote + native side q2
    const quoteText = JSON.stringify(messages[0]);
    expect(quoteText).toContain("machine-written");
    expect(quoteText).toContain(
      "may mix the main agent's and your own earlier turns",
    );
    expect(quoteText).toContain("disagreed on finding #1");
    // The compaction summary must NOT survive as a native side message.
    expect(JSON.stringify(messages[1])).not.toContain(
      "disagreed on finding #1",
    );
    expect(messages[1]).toMatchObject({ role: "user" });
  });

  test("empty main trajectory still yields a coherent quote", () => {
    const entries = [markerEntry(markerData), userEntry("q")];
    const messages = lens(entries)!;
    expect(JSON.stringify(messages[0])).toContain(
      "(the main session has no messages yet)",
    );
  });

  test("malformed marker index yields null instead of a guessed boundary", () => {
    expect(
      buildLensMessages(branchWithSide(), branchWithSide(), -1),
    ).toBeNull();
    expect(buildLensMessages([], [], 0)).toBeNull();
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
      baseId: "glm-5.3",
    });
    expect(parseModelArg("openai/org/model-id")).toEqual({
      provider: "openai",
      id: "org/model-id",
      baseId: "org/model-id",
    });
    expect(parseModelArg("noslash")).toBeUndefined();
    expect(parseModelArg("/leading")).toBeUndefined();
    expect(parseModelArg("trailing/")).toBeUndefined();
  });

  test("parseModelArg offers a thinking suffix without committing to it", () => {
    // :low parses as a level candidate; the caller tries the full id first.
    expect(parseModelArg("kilo/glm-5.3-flash:low")).toEqual({
      provider: "kilo",
      id: "glm-5.3-flash:low",
      baseId: "glm-5.3-flash",
      level: "low",
    });
    // A colon suffix that is not a known level stays part of the id (kilo :free).
    expect(parseModelArg("kilo/some-model:free")).toEqual({
      provider: "kilo",
      id: "some-model:free",
      baseId: "some-model:free",
    });
    expect(parseModelArg("kilo/a:bogus")).toEqual({
      provider: "kilo",
      id: "a:bogus",
      baseId: "a:bogus",
    });
    // A level-like suffix on an empty base id is not a level candidate.
    expect(parseModelArg("kilo/:low")).toEqual({
      provider: "kilo",
      id: ":low",
      baseId: ":low",
    });
  });
});

describe("activeSideModel", () => {
  test("prefers the last model_change after the marker over the marker's model", () => {
    const raw: SessionEntry[] = [
      userEntry("q"),
      markerEntry(markerData),
      {
        type: "model_change",
        provider: "kilo",
        modelId: "glm-5.3-flash",
        id: id(),
        parentId: "root",
        timestamp: new Date(6).toISOString(),
      },
      userEntry("side turn"),
      {
        type: "model_change",
        provider: "openai",
        modelId: "gpt-5.2",
        id: id(),
        parentId: "root",
        timestamp: new Date(7).toISOString(),
      },
    ];
    expect(activeSideModel(raw, markerData)).toEqual({
      provider: "openai",
      id: "gpt-5.2",
    });
  });

  test("falls back to the marker's model when no model_change follows it", () => {
    const raw = branchWithSide();
    expect(activeSideModel(raw, markerData)).toEqual(markerData.sideModel);
  });
});

describe("filterSideModelCompletions", () => {
  const registry = {
    getAvailable: () => [
      { provider: "kilo", id: "glm-5.3" },
      { provider: "kilo", id: "glm-5.3-flash" },
      { provider: "anthropic", id: "sonnet-4.5" },
      { provider: "kilo", id: "glm-5.3" }, // duplicate ref dedupes
    ],
  } as unknown as Parameters<typeof filterSideModelCompletions>[1];

  test("prefix-filters available models as provider/id", () => {
    expect(filterSideModelCompletions("kilo/", registry)).toEqual([
      { value: "kilo/glm-5.3", label: "kilo/glm-5.3" },
      { value: "kilo/glm-5.3-flash", label: "kilo/glm-5.3-flash" },
    ]);
    expect(filterSideModelCompletions("anthropic/son", registry)).toEqual([
      { value: "anthropic/sonnet-4.5", label: "anthropic/sonnet-4.5" },
    ]);
  });

  test("no registry or no matches yields null", () => {
    expect(filterSideModelCompletions("kilo/", undefined)).toBeNull();
    expect(filterSideModelCompletions("google/", registry)).toBeNull();
  });
});
