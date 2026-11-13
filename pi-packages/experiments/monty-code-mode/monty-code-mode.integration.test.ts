/**
 * Integration tests: a real Monty sandbox driven through MontyCodeRunner with a fake pi tool
 * context. Verifies the full bridge — kwargs marshaling, asyncio.gather parallelism through
 * executeTool, REPL persistence, error mapping, the tool-call cap, timeouts, and teardown.
 * Requires the @pydantic/monty platform binary (installed with the experiments package).
 */
import { afterAll, expect, test } from "bun:test";
import type {
  AgentTool,
  AgentToolCallOutcome,
} from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { MontyCodeRunner, type RunCodeDetails } from "./runner.ts";

/** A shared runner for the happy-path and REPL tests; its session state is per-test-checked. */
const runner = new MontyCodeRunner();
afterAll(async () => {
  await runner.close();
});

const weatherTool: AgentTool = {
  name: "get_weather",
  label: "Get Weather",
  description: "Get current weather for a city.",
  parameters: Type.Object({
    city: Type.String({ description: "City name" }),
    units: Type.Optional(Type.String({ default: "C" })),
  }),
  outputSchema: Type.Object({ city: Type.String(), temp: Type.Integer() }),
  async execute(_id, params) {
    return {
      content: [
        { type: "text", text: JSON.stringify({ city: params.city, temp: 21 }) },
      ],
      details: undefined,
      structuredContent: { city: params.city, temp: 21 },
    };
  },
} as AgentTool;

const echoTool: AgentTool = {
  name: "echo",
  label: "Echo",
  description: "Echo text back.",
  parameters: Type.Object({ text: Type.String() }),
  async execute(_id, params) {
    return {
      content: [{ type: "text", text: `echo:${params.text}` }],
      details: undefined,
    };
  },
} as AgentTool;

interface FakeToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * A minimal ExtensionToolContext: `tools` plus an executeTool whose behavior the test controls.
 * A `journal` collects every nested call in order.
 */
function fakeCtx(
  tools: AgentTool[],
  onExecute?: (
    call: FakeToolCall,
  ) => AgentToolCallOutcome | Promise<AgentToolCallOutcome>,
): { ctx: ExtensionToolContext; journal: FakeToolCall[] } {
  const journal: FakeToolCall[] = [];
  const ctx = {
    tools,
    async executeTool(
      name: string,
      args: unknown,
    ): Promise<AgentToolCallOutcome> {
      const toolArgs = (args ?? {}) as Record<string, unknown>;
      journal.push({ name, args: toolArgs });
      const overridden = await onExecute?.({ name, args: toolArgs });
      if (overridden) return overridden;
      // Default: run the tool itself, like pi does; a throw becomes an error outcome.
      const tool = tools.find((t) => t.name === name);
      try {
        const result = await tool?.execute(
          "nested",
          toolArgs as never,
          undefined,
          undefined,
        );
        return {
          toolCall: {
            id: "nested",
            name,
            arguments: toolArgs,
          } as AgentToolCallOutcome["toolCall"],
          result: result ?? {
            content: [{ type: "text", text: "unknown tool" }],
            details: undefined,
          },
          isError: false,
        };
      } catch (error) {
        return {
          toolCall: {
            id: "nested",
            name,
            arguments: toolArgs,
          } as AgentToolCallOutcome["toolCall"],
          result: {
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
            details: undefined,
          },
          isError: true,
        };
      }
    },
  } as unknown as ExtensionToolContext;
  return { ctx, journal };
}

test("one run_code call gathers parallel tool calls and returns the filtered result", async () => {
  const { ctx, journal } = fakeCtx([weatherTool]);
  const result = await runner.run(
    {
      code: `
import asyncio
async def one(city):
    r = await get_weather(city=city)
    return r['temp']
temps = await asyncio.gather(one('Paris'), one('Tokyo'), one('Oslo'))
sum(temps)
`,
    },
    ctx,
    undefined,
    undefined,
  );
  expect(result.isError).toBeUndefined();
  expect(result.details).toBeDefined();
  const details = result.details as RunCodeDetails;
  expect(details.calls.map((c) => c.status)).toEqual(["ok", "ok", "ok"]);
  expect(journal.map((c) => c.args.city)).toEqual(["Paris", "Tokyo", "Oslo"]);
  const text = result.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n");
  expect(text).toContain("<result>");
  expect(text).toContain("63");
  expect(text).toContain("3 nested tool call(s): 3 ok");
});

