import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  sessionEntryToContextMessages,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";

export const KETAMINE_STRATEGY = "ketamine";
export const KETAMINE_VERSION = 1;

export interface TrajectoryUnit {
  id: string;
  entryIds: string[];
  messages: AgentMessage[];
}

export interface TrajectorySnapshot {
  version: 1;
  targetSessionFile?: string;
  targetSessionId: string;
  createdAt: string;
  customInstructions?: string;
  maxCuratedTokens: number;
  units: TrajectoryUnit[];
}

const contentBlockSchema = z.object({ type: z.string().min(1) }).passthrough();
const contentSchema = z.union([z.string(), z.array(contentBlockSchema)]);
const timestampSchema = z.number().finite().nonnegative();
const agentMessageSchema = z.discriminatedUnion("role", [
  z
    .object({
      role: z.literal("user"),
      content: contentSchema,
      timestamp: timestampSchema,
    })
    .passthrough(),
  z
    .object({
      role: z.literal("assistant"),
      content: z.array(contentBlockSchema),
      provider: z.string(),
      model: z.string(),
      usage: z
        .object({ totalTokens: z.number().finite().nonnegative() })
        .passthrough(),
      stopReason: z.string(),
      timestamp: timestampSchema,
    })
    .passthrough(),
  z
    .object({
      role: z.literal("toolResult"),
      toolCallId: z.string(),
      toolName: z.string(),
      content: z.array(contentBlockSchema),
      isError: z.boolean(),
      timestamp: timestampSchema,
    })
    .passthrough(),
  z
    .object({
      role: z.literal("bashExecution"),
      command: z.string(),
      output: z.string(),
      cancelled: z.boolean(),
      truncated: z.boolean(),
      timestamp: timestampSchema,
    })
    .passthrough(),
  z
    .object({
      role: z.literal("custom"),
      customType: z.string(),
      content: contentSchema,
      display: z.boolean(),
      timestamp: timestampSchema,
    })
    .passthrough(),
  z
    .object({
      role: z.literal("branchSummary"),
      summary: z.string(),
      fromId: z.string(),
      timestamp: timestampSchema,
    })
    .passthrough(),
  z
    .object({
      role: z.literal("compactionSummary"),
      summary: z.string(),
      tokensBefore: z.number().finite().nonnegative(),
      timestamp: timestampSchema,
    })
    .passthrough(),
]);

const snapshotSchema = z.object({
  version: z.literal(1),
  targetSessionFile: z.string().optional(),
  targetSessionId: z.string().min(1),
  createdAt: z.iso.datetime(),
  customInstructions: z.string().optional(),
  maxCuratedTokens: z.number().int().positive(),
  units: z
    .array(
      z.object({
        id: z.string().min(1),
        entryIds: z.array(z.string().min(1)).min(1),
        messages: z.array(agentMessageSchema).min(1),
      }),
    )
    .min(1),
});

export function parseSnapshot(value: unknown): TrajectorySnapshot {
  return snapshotSchema.parse(value) as unknown as TrajectorySnapshot;
}

export const decisionSchema = z
  .object({
    action: z.enum(["keep", "summarize", "drop"]),
    unitIds: z.array(z.string().min(1)).min(1),
    summary: z.string().trim().min(1).optional(),
  })
  .superRefine((decision, context) => {
    if (decision.action === "summarize" && !decision.summary) {
      context.addIssue({
        code: "custom",
        message: "summary is required when action is summarize",
        path: ["summary"],
      });
    }
    if (decision.action !== "summarize" && decision.summary !== undefined) {
      context.addIssue({
        code: "custom",
        message: "summary is only allowed when action is summarize",
        path: ["summary"],
      });
    }
  });

export const curationPlanSchema = z.object({
  decisions: z.array(decisionSchema).min(1),
  rationale: z.string().trim().min(1),
});

export type CurationDecision = z.infer<typeof decisionSchema>;
export type CurationPlan = z.infer<typeof curationPlanSchema>;

