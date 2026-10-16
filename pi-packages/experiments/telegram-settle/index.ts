/**
 * telegram-settle
 *
 * When an agent run settles (agent has gone idle after all retries,
 * compactions, and follow-ups), send the last assistant message to the
 * local telegram-bridge (~/build/telegram-bridge/) so it can be delivered
 * to Telegram.
 *
 * Behavior:
 * - Aborted runs (Escape/cancel) never send: the ping is for finished
 *   work, and an abort would otherwise re-send the previous message.
 *   agent_settled itself carries no abort flag, so the outcome is read
 *   from agent_before_settle (outcome === "aborted") and consumed at
 *   settle time.
 * - Text message by default (tg.py msg), split into sequential chunks
 *   under Telegram's 4096-char sendMessage cap (splitting prefers
 *   newline boundaries; the split newline itself is dropped).
 *   TELEGRAM_SETTLE_MODE=voice opts into the voice-note path (tgsay).
 *   Bridge directory can be overridden with TELEGRAM_BRIDGE_DIR.
 * - lastSentText is only recorded after a successful send, so a failed
 *   delivery is retried on the next settle instead of being skipped.
 * - Silent in the TUI on success: stderr from an extension is rendered
 *   onto the input line, so it must never be written there. Failures go
 *   through ui.notify when a UI is present; console.error is used only
 *   when headless (hasUI === false), where stderr is a real terminal.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

interface AssistantEntry {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    errorMessage?: unknown;
  };
}

// Telegram's sendMessage hard cap. JS string length is UTF-16 code
// units — the same unit Telegram counts — so .length is the right measure.
export const TELEGRAM_TEXT_LIMIT = 4096;

/**
 * Split text into pieces Telegram will accept. Splits at the last newline
 * in the back half of the window when one exists (paragraphs and code
 * blocks break cleanly); otherwise hard-cuts at the limit. The split
 * newline is dropped rather than duplicated; all other bytes are kept, so
 * pieces joined with "\n" reassemble the original (when every split chose
 * a newline).
 */
export function chunkForTelegram(
  text: string,
  limit: number = TELEGRAM_TEXT_LIMIT,
): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const nl = rest.lastIndexOf("\n", limit - 1);
    const useNewline = nl >= Math.floor(limit / 2);
    const cut = useNewline ? nl : limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(useNewline ? cut + 1 : cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

function findLastAssistantText(ctx: ExtensionContext): string | undefined {
  try {
    const entries =
      ctx.sessionManager.getEntries() as unknown as AssistantEntry[];
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.type !== "message" || entry.message?.role !== "assistant")
        continue;
      if (entry.message.errorMessage) continue;
      const text = extractText(entry.message.content).trim();
      if (text) return text;
    }
  } catch (err) {
    report(ctx, `failed to read session entries: ${String(err)}`);
  }
  return undefined;
}

function report(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) {
    ctx.ui.notify(`telegram-settle: ${message}`, "error");
  } else {
    console.error(`telegram-settle: ${message}`);
  }
}

function sendOnce(
  ctx: ExtensionContext,
  script: string,
  args: string[],
  stdinText: string | undefined,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(script, args, { stdio: ["pipe", "pipe", "pipe"] });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      report(ctx, `failed to launch ${script}: ${String(err)}`);
      resolve(false);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        report(
          ctx,
          `bridge exited ${code ?? "?"}: ${(stderr || stdout).trim()}`,
        );
        resolve(false);
      } else {
        resolve(true);
      }
    });

    if (stdinText !== undefined) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
}

/** Send text via the bridge; returns whether every piece was delivered. */
async function runBridge(
  ctx: ExtensionContext,
  mode: string,
  text: string,
): Promise<boolean> {
  const bridgeDir =
    process.env.TELEGRAM_BRIDGE_DIR ||
    join(homedir(), "build", "telegram-bridge");

  const isText = mode === "text";
  const script = join(bridgeDir, isText ? "tg.py" : "tgsay");
  // Text mode: chunk under Telegram's cap (also keeps each argv string
  // far below the kernel's ~128KB per-arg limit). Voice mode: one stdin
  // write — its constraint is audio size, not message length.
  const pieces = isText ? chunkForTelegram(text) : [text];

  let ok = true;
  for (let i = 0; i < pieces.length; i++) {
    const delivered = await sendOnce(
      ctx,
      script,
      isText ? ["msg", pieces[i]] : [],
      isText ? undefined : text,
    );
    if (!delivered) {
      ok = false;
      if (pieces.length > 1) {
        report(ctx, `piece ${i + 1}/${pieces.length} not delivered`);
      }
    }
  }

  if (ok && !ctx.hasUI) {
    // Headless only: in a TUI this line would land on the input line.
    console.error(
      `telegram-settle: sent (${mode}${pieces.length > 1 ? `, ${pieces.length} pieces` : ""})`,
    );
  }
  return ok;
}

export default function (pi: ExtensionAPI) {
  let lastSentText = "";
  // agent_settled carries no abort flag; agent_before_settle does
  // (BoundaryState.outcome). Set on every before_settle, consumed by the
  // next agent_settled.
  let settleAborted = false;

  pi.on("agent_before_settle", (event) => {
    settleAborted = event.outcome === "aborted";
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (settleAborted) {
      settleAborted = false; // cancel means stop, never ping
      return;
    }
    const text = findLastAssistantText(ctx);
    if (!text) return;
    if (text === lastSentText) return; // already delivered this session

    const mode = (process.env.TELEGRAM_SETTLE_MODE || "text").toLowerCase();
    const sent = await runBridge(
      ctx,
      mode === "voice" ? "voice" : "text",
      text,
    );
    // Record only after success so a failed send retries on next settle.
    if (sent) lastSentText = text;
  });
}
