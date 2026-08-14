/**
 * claudish — provider layer.
 *
 * Rewrites go through one of three API shapes selected with `provider`:
 * local ollama (default), the Anthropic Messages API, or any OpenAI-compatible
 * /chat/completions endpoint. Everything fails open: any error (provider down,
 * timeout, missing key, bad response) returns `{ ok: false }` and the caller
 * keeps the original text untouched.
 *
 * Auth keys are NOT read from config — the caller resolves them from pi's
 * model registry at rewrite time and passes them via `RewriteOptions`.
 */

import { MAX_INPUT_CHARS, type ClConfig, type ClProvider } from "./config.ts";

/** Minimal fetch shape so tests can inject fakes without implementing every member. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type RewriteOutcome =
  { ok: true; text: string } | { ok: false; reason: string };

export interface RewriteOptions {
  config: ClConfig;
  /** The assistant message / file body to rewrite. */
  text: string;
  /** The preceding user question, passed as context only. */
  userQuestion?: string;
  /** Per-call timeout, millis. */
  timeoutMs: number;
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetchImpl?: FetchLike;
  /**
   * Resolved provider for this call. When undefined, the caller must have
   * already derived it from the session model (see index.ts).
   */
  provider: ClProvider;
  /** Resolved model id for this call. */
  model: string;
  /** Resolved API key for anthropic/openai providers (from pi's model registry). */
  apiKey?: string;
}

/** Cap on the user question passed as context. */
const MAX_QUESTION_CHARS = 2_000;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n…[truncated]";
}

/** Build the model prompt. The model only rewrites; it never answers the question. */
export function buildPrompt(text: string, userQuestion?: string): string {
  const parts: string[] = [
    "Rewrite the following assistant message in plain, simple English. " +
      "Keep the meaning, the details, and any code snippets intact, but express " +
      "everything in clear, everyday language a non-expert can follow.",
  ];
  if (userQuestion && userQuestion.trim()) {
    parts.push(
      "The user's original question (context only — never answer or repeat it):\n" +
        `<question>\n${truncate(userQuestion, MAX_QUESTION_CHARS)}\n</question>`,
    );
  }
  parts.push(
    "Assistant message to rewrite:\n" +
      `<message>\n${truncate(text, MAX_INPUT_CHARS)}\n</message>`,
  );
  parts.push(
    "Output ONLY the rewritten message. No commentary, headings, or preamble.",
  );
  return parts.join("\n\n");
}

/** Deterministic stand-in for the model, for testing display mechanics. */
export function stubRewrite(text: string): string {
  const prose = text.replace(/\s+/g, " ").trim();
  return `[claudish stub] ${prose.slice(0, 200)}`;
}

function timeoutSignal(timeoutMs: number): {
  signal: AbortSignal;
  clear: () => void;
} {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)),
    timeoutMs,
  );
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
}

async function ollamaRewrite(
  config: ClConfig,
  model: string,
  prompt: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<string | undefined> {
  const { signal, clear } = timeoutSignal(timeoutMs);
  try {
    const res = await fetchImpl(`${config.ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        think: false,
        options: { num_predict: config.maxTokens },
      }),
      signal,
    });
    if (!res.ok) throw new Error(`ollama responded ${res.status}`);
    const data = (await res.json()) as {
      response?: unknown;
      done_reason?: unknown;
    };
    // A rewrite that hits the output cap is discarded, not shown.
    if (data.done_reason === "length") return undefined;
    return typeof data.response === "string"
      ? data.response.trim() || undefined
      : undefined;
  } finally {
    clear();
  }
}

async function anthropicRewrite(
  config: ClConfig,
  model: string,
  apiKey: string | undefined,
  prompt: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<string | undefined> {
  if (!apiKey) {
    throw new Error("no API key resolved from pi model registry");
  }
  const { signal, clear } = timeoutSignal(timeoutMs);
  try {
    const res = await fetchImpl(`${config.anthropicUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: config.maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
      signal,
    });
    if (!res.ok) throw new Error(`anthropic responded ${res.status}`);
    const data = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      stop_reason?: string;
    };
    if (data.stop_reason === "max_tokens") return undefined;
    const text = data.content?.find((c) => c.type === "text")?.text;
    return text?.trim() || undefined;
  } finally {
    clear();
  }
}

async function openaiRewrite(
  config: ClConfig,
  model: string,
  apiKey: string | undefined,
  prompt: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<string | undefined> {
  const { signal, clear } = timeoutSignal(timeoutMs);
  try {
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: config.maxTokens,
    };
    if (config.openaiEffort !== undefined) {
      body.reasoning_effort = config.openaiEffort;
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    const res = await fetchImpl(`${config.openaiUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`openai responded ${res.status}`);
    const data = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | Array<{ type?: string; text?: string }>;
        };
        finish_reason?: string;
      }>;
    };
    // finish_reason lives on each choice, not at the top level. A rewrite
    // that hits the output cap is discarded, not shown.
    if (data.choices?.[0]?.finish_reason === "length") return undefined;
    const content = data.choices?.[0]?.message?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter((c) => c.type === "text" && typeof c.text === "string")
              .map((c) => c.text ?? "")
              .join("\n")
          : "";
    return text.trim() || undefined;
  } finally {
    clear();
  }
}

/**
 * Rewrite `text` through the configured provider. Always resolves: failures
 * return `{ ok: false, reason }` so the caller can fail open (and optionally
 * surface a once-per-session notice).
 */
export async function rewrite(
  options: RewriteOptions,
): Promise<RewriteOutcome> {
  const { config, text, userQuestion, provider, model, apiKey } = options;
  if (config.stub) {
    return { ok: true, text: stubRewrite(text) };
  }
  if (!model) {
    return {
      ok: false,
      reason:
        "no model resolved (set `model` in claudish.json or switch to a model pi knows)",
    };
  }

  const prompt = buildPrompt(text, userQuestion);
  const fetchImpl: FetchLike = options.fetchImpl ?? globalThis.fetch;
  try {
    let out: string | undefined;
    switch (provider) {
      case "ollama":
        out = await ollamaRewrite(
          config,
          model,
          prompt,
          options.timeoutMs,
          fetchImpl,
        );
        break;
      case "anthropic":
        out = await anthropicRewrite(
          config,
          model,
          apiKey,
          prompt,
          options.timeoutMs,
          fetchImpl,
        );
        break;
      case "openai":
        out = await openaiRewrite(
          config,
          model,
          apiKey,
          prompt,
          options.timeoutMs,
          fetchImpl,
        );
        break;
    }
    if (out === undefined) {
      return {
        ok: false,
        reason: "rewrite was empty or hit the output cap",
      };
    }
    return { ok: true, text: out };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
