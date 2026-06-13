/**
 * Selective Context Trimming Extension for Pi
 *
 * Instead of fighting blanket compaction (which is lossy and uncontrollable),
 * this extension lets you selectively compact specific conversation turns.
 *
 * How it works:
 * 1. The `trim_context` tool lets the LLM compact the oldest N turns
 * 2. The `/trim` command shows an interactive turn picker
 * 3. The `/untrim` command restores all compacted turns
 * 4. The `context` event applies trimming on every LLM call
 * 5. State is persisted in custom entries (survives reloads)
 *
 * The session file is never modified — trimming is a view-layer operation.
 * The full conversation history is always preserved in the session.
 *
 * Usage:
 *   /trim          → pick a turn to compact interactively
 *   /trim 3        → compact the 3 oldest turns
 *   /untrim        → restore all compacted turns
 *   selective_trim  → LLM tool for programmatic compaction
 */

import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";

// ── Types ─────────────────────────────────────────────────────────────

interface CompactedTurn {
  /** Hash of first user message text (for identification) */
  hash: string;
  /** First 120 chars of user message (for verification) */
  prefix: string;
  /** Turn index when compacted (for fallback matching) */
  turnIndex: number;
  /** Generated summary */
  summary: string;
}

interface TrimState {
  version: 1;
  compacted: CompactedTurn[];
}

const CUSTOM_TYPE = "trim-context";

const SUMMARIZE_SYSTEM = `You are a conversation summarizer. Given conversation turns, create a concise structured summary capturing:

1. **Goal**: What the user was trying to accomplish
2. **Key Decisions**: Important choices and rationale
3. **Work Done**: Files modified, commands run, approaches tried
4. **Outcomes**: Results, errors, resolutions
5. **Critical Context**: Data needed to continue (file paths, function names, configs)

Be thorough but concise. This summary replaces the full conversation, so include all actionable details.
Format as markdown with clear sections.`;

// ── Helpers ───────────────────────────────────────────────────────────

type AnyMessage = Record<string, any>;

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p: AnyMessage) => p?.type === "text" && typeof p.text === "string")
    .map((p: AnyMessage) => p.text)
    .join("\n")
    .trim();
}

function hashText(text: string): string {
  return createHash("sha256")
    .update(text.normalize().slice(0, 500))
    .digest("hex")
    .slice(0, 16);
}

function getUserPrefix(msg: AnyMessage): string {
  const text = extractText(msg.content);
  return text.slice(0, 120);
}

interface Turn {
  /** 0-based turn index */
  index: number;
  /** All messages in this turn */
  messages: AnyMessage[];
  /** Hash of first user message */
  hash: string;
  /** First 120 chars of first user message */
  prefix: string;
}

function splitIntoTurns(messages: AnyMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: AnyMessage[] = [];

  for (const msg of messages) {
    const role = msg?.role;
    if ((role === "user" || role === "bashExecution") && current.length > 0) {
      const first = current[0];
      turns.push({
        index: turns.length,
        messages: current,
        hash: hashText(getUserPrefix(first)),
        prefix: getUserPrefix(first),
      });
      current = [];
    }
    current.push(msg);
  }

  if (current.length > 0) {
    const first = current[0];
    turns.push({
      index: turns.length,
      messages: current,
      hash: hashText(getUserPrefix(first)),
      prefix: getUserPrefix(first),
    });
  }

  return turns;
}

function serializeTurns(turns: Turn[]): string {
  const parts: string[] = [];
  for (const turn of turns) {
    parts.push(`--- Turn ${turn.index + 1} ---`);
    for (const msg of turn.messages) {
      const role = msg?.role;
      if (role === "user") {
        parts.push(`[User]: ${extractText(msg.content).slice(0, 2000)}`);
      } else if (role === "assistant") {
        const text = (msg.content || [])
          .filter((c: AnyMessage) => c?.type === "text")
          .map((c: AnyMessage) => c.text)
          .join("\n")
          .slice(0, 2000);
        if (text) parts.push(`[Assistant]: ${text}`);
        const toolCalls = (msg.content || [])
          .filter((c: AnyMessage) => c?.type === "toolCall")
          .map(
            (c: AnyMessage) =>
              `${c.name}(${JSON.stringify(c.arguments).slice(0, 200)})`,
          )
          .join("; ");
        if (toolCalls) parts.push(`[Tool Calls]: ${toolCalls}`);
      } else if (role === "toolResult") {
        const text = extractText(msg.content).slice(0, 500);
        const name = msg.toolName || "unknown";
        parts.push(`[${name} Result]: ${text}`);
      } else if (role === "bashExecution") {
        parts.push(`[Bash]: ${String(msg.command || "").slice(0, 500)}`);
      } else if (role === "compactionSummary") {
        parts.push(
          `[Previous Summary]: ${String(msg.summary || "").slice(0, 500)}`,
        );
      }
    }
    parts.push("");
  }
  return parts.join("\n");
}

