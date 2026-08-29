/**
 * copy-trajectory — /copy-trajectory
 *
 * Copies the current session's trajectory to the system clipboard as plain
 * text, keeping only the human-readable conversation: user messages and
 * assistant text. Tool calls, tool results, and session metadata are stripped.
 *
 *   /copy-trajectory            copy user + assistant text
 *   /copy-trajectory thinking   also include assistant thinking blocks
 *
 * Uses ctx.sessionManager.getBranch() for the active (compaction-aware) branch
 * and @earendil-works/pi-coding-agent's copyToClipboard for the clipboard write.
 */

import {
  copyToClipboard,
  type ExtensionAPI,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describeError, extractTextParts } from "./json-file.ts";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

/** Extract `thinking` content blocks from an assistant message body. */
const extractThinkingParts = (content: unknown): string[] => {
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "thinking" && typeof block.thinking === "string") {
      parts.push(block.thinking);
    }
  }
  return parts;
};

type Turn = {
  role: "User" | "Assistant";
  /** For assistant turns: the model that actually served the reply (or the
   *  requested model when the provider doesn't report the resolved one). */
  model?: string;
  body: string;
};

/** Build the readable turns from a branch of session entries. */
function buildTrajectory(
  entries: readonly SessionEntry[],
  includeThinking: boolean,
): Turn[] {
  const turns: Turn[] = [];

  for (const entry of entries) {
    // getBranch() returns the full SessionEntry union; the `message` member
    // is discriminated by `type: "message"`.
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") continue;

    const chunks: string[] = [...extractTextParts(message.content)];

    let model: string | undefined;
    if (message.role === "assistant") {
      // AssistantMessage carries both the requested `model` and, when the
      // provider echoes it back, `responseModel` (the model that actually ran).
      model = message.responseModel ?? message.model;
      if (includeThinking) {
        for (const t of extractThinkingParts(message.content)) {
          chunks.push(
            t
              .split("\n")
              .map((line) => `> ${line}`)
              .join("\n"),
          );
        }
      }
    }

    const body = chunks.join("\n").trim();
    if (!body) continue; // skip empty / tool-only turns

    turns.push({
      role: message.role === "user" ? "User" : "Assistant",
      model,
      body,
    });
  }

  return turns;
}

const renderTrajectory = (turns: readonly Turn[]): string =>
  turns
    .map((t) => {
      const header =
        t.role === "Assistant" && t.model
          ? `## Assistant (${t.model})`
          : `## ${t.role}`;
      return `${header}\n\n${t.body}`;
    })
    .join("\n\n");

export default function (pi: ExtensionAPI) {
  pi.registerCommand("copy-trajectory", {
    description:
      "Copy the conversation (user + assistant text, no tool calls) to the clipboard",
    getArgumentCompletions: (prefix) => {
      const opts = ["thinking"].filter((o) => o.startsWith(prefix));
      return opts.length > 0 ? opts.map((o) => ({ value: o, label: o })) : null;
    },
    handler: async (args, ctx) => {
      // Don't snapshot a half-streamed message.
      await ctx.waitForIdle();

      const arg = args.trim();
      if (arg !== "" && arg !== "thinking") {
        ctx.ui.notify(
          `Unknown argument ${JSON.stringify(arg)}. Usage: /copy-trajectory [thinking]`,
          "warning",
        );
        return;
      }
      const includeThinking = arg === "thinking";

      const turns = buildTrajectory(
        ctx.sessionManager.getBranch(),
        includeThinking,
      );

      if (turns.length === 0) {
        ctx.ui.notify("No messages to copy yet", "warning");
        return;
      }

      const text = renderTrajectory(turns);

      try {
        await copyToClipboard(text);
      } catch (err) {
        ctx.ui.notify(`Failed to copy: ${describeError(err)}`, "error");
        return;
      }

      ctx.ui.notify(
        `Copied ${turns.length} message${turns.length === 1 ? "" : "s"} (${text.length.toLocaleString()} chars) to clipboard`,
        "info",
      );
    },
  });
}
