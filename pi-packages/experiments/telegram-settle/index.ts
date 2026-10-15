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
 * - Text message by default (tg.py msg). TELEGRAM_SETTLE_MODE=voice opts
 *   into the voice-note path (tgsay). Bridge directory can be overridden
 *   with TELEGRAM_BRIDGE_DIR.
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

async function runBridge(
  ctx: ExtensionContext,
  mode: string,
  text: string,
): Promise<void> {
  const bridgeDir =
    process.env.TELEGRAM_BRIDGE_DIR ||
    join(homedir(), "build", "telegram-bridge");

  const isText = mode === "text";
  const script = join(bridgeDir, isText ? "tg.py" : "tgsay");
  const args = isText ? ["msg", text] : [];

  await new Promise<void>((resolve) => {
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
      resolve();
    });
    child.on("close", (code) => {
      if (code !== 0) {
        report(
          ctx,
          `bridge exited ${code ?? "?"}: ${(stderr || stdout).trim()}`,
        );
      } else if (!ctx.hasUI) {
        // Headless only: in a TUI this line would land on the input line.
        console.error(`telegram-settle: sent (${mode})`);
      }
      resolve();
    });

    if (!isText) {
      child.stdin.write(text);
    }
    child.stdin.end();
  });
}

export default function (pi: ExtensionAPI) {
  let lastSentText = "";

  pi.on("agent_settled", async (event, ctx) => {
    if (event.aborted) return; // cancel means stop, never ping
    const text = findLastAssistantText(ctx);
    if (!text) return;
    if (text === lastSentText) return; // already delivered this session

    lastSentText = text;

    const mode = (process.env.TELEGRAM_SETTLE_MODE || "text").toLowerCase();
    await runBridge(ctx, mode === "voice" ? "voice" : "text", text);
  });
}
