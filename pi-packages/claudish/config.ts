/**
 * claudish — configuration.
 *
 * All behavior is controlled by a JSON file at `<agentDir>/claudish.json`,
 * mirroring the bermudis-pi-goodies pattern. Auth is NOT configured here —
 * pi resolves API keys via `ctx.modelRegistry.getApiKeyForProvider(provider)`.
 *
 * `model` and `provider` are optional: when absent, they default to the
 * session's active model (`ctx.model`) at rewrite time. This means claudish
 * rewrites through the same model you're chatting with, unless you pin a
 * cheaper one in the config file.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { describeError } from "./json-file.ts";

export type ClProvider = "ollama" | "anthropic" | "openai";
export type ClMdMode = "sibling" | "overwrite";

export const CONFIG_FILENAME = "claudish.json";

export interface ClConfig {
  /** Master switch (default true). */
  enabled: boolean;
  /** Kill-switch flag file path (default ~/.claude/claudish-off). */
  offFile: string;
  /**
   * Which LLM API shape to use. When absent, claudish reuses the current
   * pi model via ModelRegistry.complete — whatever model you're chatting
   * with. Set provider explicitly ("ollama" | "anthropic" | "openai")
   * only to override the model and hit a specific API shape / URL.
   */
  provider: ClProvider | undefined;
  /**
   * Model name. When absent, defaults to the session model's id at
   * rewrite time (pi path) or the model string sent to the provider API.
   */
  model: string | undefined;
  /** ollama base URL. */
  ollamaUrl: string;
  /** anthropic base URL. */
  anthropicUrl: string;
  /** OpenAI-compatible base URL (may end in /v1). */
  openaiUrl: string;
  /**
   * reasoning_effort sent with openai-provider requests.
   * undefined = omit the field. No default: "none" is not a valid OpenAI
   * value (the API accepts low/medium/high, or minimal on some models).
   * Set explicitly for reasoning models.
   */
  openaiEffort: string | undefined;
  /** Completion cap applied to all providers. */
  maxTokens: number;
  /** Skip messages/files whose prose (code stripped) is shorter. */
  minChars: number;
  /** Deterministic stub instead of the model (for testing). */
  stub: boolean;
  /** LLM client timeout for the display hook (millis). */
  displayTimeoutMs: number;
  /** LLM client timeout for the Markdown file hook (millis). */
  mdTimeoutMs: number;
  /** Write a debug log to $TMPDIR/claudish-to-english/. */
  debug: boolean;
  /** Show a once-per-session notice when a rewrite is skipped. */
  notice: boolean;
  /** Markdown hook opt-in directory. Unset = hook does nothing. */
  mdDir: string | undefined;
  /** sibling or overwrite. */
  mdMode: ClMdMode;
  /** Sibling infix: NAME.<suffix>.md. */
  mdSuffix: string;
}

/** Fields the JSON file may contain. All are optional. */
interface ClConfigFile {
  enabled?: boolean;
  offFile?: string;
  provider?: string;
  model?: string;
  ollamaUrl?: string;
  anthropicUrl?: string;
  openaiUrl?: string;
  openaiEffort?: string;
  maxTokens?: number;
  minChars?: number;
  stub?: boolean;
  displayTimeoutMs?: number;
  mdTimeoutMs?: number;
  debug?: boolean;
  notice?: boolean;
  mdDir?: string;
  mdMode?: string;
  mdSuffix?: string;
}

/** Hard cap on how much of a message/file we send to the rewriter. */
export const MAX_INPUT_CHARS = 40_000;

/** Default config values, used when the file is absent or a field is missing. */
export const DEFAULTS: ClConfig = {
  enabled: true,
  offFile: expandHome("~/.claude/claudish-off"),
  provider: undefined,
  model: undefined,
  ollamaUrl: "http://localhost:11434",
  anthropicUrl: "https://api.anthropic.com",
  openaiUrl: "https://api.openai.com/v1",
  openaiEffort: undefined,
  maxTokens: 4096,
  minChars: 200,
  stub: false,
  displayTimeoutMs: 45_000,
  mdTimeoutMs: 150_000,
  debug: false,
  notice: true,
  mdDir: undefined,
  mdMode: "sibling",
  mdSuffix: "plain",
};

