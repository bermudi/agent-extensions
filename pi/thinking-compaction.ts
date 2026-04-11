import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const EXTENSION_NAME = "thinking-compaction";
const SUMMARY_MODEL_CANDIDATES: Array<[string, string]> = [["google", "gemini-2.5-flash"]];
const MAX_THINKING_PER_MESSAGE = 2500;
const MAX_ASSISTANT_TEXT_PER_MESSAGE = 700;
const MAX_TOOL_EVIDENCE_PER_ITEM = 700;
const MAX_TURN_TEXT = 12000;
const MAX_PROMPT_TEXT = 180000;

const INITIAL_PROMPT = `You are compacting an AI coding session for future continuation.

Your highest priority is preserving the assistant's working mind:
- how it understood the codebase
- what issues it identified
- what approaches it tried
- what dead ends or false starts happened
- why it changed direction
- what mental model it built

Low-value information to aggressively compress or omit unless essential:
- raw file contents from read tool calls
- repetitive tool call lists
- boilerplate assistant chatter ("let me check", "I'll inspect", etc.)
- unimportant command output

Convert the transcript into a small number of coherent units of work. Each unit should preserve the reasoning trail, not just the final result.

Use this EXACT format:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements, constraints, or preferences]
- [Or "(none)"]

## Units of Work
### Unit 1: [short title]
- **Understanding**: [What the assistant learned / how it interpreted the code]
- **Issues found**: [Problems, risks, or mismatches it identified]
- **Attempts**: [What it tried, including wrong turns if important]
- **Outcome**: [Where that unit ended up]

### Unit 2: [short title]
- **Understanding**: ...
- **Issues found**: ...
- **Attempts**: ...
- **Outcome**: ...

## Current Mental Model
- [How the assistant currently understands the system / problem]

## Open Questions / Risks
- [Outstanding uncertainty, risk, or unresolved point]
- [Or "(none)"]

## Next Steps
1. [What should happen next]

Rules:
- Preserve exact file paths, function names, identifiers, branch names, and important error messages.
- Prefer reasoning and problem-solving over chronology.
- If the assistant corrected itself, preserve the correction.
- Mention file modifications only when they matter to the reasoning or current state.
- Be concise but high-signal.`;

const UPDATE_PROMPT = `You are updating an existing compaction summary for an AI coding session.

The previous summary is in <previous-summary>. The new transcript is in <new-work>.

Your highest priority is preserving the assistant's reasoning trail and mental model. Merge the previous summary with the new work while keeping the result concise and high-signal.

Rules:
- Preserve important prior context unless superseded.
- Add new units of work as needed, or update existing ones if they naturally continue the same effort.
- Keep the focus on understanding, issues found, attempts, course corrections, and outcomes.
- Remove stale "Next Steps" items if they are already done.
- Preserve exact file paths, function names, identifiers, branch names, and important error messages.
- Do not bloat the summary with raw tool output or repetitive tool listings.

Use this EXACT format:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements, constraints, or preferences]
- [Or "(none)"]

## Units of Work
### Unit 1: [short title]
- **Understanding**: [What the assistant learned / how it interpreted the code]
- **Issues found**: [Problems, risks, or mismatches it identified]
- **Attempts**: [What it tried, including wrong turns if important]
- **Outcome**: [Where that unit ended up]

## Current Mental Model
- [How the assistant currently understands the system / problem]

## Open Questions / Risks
- [Outstanding uncertainty, risk, or unresolved point]
- [Or "(none)"]

## Next Steps
1. [What should happen next]`;

type AnyRecord = Record<string, any>;
type AnyMessage = AnyRecord;
type ToolCallInfo = {
  name: string;
  args: AnyRecord;
};
type Turn = {
  label: string;
  request: string;
  reasoning: string[];
  responses: string[];
  evidence: string[];
  toolCalls: Map<string, ToolCallInfo>;
};

