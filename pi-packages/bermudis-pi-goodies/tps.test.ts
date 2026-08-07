import { describe, expect, test } from "bun:test";
import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import tps from "./tps.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function captureHandlers(): {
  start: Handler;
  end: Handler;
  notified: Array<{ message: string; level: string }>;
} {
  const handlers = new Map<string, Handler>();
  const notified: Array<{ message: string; level: string }> = [];
  tps({
    on(event, handler) {
      handlers.set(event, handler as Handler);
    },
  } as unknown as ExtensionAPI);
  const start = handlers.get("agent_start");
  const end = handlers.get("agent_end");
  if (!start || !end) {
    throw new Error("tps did not register agent_start and agent_end");
  }
  return {
    start,
    end,
    notified,
  };
}

function ctx(
  hasUI: boolean,
  notified: Array<{ message: string; level: string }>,
): ExtensionContext {
  return {
    hasUI,
    ui: {
      notify(message: string, level: string) {
        notified.push({ message, level });
      },
    },
  } as unknown as ExtensionContext;
}

function assistant(
  usage: Partial<AssistantMessage["usage"]>,
): AssistantMessage {
  return {
    role: "assistant",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      ...usage,
    },
  } as AssistantMessage;
}

function endEvent(messages: unknown[]): AgentEndEvent {
  return { messages } as AgentEndEvent;
}

describe("tps", () => {
  test("notifies tokens/sec and usage at agent end", () => {
    const { start, end, notified } = captureHandlers();
    const realNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      start({}, {});
      Date.now = () => 1_000_100;
      end(
        endEvent([
          assistant({
            input: 2000,
            output: 1000,
            cacheRead: 3000,
            cacheWrite: 400,
            totalTokens: 5500,
          }),
        ]),
        ctx(true, notified),
      );
    } finally {
      Date.now = realNow;
    }

    expect(notified).toEqual([
      {
        message:
          "TPS 10000.0 tok/s. out 1,000, in 2,000, cache r/w 3,000/400, total 5,500, 0.1s",
        level: "info",
      },
    ]);
  });

  test("sums usage across multiple assistant messages and skips others", () => {
    const { start, end, notified } = captureHandlers();
    const realNow = Date.now;
    Date.now = () => 5_000_000;
    try {
      start({}, {});
      Date.now = () => 5_001_000;
      end(
        endEvent([
          { role: "user", usage: { input: 999, output: 999 } },
          assistant({
            input: 100,
            output: 200,
            cacheRead: 300,
            cacheWrite: 400,
            totalTokens: 1000,
          }),
          assistant({
            input: 500,
            output: 800,
            cacheRead: 700,
            cacheWrite: 600,
            totalTokens: 2600,
          }),
        ]),
        ctx(true, notified),
      );
    } finally {
      Date.now = realNow;
    }

    expect(notified).toHaveLength(1);
    expect(notified[0].message).toBe(
      "TPS 1000.0 tok/s. out 1,000, in 600, cache r/w 1,000/1,000, total 3,600, 1.0s",
    );
  });

  test("does not notify without UI", () => {
    const { start, end, notified } = captureHandlers();
    start({}, {});
    end(endEvent([assistant({ output: 100 })]), ctx(false, notified));
    expect(notified).toHaveLength(0);
  });

  test("does not notify when no agent_start preceded the end", () => {
    const { end, notified } = captureHandlers();
    end(endEvent([assistant({ output: 100 })]), ctx(true, notified));
    expect(notified).toHaveLength(0);
  });

  test("does not notify when there is no assistant output", () => {
    const { start, end, notified } = captureHandlers();
    start({}, {});
    end(endEvent([assistant({ input: 50 })]), ctx(true, notified));
    expect(notified).toHaveLength(0);
  });

  test("resets the timer after a turn so a second end without start stays silent", () => {
    const { start, end, notified } = captureHandlers();
    const realNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      start({}, {});
      Date.now = () => 1_001_000;
      end(endEvent([assistant({ output: 500 })]), ctx(true, notified));
      end(endEvent([assistant({ output: 500 })]), ctx(true, notified));
    } finally {
      Date.now = realNow;
    }

    expect(notified).toHaveLength(1);
  });
});
