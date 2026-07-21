/**
 * name-with-ai — Generate a session name using AI.
 *
 * Sends the first user message to the current model and asks it to
 * produce a short descriptive name.
 *
 * Usage:
 *   /name-with-ai         — generate a name from the first user message
 *   /name-with-ai <name>  — set manually (fallback passthrough)
 */

import { Agent, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  type Api,
  type Model,
  streamSimple,
} from "@earendil-works/pi-ai/compat";
import {
  convertToLlm,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const NAMING_PROMPT = [
  "You are a session naming engine. Given a user's message, produce a short, descriptive session name.",
  "",
  "Rules:",
  "- Maximum 60 characters.",
  "- No quotes, no markdown, no punctuation at the end.",
  '- Use imperative or noun-phrase style (e.g. "Refactor auth middleware", "Fix CSS grid layout").',
  '- Be specific, not generic. "Add retry logic to fetch helper" > "Code changes".',
  "- Output ONLY the name. Nothing else.",
].join("\n");

function extractLastAssistantText(
  messages: Array<{ role: string; content?: unknown }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      const parts: string[] = [];
      for (const block of msg.content) {
        if (
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          block.type === "text" &&
          "text" in block
        )
          parts.push((block as { text?: string }).text ?? "");
      }
      return parts.join("\n").trim();
    }
  }
  return "";
}

function extractText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: string; text?: string } =>
          typeof b === "object" && b !== null,
      )
      .map((b) => (b.type === "text" ? (b.text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function sanitizeName(raw: string): string {
  return raw
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^\*+|\*+$/g, "")
    .replace(/^#+\s*/, "")
    .replace(/[.!?:;]+$/, "")
    .replace(/\n/g, " ")
    .trim()
    .slice(0, 60);
}

export default function nameWithAiExtension(pi: ExtensionAPI) {
  pi.registerCommand("name-with-ai", {
    description: "Generate a session name using AI from the first user message",
    handler: async (args, ctx) => {
      const manual = args?.trim();
      if (manual) {
        pi.setSessionName(manual);
        ctx.ui.notify(`Session named: ${manual}`, "info");
        return;
      }

      if (!ctx.model) {
        ctx.ui.notify("No model selected — switch to a model first", "warning");
        return;
      }

      // Grab the first user message from the current branch
      const branch = ctx.sessionManager.getBranch();
      const firstUser = branch.find(
        (e) => e.type === "message" && e.message?.role === "user",
      );
      if (!firstUser || firstUser.type !== "message") {
        ctx.ui.notify("Nothing to name yet — send a message first", "warning");
        return;
      }

      const msgContent = (firstUser.message as { content?: unknown }).content;
      const prompt = extractText(msgContent);
      if (!prompt) {
        ctx.ui.notify(
          "First message is empty — can't generate a name",
          "warning",
        );
        return;
      }

      // Truncate long messages to keep the call cheap
      const snippet =
        prompt.length > 1000 ? prompt.slice(0, 997) + "…" : prompt;

      ctx.ui.setStatus("name-with-ai", "Generating name…");

      const abortController = new AbortController();
      const onCtxAbort = () => abortController.abort();
      if (ctx.signal)
        ctx.signal.addEventListener("abort", onCtxAbort, { once: true });

      try {
        const model = ctx.model as Model<Api>;

        const agent = new Agent({
          initialState: {
            systemPrompt: NAMING_PROMPT,
            model,
            thinkingLevel: "off" as ThinkingLevel,
            messages: [],
          },
          convertToLlm,
          streamFn: async (m, context, options) => {
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
            if (!auth.ok)
              throw new Error(
                `Auth failed: ${(auth as { error: string }).error}`,
              );
            return streamSimple(m, context, {
              ...options,
              apiKey: auth.apiKey,
              headers: auth.headers ?? undefined,
            });
          },
        });

        if (abortController.signal.aborted) return;

        const abortHandler = () => {
          try {
            agent.abort();
          } catch {
            /* */
          }
        };
        abortController.signal.addEventListener("abort", abortHandler, {
          once: true,
        });

        await agent.prompt(snippet);
        await agent.waitForIdle();

        const output = extractLastAssistantText(agent.state.messages);
        const name = sanitizeName(output);

        if (name) {
          pi.setSessionName(name);
          ctx.ui.notify(`Named: ${name}`, "info");
        } else {
          ctx.ui.notify(
            "AI returned an empty name — try /name-with-ai <name>",
            "warning",
          );
        }

        abortController.signal.removeEventListener("abort", abortHandler);
      } catch (err) {
        ctx.ui.notify(
          `Naming failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      } finally {
        if (ctx.signal) ctx.signal.removeEventListener("abort", onCtxAbort);
        ctx.ui.setStatus("name-with-ai", undefined);
      }
    },
  });
}
