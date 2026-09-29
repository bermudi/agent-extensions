/**
 * /copy-with-model — Copy last assistant message wrapped in a code block
 * tagged with the model that WROTE the message. Escapes backticks if needed.
 *
 * The tag comes from the message itself (`responseModel` when the provider
 * echoed the resolved model, else the requested `model`) — never from the
 * session's *active* model: ask model A, switch to model B, and the fence
 * must still credit A. The active model is only a fallback for messages
 * that carry none.
 *
 * Example output for claude-sonnet-4:
 * ```claude-sonnet-4
 * Ok
 * ```
 */

import {
  copyToClipboard,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { describeError, extractTextParts } from "./json-file.ts";

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * What /copy-with-model should put on the clipboard: the last assistant
 * message's text plus the fence tag.
 *
 * `tag` is the model that produced the message — `responseModel` (the model
 * that actually ran, when the provider reports it) falling back to the
 * requested `model` — and only then the session's active model. `tag` is
 * undefined only when neither the message nor the session carries one.
 *
 * Returns undefined when there is no assistant message to copy (a trailing
 * text-less message keeps the previous behavior: no copy).
 */
export function buildCopyPayload(
  entries: any[],
  activeModel: { provider: string; id: string } | undefined,
): { text: string; tag?: string } | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || msg.role !== "assistant") continue;
    // Skip aborted messages with no content
    if (
      msg.stopReason === "aborted" &&
      (!msg.content || msg.content.length === 0)
    )
      continue;
    const text = extractTextParts(msg.content).join("\n").trim();
    if (!text) return undefined;
    const tag =
      (typeof msg.responseModel === "string" && msg.responseModel) ||
      (typeof msg.model === "string" && msg.model) ||
      activeModel?.id;
    return { text, tag: tag || undefined };
  }
  return undefined;
}

/**
 * Wrap text in a code fence, escalating fence level if the content
 * already contains backtick sequences.
 *
 * ```       → ````
 * ````      → `````
 * etc.
 */
function wrapInCodeBlock(tag: string, text: string): string {
  // Find the longest run of consecutive backticks in the content
  let maxRun = 0;
  for (const line of text.split("\n")) {
    let run = 0;
    for (const ch of line) {
      if (ch === "`") {
        run++;
        maxRun = Math.max(maxRun, run);
      } else {
        run = 0;
      }
    }
  }

  // Fence needs at least 3 backticks and one more than the longest run
  const fenceLen = Math.max(3, maxRun + 1);
  const fence = "`".repeat(fenceLen);

  return `${fence}${tag}\n${text}\n${fence}`;
}

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerCommand("copy-with-model", {
    description:
      "Copy last assistant message to clipboard in a code block tagged with the model that wrote it",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const payload = buildCopyPayload(
        ctx.sessionManager.getBranch(),
        ctx.model,
      );

      if (!payload) {
        ctx.ui.notify("No assistant messages to copy", "error");
        return;
      }

      const tag = payload.tag;
      if (!tag) {
        ctx.ui.notify(
          "No model recorded for this message and none selected",
          "error",
        );
        return;
      }

      const wrapped = wrapInCodeBlock(tag, payload.text);

      try {
        await copyToClipboard(wrapped);
        ctx.ui.notify(`Copied with model \`${tag}\``, "info");
      } catch (err) {
        ctx.ui.notify(`Failed to copy: ${describeError(err)}`, "error");
      }
    },
  });
}
