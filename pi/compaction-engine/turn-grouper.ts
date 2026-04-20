type AnyRecord = Record<string, any>;
type AnyMessage = AnyRecord;

export type ToolCallInfo = {
  name: string;
  args: AnyRecord;
};

export type Turn = {
  label: string;
  request: string;
  reasoning: string[];
  responses: string[];
  evidence: string[];
  toolCalls: Map<string, ToolCallInfo>;
};

// ── Turn grouping ─────────────────────────────────────────────────────

export function groupIntoTurns(messages: AnyMessage[]): Turn[] {
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

export function createTurn(label: string, request: string): Turn {
  return {
    label,
    request: request || "(empty)",
    reasoning: [],
    responses: [],
    evidence: [],
    toolCalls: new Map(),
  };
}

export function finalizeTurn(turn: Turn, index: number): Turn {
  return { ...turn, label: `${turn.label} ${index}` };
}

export function hasUsefulTurnContent(turn: Turn) {
  return Boolean(turn.request || turn.reasoning.length || turn.responses.length || turn.evidence.length);
}

export function isTurnStartRole(role: string) {
  return role === "user" || role === "bashExecution" || role === "custom";
}

export function labelForRole(role: string) {
  switch (role) {
    case "bashExecution":
      return "User Bash";
    case "custom":
      return "Custom Input";
    default:
      return "Turn";
  }
}

export function describeTurnRequest(message: AnyMessage) {
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

export function ingestAssistantMessage(turn: Turn, message: AnyMessage) {
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

export function ingestToolResult(turn: Turn, message: AnyMessage) {
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

export function summarizeBashEvidence(command: string | undefined, output: string, isError: boolean) {
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

export function pickInterestingLines(text: string, maxLines: number) {
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

// ── Filler detection ──────────────────────────────────────────────────

export function looksLikeFiller(text: string) {
  if (text.length > 180) return false;

  const firstLine = text.split("\n")[0].trim().toLowerCase();
  const match = firstLine.match(/^(let me|i'll|i will|first,? let me|now let me|i'm going to|i am going to|i should|i need to)\s+(?:check|look|see|inspect|examine|investigate|review|read|try|find|search|explore|start|begin)\b/i);
  return Boolean(match);
}

// ── Internal utilities ────────────────────────────────────────────────

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
