/**
 * Background-report delivery (sidekick block:false) through pi's REAL
 * AgentSession and fusion's real code. Only the sidekick and the provider
 * reply are fakes. The lead is scripted: hand off, then do more work or stop.
 *
 * Pi facts these pin (verified in 1.4.0 source + 1.5.0 runtime, 2026-11-02):
 * - deliverAs "followUp" is drained only when the lead would stop. That was
 *   the 14-min-late report in the first live session.
 * - interactive Esc / dequeue clears the steer+followUp queues. A queued
 *   custom message is not restored to the editor, so it is gone.
 * - a triggerTurn:false send mid-run is parked, appended at turn_end (or in
 *   the aborted run's finally), and survives that queue clear.
 */
import { afterEach, expect, test } from "bun:test";
import { Type } from "typebox";
import {
  createTestSession,
  type TestSession,
} from "@marcfargas/pi-test-harness";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import type {
  AgentSession,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createFusion } from "./fusion.ts";
import type { Logger, SidekickConnector, TurnOutcome } from "./fusion-types.ts";

const sessions: TestSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose();
});

const quiet: Logger = { info() {}, warn() {}, error() {} };

class FakeSidekick implements SidekickConnector {
  readonly harness = "devin" as const;
  readonly model = "swe-2-medium";
  readonly sessionId = "fake-sidekick";
  private resolve: ((o: TurnOutcome) => void) | undefined;
  readonly started: Promise<void>;
  private markStarted!: () => void;
  constructor() {
    this.started = new Promise((r) => (this.markStarted = r));
  }
  prompt(): Promise<TurnOutcome> {
    this.markStarted();
    return new Promise((r) => (this.resolve = r));
  }
  finish() {
    this.resolve?.({ report: "REPORT-BODY", stopReason: "end_turn" });
  }
  async inject() {
    return false;
  }
  async cancel() {}
  async dispose() {}
}

type Step = "handoff" | "slow" | "final";

async function setup(script: Step[], onStream?: (turn: number) => void) {
  const sidekick = new FakeSidekick();
  let release!: () => void;
  let entered!: () => void;
  const slowEntered = new Promise<void>((r) => (entered = r));
  const gate = new Promise<void>((r) => (release = r));
  const harness = await createTestSession({
    systemPrompt: "test lead",
    mockUI: { select: (_t, items) => items.find((i) => i.startsWith("Devin")) },
    extensionFactories: [
      (pi: ExtensionAPI) => {
        createFusion(pi, {
          connectors: {
            devin: async () => sidekick,
            piz: async () => {
              throw new Error("unused");
            },
          },
          log: quiet,
        });
        pi.registerTool({
          name: "slow",
          label: "slow",
          description: "waits for the test",
          parameters: Type.Object({}),
          async execute() {
            entered();
            await gate;
            return {
              content: [{ type: "text", text: "slow done" }],
              details: {},
            };
          },
        });
      },
    ],
  });
  sessions.push(harness);
  const session = harness.session as AgentSession;
  const model = session.model;
  if (!model) throw new Error("harness did not select a model");
  /** Per provider request: did the lead's context already contain the report? */
  const sees: boolean[] = [];
  let turn = 0;
  session.agent.streamFunction = (_m, context, options) => {
    sees.push(JSON.stringify(context.messages).includes("REPORT-BODY"));
    const aborted = options?.signal?.aborted === true;
    const step: Step = aborted ? "final" : (script[turn] ?? "final");
    turn++;
    onStream?.(turn);
    const content: AssistantMessage["content"] =
      step === "handoff"
        ? [
            {
              type: "toolCall",
              id: `c${turn}`,
              name: "sidekick",
              arguments: { message: "do it", block: false },
            },
          ]
        : step === "slow"
          ? [{ type: "toolCall", id: `c${turn}`, name: "slow", arguments: {} }]
          : [{ type: "text", text: `final ${turn}` }];
    const message: AssistantMessage = {
      role: "assistant",
      content,
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
      stopReason: aborted ? "aborted" : step === "final" ? "stop" : "toolUse",
      timestamp: Date.now(),
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: message.stopReason as never, message });
    return stream;
  };
  session.setActiveToolsByName([...session.getActiveToolNames(), "slow"]);
  await session.prompt("/fusion");
  expect(session.getActiveToolNames()).toContain("sidekick");
  const reports = () =>
    session.sessionManager
      .getBranch()
      .filter(
        (e) => e.type === "custom_message" && e.customType === "fusion-report",
      ).length;
  const settle = async () => {
    await session.waitForIdle();
    await new Promise((r) => setTimeout(r, 20));
    await session.waitForIdle();
  };
  return { session, sidekick, slowEntered, release, sees, reports, settle };
}

test("mid tool batch: the lead's very next request carries the report", async () => {
  const t = await setup(["handoff", "slow", "final"]);
  const run = t.session.prompt("go");
  await t.slowEntered;
  t.sidekick.finish();
  await new Promise((r) => setTimeout(r, 10));
  t.release();
  await run;
  await t.settle();
  // req1 hands off, req2 runs `slow`, req3 (right after that batch) sees it.
  expect(t.sees).toEqual([false, false, true]);
  expect(t.reports()).toBe(1);
});

test("report landing during the lead's final turn gets the lead one more request", async () => {
  let t!: Awaited<ReturnType<typeof setup>>;
  t = await setup(["handoff", "final"], (turn) => {
    if (turn === 2) t.sidekick.finish(); // while the final answer streams
  });
  await t.session.prompt("go");
  await t.settle();
  expect(t.sees).toEqual([false, false, true]);
  expect(t.reports()).toBe(1);
});

test("Esc (queue clear + abort, as interactive mode does) keeps the report", async () => {
  const t = await setup(["handoff", "slow", "final"]);
  const run = t.session.prompt("go");
  await t.slowEntered;
  t.sidekick.finish();
  await new Promise((r) => setTimeout(r, 10));
  // interactive-mode restoreQueuedMessagesToEditor({ abort: true })
  t.session.clearQueue();
  const aborted = t.session.abort();
  t.release();
  await Promise.allSettled([run, aborted]);
  await t.settle();
  // In the transcript for the user and the lead's next prompt. Esc is
  // respected: no extra lead request is started for it.
  expect(t.reports()).toBe(1);
  const requestsAfterEsc = t.sees.length;
  await t.settle();
  expect(t.sees.length).toBe(requestsAfterEsc);
});

test("idle lead: the report starts a turn", async () => {
  const t = await setup(["handoff", "final"]);
  await t.session.prompt("go");
  await t.settle();
  expect(t.sees).toEqual([false, false]);
  t.sidekick.finish();
  await new Promise((r) => setTimeout(r, 10));
  await t.settle();
  expect(t.sees).toEqual([false, false, true]);
  expect(t.reports()).toBe(1);
});