test("kwargs, defaults, and positional rescue marshal into one args object", async () => {
  const { ctx, journal } = fakeCtx([echoTool]);
  await runner.run(
    { code: "await echo(text='hi')" },
    ctx,
    undefined,
    undefined,
  );
  expect(journal[0]?.args).toEqual({ text: "hi" });
  // Positional call despite the keyword-only signature still lands on the first parameter.
  await runner.run({ code: "await echo('loose')" }, ctx, undefined, undefined);
  expect(journal[1]?.args).toEqual({ text: "loose" });
});

test("REPL state persists across calls and restart clears it", async () => {
  const { ctx } = fakeCtx([]);
  await runner.run({ code: "state = [1, 2, 3]" }, ctx, undefined, undefined);
  const kept = await runner.run(
    { code: "len(state)" },
    ctx,
    undefined,
    undefined,
  );
  expect(kept.isError).toBeUndefined();

  const cleared = await runner.run(
    { code: "len(state)", restart: true },
    ctx,
    undefined,
    undefined,
  );
  expect(cleared.isError).toBe(true);
  const text = cleared.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n");
  expect(text).toContain("NameError");
  expect((cleared.details as RunCodeDetails).sessionReset).toBe(true);
});

test("a failed tool call raises inside the sandbox and keeps the session usable", async () => {
  const { ctx } = fakeCtx([echoTool], ({ name }) => ({
    toolCall: {
      id: "nested",
      name,
      arguments: {},
    } as AgentToolCallOutcome["toolCall"],
    result: {
      content: [{ type: "text", text: "tool echo failed: rate limited" }],
      details: undefined,
    },
    isError: true,
  }));
  const failed = await runner.run(
    { code: "await echo(text='x')" },
    ctx,
    undefined,
    undefined,
  );
  expect(failed.isError).toBe(true);
  const text = failed.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n");
  expect(text).toContain("tool echo failed: rate limited");
  expect((failed.details as RunCodeDetails).calls[0]?.status).toBe("error");

  // Session survives: state from before the failure is still there.
  const { ctx: freshCtx } = fakeCtx([]);
  const after = await runner.run(
    { code: "'alive'" },
    freshCtx,
    undefined,
    undefined,
  );
  expect(after.isError).toBeUndefined();
});

test("print output lands in <output> alongside the <result>", async () => {
  const { ctx } = fakeCtx([]);
  const result = await runner.run(
    { code: "print('working…')\nprint('still working')\n'final'" },
    ctx,
    undefined,
    undefined,
  );
  const text = result.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n");
  expect(text).toContain("<output>\nworking…\nstill working\n</output>");
  expect(text).toContain('<result>\n"final"\n</result>');
  expect((result.details as RunCodeDetails).printChars).toBeGreaterThan(0);
});

test("a snippet with no value and no print says so instead of an empty result", async () => {
  const { ctx } = fakeCtx([]);
  const result = await runner.run({ code: "x = 5" }, ctx, undefined, undefined);
  const text = result.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n");
  expect(text).toContain("no output, no result value");
});

test("print output already captured is preserved on the error path", async () => {
  const { ctx } = fakeCtx([]);
  const result = await runner.run(
    { code: "print('progress: half done')\n1/0" },
    ctx,
    undefined,
    undefined,
  );
  expect(result.isError).toBe(true);
  const text = result.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n");
  expect(text.indexOf("<output>")).toBeLessThan(text.indexOf("Python error:"));
  expect(text).toContain("<output>\nprogress: half done\n</output>");
  expect(text).toContain("ZeroDivisionError");
  expect((result.details as RunCodeDetails).printChars).toBeGreaterThan(0);
});

test("extra positional arguments surface as a clear error, not a dropped argument", async () => {
  const { ctx, journal } = fakeCtx([echoTool]);
  const result = await runner.run(
    { code: "await echo('a', 'b')" },
    ctx,
    undefined,
    undefined,
  );
  expect(result.isError).toBe(true);
  const text = result.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n");
  expect(text).toContain("too many positional arguments");
  expect(journal).toEqual([]); // nothing reached the tool
});

