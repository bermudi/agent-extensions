import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import {
  assertCurationFits,
  formatToolResultWindow,
  formatUnit,
  formatUnitWindow,
  parseSnapshot,
  validatePlan,
} from "./core.ts";

const snapshotPath = process.env.KETAMINE_SNAPSHOT_PATH;
let snapshotPromise: Promise<ReturnType<typeof parseSnapshot>> | undefined;

function loadSnapshot(): Promise<ReturnType<typeof parseSnapshot>> {
  if (!snapshotPath) {
    return Promise.reject(
      new Error("KETAMINE_SNAPSHOT_PATH is not configured"),
    );
  }
  snapshotPromise ??= readFile(snapshotPath, "utf8").then((contents) => {
    const raw: unknown = JSON.parse(contents);
    return parseSnapshot(raw);
  });
  return snapshotPromise;
}

export default function observerExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ketamine_trajectory",
    label: "Inspect trajectory",
    description:
      "Read a compact chronological map of the frozen trajectory: user intent, assistant reasoning/responses, tool calls, errors, and tool-output sizes. Successful tool-output bodies are omitted. Inspect every page before submitting.",
    promptSnippet: "Inspect a page of the frozen trajectory",
    parameters: Type.Object({
      offset: Type.Optional(
        Type.Number({ minimum: 0, description: "Zero-based unit offset" }),
      ),
      limit: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 10,
          description: "Units to return; defaults to 10",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const snapshot = await loadSnapshot();
      const offset = Math.floor(params.offset ?? 0);
      const limit = Math.floor(params.limit ?? 10);
      const units = snapshot.units.slice(offset, offset + limit);
      const nextOffset = offset + units.length;

      return {
        content: [
          {
            type: "text",
            text: [
              `Trajectory units ${offset}-${Math.max(offset, nextOffset - 1)} of ${snapshot.units.length}. Curated-context budget: approximately ${snapshot.maxCuratedTokens.toLocaleString()} tokens.`,
              offset === 0
                ? snapshot.customInstructions
                  ? `User compaction focus: ${snapshot.customInstructions}`
                  : "No additional compaction focus was provided."
                : "Continue inspecting the remaining trajectory.",
              nextOffset < snapshot.units.length
                ? `Next offset: ${nextOffset}`
                : "This is the final page.",
              "",
              ...units.map((unit) => formatUnit(unit, 8_000)),
            ].join("\n\n"),
          },
        ],
        details: {
          offset,
          returned: units.length,
          total: snapshot.units.length,
          nextOffset:
            nextOffset < snapshot.units.length ? nextOffset : undefined,
        },
      };
    },
  });

  pi.registerTool({
    name: "ketamine_unit",
    label: "Inspect trajectory unit",
    description:
      "Read a detailed character window from one trajectory unit, including full user/assistant text and exposed reasoning. Tool-output bodies remain omitted and are referenced by resultIndex.",
    promptSnippet:
      "Inspect a detailed turn without consuming tool-output bodies",
    parameters: Type.Object({
      unitId: Type.String({ minLength: 1 }),
      offset: Type.Optional(Type.Number({ minimum: 0 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20_000 })),
    }),
    async execute(_toolCallId, params) {
      const snapshot = await loadSnapshot();
      const unit = snapshot.units.find(
        (candidate) => candidate.id === params.unitId,
      );
      if (!unit) {
        throw new Error(`Unknown trajectory unit: ${params.unitId}`);
      }
      const offset = Math.floor(params.offset ?? 0);
      const window = formatUnitWindow(
        unit,
        offset,
        Math.floor(params.limit ?? 12_000),
      );
      return {
        content: [
          {
            type: "text",
            text: [
              `${unit.id}, characters ${offset}-${offset + window.text.length} of ${window.totalChars}`,
              window.nextOffset === undefined
                ? "Final window."
                : `Next offset: ${window.nextOffset}`,
              "",
              window.text,
            ].join("\n"),
          },
        ],
        details: { unitId: unit.id, offset, ...window },
      };
    },
  });

  pi.registerTool({
    name: "ketamine_tool_result",
    label: "Inspect one tool result",
    description:
      "Read a paginated character window from one specific tool result. Use only when the trajectory map or assistant reasoning indicates that exact output matters.",
    promptSnippet: "Inspect one relevant tool output on demand",
    parameters: Type.Object({
      unitId: Type.String({ minLength: 1 }),
      resultIndex: Type.Number({ minimum: 0 }),
      offset: Type.Optional(Type.Number({ minimum: 0 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20_000 })),
    }),
    async execute(_toolCallId, params) {
      const snapshot = await loadSnapshot();
      const unit = snapshot.units.find(
        (candidate) => candidate.id === params.unitId,
      );
      if (!unit) throw new Error(`Unknown trajectory unit: ${params.unitId}`);
      const offset = Math.floor(params.offset ?? 0);
      const resultIndex = Math.floor(params.resultIndex);
      const window = formatToolResultWindow(
        unit,
        resultIndex,
        offset,
        Math.floor(params.limit ?? 12_000),
      );
      return {
        content: [
          {
            type: "text",
            text: [
              `${unit.id} tool result ${resultIndex}, characters ${offset}-${offset + window.text.length} of ${window.totalChars}`,
              window.nextOffset === undefined
                ? "Final window."
                : `Next offset: ${window.nextOffset}`,
              "",
              window.text,
            ].join("\n"),
          },
        ],
        details: { unitId: unit.id, resultIndex, offset, ...window },
      };
    },
  });

  pi.registerTool({
    name: "ketamine_submit",
    label: "Submit curated context",
    description:
      "Submit the final exhaustive keep/summarize/drop plan. Every trajectory unit must appear exactly once and remain in chronological order. This terminates the observer.",
    promptSnippet: "Submit the exhaustive curation plan",
    parameters: Type.Object({
      rationale: Type.String({
        minLength: 1,
        description: "Brief explanation of the curation strategy",
      }),
      decisions: Type.Array(
        Type.Object({
          action: Type.Union([
            Type.Literal("keep"),
            Type.Literal("summarize"),
            Type.Literal("drop"),
          ]),
          unitIds: Type.Array(Type.String({ minLength: 1 }), {
            minItems: 1,
            description:
              "One or more consecutive unit IDs, in chronological order",
          }),
          summary: Type.Optional(
            Type.String({
              minLength: 1,
              description:
                "Required for summarize and forbidden for keep/drop; replacement context for these units",
            }),
          ),
        }),
        { minItems: 1 },
      ),
    }),
    async execute(_toolCallId, params) {
      const snapshot = await loadSnapshot();
      const plan = validatePlan(params, snapshot.units);
      assertCurationFits(plan, snapshot.units, snapshot.maxCuratedTokens);
      return {
        content: [
          {
            type: "text",
            text: `Submitted ${plan.decisions.length} curation decisions.`,
          },
        ],
        details: plan,
        terminate: true,
      };
    },
  });
}
