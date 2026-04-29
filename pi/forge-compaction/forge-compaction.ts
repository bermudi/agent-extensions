/**
 * Forge-style Compaction Extension for Pi
 *
 * Clones ForgeCode's compaction strategy: pure structural compression
 * with no LLM call. Instead of asking a model to summarize, it:
 *
 * 1. Extracts structured data from messages (tool calls, text, roles)
 * 2. Deduplicates consecutive same-role messages
 * 3. Keeps only the last operation per file path
 * 4. Renders a Handlebars-like template with the structured data
 * 5. Returns the rendered output as the compaction summary
 *
 * Zero latency, zero cost, fully deterministic.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

// ── Types ─────────────────────────────────────────────────────────────

type AnyRecord = Record<string, unknown>;

interface ToolCall {
  id?: string;
  name: string;
  args: AnyRecord;
}

interface SummaryBlock {
  role: "user" | "assistant" | "system";
  contents: SummaryContent[];
}

type SummaryContent =
  | { type: "text"; text: string }
  | { type: "tool"; tool: SummaryTool; id?: string; success: boolean };

type SummaryTool =
  | { kind: "read"; path: string }
  | { kind: "update"; path: string }
  | { kind: "delete"; path: string }
  | { kind: "shell"; command: string }
  | { kind: "search"; pattern: string }
  | { kind: "grep"; pattern: string }
  | { kind: "find"; pattern: string }
  | { kind: "ls"; path: string }
  | { kind: "unknown"; name: string };

// ── Main extension ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, customInstructions, signal } = event;
    const { messagesToSummarize, turnPrefixMessages, previousSummary, firstKeptEntryId, tokensBefore, fileOps } = preparation;

    const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
    if (allMessages.length === 0) return;

    if (signal?.aborted) return;

    // 1. Extract structured summary blocks from messages
    const rawBlocks = extractSummaryBlocks(allMessages);

    // 2. Apply transformer pipeline (dedupe, trim, etc.)
    const transformed = applyTransformers(rawBlocks);

    // 3. Render template
    const templateOutput = renderTemplate(transformed, previousSummary, customInstructions);

    // 4. Compute file lists from pi's tracked file ops
    const readFiles = fileOps?.read ? [...fileOps.read] : [];
    const modifiedFiles = [...(fileOps?.written || []), ...(fileOps?.edited || [])];
    const fileTags = formatFileTags(readFiles, modifiedFiles);

    const summary = `${templateOutput}${fileTags}`;

    if (!summary.trim()) return;

    ctx.ui.notify(
      `Forge compaction: structured ${allMessages.length} messages (${tokensBefore.toLocaleString()} tokens) — no LLM call`,
      "info",
    );

    return {
      compaction: {
        summary,
        firstKeptEntryId,
        tokensBefore,
        details: {
          strategy: "forge-compaction",
          blocksBefore: rawBlocks.length,
          blocksAfter: transformed.length,
          readFiles,
          modifiedFiles,
        },
      },
    };
  });
}

// ── Message extraction ────────────────────────────────────────────────

function extractSummaryBlocks(messages: AgentMessage[]): SummaryBlock[] {
  const blocks: SummaryBlock[] = [];
  // Track tool results by callId for success/failure linking
  const toolResults = new Map<string, { isError: boolean; toolName: string }>();

  // First pass: collect tool results
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      const tr = msg as unknown as AnyRecord;
      const callId = typeof tr.toolCallId === "string" ? tr.toolCallId : undefined;
      if (callId) {
        toolResults.set(callId, {
          isError: Boolean(tr.isError),
          toolName: typeof tr.toolName === "string" ? tr.toolName : "unknown",
        });
      }
    }
  }

  // Second pass: build summary blocks
  for (const msg of messages) {
    const role = msg.role as string;

    // Skip tool results — they're consumed by tool call linking
    if (role === "toolResult") continue;

    // Skip compaction/branch summaries — they become previousSummary
    if (role === "compactionSummary" || role === "branchSummary") continue;

    if (role === "user") {
      const text = extractText(msg);
      if (text) {
        blocks.push({ role: "user", contents: [{ type: "text", text }] });
      }
      continue;
    }

    if (role === "bashExecution") {
      const be = msg as unknown as AnyRecord;
      const command = typeof be.command === "string" ? be.command : "";
      if (command) {
        blocks.push({
          role: "user",
          contents: [{ type: "text", text: `User executed: ${command}` }],
        });
      }
      continue;
    }

    if (role === "assistant") {
      const contents: SummaryContent[] = [];
      const text = extractText(msg);
      if (text) {
        contents.push({ type: "text", text });
      }

      // Extract tool calls
      const toolCalls = extractToolCalls(msg);
      for (const tc of toolCalls) {
        const tool = classifyTool(tc.name, tc.args);
        const result = tc.id ? toolResults.get(tc.id) : undefined;
        const success = result ? !result.isError : true;
        contents.push({ type: "tool", tool, id: tc.id, success });
      }

      if (contents.length > 0) {
        blocks.push({ role: "assistant", contents });
      }
      continue;
    }
  }

  return blocks;
}

function extractText(msg: AgentMessage): string {
  const m = msg as unknown as AnyRecord;
  const content = m.content;

  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((part: AnyRecord) => part?.type === "text" && typeof part.text === "string")
    .map((part: AnyRecord) => part.text)
    .join("\n")
    .trim();
}

function extractToolCalls(msg: AgentMessage): ToolCall[] {
  const m = msg as unknown as AnyRecord;
  const content = m.content;
  if (!Array.isArray(content)) return [];

  return content
    .filter((part: AnyRecord) => part?.type === "toolCall")
    .map((part: AnyRecord) => ({
      id: typeof part.id === "string" ? part.id : undefined,
      name: typeof part.name === "string" ? part.name : "unknown",
      args: isRecord(part.arguments) ? (part.arguments as AnyRecord) : {},
    }));
}

function classifyTool(name: string, args: AnyRecord): SummaryTool {
  switch (name) {
    case "read":
      return { kind: "read", path: String(args.path ?? args.file_path ?? "") };
    case "write":
      return { kind: "update", path: String(args.path ?? args.file_path ?? "") };
    case "edit":
      return { kind: "update", path: String(args.path ?? args.file_path ?? "") };
    case "bash":
      return { kind: "shell", command: String(args.command ?? "") };
    case "grep":
      return { kind: "grep", pattern: String(args.pattern ?? args.query ?? "") };
    case "find":
      return { kind: "find", pattern: String(args.pattern ?? args.name ?? "") };
    case "ls":
      return { kind: "ls", path: String(args.path ?? "") };
    default:
      // Catch search-like tools
      if (name.includes("search")) {
        return { kind: "search", pattern: String(args.pattern ?? args.query ?? "") };
      }
      return { kind: "unknown", name };
  }
}

// ── Transformer pipeline ─────────────────────────────────────────────

function applyTransformers(blocks: SummaryBlock[]): SummaryBlock[] {
  let result = blocks;

  // 1. Drop system messages
  result = result.filter((b) => b.role !== "system");

  // 2. Deduplicate consecutive user messages (merge text)
  result = dedupeConsecutiveRole(result, "user");

  // 3. Trim: keep only the last operation per file path
  result = trimDuplicateFilePaths(result);

  // 4. Deduplicate consecutive assistant content blocks
  result = dedupeConsecutiveRole(result, "assistant");

  // 5. Truncate long text blocks
  result = truncateText(result, 500);

  return result;
}

function dedupeConsecutiveRole(blocks: SummaryBlock[], role: "user" | "assistant"): SummaryBlock[] {
  const result: SummaryBlock[] = [];

  for (const block of blocks) {
    if (block.role === role && result.length > 0 && result[result.length - 1].role === role) {
      // Merge contents into previous block
      const prev = result[result.length - 1];
      prev.contents.push(...block.contents);
    } else {
      result.push({ ...block, contents: [...block.contents] });
    }
  }

  return result;
}

function trimDuplicateFilePaths(blocks: SummaryBlock[]): SummaryBlock[] {
  // Track which file paths we've seen — keep only the last occurrence of each
  const seenPaths = new Map<string, { blockIdx: number; contentIdx: number }>();

  // Forward pass: record all file paths
  for (let bi = 0; bi < blocks.length; bi++) {
    for (let ci = 0; ci < blocks[bi].contents.length; ci++) {
      const c = blocks[bi].contents[ci];
      if (c.type === "tool") {
        const path = toolPath(c.tool);
        if (path) {
          seenPaths.set(path, { blockIdx: bi, contentIdx: ci });
        }
      }
    }
  }

  // Now do a reverse pass: keep only the LAST occurrence of each path
  const lastOccurrence = new Map<string, boolean>();
  const result: SummaryBlock[] = [];

  for (let bi = blocks.length - 1; bi >= 0; bi--) {
    const contents: SummaryContent[] = [];
    for (let ci = blocks[bi].contents.length - 1; ci >= 0; ci--) {
      const c = blocks[bi].contents[ci];
      if (c.type === "tool") {
        const path = toolPath(c.tool);
        if (path) {
          if (!lastOccurrence.has(path)) {
            lastOccurrence.set(path, true);
            contents.unshift(c);
          }
          // else: skip this duplicate
        } else {
          contents.unshift(c);
        }
      } else {
        contents.unshift(c);
      }
    }
    if (contents.length > 0) {
      result.unshift({ ...blocks[bi], contents });
    }
  }

  return result;
}

function toolPath(tool: SummaryTool): string | undefined {
  switch (tool.kind) {
    case "read":
    case "update":
    case "delete":
    case "ls":
      return tool.path || undefined;
    default:
      return undefined;
  }
}

function truncateText(blocks: SummaryBlock[], maxLen: number): SummaryBlock[] {
  return blocks.map((block) => ({
    ...block,
    contents: block.contents.map((c) => {
      if (c.type === "text" && c.text.length > maxLen) {
        return { ...c, text: c.text.slice(0, maxLen) + "\n[... truncated]" };
      }
      return c;
    }),
  }));
}

// ── Template rendering ────────────────────────────────────────────────

function renderTemplate(blocks: SummaryBlock[], previousSummary?: string, customInstructions?: string): string {
  const parts: string[] = [];

  parts.push("Use the following summary as the authoritative reference for all coding suggestions and decisions. Do not re-explain or revisit it unless I ask.\n");

  if (customInstructions?.trim()) {
    parts.push(`<focus>\n${customInstructions.trim()}\n</focus>\n`);
  }

  if (previousSummary?.trim()) {
    parts.push(`<previous-summary>\n${previousSummary.trim()}\n</previous-summary>\n`);
  }

  parts.push("## Summary\n");

  let blockNum = 1;
  for (const block of blocks) {
    parts.push(`### ${blockNum}. ${capitalize(block.role)}\n`);

    for (const content of block.contents) {
      if (content.type === "text") {
        parts.push("```\n" + content.text + "\n```\n");
      } else if (content.type === "tool") {
        const line = renderTool(content.tool, content.success);
        if (line) parts.push(line + "\n");
      }
    }

    blockNum++;
  }

  parts.push("---\n");
  parts.push("Proceed with implementation based on this context.");

  return parts.join("\n");
}

function renderTool(tool: SummaryTool, success: boolean): string {
  const suffix = success ? "" : " ❌";
  switch (tool.kind) {
    case "read":
      return `**Read:** \`${tool.path}\`${suffix}`;
    case "update":
      return `**Update:** \`${tool.path}\`${suffix}`;
    case "delete":
      return `**Delete:** \`${tool.path}\`${suffix}`;
    case "shell":
      return `**Execute:**\n\`\`\`\n${tool.command}\n\`\`\`${suffix}`;
    case "search":
      return `**Search:** \`${tool.pattern}\`${suffix}`;
    case "grep":
      return `**Grep:** \`${tool.pattern}\`${suffix}`;
    case "find":
      return `**Find:** \`${tool.pattern}\`${suffix}`;
    case "ls":
      return `**Ls:** \`${tool.path}\`${suffix}`;
    case "unknown":
      return `**${tool.name}**${suffix}`;
  }
}

// ── File tags ─────────────────────────────────────────────────────────

function formatFileTags(readFiles: string[], modifiedFiles: string[]): string {
  const parts: string[] = [];

  if (readFiles.length > 0) {
    parts.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }

  if (modifiedFiles.length > 0) {
    parts.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }

  return parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
}

// ── Utilities ─────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
