import { describe, expect, test } from "bun:test";
import { ObserverEventCollector } from "./observer-process.ts";

const plan = { rationale: "curate", decisions: [] };

function successfulEnd(details: unknown) {
  return {
    type: "tool_execution_end",
    toolName: "ketamine_submit",
    isError: false,
    result: { details },
  };
}

describe("observer result protocol", () => {
  test("does not accept an unexecuted submit start", () => {
    const collector = new ObserverEventCollector();
    collector.consume({
      type: "tool_execution_start",
      toolName: "ketamine_submit",
      args: plan,
    });
    expect(collector.successfulSubmissions).toBe(0);
    expect(collector.plan).toBeUndefined();
  });

  test("does not accept failed submit execution", () => {
    const collector = new ObserverEventCollector();
    collector.consume({ ...successfulEnd(plan), isError: true });
    expect(collector.successfulSubmissions).toBe(0);
  });

  test("captures successful execution details and counts duplicates", () => {
    const collector = new ObserverEventCollector();
    collector.consume(successfulEnd(plan));
    collector.consume(successfulEnd({ ...plan, rationale: "second" }));
    expect(collector.successfulSubmissions).toBe(2);
    expect(collector.plan).toEqual({ ...plan, rationale: "second" });
  });

  test("aggregates observer assistant usage", () => {
    const collector = new ObserverEventCollector();
    const usage = {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 18,
      cost: {
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        total: 10,
      },
    };
    collector.consume({
      type: "message_end",
      message: { role: "assistant", usage },
    });
    collector.consume({
      type: "message_end",
      message: { role: "assistant", usage },
    });
    expect(collector.usage?.totalTokens).toBe(36);
    expect(collector.usage?.cost.total).toBe(20);
  });
});