/** Expand a leading `~`/`~/` to the home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

function parseProvider(raw: string | undefined): ClProvider | undefined {
  if (raw === undefined || raw === "") return undefined;
  const p = raw.trim().toLowerCase();
  return p === "anthropic" || p === "openai" || p === "ollama" ? p : undefined;
}

function parseMdMode(raw: string | undefined): ClMdMode {
  return raw === "overwrite" ? "overwrite" : "sibling";
}

function clampPositiveInt(
  n: number | undefined,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (n === undefined || typeof n !== "number") return fallback;
  if (!Number.isFinite(n) || n < 1 || n > max || !Number.isInteger(n))
    return fallback;
  return n;
}

function clampNonNegativeInt(
  n: number | undefined,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (n === undefined || typeof n !== "number") return fallback;
  if (!Number.isFinite(n) || n < 0 || n > max || !Number.isInteger(n))
    return fallback;
  return n;
}

/**
 * Map a pi session model provider name to a claudish provider (API shape).
 * Used only for the /claudish status display and for explicit provider
 * overrides. The default rewrite path no longer uses this — it calls the
 * current pi model directly via ModelRegistry, so any provider works.
 * Returns undefined when the provider doesn't map to a known API shape.
 */
export function mapProviderFromSession(
  sessionProvider: string | undefined,
): ClProvider | undefined {
  if (!sessionProvider) return undefined;
  const p = sessionProvider.toLowerCase();
  if (p === "anthropic") return "anthropic";
  if (p === "openai") return "openai";
  return undefined;
}

export interface LoadResult {
  config: ClConfig;
  /** Non-null when the file existed but failed to parse or validate. */
  error: string | null;
  /** Whether the config file existed. */
  present: boolean;
}

/**
 * Load config from a JSON file. An absent file is valid — all defaults apply.
 * Reads are uncached (the file is tiny and events are rare), so hand edits
 * are picked up without a reload.
 */
export function loadConfig(path: string): LoadResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: { ...DEFAULTS }, error: null, present: false };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = describeError(error);
    console.error(`[claudish] invalid JSON in ${path}:`, message);
    return { config: { ...DEFAULTS }, error: message, present: true };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const message = "the top level must be an object";
    console.error(`[claudish] invalid config at ${path}:`, message);
    return { config: { ...DEFAULTS }, error: message, present: true };
  }

  const file = parsed as ClConfigFile;

  // Warn about unknown keys so hand edits surface typos.
  const known = new Set<keyof ClConfigFile>([
    "enabled",
    "offFile",
    "provider",
    "model",
    "ollamaUrl",
    "anthropicUrl",
    "openaiUrl",
    "openaiEffort",
    "maxTokens",
    "minChars",
    "stub",
    "displayTimeoutMs",
    "mdTimeoutMs",
    "debug",
    "notice",
    "mdDir",
    "mdMode",
    "mdSuffix",
  ]);
  const unknownKeys = Object.keys(file).filter((k) => !known.has(k as never));
  if (unknownKeys.length > 0) {
    console.warn(
      `[claudish] unknown field(s) in ${path}: ${unknownKeys.join(", ")}`,
    );
  }

  const config: ClConfig = {
    enabled: file.enabled ?? DEFAULTS.enabled,
    offFile: expandHome(file.offFile ?? DEFAULTS.offFile),
    provider: parseProvider(file.provider),
    model: file.model && file.model.trim() !== "" ? file.model : undefined,
    ollamaUrl: (file.ollamaUrl ?? DEFAULTS.ollamaUrl).replace(/\/+$/, ""),
    anthropicUrl: (file.anthropicUrl ?? DEFAULTS.anthropicUrl).replace(
      /\/+$/,
      "",
    ),
    openaiUrl: (file.openaiUrl ?? DEFAULTS.openaiUrl).replace(/\/+$/, ""),
    openaiEffort:
      file.openaiEffort === undefined || file.openaiEffort === ""
        ? undefined
        : file.openaiEffort,
    maxTokens: clampPositiveInt(file.maxTokens, DEFAULTS.maxTokens, 100_000),
    minChars: clampNonNegativeInt(file.minChars, DEFAULTS.minChars),
    stub: file.stub ?? DEFAULTS.stub,
    displayTimeoutMs: clampPositiveInt(
      file.displayTimeoutMs,
      DEFAULTS.displayTimeoutMs,
      60_000,
    ),
    mdTimeoutMs: clampPositiveInt(
      file.mdTimeoutMs,
      DEFAULTS.mdTimeoutMs,
      180_000,
    ),
    debug: file.debug ?? DEFAULTS.debug,
    notice: file.notice ?? DEFAULTS.notice,
    mdDir:
      file.mdDir && file.mdDir.trim() !== ""
        ? expandHome(file.mdDir)
        : undefined,
    mdMode: parseMdMode(file.mdMode),
    mdSuffix: file.mdSuffix ?? DEFAULTS.mdSuffix,
  };

  return { config, error: null, present: true };
}
