import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DEBUG_DIR = join(homedir(), ".pi", "logs", "thinking-compaction");

const EXTENSION_NAME = "thinking-compaction";
const SUMMARY_MODEL_CANDIDATES: Array<[string, string]> = [["google", "gemini-2.5-flash"]];
// Rough heuristic: 1 token ≈ 3.5 characters. Conservative to avoid overshooting.
const CHARS_PER_TOKEN = 3.5;

const INITIAL_PROMPT = `You are compacting an AI coding session for future continuation.

Your highest priority is preserving the assistant's working mind:
- how it understood the codebase
- what issues it identified
- what approaches it tried
- what dead ends or false starts happened
- why it changed direction
- what mental model it built

User messages may contain crucial details — requirements, constraints, preferences, or corrections buried in casual conversation. You SHOULD attempt to preserve as much of that content as possible without sacrificing the compression of other low-value material.

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
- User messages often contain the most important context (requirements, constraints, corrections). Never sacrifice user-stated details for the sake of brevity.

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
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const runDir = join(DEBUG_DIR, runId);

    if (allMessages.length === 0) return;

    const turns = groupIntoTurns(allMessages);

    const modelChoice = await resolveSummaryModel(ctx);
    if (!modelChoice) {
      ctx.ui.notify("Thinking compaction: no summary model available, falling back to default compaction", "warning");
      return;
    }

    const systemPrompt = previousSummary ? UPDATE_PROMPT : INITIAL_PROMPT;
    const summaryMaxTokens = (modelChoice.model.maxTokens as number) ?? 8192;
    const maxPromptChars = computeCharBudget(modelChoice.model.contextWindow as number | undefined, summaryMaxTokens, systemPrompt);
    const transcript = buildTranscript(turns, maxPromptChars);
    if (!transcript.trim()) return;

    const prompt = buildPrompt({
      transcript,
      previousSummary: stripFileTags(previousSummary),
      customInstructions,
    });

    // ── Observability ────────────────────────────────────────────────────
    await mkdir(runDir, { recursive: true });
    await Promise.all([
      writeFile(join(runDir, "inputs.json"), JSON.stringify({
        timestamp: new Date().toISOString(),
        tokensBefore,
        messagesToSummarizeCount: messagesToSummarize.length,
        turnPrefixMessagesCount: turnPrefixMessages.length,
        firstKeptEntryId,
        hasPreviousSummary: Boolean(previousSummary),
        customInstructions,
        fileOps: {
          read: fileOps?.read ? [...fileOps.read] : [],
          written: fileOps?.written ? [...fileOps.written] : [],
          edited: fileOps?.edited ? [...fileOps.edited] : [],
        },
      }, null, 2)),
      writeFile(join(runDir, "transcript.md"), transcript),
      writeFile(join(runDir, "prompt.txt"), prompt),
    ]);

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
          maxTokens: summaryMaxTokens,
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

      // ── Observability: output ─────────────────────────────────────────
      await writeFile(join(runDir, "summary.md"), finalSummary);
      await writeFile(join(runDir, "details.json"), JSON.stringify({
        version: 2,
        strategy: EXTENSION_NAME,
        readFiles,
        modifiedFiles,
        turns: turns.length,
        model: `${modelChoice.model.provider}/${modelChoice.model.id}`,
        summaryLength: finalSummary.length,
        transcriptLength: transcript.length,
        promptLength: prompt.length,
      }, null, 2));

      return {
        compaction: {
          summary: finalSummary,
          firstKeptEntryId,
          tokensBefore,
          details: {
            version: 2,
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

// ── Model resolution ──────────────────────────────────────────────────

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

// ── Prompt construction ───────────────────────────────────────────────

function buildPrompt(args: { transcript: string; previousSummary?: string; customInstructions?: string }) {
  const parts: string[] = [];

  if (args.customInstructions?.trim()) {
    parts.push(`<focus>\n${args.customInstructions.trim()}\n</focus>`);
  }

  if (args.previousSummary?.trim()) {
    parts.push(`<previous-summary>\n${args.previousSummary.trim()}\n</previous-summary>`);
    parts.push(`<new-work>\n${args.transcript}\n</new-work>`);
  } else {
    parts.push(`<conversation>\n${args.transcript}\n</conversation>`);
  }

  return parts.join("\n\n");
}

// ── Turn grouping ─────────────────────────────────────────────────────

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
      const summary = typeof message.summary === "string" ? message.summary : "";
      if (summary) current.responses.push(summary);
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
  return { ...turn, label: `${turn.label} ${index}` };
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

// ── Message ingestion ─────────────────────────────────────────────────

function ingestAssistantMessage(turn: Turn, message: AnyMessage) {
  const blocks = Array.isArray(message?.content) ? message.content : [];

  const thinking = blocks
    .filter((block: AnyRecord) => block?.type === "thinking" && typeof block.thinking === "string")
    .map((block: AnyRecord) => block.thinking)
    .join("\n\n")
    .trim();

  if (thinking) {
    turn.reasoning.push(thinking);
  }

  const text = blocks
    .filter((block: AnyRecord) => block?.type === "text" && typeof block.text === "string")
    .map((block: AnyRecord) => block.text)
    .join("\n\n")
    .trim();

  if (text && !looksLikeFiller(text)) {
    turn.responses.push(text);
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
    turn.evidence.push(`${descriptor} error: ${text || "(no output)"}`);
    return;
  }

  if (toolName === "edit" || toolName === "write") {
    const path = typeof toolCall?.args?.path === "string" ? toolCall.args.path : undefined;
    if (path) {
      turn.evidence.push(`${toolName} succeeded on ${path}`);
    }
    return;
  }

  // Generic tool result (find, grep, ls, session_search, etc.)
  if (text) {
    const descriptor = toolCall?.name ? `${toolCall.name}` : toolName;
    turn.evidence.push(`${descriptor}: ${text}`);
  }
}

// ── Bash evidence summarization ───────────────────────────────────────
// The only place we summarize — we're formatting tool output for the model,
// not truncating it. The model handles compression; we handle relevance.

function summarizeBashEvidence(command: string | undefined, output: string, isError: boolean) {
  // Command is one-liner for display — bash commands are typically short.
  const cmd = oneLine(command || "bash");
  const cleaned = output.trim();
  const lowerCommand = cmd.toLowerCase();
  const commandLooksImportant = /(go test|npm test|pnpm test|yarn test|pytest|cargo test|vitest|jest|go build|tsc\b|eslint|golangci-lint|make test|make lint|git diff|git status|gh\b)/i.test(cmd);
  const outputLooksImportant = /(\bpass\b|\bfail\b|error|panic:|traceback|exception|undefined|not found|timed out|permission denied|lgtm|rejected|critical|warning)/i.test(cleaned);

  if (!isError && !commandLooksImportant && !outputLooksImportant) {
    return undefined;
  }

  const interestingLines = pickInterestingLines(cleaned, 8);
  const detail = interestingLines.length > 0 ? interestingLines.join(" | ") : cleaned || "(no output)";

  if (/go test|npm test|pnpm test|yarn test|pytest|cargo test|vitest|jest/i.test(lowerCommand)) {
    const status = /(\bFAIL\b|failed|panic:|error)/i.test(cleaned) || isError ? "failed" : /(\bPASS\b|\bok\b|passed)/i.test(cleaned) ? "passed" : "ran";
    return `Test \`${cmd}\` ${status}: ${detail}`;
  }

  if (/go build|tsc\b|eslint|golangci-lint|make test|make lint/i.test(lowerCommand)) {
    const status = isError || /(error|fail)/i.test(cleaned) ? "reported problems" : "completed";
    return `Check \`${cmd}\` ${status}: ${detail}`;
  }

  if (/git diff/i.test(lowerCommand)) {
    return `Git diff \`${cmd}\`${isError ? " errored" : ""}: ${detail}`;
  }

  return `Bash \`${cmd}\`${isError ? " errored" : ""}: ${detail}`;
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