test("a snippet that swallows the abort error is labelled as cancelled", async () => {
  const local = new MontyCodeRunner();
  try {
    const { ctx } = fakeCtx([echoTool]);
    const controller = new AbortController();
    controller.abort();
    const result = await local.run(
      {
        code: "result = None\ntry:\n    await echo(text='x')\nexcept RuntimeError:\n    result = 'swallowed'\nresult",
      },
      ctx,
      controller.signal,
      undefined,
    );
    expect(result.isError).toBeUndefined();
    const text = result.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    expect(text).toContain("cancelled mid-run");
    expect(text).toContain('<result>\n"swallowed"\n</result>');
  } finally {
    await local.close();
  }
});

test("an abort landing after the last tool call is labelled without claiming the snippet saw it", async () => {
  const local = new MontyCodeRunner();
  try {
    const controller = new AbortController();
    // Abort fires while the (only) tool call is in flight; no later call arrives aborted,
    // so the snippet never observes the abort and finishes normally.
    const { ctx } = fakeCtx([echoTool], () => {
      controller.abort();
      return undefined;
    });
    const result = await local.run(
      { code: "await echo(text='x')\n'done'" },
      ctx,
      controller.signal,
      undefined,
    );
    expect(result.isError).toBeUndefined();
    const text = result.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    expect(text).toContain("cancelled mid-run");
    expect(text).toContain("no tool call saw the abort");
    expect(text).not.toContain("the snippet ignored the abort");
    expect(text).toContain('<result>\n"done"\n</result>');
  } finally {
    await local.close();
  }
});

test("huge tool error text is truncated on the error path", async () => {
  const local = new MontyCodeRunner();
  try {
    const big = "x".repeat(60_000);
    const { ctx } = fakeCtx([echoTool], ({ name }) => ({
      toolCall: {
        id: "nested",
        name,
        arguments: {},
      } as AgentToolCallOutcome["toolCall"],
      result: {
        content: [{ type: "text", text: big }],
        details: undefined,
      },
      isError: true,
    }));
    const result = await local.run(
      { code: "await echo(text='y')" },
      ctx,
      undefined,
      undefined,
    );
    expect(result.isError).toBe(true);
    const text = result.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    expect(text).toContain("… (error text truncated)");
    expect(text.length).toBeLessThan(60_000);
  } finally {
    await local.close();
  }
});

test("a closed runner reports an error instead of crashing", async () => {
  const local = new MontyCodeRunner();
  await local.close();
  const { ctx } = fakeCtx([]);
  const result = await local.run({ code: "1" }, ctx, undefined, undefined);
  expect(result.isError).toBe(true);
  const text = result.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n");
  expect(text).toContain("monty-code-mode runner is closed");
});

test("syntax errors keep the session and report the traceback line", async () => {
  const { ctx } = fakeCtx([]);
  const before = await runner.run(
    { code: "keep = 1" },
    ctx,
    undefined,
    undefined,
  );
  expect(before.isError).toBeUndefined();
  const broken = await runner.run(
    { code: "def (:" },
    ctx,
    undefined,
    undefined,
  );
  expect(broken.isError).toBe(true);
  expect((broken.details as RunCodeDetails).sessionReset).toBeUndefined();
});

test("past the nested tool-call cap the call site raises and the snippet can return partials", async () => {
  const fast = new MontyCodeRunner();
  try {
    const { ctx } = fakeCtx([echoTool]);
    const result = await fast.run(
      {
        code: "results = []\nfor i in range(500):\n    try:\n        results.append(await echo(text=str(i)))\n    except RuntimeError as e:\n        break\nlen(results)",
      },
      ctx,
      undefined,
      undefined,
    );
    expect(result.isError).toBeUndefined();
    const text = result.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    expect(text).toContain("<result>\n100");
  } finally {
    await fast.close();
  }
});

test("a pure-compute spin hits the feed timeout, errors, and the next call still runs", async () => {
  const quick = new MontyCodeRunner({ maxFeedDurationSecs: 1 });
  try {
    const { ctx } = fakeCtx([]);
    const spun = await quick.run(
      { code: "while True:\n    pass" },
      ctx,
      undefined,
      undefined,
    );
    expect(spun.isError).toBe(true);
    const text = spun.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    expect(text).toContain("time limit exceeded");
    expect((spun.details as RunCodeDetails).sessionReset).toBeUndefined();
    const after = await quick.run(
      { code: "40 + 2" },
      ctx,
      undefined,
      undefined,
    );
    expect(after.isError).toBeUndefined();
  } finally {
    await quick.close();
  }
});
