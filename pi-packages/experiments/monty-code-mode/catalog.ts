/**
 * Model-facing catalog for the `run_code` tool: Python identifiers for tool names,
 * Python signatures rendered from tool JSON schemas, and the tool description that
 * lists every callable tool. Pure functions — no Monty, no pi runtime.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";

/** Stdlib modules Monty 1.6 can import (verified by probe; anything else raises ModuleNotFoundError). */
export const MONTY_MODULES = [
  "annotationlib",
  "asyncio",
  "base64",
  "binascii",
  "bisect",
  "collections",
  "copy",
  "csv",
  "dataclasses",
  "datetime",
  "decimal",
  "fnmatch",
  "functools",
  "hashlib",
  "itertools",
  "json",
  "math",
  "os",
  "os.path",
  "pathlib",
  "random",
  "re",
  "sys",
  "time",
  "tomllib",
  "typing",
  "unicodedata",
] as const;

const PYTHON_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

const PYTHON_BUILTINS = new Set([
  "abs",
  "aiter",
  "all",
  "any",
  "bin",
  "bool",
  "bytearray",
  "bytes",
  "callable",
  "chr",
  "classmethod",
  "compile",
  "complex",
  "delattr",
  "dict",
  "dir",
  "divmod",
  "enumerate",
  "eval",
  "filter",
  "float",
  "format",
  "frozenset",
  "getattr",
  "globals",
  "hasattr",
  "hash",
  "help",
  "hex",
  "id",
  "input",
  "int",
  "isinstance",
  "issubclass",
  "iter",
  "len",
  "list",
  "locals",
  "map",
  "max",
  "memoryview",
  "min",
  "next",
  "object",
  "oct",
  "open",
  "ord",
  "pow",
  "print",
  "property",
  "range",
  "repr",
  "reversed",
  "round",
  "set",
  "setattr",
  "slice",
  "sorted",
  "staticmethod",
  "str",
  "sum",
  "super",
  "tuple",
  "type",
  "vars",
  "zip",
]);

/** Names a tool identifier must not shadow: keywords, builtins, and Monty's importable modules. */
const RESERVED = new Set<string>([
  ...PYTHON_KEYWORDS,
  ...PYTHON_BUILTINS,
  ...MONTY_MODULES,
]);

/**
 * A tool name as a valid Python identifier: invalid characters become `_`, a leading digit gets a
 * `_` prefix, and reserved words (keywords, builtins, Monty's modules) get a trailing `_` so the
 * tool stays callable instead of shadowing `print` or losing to `import json`.
 */
export function toPythonIdentifier(name: string): string {
  let id = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (!/^[a-zA-Z_]/.test(id)) id = `_${id}`;
  if (RESERVED.has(id)) id = `${id}_`;
  return id;
}

/**
 * Tool names to sandbox identifiers, collision-free: the first name keeps its direct identifier,
 * later collisions get `_2`, `_3`, … suffixes.
 */
export function buildIdentifierMap(
  toolNames: readonly string[],
): Map<string, string> {
  const taken = new Set<string>();
  const map = new Map<string, string>();
  for (const name of toolNames) {
    let id = toPythonIdentifier(name);
    if (taken.has(id)) {
      let n = 2;
      while (taken.has(`${id}_${n}`)) n++;
      id = `${id}_${n}`;
    }
    taken.add(id);
    map.set(name, id);
  }
  return map;
}

interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
  enum?: unknown[];
  default?: unknown;
  description?: string;
  anyOf?: unknown[];
  oneOf?: unknown[];
}

function asSchema(value: unknown): JsonSchemaObject | undefined {
  return typeof value === "object" && value !== null
    ? (value as JsonSchemaObject)
    : undefined;
}

/** One JSON-Schema node as a Python annotation. Anything shapeless is `Any`. */
export function pythonType(schema: unknown): string {
  const s = asSchema(schema);
  if (!s) return "Any";
  if (Array.isArray(s.enum) && s.enum.every((v) => typeof v === "string"))
    return "str";
  switch (s.type) {
    case "string":
      return "str";
    case "integer":
      return "int";
    case "number":
      return "float";
    case "boolean":
      return "bool";
    case "array":
      return "list";
    case "object":
      return "dict";
    default:
      return "Any";
  }
}

function reprDefault(value: unknown): string | undefined {
  if (value === null) return "None";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
    case "boolean":
      return String(value);
    default:
      return undefined;
  }
}