export interface KetamineCheckpoint {
  strategy: typeof KETAMINE_STRATEGY;
  version: typeof KETAMINE_VERSION;
  runId: string;
  observerSessionDir: string;
  plan: CurationPlan;
  curatedMessages: AgentMessage[];
}

function startsUnit(message: AgentMessage): boolean {
  return (
    message.role === "user" ||
    message.role === "bashExecution" ||
    message.role === "custom" ||
    message.role === "branchSummary" ||
    message.role === "compactionSummary"
  );
}

function appendMessageToUnit(
  units: TrajectoryUnit[],
  message: AgentMessage,
  messageId: string,
  unitId: string,
): void {
  let current = units.at(-1);
  if (!current || startsUnit(message)) {
    current = { id: unitId, entryIds: [], messages: [] };
    units.push(current);
  }
  if (!current.entryIds.includes(messageId)) current.entryIds.push(messageId);
  current.messages.push(message);
}

/** Group the active branch into protocol-safe turns. Tool results never become detached. */
export function buildTrajectoryUnits(
  entries: SessionEntry[],
): TrajectoryUnit[] {
  const units: TrajectoryUnit[] = [];
  for (const entry of entries) {
    for (const message of sessionEntryToContextMessages(entry)) {
      appendMessageToUnit(units, message, entry.id, `turn:${entry.id}`);
    }
  }
  return units;
}

/** Group an already-curated effective context for a subsequent Ketamine pass. */
export function buildTrajectoryUnitsFromMessages(
  messages: AgentMessage[],
): TrajectoryUnit[] {
  const units: TrajectoryUnit[] = [];
  messages.forEach((message, index) => {
    appendMessageToUnit(
      units,
      message,
      `effective-message:${index}`,
      `turn:effective-${units.length}`,
    );
  });
  return units;
}

/** Validate full, ordered, exactly-once coverage of the trajectory. */
export function validatePlan(
  rawPlan: unknown,
  units: TrajectoryUnit[],
): CurationPlan {
  const plan = curationPlanSchema.parse(rawPlan);
  const expectedIds = units.map((unit) => unit.id);
  const actualIds = plan.decisions.flatMap((decision) => decision.unitIds);

  if (actualIds.length !== expectedIds.length) {
    throw new Error(
      `Curation plan covers ${actualIds.length} units; expected ${expectedIds.length}`,
    );
  }

  for (let index = 0; index < expectedIds.length; index++) {
    if (actualIds[index] !== expectedIds[index]) {
      throw new Error(
        `Curation plan must cover every unit exactly once in chronological order; expected ${expectedIds[index]} at position ${index}, received ${actualIds[index] ?? "nothing"}`,
      );
    }
  }

  return plan;
}

function summaryMessage(summary: string, timestamp: number): AgentMessage {
  return {
    role: "custom",
    customType: "ketamine-summary",
    content: [{ type: "text", text: summary }],
    display: true,
    timestamp,
  };
}

/** Materialize exact kept turns and synthetic summaries; dropped turns vanish. */
export function materializePlan(
  plan: CurationPlan,
  units: TrajectoryUnit[],
): AgentMessage[] {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const messages: AgentMessage[] = [];

  for (const decision of plan.decisions) {
    const selected = decision.unitIds.map((id) => {
      const unit = byId.get(id);
      if (!unit) throw new Error(`Unknown trajectory unit: ${id}`);
      return unit;
    });

    if (decision.action === "keep") {
      for (const unit of selected)
        messages.push(...structuredClone(unit.messages));
    } else if (decision.action === "summarize") {
      const firstTimestamp = selected[0]?.messages[0]?.timestamp;
      messages.push(
        summaryMessage(
          decision.summary ?? "",
          typeof firstTimestamp === "number" ? firstTimestamp : Date.now(),
        ),
      );
    }
  }

  return messages;
}