export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, customInstructions, signal } = event;
    const { messagesToSummarize, turnPrefixMessages, previousSummary, firstKeptEntryId, tokensBefore, fileOps } = preparation;

    const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
    if (allMessages.length === 0) return;

    const turns = groupIntoTurns(allMessages);
    const transcript = buildTranscript(turns);
    if (!transcript.trim()) return;

    const modelChoice = await resolveSummaryModel(ctx);
    if (!modelChoice) {
      ctx.ui.notify("Thinking compaction: no summary model available, falling back to default compaction", "warning");
      return;
    }

    const prompt = buildPrompt({
      transcript,
      previousSummary: stripFileTags(previousSummary),
      customInstructions,
    });

    ctx.ui.notify(
      `Thinking compaction: summarizing ${allMessages.length} messages (${tokensBefore.toLocaleString()} tokens) with ${modelChoice.model.provider}/${modelChoice.model.id}`,
      "info",
    );

    try {
      const response = await complete(
        modelChoice.model,
        {
          systemPrompt: previousSummary ? UPDATE_PROMPT : INITIAL_PROMPT,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: prompt }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: modelChoice.auth.apiKey,
          headers: modelChoice.auth.headers,
          maxTokens: 8192,
          signal,
        },
      );

      const summary = response.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();

      if (!summary) {
        if (!signal.aborted) {
          ctx.ui.notify("Thinking compaction produced an empty summary, falling back to default compaction", "warning");
        }
        return;
      }

      const { readFiles, modifiedFiles } = computeFileLists(fileOps);
      const finalSummary = `${summary}${formatFileTags(readFiles, modifiedFiles)}`;

      return {
        compaction: {
          summary: finalSummary,
          firstKeptEntryId,
          tokensBefore,
          details: {
            version: 1,
            strategy: EXTENSION_NAME,
            readFiles,
            modifiedFiles,
            turns: turns.length,
            model: `${modelChoice.model.provider}/${modelChoice.model.id}`,
          },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!signal.aborted) {
        ctx.ui.notify(`Thinking compaction failed: ${message}`, "error");
      }
      return;
    }
  });
}

async function resolveSummaryModel(ctx: AnyRecord) {
  const seen = new Set<string>();
  const candidates: AnyRecord[] = [];

  for (const [provider, id] of SUMMARY_MODEL_CANDIDATES) {
    const model = ctx.modelRegistry.find(provider, id);
    if (model) candidates.push(model);
  }

  if (ctx.model) candidates.push(ctx.model);

  for (const model of candidates) {
    if (!model) continue;
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok && auth.apiKey) {
      return { model, auth };
    }
  }

  return undefined;
}

function buildPrompt(args: { transcript: string; previousSummary?: string; customInstructions?: string }) {
  const parts: string[] = [];

  if (args.customInstructions?.trim()) {
    parts.push(`<focus>\n${args.customInstructions.trim()}\n</focus>`);
  }

  if (args.previousSummary?.trim()) {
    parts.push(`<previous-summary>\n${args.previousSummary.trim()}\n</previous-summary>`);
    parts.push(`<new-work>\n${truncateForPrompt(args.transcript)}\n</new-work>`);
  } else {
    parts.push(`<conversation>\n${truncateForPrompt(args.transcript)}\n</conversation>`);
  }

  return parts.join("\n\n");
}

function groupIntoTurns(messages: AnyMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current = createTurn("Context", "(implicit continuation)");
  let haveCurrent = false;

  for (const message of messages) {
    const role = message?.role;

    if (isTurnStartRole(role)) {
      if (haveCurrent && hasUsefulTurnContent(current)) {
        turns.push(finalizeTurn(current, turns.length + 1));
      }
      current = createTurn(labelForRole(role), describeTurnRequest(message));
      haveCurrent = true;
      continue;
    }

    haveCurrent = true;

    if (role === "assistant") {
      ingestAssistantMessage(current, message);
      continue;
    }

    if (role === "toolResult") {
      ingestToolResult(current, message);
      continue;
    }

    if (role === "branchSummary" || role === "compactionSummary") {
      current.responses.push(trimMiddle(typeof message.summary === "string" ? message.summary : "", MAX_ASSISTANT_TEXT_PER_MESSAGE));
      continue;
    }
  }

  if (haveCurrent && hasUsefulTurnContent(current)) {
    turns.push(finalizeTurn(current, turns.length + 1));
  }

  return turns;
}

function createTurn(label: string, request: string): Turn {
  return {
    label,
    request: request || "(empty)",
    reasoning: [],
    responses: [],
    evidence: [],
    toolCalls: new Map(),
  };
}

function finalizeTurn(turn: Turn, index: number): Turn {
  return {
    ...turn,
    label: `${turn.label} ${index}`,
    reasoning: capSection(turn.reasoning, MAX_TURN_TEXT),
    responses: capSection(turn.responses, Math.floor(MAX_TURN_TEXT / 2)),
    evidence: capSection(turn.evidence, Math.floor(MAX_TURN_TEXT / 2)),
  };
}

