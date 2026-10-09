import { describe, expect, test } from "bun:test";
import {
  estimateTokens,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type {
  CustomEntry,
  CustomMessageEntry,
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  activeSideModel,
  applySideStatus,
  buildLensMessages,
  buildSummaryHandoff,
  buildTrajectoryHandoff,
  collectCoveredUpTo,
  deltaSideEntries,
  estimateLensedContextTokens,
  estimateSideCompactionTokens,
  filterExitCompletions,
  filterSideModelCompletions,
  findSideBoundary,
  parseExitMode,
  parseModelArg,
  parseSideMarkerData,
  summarizeWithProgress,
} from "./side.ts";
import {
  formatSideLensSuffix,
  onSideBadgeChange,
  resetSideBadgeState,
  setMergedSideBadgeInstalled,
  setMergedSideBadgeRendered,
  setSideLensTokens,
  setSideSessionModel,
} from "./side-state.ts";

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

function toolResultEntry(text: string, timestamp = 2): MessageEntry {
  return {
    type: "message",
    id: id(),
    parentId: "root",
    timestamp: new Date(timestamp).toISOString(),
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text }],
      isError: false,
      timestamp,
    },
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

describe("applySideStatus badge policy", () => {
  function captureStatus(): {
    ctx: ExtensionContext;
    calls: Array<[string, string | undefined]>;
  } {
    const calls: Array<[string, string | undefined]> = [];
    const ctx = {
      ui: {
        setStatus(key: string, text: string | undefined) {
          calls.push([key, text]);
        },
      },
    } as unknown as ExtensionContext;
    return { ctx, calls };
  }

  test("shows the classic status line when no merged footer badge is active", () => {
    resetSideBadgeState();
    setSideSessionModel({ provider: "zai", id: "glm-5.3" });
    const { ctx, calls } = captureStatus();
    applySideStatus(ctx);
    expect(calls).toEqual([["side", "side: zai/glm-5.3"]]);
  });

  test("status line carries the lensed estimate when present", () => {
    resetSideBadgeState();
    setSideSessionModel({ provider: "zai", id: "glm-5.3" });
    setSideLensTokens(46_000);
    const { ctx, calls } = captureStatus();
    applySideStatus(ctx);
    expect(calls).toEqual([["side", "side: zai/glm-5.3 · ~46k lensed"]]);
  });

  test("suppresses the status line while the merged footer badge is live", () => {
    resetSideBadgeState();
    setSideSessionModel({ provider: "zai", id: "glm-5.3" });
    setMergedSideBadgeInstalled(true);
    setMergedSideBadgeRendered(true);
    const { ctx, calls } = captureStatus();
    applySideStatus(ctx);
    expect(calls).toEqual([["side", undefined]]);
  });

  test("falls back to the status line when the merge stopped landing", () => {
    resetSideBadgeState();
    setSideSessionModel({ provider: "zai", id: "glm-5.3" });
    setMergedSideBadgeInstalled(true);
    // Footer mounted, but the merge failed on the last render (drift).
    setMergedSideBadgeRendered(false);
    const { ctx, calls } = captureStatus();
    applySideStatus(ctx);
    expect(calls).toEqual([["side", "side: zai/glm-5.3"]]);
  });

  test("clears the status line when no side session is active", () => {
    resetSideBadgeState();
    const { ctx, calls } = captureStatus();
    applySideStatus(ctx);
    expect(calls).toEqual([["side", undefined]]);
  });
});

