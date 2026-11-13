/**
 * Monty code mode for pi — `run_code`: the model writes one Python program that calls pi's
 * tools as async functions, instead of one model turn per tool call (pydantic-ai CodeMode
 * semantics on pi's nested-tool pipeline). Python runs in the Monty sandbox via the
 * @pydantic/monty native binding; REPL state persists across calls for the pi session.
 *
 * Load for a test with:
 *   pi -ne -e /abs/path/to/pi-packages/experiments/monty-code-mode/index.ts
 *
 * The tool is `model-only` (scripts must not start scripts — same rule as pi's built-in
 * `codemode`), runs sequentially with sibling tool calls (one REPL), and re-renders its
 * description from the callable loadout whenever the active tools change, so MCP tools that
 * register late still show up in the catalog.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createRunCodeDescription } from "./catalog.ts";
import {
  DEFAULT_LIMITS,
  MAX_TOOL_CALLS,
  MontyCodeRunner,
  type RunCodeDetails,
} from "./runner.ts";

export const RUN_CODE_TOOL_NAME = "run_code";

const runCodeSchema = Type.Object({
  code: Type.String({
    description: "Raw Python source (not JSON, no code fence).",
  }),
  restart: Type.Optional(
    Type.Boolean({
      description:
        "Reset the sandbox first: variables, imports, and definitions are cleared.",
    }),
  ),
});

export default function (pi: ExtensionAPI) {
  // The pool spawns worker subprocesses; start it lazily on the first run_code call, never at load.
  const runner = new MontyCodeRunner();

  pi.registerTool({
    name: RUN_CODE_TOOL_NAME,
    label: "run_code (Monty)",
    description: createRunCodeDescription([], {
      maxToolCalls: MAX_TOOL_CALLS,
      maxFeedDurationSecs: DEFAULT_LIMITS.maxFeedDurationSecs,
    }),
    promptSnippet: "Run Python that calls other tools",
    promptGuidelines: [
      "Use run_code to batch independent tool calls (asyncio.gather), chain dependent calls, or filter and transform large tool output, instead of many separate calls.",
    ],
    parameters: runCodeSchema,
    exposure: "model-only",
    executionMode: "sequential",
    prepareLoadout: (loadout) => ({
      descriptions: {
        [RUN_CODE_TOOL_NAME]: createRunCodeDescription(loadout.callable, {
          maxToolCalls: MAX_TOOL_CALLS,
          maxFeedDurationSecs: DEFAULT_LIMITS.maxFeedDurationSecs,
        }),
      },
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return runner.run(params, ctx, signal, onUpdate);
    },
  });

  pi.on("session_shutdown", async () => {
    await runner.close();
  });
}