function capSection(items: string[], maxChars: number) {
  const result: string[] = [];
  let used = 0;

  for (const item of items) {
    if (!item) continue;
    const next = item.trim();
    if (!next) continue;
    const cost = next.length + 2;
    if (used + cost <= maxChars) {
      result.push(next);
      used += cost;
      continue;
    }

    const remaining = Math.max(0, maxChars - used - 16);
    if (remaining > 80) {
      result.push(trimMiddle(next, remaining));
    }
    break;
  }

  return result;
}

function hasUsefulTurnContent(turn: Turn) {
  return Boolean(turn.request || turn.reasoning.length || turn.responses.length || turn.evidence.length);
}

function isTurnStartRole(role: string) {
  return role === "user" || role === "bashExecution" || role === "custom";
}

function labelForRole(role: string) {
  switch (role) {
    case "bashExecution":
      return "User Bash";
    case "custom":
      return "Custom Input";
    default:
      return "Turn";
  }
}

function describeTurnRequest(message: AnyMessage) {
  if (!message) return "(empty)";

  if (message.role === "user") {
    return extractText(message.content) || "(empty user message)";
  }

  if (message.role === "bashExecution") {
    const command = oneLine(message.command || "");
    return command ? `User executed bash: ${command}` : "User executed bash";
  }

  if (message.role === "custom") {
    return extractText(message.content) || `Custom input: ${message.customType || "unknown"}`;
  }

  return "(implicit continuation)";
}

function ingestAssistantMessage(turn: Turn, message: AnyMessage) {
  const blocks = Array.isArray(message?.content) ? message.content : [];

  const thinking = blocks
    .filter((block: AnyRecord) => block?.type === "thinking" && typeof block.thinking === "string")
    .map((block: AnyRecord) => block.thinking)
    .join("\n\n")
    .trim();

  if (thinking) {
    turn.reasoning.push(trimMiddle(thinking, MAX_THINKING_PER_MESSAGE));
  }

  const text = blocks
    .filter((block: AnyRecord) => block?.type === "text" && typeof block.text === "string")
    .map((block: AnyRecord) => block.text)
    .join("\n\n")
    .trim();

  if (text && !looksLikeFiller(text)) {
    turn.responses.push(trimMiddle(text, MAX_ASSISTANT_TEXT_PER_MESSAGE));
  }

  for (const block of blocks) {
    if (block?.type === "toolCall" && block.id && block.name) {
      turn.toolCalls.set(block.id, {
        name: block.name,
        args: isRecord(block.arguments) ? block.arguments : {},
      });
    }
  }
}

function ingestToolResult(turn: Turn, message: AnyMessage) {
  const toolName = typeof message?.toolName === "string" ? message.toolName : "unknown";
  const text = extractText(message?.content).trim();
  const toolCall = turn.toolCalls.get(message?.toolCallId);

  if (toolName === "read" && !message?.isError) {
    return;
  }

  if (toolName === "bash") {
    const evidence = summarizeBashEvidence(toolCall?.args?.command, text, Boolean(message?.isError));
    if (evidence) turn.evidence.push(evidence);
    return;
  }

  if (message?.isError) {
    const descriptor = toolCall?.name ? `${toolCall.name}` : toolName;
    turn.evidence.push(`${descriptor} error: ${trimMiddle(text || "(no output)", MAX_TOOL_EVIDENCE_PER_ITEM)}`);
    return;
  }

  if (toolName === "edit" || toolName === "write") {
    const path = typeof toolCall?.args?.path === "string" ? toolCall.args.path : undefined;
    if (path) {
      turn.evidence.push(`${toolName} succeeded on ${path}`);
    }
  }
}

function summarizeBashEvidence(command: string | undefined, output: string, isError: boolean) {
  const cmd = oneLine(command || "bash");
  const cleaned = output.trim();
  const lowerCommand = cmd.toLowerCase();
  const lowerOutput = cleaned.toLowerCase();
  const commandLooksImportant = /(go test|npm test|pnpm test|yarn test|pytest|cargo test|vitest|jest|go build|tsc\b|eslint|golangci-lint|make test|make lint|git diff|git status|gh\b)/i.test(cmd);
  const outputLooksImportant = /(\bpass\b|\bfail\b|error|panic:|traceback|exception|undefined|not found|timed out|permission denied|lgtm|rejected|critical|warning)/i.test(cleaned);

  if (!isError && !commandLooksImportant && !outputLooksImportant) {
    return undefined;
  }

  const interestingLines = pickInterestingLines(cleaned, 8);
  const detailSource = interestingLines.length > 0 ? interestingLines.join(" | ") : cleaned;
  const detail = trimMiddle(detailSource || "(no output)", MAX_TOOL_EVIDENCE_PER_ITEM);

  if (/go test|npm test|pnpm test|yarn test|pytest|cargo test|vitest|jest/i.test(lowerCommand)) {
    const status = /(\bFAIL\b|failed|panic:|error)/i.test(cleaned) || isError ? "failed" : /(\bPASS\b|\bok\b|passed)/i.test(cleaned) ? "passed" : "ran";
    return `Test command \`${trimMiddle(cmd, 120)}\` ${status}: ${detail}`;
  }

  if (/go build|tsc\b|eslint|golangci-lint|make test|make lint/i.test(lowerCommand)) {
    const status = isError || /(error|fail)/i.test(cleaned) ? "reported problems" : "completed";
    return `Check command \`${trimMiddle(cmd, 120)}\` ${status}: ${detail}`;
  }

  if (/git diff/i.test(lowerCommand)) {
    if (isError) return `Git diff command \`${trimMiddle(cmd, 120)}\` errored: ${detail}`;
    return undefined;
  }

  return `Bash command \`${trimMiddle(cmd, 120)}\`${isError ? " errored" : " produced relevant output"}: ${detail}`;
}