async function generateSummary(
  turns: Turn[],
  focus: string | undefined,
  signal: AbortSignal | undefined,
  ctx: AnyMessage,
): Promise<string> {
  const conversationText = serializeTurns(turns);
  const focusLine = focus ? `\nPay special attention to: ${focus}` : "";

  const prompt = `Summarize these conversation turns:${focusLine}

<turns>
${conversationText}
</turns>

Provide a structured summary in markdown.`;

  const model = ctx.model;
  if (!model) throw new Error("No model selected");

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
  }

  const response = await complete(
    model,
    {
      systemPrompt: SUMMARIZE_SYSTEM,
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: prompt }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      maxTokens: 4096,
      signal,
    },
  );

  return response.content
    .filter((c: AnyMessage) => c.type === "text")
    .map((c: AnyMessage) => c.text)
    .join("\n")
    .trim();
}

function summaryMessage(summary: string, timestamp?: number): AnyMessage {
  return {
    role: "compactionSummary",
    summary,
    tokensBefore: 0,
    timestamp: timestamp ?? Date.now(),
  };
}

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // In-memory state: hash → CompactedTurn
  const compacted = new Map<string, CompactedTurn>();

  // ── State persistence ───────────────────────────────────────────

  function persistState() {
    const state: TrimState = {
      version: 1,
      compacted: Array.from(compacted.values()),
    };
    pi.appendEntry(CUSTOM_TYPE, state);
  }

  // ── Restore on session start ────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    compacted.clear();
    // Take the LAST custom entry (most recent state)
    let latestState: TrimState | undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === "custom" &&
        entry.customType === CUSTOM_TYPE &&
        entry.data
      ) {
        latestState = entry.data as TrimState;
      }
    }
    if (latestState?.compacted) {
      for (const turn of latestState.compacted) {
        compacted.set(turn.hash, turn);
      }
    }
  });

  // ── Clean up stale state on auto-compaction ─────────────────────

  pi.on("session_compact", async (_event, ctx) => {
    // After auto-compaction, some of our compacted turns might be gone.
    // Prune any turns whose messages are no longer in the session.
    const branch = ctx.sessionManager.getBranch();
    const liveHashes = new Set<string>();

    for (const entry of branch) {
      if (entry.type === "message" && entry.message?.role === "user") {
        const text = getUserPrefix(entry.message);
        if (text) liveHashes.add(hashText(text));
      }
    }

    let changed = false;
    for (const [hash] of compacted) {
      if (!liveHashes.has(hash)) {
        compacted.delete(hash);
        changed = true;
      }
    }
    if (changed) persistState();
  });

  // ── Context event: apply trimming ───────────────────────────────

  pi.on("context", async (event) => {
    if (compacted.size === 0) return;

    const turns = splitIntoTurns(event.messages);
    if (turns.length === 0) return;

    const result: AnyMessage[] = [];
    let anyTrimmed = false;

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];

      // Check if this turn is compacted
      // Match by hash (primary) or by index+prefix (fallback for collisions)
      const byHash = compacted.get(turn.hash);
      const byFallback =
        !byHash &&
        turn.prefix.length < 20 &&
        Array.from(compacted.values()).find(
          (c) => c.turnIndex === i && c.prefix === turn.prefix,
        );

      const match = byHash || byFallback;
      if (match) {
        anyTrimmed = true;
        const ts =
          typeof turn.messages[0]?.timestamp === "number"
            ? turn.messages[0].timestamp
            : Date.now();
        result.push(summaryMessage(match.summary, ts));
        continue;
      }

      result.push(...turn.messages);
    }

    if (anyTrimmed) return { messages: result };
  });

  // ── Tool: selective_trim ─────────────────────────────────────────

  pi.registerTool({
    name: "selective_trim",
    label: "Trim Context",
    description:
      "Selectively compact specific conversation turns into summaries to free up context window space. Non-destructive: the session history is preserved, only the LLM's view changes.",
    promptSnippet: "Compact specific turns into summaries to free context",
    promptGuidelines: [
      "Use selective_trim when the conversation is long and specific turns can be safely summarized.",
      "selective_trim is non-destructive: session history is preserved, only the LLM's view changes.",
      "Call with action='list' to see all turns with brief descriptions, then call with action='compact' and specific indices.",
      "Choose turns strategically: compact verbose debugging, failed attempts, and long back-and-forth. Keep turns with critical context like key decisions, file paths, and architecture choices.",
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("compact")], {
        description:
          "'list' to see available turns, 'compact' to compact specific turns by index",
      }),
      indices: Type.Optional(
        Type.Array(Type.Number(), {
          description:
            "0-based turn indices to compact (from 'list' output). Required for action='compact'.",
        }),
      ),
      focus: Type.Optional(
        Type.String({
          description:
            "What the summary should emphasize (e.g., 'file changes and decisions', 'debugging findings')",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const { action, focus } = params;

      // Get current context messages
      const context = ctx.sessionManager.buildSessionContext();
      const allTurns = splitIntoTurns(context.messages);

      // ── List mode ──────────────────────────────────────────
      if (action === "list") {
        const lines = allTurns.map((turn, i) => {
          const isCompacted = compacted.has(turn.hash);
          const isLast = i === allTurns.length - 1;
          const tag = isCompacted
            ? " [✓ compacted]"
            : isLast
              ? " [current]"
              : "";
          const msgCount = turn.messages.length;
          const prefix = turn.prefix.slice(0, 80).replace(/\n/g, " ");
          return `${i}: ${prefix}${tag} (${msgCount} msgs)`;
        });
        return {
          content: [
            { type: "text", text: `Conversation turns:\n${lines.join("\n")}` },
          ],
        };
      }

      // ── Compact mode ───────────────────────────────────────
      const indices = params.indices ?? [];
      if (indices.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No indices provided. Use action='list' first to see available turns, then pass indices to compact.",
            },
          ],
          isError: true,
        };
      }

      // Validate indices
      const invalid = indices.filter(
        (i: number) => i < 0 || i >= allTurns.length,
      );
      if (invalid.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid turn indices: ${invalid.join(", ")}. Valid range: 0-${allTurns.length - 1}`,
            },
          ],
          isError: true,
        };
      }

      // Don't compact the last turn (current)
      const lastIdx = allTurns.length - 1;
      if (indices.includes(lastIdx)) {
        return {
          content: [
            {
              type: "text",
              text: `Cannot compact the current turn (index ${lastIdx}). Remove it from indices.`,
            },
          ],
          isError: true,
        };
      }

      // Deduplicate and sort
      const uniqueIndices = [...new Set(indices)].sort(
        (a: number, b: number) => a - b,
      );

      // Separate into to-compact vs already-done
      const toCompact: Turn[] = [];
      const alreadyDone: number[] = [];
      for (const idx of uniqueIndices) {
        if (compacted.has(allTurns[idx].hash)) {
          alreadyDone.push(idx);
        } else {
          toCompact.push(allTurns[idx]);
        }
      }

      if (toCompact.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `All selected turns are already compacted.${alreadyDone.length ? ` Indices: ${alreadyDone.join(", ")}` : ""}`,
            },
          ],
        };
      }

      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Generating summary for ${toCompact.length} turn(s) at indices [${toCompact.map((t) => t.index).join(", ")}]...`,
          },
        ],
      });

      try {
        const summary = await generateSummary(
          toCompact,
          focus,
          signal,
          ctx as AnyMessage,
        );

        if (!summary) {
          return {
            content: [
              { type: "text", text: "Summary was empty. No changes made." },
            ],
            isError: true,
          };
        }

        // Store compacted turns
        for (const turn of toCompact) {
          const entry: CompactedTurn = {
            hash: turn.hash,
            prefix: turn.prefix,
            turnIndex: turn.index,
            summary,
          };
          compacted.set(turn.hash, entry);
        }
        persistState();

        const usage = ctx.getContextUsage();
        const totalMsgs = toCompact.reduce(
          (s: number, t: Turn) => s + t.messages.length,
          0,
        );
        const tokensStr = usage?.tokens
          ? ` (~${usage.tokens.toLocaleString()} tokens in context)`
          : "";

        const skipped =
          alreadyDone.length > 0
            ? ` (skipped already-compacted: ${alreadyDone.join(", ")})`
            : "";

        return {
          content: [
            {
              type: "text",
              text: [
                `✂️ Trimmed turn(s) at indices [${toCompact.map((t) => t.index).join(", ")}] (${totalMsgs} messages)${tokensStr}.${skipped}`,
                ``,
                `Summary:`,
                summary.slice(0, 500) + (summary.length > 500 ? "..." : ""),
                ``,
                `Changes take effect on the next LLM call. Use \`/untrim\` to restore.`,
              ].join("\n"),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Trimming failed: ${msg}` }],
          isError: true,
        };
      }
    },
  });

  pi.registerCommand("trim", {
    description: "Selectively compact conversation turns to free context",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/trim requires interactive mode", "error");
        return;
      }
      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      // Check if args contain a number for quick compact
      const quickCount = parseInt(args.trim(), 10);
      if (!isNaN(quickCount) && quickCount > 0) {
        await quickTrim(quickCount, undefined, ctx);
        return;
      }

      await ctx.waitForIdle();

      // Get current context
      const context = ctx.sessionManager.buildSessionContext();
      const allTurns = splitIntoTurns(context.messages);

      if (allTurns.length <= 1) {
        ctx.ui.notify("Not enough turns to compact.", "info");
        return;
      }

      // Build labels for selection
      const labels = allTurns.map((turn, i) => {
        const isCompacted = compacted.has(turn.hash);
        const isLast = i === allTurns.length - 1;
        const tag = isCompacted ? " ✓ compacted" : isLast ? " (current)" : "";
        const msgCount = turn.messages.length;
        return `Turn ${i + 1}: ${turn.prefix.slice(0, 60)}${tag} [${msgCount} msgs]`;
      });

      const selected = await ctx.ui.select("Select a turn to compact:", labels);
      if (!selected) return;

      // Parse turn index from selected string
      const match = selected.match(/^Turn (\d+):/);
      if (!match) return;
      const idx = parseInt(match[1], 10) - 1;

      if (idx < 0 || idx >= allTurns.length) return;
      const turn = allTurns[idx];

      if (compacted.has(turn.hash)) {
        ctx.ui.notify("This turn is already compacted.", "info");
        return;
      }

      ctx.ui.notify("Generating summary...", "info");

      try {
        const summary = await generateSummary(
          [turn],
          undefined,
          undefined,
          ctx as AnyMessage,
        );

        const entry: CompactedTurn = {
          hash: turn.hash,
          prefix: turn.prefix,
          turnIndex: turn.index,
          summary,
        };
        compacted.set(turn.hash, entry);
        persistState();

        ctx.ui.notify(
          `Turn ${idx + 1} compacted. Use /untrim to restore.`,
          "info",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed: ${msg}`, "error");
      }
    },
  });

  // ── Command: /untrim ────────────────────────────────────────────

  pi.registerCommand("untrim", {
    description: "Restore all compacted turns (undo /trim)",
    handler: async (_args, ctx) => {
      if (compacted.size === 0) {
        ctx.ui.notify("No compacted turns to restore.", "info");
        return;
      }

      const count = compacted.size;
      compacted.clear();
      persistState();
      ctx.ui.notify(`Restored ${count} compacted turn(s).`, "info");
    },
  });

  // ── Internal: quick trim by count ───────────────────────────────

  async function quickTrim(
    count: number,
    focus: string | undefined,
    ctx: AnyMessage,
  ) {
    if (!ctx.model) {
      ctx.ui.notify("No model selected", "error");
      return;
    }

    const context = ctx.sessionManager.buildSessionContext();
    const allTurns = splitIntoTurns(context.messages);

    const compactible = allTurns.filter(
      (t: Turn) => !compacted.has(t.hash) && t.index < allTurns.length - 1,
    );

    if (compactible.length === 0) {
      ctx.ui.notify("No compactible turns.", "info");
      return;
    }

    const toCompact = compactible.slice(0, Math.min(count, compactible.length));
    ctx.ui.notify(`Compacting ${toCompact.length} turn(s)...`, "info");

    try {
      const summary = await generateSummary(toCompact, focus, undefined, ctx);

      for (const turn of toCompact) {
        const entry: CompactedTurn = {
          hash: turn.hash,
          prefix: turn.prefix,
          turnIndex: turn.index,
          summary,
        };
        compacted.set(turn.hash, entry);
      }
      persistState();

      const totalMsgs = toCompact.reduce(
        (s: number, t: Turn) => s + t.messages.length,
        0,
      );
      ctx.ui.notify(
        `Trimmed ${toCompact.length} turn(s) (${totalMsgs} messages). Use /untrim to restore.`,
        "info",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Failed: ${msg}`, "error");
    }
  }
}