/** `async def <id>(*, p: t = d, ...) -> <ret>` for one tool, or just the id when the schema is unusable. */
export function renderPythonSignature(
  tool: AgentTool,
  identifier: string,
): string {
  const params = asSchema(tool.parameters as unknown);
  const props = params?.properties ?? {};
  const required = new Set(params?.required ?? []);
  const args = Object.entries(props).map(([name, raw]) => {
    const schema = asSchema(raw);
    const type = pythonType(raw);
    if (required.has(name)) return `${name}: ${type}`;
    const def = schema ? reprDefault(schema.default) : undefined;
    return def !== undefined
      ? `${name}: ${type} = ${def}`
      : `${name}: ${type} | None = None`;
  });
  const output = asSchema(tool.outputSchema as unknown);
  const ret = !output ? "str" : pythonType(tool.outputSchema);
  return `async def ${identifier}(${args.length > 0 ? `*, ${args.join(", ")}` : ""}) -> ${ret}`;
}

/** Description first paragraph, trimmed — full texts cost too much catalog budget. */
function firstParagraph(text: string): string {
  return (
    text
      .trim()
      .split(/\n\s*\n/)[0]
      ?.trim() ?? ""
  );
}

/**
 * One tool's catalog section: identifier heading, signature, short description, and one line per
 * documented parameter.
 */
export function renderToolSection(tool: AgentTool, identifier: string): string {
  const lines = [`### \`${identifier}\``];
  const idEqualsName = identifier === tool.name;
  if (!idEqualsName) lines[0] += ` (\`${tool.name}\`)`;
  lines.push(renderPythonSignature(tool, identifier));
  const desc = firstParagraph(tool.description ?? "");
  if (desc) lines.push(desc);
  const params = asSchema(tool.parameters as unknown);
  for (const [name, raw] of Object.entries(params?.properties ?? {})) {
    const d = asSchema(raw)?.description;
    if (typeof d === "string" && d.trim()) lines.push(`- ${name}: ${d.trim()}`);
  }
  return lines.join("\n");
}

/** Estimated-token budget the tool catalog may spend (chars / 4, like pi's codemode inline budget). */
export const DEFAULT_CATALOG_BUDGET_TOKENS = 3000;
const CHARS_PER_TOKEN = 4;

/** The model-facing `run_code` description: sandbox contract + the callable-tool catalog. */
export function createRunCodeDescription(
  tools: readonly AgentTool[],
  options: { maxToolCalls?: number; maxFeedDurationSecs?: number } = {},
): string {
  const callable = tools.filter((t) => t.name !== "run_code");
  const maxToolCalls = options.maxToolCalls ?? 100;
  const maxSecs = options.maxFeedDurationSecs ?? 30;
  const intro = [
    "Run Python that calls other tools. The input is raw Python (not JSON, no code fence), executed in a Monty sandbox: a safe Python subset with no filesystem, network, or environment access.",
    "- Call tools as async functions and await them: `result = await read(path='src/main.ts')`. Calls run through the agent's normal tool pipeline; a failed call raises RuntimeError carrying the tool's error text.",
    "- Use `asyncio.gather(...)` for parallel calls; loops, comprehensions, and plain Python to filter, aggregate, and transform — intermediate values stay in the sandbox and never enter the conversation.",
    `- Importable modules (import before use): ${[...MONTY_MODULES].join(", ")}. No other modules and no \`import *\`. \`datetime.now()\`/\`time.time()\` reflect the sandbox clock; seed \`random.seed(...)\` for reproducibility.`,
    "- `print(...)` is for progress logging. The value of the final expression is returned to the model — put it on the last line (an assignment or `None` returns no value).",
    "- Variables, imports, and definitions persist across run_code calls in this session. Pass `restart: true` to clear the sandbox first.",
    `- Limits per call: ${maxSecs}s execution (time waiting on tools excluded), 256 MiB memory, ${maxToolCalls} nested tool calls.`,
  ].join("\n");
  if (callable.length === 0) return intro;

  const ids = buildIdentifierMap(callable.map((t) => t.name));
  const sections = callable.map((tool) => {
    const section = renderToolSection(tool, ids.get(tool.name) ?? tool.name);
    return { section, cost: Math.ceil(section.length / CHARS_PER_TOKEN) };
  });
  let budget = DEFAULT_CATALOG_BUDGET_TOKENS;
  const shown: string[] = [];
  const rest: string[] = [];
  for (const [i, s] of sections.entries()) {
    if (s.cost <= budget) {
      budget -= s.cost;
      shown.push(s.section);
    } else {
      rest.push(`\`${ids.get(callable[i].name)}\``);
    }
  }
  const catalog = ["## Callable tools", ...shown];
  if (rest.length > 0) {
    catalog.push(
      `Also callable (left out for space): ${rest.join(", ")}. Same shape as above: \`await <name>(<kwargs>)\`.`,
    );
  }
  return `${intro}\n\n${catalog.join("\n\n")}`;
}