export function isKetamineCheckpoint(
  value: unknown,
): value is KetamineCheckpoint {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.strategy !== KETAMINE_STRATEGY ||
    candidate.version !== KETAMINE_VERSION ||
    typeof candidate.runId !== "string" ||
    typeof candidate.observerSessionDir !== "string" ||
    !Array.isArray(candidate.curatedMessages) ||
    !curationPlanSchema.safeParse(candidate.plan).success
  ) {
    return false;
  }
  try {
    if (JSON.stringify(value).length > 32_000_000) return false;
  } catch {
    return false;
  }
  return candidate.curatedMessages.every(
    (message) => agentMessageSchema.safeParse(message).success,
  );
}

/**
 * Replace all pre-checkpoint messages while preserving messages created afterward,
 * including a not-yet-persisted user/tool message in the current provider turn.
 */
export function applyCheckpoint(
  currentMessages: AgentMessage[],
  checkpoint: KetamineCheckpoint,
  checkpointTimestamp: number,
): AgentMessage[] {
  const checkpointIndex = currentMessages.findLastIndex(
    (message) =>
      message.role === "compactionSummary" &&
      message.timestamp === checkpointTimestamp,
  );
  if (checkpointIndex < 0) {
    // Another context extension removed our carrier. Preserve Pi's fallback
    // context rather than guessing by wall-clock time and risking lost work.
    return structuredClone(currentMessages);
  }
  const tail = currentMessages.slice(checkpointIndex + 1);
  return [...structuredClone(checkpoint.curatedMessages), ...tail];
}

function truncateText(text: string, maxChars: number): string {
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}\n[… ${text.length - maxChars} characters omitted]`;
}

function contentText(
  content:
    | string
    | Array<{
        type: string;
        text?: string;
        mimeType?: string;
        data?: string;
      }>,
  includeImages = false,
): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      if (block.type === "image") {
        const mime =
          typeof block.mimeType === "string" ? block.mimeType : "unknown";
        const size = typeof block.data === "string" ? block.data.length : 0;
        return includeImages
          ? `[image ${mime}; ${size} encoded characters — image body unavailable to text inspection]`
          : `[image ${mime}; inspect conservatively]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function toolResultBody(
  message: Extract<AgentMessage, { role: "toolResult" }>,
): string {
  return contentText(message.content, true);
}

/** Cheap first-pass disclosure: intent, reasoning, tool calls, and result metadata only. */
export function formatUnit(
  unit: TrajectoryUnit,
  maxConversationChars = 8_000,
): string {
  const lines = [`## ${unit.id}`, `Entries: ${unit.entryIds.join(", ")}`];
  let resultIndex = 0;

  for (const message of unit.messages) {
    switch (message.role) {
      case "user":
        lines.push(
          `### User\n${truncateText(contentText(message.content), 1_200)}`,
        );
        break;
      case "custom":
        lines.push(
          `### Context (${message.customType})\n${truncateText(contentText(message.content), 1_200)}`,
        );
        break;
      case "assistant": {
        const text: string[] = [];
        const thinking: string[] = [];
        const calls: string[] = [];
        for (const block of message.content) {
          if (block.type === "text") text.push(block.text);
          else if (block.type === "thinking") thinking.push(block.thinking);
          else if (block.type === "toolCall") {
            calls.push(
              `${block.name}(${truncateText(JSON.stringify(block.arguments), 500)})`,
            );
          }
        }
        if (thinking.length > 0) {
          lines.push(
            `### Assistant reasoning\n${truncateText(thinking.join("\n"), 2_500)}`,
          );
        }
        if (text.length > 0) {
          lines.push(
            `### Assistant response\n${truncateText(text.join("\n"), 1_500)}`,
          );
        }
        if (calls.length > 0) lines.push(`### Tool calls\n${calls.join("\n")}`);
        break;
      }
      case "toolResult": {
        const body = toolResultBody(message);
        const metadata = `### Tool result ${resultIndex}: ${message.toolName} — ${message.isError ? "ERROR" : "ok"}, ${body.length.toLocaleString()} characters`;
        lines.push(
          message.isError
            ? `${metadata}\nError preview: ${truncateText(body, 600)}`
            : `${metadata}\nBody omitted; use ketamine_tool_result only if needed.`,
        );
        resultIndex += 1;
        break;
      }
      case "bashExecution":
        lines.push(
          `### User shell command\n${truncateText(message.command, 800)}\nTool result ${resultIndex}: user_bash — exit=${message.exitCode ?? "unknown"}, ${message.output.length.toLocaleString()} output characters; body omitted.`,
        );
        resultIndex += 1;
        break;
      case "branchSummary":
      case "compactionSummary":
        lines.push(
          `### Existing summary\n${truncateText(message.summary, 2_500)}`,
        );
        break;
    }
  }

  return truncateText(lines.join("\n\n"), maxConversationChars);
}

