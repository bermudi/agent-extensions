import { expect, test } from "bun:test";
import type {
  AgentTool,
  AgentToolCallOutcome,
} from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import {
  buildIdentifierMap,
  createRunCodeDescription,
  pythonType,
  renderPythonSignature,
  toPythonIdentifier,
} from "./catalog.ts";
import { marshalToolArgs, nestedCallValue } from "./runner.ts";

function fakeTool(overrides: Partial<AgentTool> = {}): AgentTool {
  return {
    name: "get_weather",
    label: "Get Weather",
    description: "Get current weather for a city.",
    parameters: Type.Object({
      city: Type.String({ description: "City name" }),
      units: Type.Optional(
        Type.String({ description: "'C' or 'F'", default: "C" }),
      ),
    }),
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
    ...overrides,
  } as AgentTool;
}

test("toPythonIdentifier maps invalid characters and guards reserved words", () => {
  expect(toPythonIdentifier("read")).toBe("read");
  expect(toPythonIdentifier("mcp__docs-search")).toBe("mcp__docs_search");
  expect(toPythonIdentifier("7zip")).toBe("_7zip");
  expect(toPythonIdentifier("print")).toBe("print_");
  expect(toPythonIdentifier("import")).toBe("import_");
  expect(toPythonIdentifier("json")).toBe("json_");
});

test("buildIdentifierMap resolves collisions deterministically", () => {
  const map = buildIdentifierMap(["do-thing", "do thing", "do_thing"]);
  expect(map.get("do-thing")).toBe("do_thing");
  expect(map.get("do thing")).toBe("do_thing_2");
  expect(map.get("do_thing")).toBe("do_thing_3");
});

test("pythonType maps JSON schema types", () => {
  expect(pythonType({ type: "string" })).toBe("str");
  expect(pythonType({ type: "integer" })).toBe("int");
  expect(pythonType({ type: "number" })).toBe("float");
  expect(pythonType({ type: "boolean" })).toBe("bool");
  expect(pythonType({ type: "array" })).toBe("list");
  expect(pythonType({ type: "object" })).toBe("dict");
  expect(pythonType({})).toBe("Any");
  expect(pythonType(undefined)).toBe("Any");
});

test("renderPythonSignature is keyword-only, defaults optionals, returns str without outputSchema", () => {
  const sig = renderPythonSignature(fakeTool(), "get_weather");
  expect(sig).toBe(
    'async def get_weather(*, city: str, units: str = "C") -> str',
  );
});

test("renderPythonSignature returns dict for an object outputSchema", () => {
  const tool = fakeTool({
    outputSchema: Type.Object({ temp: Type.Number() }),
  });
  expect(renderPythonSignature(tool, "get_weather").endsWith("-> dict")).toBe(
    true,
  );
});

test("createRunCodeDescription lists callable tools and the sandbox contract", () => {
  const description = createRunCodeDescription([
    fakeTool(),
    fakeTool({ name: "run_code" } as Partial<AgentTool>),
  ]);
  expect(description).toContain("Run Python that calls other tools");
  expect(description).toContain("asyncio.gather");
  expect(description).toContain("### `get_weather`");
  expect(description).toContain("- city: City name");
  expect(description).toContain("restart: true");
  // run_code itself is never listed as callable.
  expect(description).not.toContain("### `run_code`");
});

test("createRunCodeDescription falls back to a name list when the budget runs out", () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    fakeTool({
      name: `tool_${i}`,
      description: `${"x".repeat(400)} ${i}`,
    }),
  );
  const description = createRunCodeDescription(many);
  expect(description).toContain("Also callable (left out for space):");
  expect(description.match(/### `tool_/g)?.length ?? 0).toBeLessThan(60);
});

test("marshalToolArgs merges positional objects and trailing kwargs", () => {
  expect(marshalToolArgs([{ a: 1 }, { b: 2 }])).toEqual({ a: 1, b: 2 });
  expect(marshalToolArgs([1, { b: 2 }], "a")).toEqual({ a: 1, b: 2 });
  expect(marshalToolArgs([{ a: 1 }])).toEqual({ a: 1 });
  expect(marshalToolArgs([], "a")).toEqual({});
});

function outcome(
  result: Partial<AgentToolCallOutcome["result"]>,
  isError = false,
): AgentToolCallOutcome {
  return {
    toolCall: {
      id: "t1",
      name: "get_weather",
      arguments: {},
    } as AgentToolCallOutcome["toolCall"],
    result: {
      content: [{ type: "text", text: "sunny" }],
      details: undefined,
      ...result,
    },
    isError,
  };
}

test("nestedCallValue maps text, structuredContent, and errors", () => {
  const plain = fakeTool();
  expect(nestedCallValue(outcome({}), plain)).toBe("sunny");

  const structured = fakeTool({
    outputSchema: Type.Object({ temp: Type.Number() }),
  });
  expect(
    nestedCallValue(outcome({ structuredContent: { temp: 21 } }), structured),
  ).toEqual({ temp: 21 });

  // A structured tool resolves its structuredContent even on error results that carry one.
  expect(
    nestedCallValue(
      outcome({ structuredContent: { temp: -1 } }, true),
      structured,
    ),
  ).toEqual({ temp: -1 });

  // An error without structured content raises with the tool's error text.
  expect(() => nestedCallValue(outcome({}, true), plain)).toThrow("sunny");
});