function pickInterestingLines(text: string, maxLines: number) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const interesting = lines.filter((line) =>
    /(\bPASS\b|\bFAIL\b|error|panic:|traceback|exception|undefined|not found|timed out|permission denied|critical|warning|rejected|lgtm|--- FAIL|FAIL\t|ok\t)/i.test(
      line,
    ),
  );

  if (interesting.length > 0) {
    return interesting.slice(0, maxLines);
  }

  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, Math.ceil(maxLines / 2)), ...lines.slice(-(Math.floor(maxLines / 2)))];
}

function looksLikeFiller(text: string) {
  const compact = oneLine(text).toLowerCase();
  if (compact.length > 180) return false;

  return /^(let me|i'?ll|i will|first,? let me|now let me|i'm going to|i am going to|let's|i should|i need to)\b/.test(compact);
}

function buildTranscript(turns: Turn[]) {
  const parts: string[] = [];

  for (const turn of turns) {
    const section: string[] = [];
    section.push(`### ${turn.label}`);
    section.push(`Request: ${turn.request}`);

    if (turn.reasoning.length > 0) {
      section.push(`Reasoning:\n${turn.reasoning.map((item) => `- ${indentBullet(item)}`).join("\n")}`);
    }

    if (turn.responses.length > 0) {
      section.push(`Stated conclusions:\n${turn.responses.map((item) => `- ${indentBullet(item)}`).join("\n")}`);
    }

    if (turn.evidence.length > 0) {
      section.push(`Relevant evidence:\n${turn.evidence.map((item) => `- ${indentBullet(item)}`).join("\n")}`);
    }

    parts.push(section.join("\n\n"));
  }

  return parts.join("\n\n");
}

function indentBullet(text: string) {
  return text.replace(/\n/g, "\n  ");
}

function extractText(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((part: AnyRecord) => part?.type === "text" && typeof part.text === "string")
    .map((part: AnyRecord) => part.text)
    .join("\n")
    .trim();
}

function trimMiddle(text: string, maxChars: number) {
  if (!text) return "";
  if (text.length <= maxChars) return text;

  const head = Math.max(40, Math.floor(maxChars * 0.6));
  const tail = Math.max(20, maxChars - head - 24);
  return `${text.slice(0, head)}\n[… truncated …]\n${text.slice(-tail)}`;
}

function truncateForPrompt(text: string) {
  return trimMiddle(text, MAX_PROMPT_TEXT);
}

function oneLine(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripFileTags(summary?: string) {
  if (!summary) return summary;
  return summary
    .replace(/\n?<read-files>[\s\S]*?<\/read-files>/g, "")
    .replace(/\n?<modified-files>[\s\S]*?<\/modified-files>/g, "")
    .trim();
}

function computeFileLists(fileOps: AnyRecord) {
  const read = toStringArray(fileOps?.read);
  const written = toStringArray(fileOps?.written);
  const edited = toStringArray(fileOps?.edited);

  const modifiedSet = new Set([...written, ...edited]);
  const readFiles = [...new Set(read.filter((path) => !modifiedSet.has(path)))].sort();
  const modifiedFiles = [...modifiedSet].sort();

  return { readFiles, modifiedFiles };
}

function toStringArray(value: unknown) {
  if (value instanceof Set) {
    return [...value].filter((item): item is string => typeof item === "string");
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function formatFileTags(readFiles: string[], modifiedFiles: string[]) {
  const parts: string[] = [];

  if (readFiles.length > 0) {
    parts.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }

  if (modifiedFiles.length > 0) {
    parts.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }

  return parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
}