/** Detailed turn view with tool-result bodies replaced by stable result indexes. */
export function formatUnitWindow(
  unit: TrajectoryUnit,
  offset: number,
  limit: number,
): { text: string; totalChars: number; nextOffset?: number } {
  let resultIndex = 0;
  const disclosed = unit.messages.map((message) => {
    if (message.role !== "toolResult" && message.role !== "bashExecution") {
      return message;
    }
    const body =
      message.role === "toolResult" ? toolResultBody(message) : message.output;
    const replacement =
      message.role === "toolResult"
        ? {
            role: message.role,
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            isError: message.isError,
            timestamp: message.timestamp,
            resultIndex,
            outputCharacters: body.length,
            output: "omitted; use ketamine_tool_result",
          }
        : {
            role: message.role,
            command: message.command,
            exitCode: message.exitCode,
            cancelled: message.cancelled,
            timestamp: message.timestamp,
            resultIndex,
            outputCharacters: body.length,
            output: "omitted; use ketamine_tool_result",
          };
    resultIndex += 1;
    return replacement;
  });
  const conversation = JSON.stringify(disclosed, null, 2);
  const text = conversation.slice(offset, offset + limit);
  const nextOffset = offset + text.length;
  return {
    text,
    totalChars: conversation.length,
    nextOffset: nextOffset < conversation.length ? nextOffset : undefined,
  };
}

export function formatToolResultWindow(
  unit: TrajectoryUnit,
  resultIndex: number,
  offset: number,
  limit: number,
): { text: string; totalChars: number; nextOffset?: number } {
  const result = unit.messages.filter(
    (
      message,
    ): message is Extract<
      AgentMessage,
      { role: "toolResult" | "bashExecution" }
    > => message.role === "toolResult" || message.role === "bashExecution",
  )[resultIndex];
  if (!result)
    throw new Error(`Unknown tool result ${resultIndex} in ${unit.id}`);
  const body =
    result.role === "toolResult" ? toolResultBody(result) : result.output;
  const text = body.slice(offset, offset + limit);
  const nextOffset = offset + text.length;
  return {
    text,
    totalChars: body.length,
    nextOffset: nextOffset < body.length ? nextOffset : undefined,
  };
}

export function isOpenAiModel(provider: string, modelId: string): boolean {
  const normalizedProvider = provider.toLowerCase();
  const normalizedModel = modelId.toLowerCase();
  if (
    normalizedProvider === "openai" ||
    normalizedProvider === "openai-codex"
  ) {
    return true;
  }
  return /(^|\/)(openai\/|gpt(?:-|$)|codex(?:-|$)|o[134](?:-|$))/.test(
    normalizedModel,
  );
}

export function formatFallbackContext(messages: AgentMessage[]): string {
  return [
    "Ketamine curated the following replacement context in a separate observer session.",
    "Treat it as the complete relevant conversation history.",
    "",
    JSON.stringify(messages, null, 2),
  ].join("\n");
}

export function estimateMessageTokens(messages: AgentMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

export function assertCurationFits(
  plan: CurationPlan,
  units: TrajectoryUnit[],
  maxCuratedTokens: number,
): AgentMessage[] {
  const messages = materializePlan(plan, units);
  const estimatedTokens = estimateMessageTokens(messages);
  if (estimatedTokens > maxCuratedTokens) {
    throw new Error(
      `Curated context is approximately ${estimatedTokens.toLocaleString()} tokens; it must be at most ${maxCuratedTokens.toLocaleString()} tokens. Summarize or drop more units.`,
    );
  }
  return messages;
}
