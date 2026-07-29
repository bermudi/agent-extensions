/**
 * /copy-with-model — Copy last assistant message wrapped in a code block
 * tagged with the model name. Escapes backticks if needed.
 *
 * Example output for claude-sonnet-4:
 * ```claude-sonnet-4
 * Ok
 * ```
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync, spawn } from "node:child_process";
import { platform } from "node:os";

// ── Clipboard ─────────────────────────────────────────────────────────

function copyToClipboard(text: string): void {
  const p = platform();
  try {
    if (p === "darwin") {
      execSync("pbcopy", { input: text, timeout: 5000 });
      return;
    }
    if (p === "win32") {
      execSync("clip", { input: text, timeout: 5000 });
      return;
    }
    // Linux — Wayland
    if (process.env.WAYLAND_DISPLAY) {
      const proc = spawn("wl-copy", [], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      proc.stdin.on("error", () => {});
      proc.stdin.write(text);
      proc.stdin.end();
      proc.unref();
      return;
    }
    // Linux — X11
    if (process.env.DISPLAY) {
      try {
        execSync("xclip -selection clipboard", { input: text, timeout: 5000 });
      } catch {
        execSync("xsel --clipboard --input", { input: text, timeout: 5000 });
      }
      return;
    }
  } catch {
    // OSC 52 fallback
    const encoded = Buffer.from(text).toString("base64");
    if (encoded.length <= 100_000) {
      process.stdout.write(`\x1b]52;c;${encoded}\x07`);
      return;
    }
  }
  throw new Error("No clipboard available");
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Get text content of the last assistant entry from session entries. */
function getLastAssistantText(entries: any[]): string | undefined {
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
    let text = "";
    for (const block of msg.content ?? []) {
      if (block.type === "text") text += block.text;
    }
    return text.trim() || undefined;
  }
  return undefined;
}

/** Derive a short model tag from the full model id. */
function modelTag(model: { provider: string; id: string }): string {
  // e.g. "anthropic/claude-sonnet-4" → "claude-sonnet-4"
  //      "openai/gpt-4o" → "gpt-4o"
  return model.id;
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
      "Copy last assistant message to clipboard in a code block tagged with the model name",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const entries = ctx.sessionManager.getEntries();
      const text = getLastAssistantText(entries);

      if (!text) {
        ctx.ui.notify("No assistant messages to copy", "error");
        return;
      }

      const model = ctx.model;
      if (!model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      const tag = modelTag(model);
      const wrapped = wrapInCodeBlock(tag, text);

      try {
        copyToClipboard(wrapped);
        ctx.ui.notify(`Copied with model \`${tag}\``, "info");
      } catch (err) {
        ctx.ui.notify(
          `Failed to copy: ${err instanceof Error ? err.message : err}`,
          "error",
        );
      }
    },
  });
}