describe("estimateLensedContextTokens", () => {
  test("undefined when the branch is not a side session", () => {
    const branch = [
      userEntry("hello"),
      assistantEntry("hi there", "anthropic/sonnet-4.5"),
    ];
    expect(
      estimateLensedContextTokens(branch, branch, findSideBoundary(branch)),
    ).toBeUndefined();
  });

  test("counts quote + side turns, not the raw branch's tool activity", () => {
    // Tool-heavy main history: raw projection carries the tool result
    // verbatim; the lens quote strips tool activity (buildTrajectory keeps
    // only user/assistant text), so the lensed estimate must come out
    // smaller — the over-report correction the badge exists for.
    const branch: SessionEntry[] = [
      userEntry("read the whole file and review it"),
      assistantEntry("Reading it now.", "anthropic/sonnet-4.5"),
      toolResultEntry("x".repeat(80_000)),
      assistantEntry("The file is fine.", "anthropic/sonnet-4.5"),
      markerEntry(markerData),
      userEntry("what are your thoughts on this?"),
      assistantEntry("Three reservations.", "kilo/glm-5.3"),
    ];
    const idx = findSideBoundary(branch);
    expect(idx).toBe(4);

    const lensed = estimateLensedContextTokens(branch, branch, idx);
    expect(lensed).toBeDefined();
    expect(lensed!).toBeGreaterThan(0);

    const raw = branch
      .flatMap((entry) => sessionEntryToContextMessages(entry))
      .reduce((sum, message) => sum + estimateTokens(message), 0);
    expect(lensed!).toBeLessThan(raw);
  });

  test("grows as the side limb grows", () => {
    const base = branchWithSide();
    const idx = findSideBoundary(base);
    const before = estimateLensedContextTokens(base, base, idx);
    expect(before).toBeDefined();

    const grown = [...base, userEntry("one more question")];
    const after = estimateLensedContextTokens(grown, grown, idx);
    expect(after).toBeDefined();
    expect(after!).toBeGreaterThan(before!);
  });
});

