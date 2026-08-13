/**
 * claudish — configuration.
 *
 * All behavior is controlled by CLAUDISH_* environment variables, mirroring the
 * original Claude Code plugin. Env is read once at session start (see index.ts);
 * the only mid-session switch is the kill-switch flag file.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

export type ClProvider = "ollama" | "anthropic" | "openai";
export type ClMdMode = "sibling" | "overwrite";

export interface ClConfig {
  /** CLAUDISH_ENABLED — master switch (default 1). */
  enabled: boolean;
  /** CLAUDISH_OFF_FILE — kill-switch flag file path (default ~/.claude/claudish-off). */
  offFile: string;
  /** CLAUDISH_PROVIDER — which LLM serves rewrites. */
  provider: ClProvider;
  /** CLAUDISH_MODEL — overrides the provider default. */
  model: string;
  /** CLAUDISH_OLLAMA — ollama base URL. */
  ollamaUrl: string;
  /** CLAUDISH_ANTHROPIC_URL — anthropic base URL. */
  anthropicUrl: string;
  /** CLAUDISH_ANTHROPIC_KEY, falls back to ANTHROPIC_API_KEY. */
  anthropicKey: string | undefined;
  /** CLAUDISH_OPENAI_URL — OpenAI-compatible base URL (may end in /v1). */
  openaiUrl: string;
  /** CLAUDISH_OPENAI_KEY, falls back to OPENAI_API_KEY. */
  openaiKey: string | undefined;
  /**
   * reasoning_effort sent with openai-provider requests.
   * undefined = omit the field. Defaults to "none" for api.openai.com.
   */
  openaiEffort: string | undefined;
  /** CLAUDISH_MAX_TOKENS — completion cap for the anthropic provider. */
  maxTokens: number;
  /** CLAUDISH_MIN_CHARS — skip messages/files whose prose (code stripped) is shorter. */
  minChars: number;
  /** CLAUDISH_STUB — 1 = deterministic stub instead of the model. */
  stub: boolean;
  /** CLAUDISH_TIMEOUT — LLM client timeout for the display hook (seconds). */
  displayTimeoutMs: number;
  /** CLAUDISH_MD_TIMEOUT — LLM client timeout for the Markdown file hook (seconds). */
  mdTimeoutMs: number;
  /** CLAUDISH_DEBUG — 1 = append a debug log under $TMPDIR/claudish-to-english/. */
  debug: boolean;
  /** CLAUDISH_NOTICE — 1 = show a once-per-session notice when a rewrite is skipped. */
  notice: boolean;
  /** CLAUDISH_MD_DIR — Markdown hook opt-in directory. Unset = hook does nothing. */
  mdDir: string | undefined;
  /** CLAUDISH_MD_MODE — sibling or overwrite. */
  mdMode: ClMdMode;
  /** CLAUDISH_MD_SUFFIX — sibling infix: NAME.<suffix>.md. */
  mdSuffix: string;
}

/** Provider defaults, kept identical to the upstream plugin. */
export const PROVIDER_DEFAULT_MODELS: Record<ClProvider, string> = {
  ollama: "gemma4:26b-mlx",
  anthropic: "claude-haiku-4-5",
  openai: "gpt-5.6-luna",
};

/** Hard cap on how much of a message/file we send to the rewriter. */
export const MAX_INPUT_CHARS = 40_000;

/** Seconds ranges the plugin documents for the two hook timeouts. */
export const DISPLAY_TIMEOUT_RANGE = [1, 60] as const;
export const MD_TIMEOUT_RANGE = [1, 180] as const;

/** Expand a leading `~`/`~/` to the home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  max: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > max || !Number.isInteger(n)) {
    return fallback;
  }
  return n;
}

function parseNonNegativeInt(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return fallback;
  return n;
}

function parseProvider(raw: string | undefined): ClProvider {
  const p = (raw ?? "ollama").trim().toLowerCase();
  return p === "anthropic" || p === "openai" || p === "ollama" ? p : "ollama";
}

function parseMdMode(raw: string | undefined): ClMdMode {
  return raw === "overwrite" ? "overwrite" : "sibling";
}

/**
 * Parse configuration from an env object. Kept pure (no process access) so it
 * is easy to test; index.ts passes `process.env`.
 */
export function parseConfig(env: Record<string, string | undefined>): ClConfig {
  const provider = parseProvider(env.CLAUDISH_PROVIDER);

  const openaiUrl = (
    env.CLAUDISH_OPENAI_URL ?? "https://api.openai.com/v1"
  ).replace(/\/+$/, "");
  const explicitEffort = env.CLAUDISH_OPENAI_EFFORT;
  const openaiEffort =
    explicitEffort !== undefined
      ? explicitEffort === ""
        ? undefined
        : explicitEffort
      : openaiUrl.includes("api.openai.com")
        ? "none"
        : undefined;

  const mdDirRaw = env.CLAUDISH_MD_DIR;
  const mdDir =
    mdDirRaw && mdDirRaw.trim() !== "" ? expandHome(mdDirRaw) : undefined;

  return {
    enabled: env.CLAUDISH_ENABLED !== "0",
    offFile: expandHome(env.CLAUDISH_OFF_FILE ?? "~/.claude/claudish-off"),
    provider,
    model: env.CLAUDISH_MODEL ?? PROVIDER_DEFAULT_MODELS[provider],
    ollamaUrl: (env.CLAUDISH_OLLAMA ?? "http://localhost:11434").replace(
      /\/+$/,
      "",
    ),
    anthropicUrl: (
      env.CLAUDISH_ANTHROPIC_URL ?? "https://api.anthropic.com"
    ).replace(/\/+$/, ""),
    anthropicKey:
      env.CLAUDISH_ANTHROPIC_KEY ?? env.ANTHROPIC_API_KEY ?? undefined,
    openaiUrl,
    openaiKey: env.CLAUDISH_OPENAI_KEY ?? env.OPENAI_API_KEY ?? undefined,
    openaiEffort,
    maxTokens: parsePositiveInt(env.CLAUDISH_MAX_TOKENS, 4096, 100_000),
    minChars: parseNonNegativeInt(env.CLAUDISH_MIN_CHARS, 200),
    stub: env.CLAUDISH_STUB === "1",
    displayTimeoutMs:
      parsePositiveInt(env.CLAUDISH_TIMEOUT, 45, DISPLAY_TIMEOUT_RANGE[1]) *
      1000,
    mdTimeoutMs:
      parsePositiveInt(env.CLAUDISH_MD_TIMEOUT, 150, MD_TIMEOUT_RANGE[1]) *
      1000,
    debug: env.CLAUDISH_DEBUG === "1",
    notice: env.CLAUDISH_NOTICE !== "0",
    mdDir,
    mdMode: parseMdMode(env.CLAUDISH_MD_MODE),
    mdSuffix: env.CLAUDISH_MD_SUFFIX ?? "plain",
  };
}
