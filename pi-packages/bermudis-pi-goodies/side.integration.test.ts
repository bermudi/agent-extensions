/**
 * Runs Pi's real pre-send compaction check and extension dispatcher offline.
 * Provider replies are fixtures; no provider/tokenizer is contacted.
 */
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createTestSession,
  type TestSession,
} from "@marcfargas/pi-test-harness";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type ContextEvent,
  type ExtensionAPI,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import side from "./side.ts";
import { setGoodiesLogPathForTesting } from "./goodies-log.ts";
import { resetSideBadgeState } from "./side-state.ts";

const sessions: TestSession[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  setGoodiesLogPathForTesting();
  resetSideBadgeState();
});

async function setup(onSide = true): Promise<{
  harness: TestSession;
  session: AgentSession;
  passedCompactions: SessionBeforeCompactEvent[];
  requests: ContextEvent["messages"][];
}> {
  const passedCompactions: SessionBeforeCompactEvent[] = [];
  const requests: ContextEvent["messages"][] = [];
  const factories: ((pi: ExtensionAPI) => void)[] = [
    (pi) => {
      if (onSide) side(pi);
      // A safety net: record compactions /side didn't veto, then cancel so
      // a regression cannot call a live summarization provider.
      pi.on("session_before_compact", (event) => {
        passedCompactions.push(event);
        return { cancel: true };
      });
      pi.on("context", (event) => {
        requests.push(event.messages);
      });
    },
  ];
  const harness = await createTestSession({
    extensionFactories: factories,
    systemPrompt: "You are a test consultant.",
  });
  sessions.push(harness);
  setGoodiesLogPathForTesting(join(harness.cwd, "goodies.log"));
  const session = harness.session as AgentSession;
  const model = session.model;
  if (!model) throw new Error("harness did not select a model");
  // The harness's run() still assigns the old agent.streamFn property;
  // install our offline reply on Pi's current streamFunction instead.
  session.agent.streamFunction = () => {
    const stream = createAssistantMessageEventStream();
    stream.push({
      type: "done",
      reason: "stop",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Yes." }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    });
    return stream;
  };
  session.settingsManager.setCompactionEnabled(true);
  session.sessionManager.appendMessage({
    role: "user",
    content: "Review the findings.",
    timestamp: 1,
  });
  session.sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "I checked the findings." }],
    api: model.api,
    provider: model.provider,
    // The parked main model had a larger window than the selected side
    // model; this is a model SWITCH, not overflow by the current model.
    model: "gpt-4.1",
    usage: {
      input: 160_000,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 160_010,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
  session.sessionManager.appendMessage({
    role: "toolResult",
    toolCallId: "main-read",
    toolName: "read",
    content: [{ type: "text", text: "main tool output ".repeat(40_000) }],
    isError: false,
    timestamp: 3,
  });
  if (onSide) {
    session.sessionManager.appendCustomEntry("side-session", {
      v: 1,
      mainTipId: session.sessionManager.getLeafId(),
      mainModel: { provider: model.provider, id: "gpt-4.1" },
      sideModel: { provider: model.provider, id: model.id },
    });
  }
  session.agent.state.messages =
    session.sessionManager.buildSessionProjection().messages;
  return { harness, session, passedCompactions, requests };
}

test("pre-send threshold uses the side lens, not main usage or tool output", async () => {
  const { session, passedCompactions, requests } = await setup();
  await session.prompt("Do you agree?");
  expect(passedCompactions.length).toBe(0);
  expect(requests.length).toBeGreaterThan(0);
  const request = JSON.stringify(requests[0]);
  expect(request).toContain("Main session transcript");
  expect(request).toContain("Do you agree?");
  expect(request).not.toContain("main tool output");
  expect(
    session.sessionManager.getBranch().some((e) => e.type === "compaction"),
  ).toBe(false);
});

test("main branches retain Pi's threshold compaction", async () => {
  const { session, passedCompactions } = await setup(false);
  await session.prompt("Continue.");
  expect(passedCompactions.some((e) => e.reason === "threshold")).toBe(true);
});

test("side manual compaction and actual overflow recovery are not vetoed", async () => {
  const { session, passedCompactions } = await setup();
  const branchEntries = session.sessionManager.getBranch();
  const preparation = compactionFixture(session);
  for (const reason of ["manual", "overflow"] as const) {
    await session.extensionRunner.emit({
      type: "session_before_compact",
      branchEntries,
      preparation,
      reason,
      willRetry: reason === "overflow",
      signal: new AbortController().signal,
    });
  }
  expect(passedCompactions.map((e) => e.reason)).toEqual([
    "manual",
    "overflow",
  ]);
});

test("a genuinely large side conversation still permits threshold compaction", async () => {
  const { session, passedCompactions } = await setup();
  session.sessionManager.appendMessage({
    role: "user",
    content: "large side turn ".repeat(40_000),
    timestamp: 4,
  });
  const branchEntries = session.sessionManager.getBranch();
  const preparation = compactionFixture(session);
  await session.extensionRunner.emit({
    type: "session_before_compact",
    branchEntries,
    preparation,
    reason: "threshold",
    willRetry: false,
    signal: new AbortController().signal,
  });
  expect(passedCompactions.map((e) => e.reason)).toEqual(["threshold"]);
});

for (const boundary of ["compaction", "context_edit"] as const) {
  test(`side usage before ${boundary} cannot retrigger threshold compaction`, async () => {
    const { session, passedCompactions } = await setup();
    const model = session.model;
    if (!model) throw new Error("missing model");
    const mainResponse = session.sessionManager
      .getBranch()
      .find((e) => e.type === "message" && e.message.role === "assistant");
    if (
      mainResponse?.type !== "message" ||
      mainResponse.message.role !== "assistant"
    )
      throw new Error("missing main fixture response");
    const firstSideId = session.sessionManager.appendMessage({
      role: "user",
      content: "What do you think?",
      timestamp: 4,
    });
    const sideResponse = {
      ...mainResponse.message,
      model: model.id,
      usage: {
        ...mainResponse.message.usage,
        input: 119_990,
        totalTokens: 120_000,
      },
      timestamp: 5,
    };
    session.sessionManager.appendMessage(sideResponse);
    if (boundary === "compaction") {
      // Retain the successful side response, including its obsolete usage.
      session.sessionManager.appendCompaction(
        "Small summary.",
        firstSideId,
        120_000,
      );
    } else {
      session.sessionManager.appendContextEdit(firstSideId, {
        content: "Short question.",
      });
    }
    session.sessionManager.appendMessage({
      ...sideResponse,
      stopReason: "error",
      errorMessage: "Offline test error fixture",
      usage: {
        ...sideResponse.usage,
        input: 0,
        output: 0,
        totalTokens: 0,
      },
      timestamp: Date.now(),
    });
    const check = async (): Promise<void> => {
      await session.extensionRunner.emit({
        type: "session_before_compact",
        branchEntries: session.sessionManager.getBranch(),
        preparation: compactionFixture(session),
        reason: "threshold",
        willRetry: false,
        signal: new AbortController().signal,
      });
    };
    await check();
    expect(passedCompactions.length).toBe(0);
    // A new successful side response after the boundary has valid usage.
    session.sessionManager.appendMessage({
      ...sideResponse,
      timestamp: Date.now(),
    });
    await check();
    expect(passedCompactions.map((e) => e.reason)).toEqual(["threshold"]);
  });
}

// Only the policy tests above dispatch fixtures. The regression test runs
// Pi's real preparation, pre-send threshold check, and request pipeline.
function compactionFixture(
  session: AgentSession,
): SessionBeforeCompactEvent["preparation"] {
  return {
    firstKeptEntryId: session.sessionManager.getLeafId() ?? "",
    messagesToSummarize: [],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 160_010,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: session.settingsManager.getCompactionSettings(session.model),
  };
}