describe("estimateSideCompactionTokens", () => {
  test("includes system prompt and declared tool schemas", () => {
    const messages = [userEntry("hi").message];
    const tools = [
      {
        name: "read",
        description: "Read a file",
        parameters: { type: "object" },
      },
    ];
    expect(
      estimateSideCompactionTokens(messages, "system prompt", tools, []),
    ).toBe(
      estimateTokens(messages[0]!) +
        Math.ceil("system prompt".length / 4) +
        Math.ceil(JSON.stringify(tools).length / 4),
    );
  });

  test("valid side usage plus trailing turns is a floor; failed usage is not", () => {
    const assistant = assistantEntry("yes", "kilo/glm-5.3").message;
    if (assistant.role !== "assistant") throw new Error("expected assistant");
    const withUsage = {
      ...assistant,
      stopReason: "stop" as const,
      usage: {
        input: 90_000,
        output: 100,
        cacheRead: 1_000,
        cacheWrite: 0,
        totalTokens: 91_100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const next = userEntry("next question").message;
    const branch: SessionEntry[] = [
      { ...assistantEntry("", "kilo/glm-5.3"), message: withUsage },
      { ...userEntry(""), message: next },
    ];
    expect(
      estimateSideCompactionTokens([withUsage, next], "", [], branch),
    ).toBe(91_100 + estimateTokens(next));
    for (const stopReason of ["error", "aborted"] as const) {
      const failed = { ...withUsage, stopReason };
      const failedBranch: SessionEntry[] = [
        { ...assistantEntry("", "kilo/glm-5.3"), message: failed },
        branch[1]!,
      ];
      expect(
        estimateSideCompactionTokens([failed, next], "", [], failedBranch),
      ).toBe(estimateTokens(failed) + estimateTokens(next) + 1);
    }
  });
});

describe("formatSideLensSuffix", () => {
  test("empty while no side session (or sub-1k estimate) is active", () => {
    resetSideBadgeState();
    expect(formatSideLensSuffix()).toBe("");
    setSideLensTokens(999);
    expect(formatSideLensSuffix()).toBe("");
  });

  test("formats k and M magnitudes", () => {
    resetSideBadgeState();
    setSideLensTokens(46_000);
    expect(formatSideLensSuffix()).toBe(" · ~46k lensed");
    setSideLensTokens(9_700);
    expect(formatSideLensSuffix()).toBe(" · ~9.7k lensed");
    setSideLensTokens(1_234_567);
    expect(formatSideLensSuffix()).toBe(" · ~1.2M lensed");
  });

  test("emits only when the estimate actually changes", () => {
    resetSideBadgeState();
    let calls = 0;
    const off = onSideBadgeChange(() => {
      calls++;
    });
    setSideLensTokens(100);
    setSideLensTokens(100); // unchanged — no emit
    setSideLensTokens(undefined);
    off();
    expect(calls).toBe(2);
  });
});

describe("summarizeWithProgress", () => {
  const sideModel = { provider: "kilo", id: "glm-5.3" };
  const WIDGET_KEY = "bermudis-pi-goodies.side-summarize";
  const reply = {
    content: [{ type: "text", text: "The consultant agreed." }],
  };

  function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
  } {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  type InputHandler = (
    data: string,
  ) => { consume?: boolean; data?: string } | undefined;

  function fakeCtx(complete: (signal?: AbortSignal) => Promise<unknown>): {
    ctx: ExtensionCommandContext;
    widgets: Array<[string, string[] | undefined]>;
    getInput: () => InputHandler | undefined;
    isUnsubscribed: () => boolean;
  } {
    const widgets: Array<[string, string[] | undefined]> = [];
    let inputHandler: InputHandler | undefined;
    let unsubscribed = false;
    const ctx = {
      hasUI: true,
      ui: {
        setWidget(key: string, content: string[] | undefined) {
          widgets.push([key, content]);
        },
        onTerminalInput(handler: InputHandler) {
          inputHandler = handler;
          return () => {
            unsubscribed = true;
          };
        },
      },
      modelRegistry: {
        find: () => ({ provider: sideModel.provider, id: sideModel.id }),
        complete: (
          _model: unknown,
          _context: unknown,
          options?: { signal?: AbortSignal },
        ) => complete(options?.signal),
      },
    } as unknown as ExtensionCommandContext;
    return {
      ctx,
      widgets,
      getInput: () => inputHandler,
      isUnsubscribed: () => unsubscribed,
    };
  }

  test("shows a progress widget for the whole call, then cleans up", async () => {
    const gate = deferred<unknown>();
    const h = fakeCtx(() => gate.promise);
    const pending = summarizeWithProgress(h.ctx, sideModel, "transcript", 3);
    // summarizeWithProgress runs its UI setup synchronously before the first
    // await, so the widget is already up while the call is in flight — the
    // whole point: the UI must move the moment the picker closes.
    expect(h.widgets).toEqual([
      [
        WIDGET_KEY,
        [
          expect.stringContaining(
            "summarizing side consultation (3 turns) with kilo/glm-5.3",
          ),
        ],
      ],
    ]);
    expect(h.widgets[0]?.[1]?.[0]).toContain("esc cancels");
    gate.resolve(reply);
    const result = await pending;
    expect(result).toEqual({ ok: true, text: "The consultant agreed." });
    expect(h.widgets[h.widgets.length - 1]).toEqual([WIDGET_KEY, undefined]);
    expect(h.isUnsubscribed()).toBe(true);
  });

  test("Esc aborts the call and reports cancelled, still cleaning up", async () => {
    const h = fakeCtx(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("Request was aborted")),
            { once: true },
          );
        }),
    );
    const pending = summarizeWithProgress(h.ctx, sideModel, "transcript", 1);
    const handler = h.getInput();
    expect(handler).toBeDefined();
    // Only a bare Esc cancels; escape sequences must pass through.
    expect(handler("\x1b[A")).toBeUndefined();
    expect(handler("\x1b[<u")).toBeUndefined();
    expect(handler("\x1b")).toEqual({ consume: true });
    const result = await pending;
    expect(result).toEqual({ ok: false, cancelled: true });
    expect(h.widgets[h.widgets.length - 1]).toEqual([WIDGET_KEY, undefined]);
    expect(h.isUnsubscribed()).toBe(true);
  });

  test("non-abort failures surface as errors, not cancels", async () => {
    const h = fakeCtx(() => Promise.reject(new Error("429 slow down")));
    const result = await summarizeWithProgress(h.ctx, sideModel, "t", 2);
    if (result.ok || result.cancelled) {
      throw new Error("expected the error outcome");
    }
    expect((result.error as Error).message).toBe("429 slow down");
    expect(h.widgets[h.widgets.length - 1]).toEqual([WIDGET_KEY, undefined]);
    expect(h.isUnsubscribed()).toBe(true);
  });

  test("works without UI methods (headless/limited contexts)", async () => {
    const ctx = {
      hasUI: false,
      modelRegistry: {
        find: () => ({ provider: sideModel.provider, id: sideModel.id }),
        complete: () => Promise.resolve(reply),
      },
    } as unknown as ExtensionCommandContext;
    const result = await summarizeWithProgress(ctx, sideModel, "t", 1);
    expect(result).toEqual({ ok: true, text: "The consultant agreed." });
  });

  test("the progress line never wraps on narrow terminals", async () => {
    const longModel = { provider: "kilo", id: "x".repeat(120) };
    const h = fakeCtx(() => Promise.resolve(reply));
    await summarizeWithProgress(h.ctx, longModel, "t", 12);
    const line = h.widgets[0]?.[1]?.[0] ?? "";
    expect(line.length).toBeLessThanOrEqual(80);
    expect(line.endsWith("…")).toBe(true);
  });
});
