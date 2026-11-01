/**
 * copy-trajectory — /copy-trajectory
 *
 * Copies the current session's trajectory to the system clipboard as plain
 * text, keeping only what the conversation actually ran on: user and
 * assistant text, plus injected context that later turns may answer —
 * displayed custom_message entries (side-consultation handoffs,
 * external-change diffs, ketamine summaries) and branch summaries (pi-native,
 * the only record of an abandoned limb). Without those, turns replying to
 * injected material ("the consultant's other points…") dangle without
 * their referent.
 * Tool calls, tool results, and session metadata are stripped. Compaction
 * summaries are skipped on purpose: getBranch() is the raw parent chain, so
 * the pre-compaction originals are still on the branch and the summary
 * would only duplicate them.
 *
 *   /copy-trajectory            copy user + assistant text + injected context
 *   /copy-trajectory thinking   also include assistant thinking blocks
 *
 * Uses ctx.sessionManager.getBranch() for the active branch (the raw parent
 * chain — compacted-away entries included, so the clipboard copy keeps
 * everything) and @earendil-works/pi-coding-agent's copyToClipboard for the
 * clipboard write.
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
  role: "User" | "Assistant" | "Context";
  /** For assistant turns: the model that actually served the reply (or the
   *  requested model when the provider doesn't report the resolved one). */
  model?: string;
  /** For context turns: what injected the content (customType, or a fixed
   *  label for pi-native entries like branch summaries). */
  source?: string;
  body: string;
};

/** Build the readable turns from a branch of session entries. */
export function buildTrajectory(
  entries: readonly SessionEntry[],
  includeThinking: boolean,
): Turn[] {
  const turns: Turn[] = [];

  for (const entry of entries) {
    // getBranch() returns the full SessionEntry union; `message` entries are
    // the conversation itself, custom_message/branch_summary entries are
    // injected context the model saw and later turns may lean on.
    if (entry.type === "message") {
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
    } else if (entry.type === "custom_message") {
      // Displayed injections (side handoffs, external-change diffs, ketamine
      // summaries, …) are part of what the model answered; hidden ones
      // (display: false) are machinery the reader never saw. The content is
      // self-describing — side handoffs embed their own model/turn header —
      // so no per-producer knowledge is needed here.
      if (!entry.display) continue;
      const body = extractTextParts(entry.content).join("\n").trim();
      if (!body) continue; // image-only injections carry no text
      turns.push({ role: "Context", source: entry.customType, body });
    } else if (entry.type === "branch_summary") {
      // The summarized limb's entries are not on this branch — the summary
      // is the only record of them.
      const body = entry.summary.trim();
      if (body) turns.push({ role: "Context", source: "branch summary", body });
    }
    // compaction: deliberately skipped — see file header. Everything else
    // (markers, model_change, usage, …) is machinery.
  }

  return turns;
}

export const renderTrajectory = (turns: readonly Turn[]): string =>
  turns
    .map((t) => {
      const header =
        t.role === "Context"
          ? `## Injected context${t.source ? ` (${t.source})` : ""}`
          : t.role === "Assistant" && t.model
            ? `## Assistant (${t.model})`
            : `## ${t.role}`;
      return `${header}\n\n${t.body}`;
    })
    .join("\n\n");

export default function (pi: ExtensionAPI) {
  pi.registerCommand("copy-trajectory", {
    description:
      "Copy the conversation (user + assistant text + injected context, no tool calls) to the clipboard",
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
