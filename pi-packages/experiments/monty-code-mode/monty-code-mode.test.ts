import { expect, test } from "bun:test";
import type {
  AgentTool,
  AgentToolCallOutcome,
} from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import {
  buildIdentifierMap,
  createRunCodeDescription,
  isUsableKwargName,
  pythonType,
  renderPythonSignature,
  renderToolSection,
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

test("pythonType renders short all-string enums as Literal, longer ones as the base type", () => {
  expect(pythonType({ type: "string", enum: ["celsius", "fahrenheit"] })).toBe(
    'Literal["celsius", "fahrenheit"]',
  );
  // 11 literals is past the cap, and integer enums are not string literals at all.
  const long = Array.from({ length: 11 }, (_, i) => `v${i}`);
  expect(pythonType({ type: "string", enum: long })).toBe("str");
  expect(pythonType({ type: "integer", enum: [1, 2] })).toBe("int");
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

test("optional params without a default are marked, not rendered as None", () => {
  const tool = fakeTool({
    parameters: Type.Object({
      city: Type.String(),
      units: Type.Optional(Type.String()),
    }),
  });
  expect(renderPythonSignature(tool, "get_weather")).toBe(
    "async def get_weather(*, city: str, units: str (optional)) -> str",
  );
});

test("isUsableKwargName accepts identifiers and builtins, rejects keywords and dashes", () => {
  expect(isUsableKwargName("city")).toBe(true);
  expect(isUsableKwargName("id")).toBe(true); // builtins are legal as kwargs
  expect(isUsableKwargName("from")).toBe(false);
  expect(isUsableKwargName("2fast")).toBe(false);
  expect(isUsableKwargName("max-results")).toBe(false);
});

test("params that cannot be kwargs stay out of the signature and get the dict escape hatch", () => {
  const tool = fakeTool({
    parameters: Type.Object({
      city: Type.String({ description: "City name" }),
      from: Type.String(),
      "max-results": Type.Integer({ default: 10 }),
    }),
  });
  expect(renderPythonSignature(tool, "get_weather")).toBe(
    "async def get_weather(*, city: str) -> str",
  );
  const section = renderToolSection(tool, "get_weather");
  expect(section).toContain(
    "- 'from' (str, not a valid Python name): pass as `get_weather(**{'from': value})`",
  );
  expect(section).toContain(
    "- 'max-results' (int, not a valid Python name): pass as `get_weather(**{'max-results': value})`",
  );
  const description = createRunCodeDescription([tool]);
  expect(description).toContain(
    "pass them through a dict: `await tool(**{'from': value})`",
  );
  // No escape-hatch bullet when every param name is a valid kwarg.
  expect(createRunCodeDescription([fakeTool()])).not.toContain(
    "not a valid Python identifier",
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
  // The overflow tail itself is capped, so it cannot defeat the budget.
  expect(description).toMatch(/… and \d+ more/);
});

test("marshalToolArgs maps positionals onto declared names and rejects overflow", () => {
  expect(marshalToolArgs(["Paris", "F"], ["city", "units"])).toEqual({
    city: "Paris",
    units: "F",
  });
  expect(marshalToolArgs([1, { b: 2 }], ["a"])).toEqual({ a: 1, b: 2 });
  // A single trailing dict is the kwargs form — usable even for odd param names.
  expect(marshalToolArgs([{ "max-results": 5 }])).toEqual({
    "max-results": 5,
  });
  expect(marshalToolArgs([], ["a"])).toEqual({});
  expect(() => marshalToolArgs([1, 2, 3], ["a"])).toThrow(
    "too many positional arguments",
  );
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

  // Non-text content (images) cannot cross into the sandbox; placeholder, not "".
  const imageContent = [
    { type: "image", data: "…", mimeType: "image/png" },
  ] as unknown as AgentToolCallOutcome["result"]["content"];
  expect(nestedCallValue(outcome({ content: imageContent }), plain)).toBe(
    "[non-text tool content omitted]",
  );
});