// ── Transcript building ───────────────────────────────────────────────

function computeCharBudget(contextWindow: number | undefined, maxOutputTokens: number, systemPrompt: string) {
  // Fallback to 128k tokens if contextWindow is unknown — conservative default.
  const cw = contextWindow ?? 128_000;
  const systemPromptTokens = Math.ceil(systemPrompt.length / CHARS_PER_TOKEN);
  const availableTokens = cw - maxOutputTokens - systemPromptTokens;
  return Math.floor(availableTokens * CHARS_PER_TOKEN);
}

function buildTranscript(turns: Turn[], maxChars: number): string {
  const formatted = turns.map(formatTurn);
  // If the full transcript fits, send it all — the model decides what matters.
  const full = formatted.join("\n\n");
  if (full.length <= maxChars) return full;

  // Otherwise drop middle turns — keep the first (context) and last (recent).
  const charBudget = maxChars;
  const firstTurn = formatted[0];
  const firstLen = firstTurn?.length ?? 0;

  // Walk backwards from the end, including recent turns until budget is spent.
  // Budget accounts for all content: first turn + gap marker + recent turns.
  let used = firstLen;
  const keptRecent: string[] = [];

  for (let i = formatted.length - 1; i > 0; i--) {
    if (used + formatted[i].length + 4 > charBudget) break;
    keptRecent.push(formatted[i]);
    used += formatted[i].length + 4;
  }

  // Assemble: first turn, gap marker, then recent turns in chronological order.
  const recentInOrder = keptRecent.reverse();
  const droppedCount = turns.length - 1 - recentInOrder.length;
  const parts: string[] = [];
  if (firstTurn) parts.push(firstTurn);
  if (droppedCount > 0) parts.push(`[… ${droppedCount} earlier turns omitted …]`);
  parts.push(...recentInOrder);
  return parts.join("\n\n");
}

function formatTurn(turn: Turn): string {
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

  return section.join("\n\n");
}

function indentBullet(text: string) {
  return text.replace(/\n/g, "\n  ");
}

// ── Filler detection ──────────────────────────────────────────────────

function looksLikeFiller(text: string) {
  // Only filter short messages that are pure hedging — no substantive content.
  // Check the first line (not the collapsed string) and total length.
  if (text.length > 180) return false;

  const firstLine = text.split("\n")[0].trim().toLowerCase();
  // Must start with a hedging phrase followed by a verb/sentence boundary.
  // Avoids matching "I'll implement the auth module" (substantive continuation).
  const match = firstLine.match(/^(let me|i'll|i will|first,? let me|now let me|i'm going to|i am going to|i should|i need to)\s+(?:check|look|see|inspect|examine|investigate|review|read|try|find|search|explore|start|begin)\b/i);
  return Boolean(match);
}

// ── Utilities ──────────────────────────────────────────────────────────

function extractText(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((part: AnyRecord) => part?.type === "text" && typeof part.text === "string")
    .map((part: AnyRecord) => part.text)
    .join("\n")
    .trim();
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