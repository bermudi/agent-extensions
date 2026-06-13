import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";
import { parseSessionMessages } from "./jsonl-parser";
import {
  groupIntoTurns,
  buildTranscript,
  buildPrompt,
  computeCharBudget,
  SUMMARY_MAX_TOKENS,
} from "../../compaction-engine";
import { INITIAL_PROMPT } from "../../compaction-engine";

// ── Model resolution ──────────────────────────────────────────────────

interface ModelRegistry {
  getApiKeyAndHeaders(
    model: unknown,
  ): Promise<{
    ok: boolean;
    apiKey?: string;
    headers?: Record<string, string>;
  }>;
}

interface SignalContext {
  signal?: AbortSignal;
}

async function resolveModel(ctx: ExtensionContext) {
  if (!ctx.model) return undefined;
  const auth = await (
    ctx.modelRegistry as unknown as ModelRegistry
  ).getApiKeyAndHeaders(ctx.model);
  if (auth.ok && auth.apiKey) {
    return { model: ctx.model, auth };
  }
  return undefined;
}

// ── Handoff prompt template ───────────────────────────────────────────

const HANDOFF_EXTRACTION_PROMPT = `Produce a focused extraction for handoff:

1. Begin the summary with a header line: "Handoff from Session <session-id> (<project>, <date>)"
2. Add a section listing relevant files mentioned or modified during the session.
3. Keep the focus on what the NEXT session needs to know to continue effectively.
4. Preserve exact file paths, function names, identifiers, branch names, and error messages.`;

/**
 * Generate a handoff prompt from the current session.
 *
 * Uses the compaction engine's transcript builder with the INITIAL_PROMPT
 * summarizer, plus handoff-specific extraction instructions.
 */
export async function generateHandoffPrompt(
  sessionFile: string,
  sessionId: string,
  cwd: string,
  timestamp: string,
  ctx: ExtensionContext,
  goal?: string,
): Promise<string> {
  const modelChoice = await resolveModel(ctx);
  if (!modelChoice) {
    throw new Error("No model with API key available for handoff.");
  }

  const messages = parseSessionMessages(sessionFile);
  const turns = groupIntoTurns(messages);

  if (turns.length === 0) {
    throw new Error("Empty session — no user or assistant messages found.");
  }

  const maxPromptChars = computeCharBudget(
    modelChoice.model.contextWindow as number | undefined,
    SUMMARY_MAX_TOKENS,
    INITIAL_PROMPT,
  );
  const transcript = buildTranscript(turns, maxPromptChars);

  // Build the user payload using the compaction engine's buildPrompt helper.
  // This uses the <focus> tag convention for custom instructions.
  const customInstructions = goal?.trim()
    ? `Goal for next session: ${goal.trim()}\n\n${HANDOFF_EXTRACTION_PROMPT}`
    : HANDOFF_EXTRACTION_PROMPT;
  const promptPayload = buildPrompt({ transcript, customInstructions });

  // Prepend session metadata
  const sessionMeta = `Session ID: ${sessionId}\nProject: ${cwd}\nDate: ${timestamp}`;
  const userContent = `${sessionMeta}\n\n${promptPayload}`;

  // Base compaction prompt + optional goal focus
  let systemPrompt = INITIAL_PROMPT;
  if (goal?.trim()) {
    systemPrompt += `\n\nThe user's goal for the new session is: "${goal.trim()}"\nFocus the extraction on what matters for achieving this goal.`;
  }

  const response = await complete(
    modelChoice.model,
    {
      systemPrompt,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: userContent }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: modelChoice.auth.apiKey,
      headers: modelChoice.auth.headers,
      maxTokens: SUMMARY_MAX_TOKENS,
      signal: (ctx as unknown as SignalContext).signal,
    },
  );

  const summary = response.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();

  if (!summary) {
    throw new Error("Model returned an empty handoff summary.");
  }

  return summary;
}
