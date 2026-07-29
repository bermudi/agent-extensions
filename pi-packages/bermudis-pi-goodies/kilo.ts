/**
 * Kilo Provider Extension
 *
 * Access 300+ models via the Kilo Gateway (OpenRouter-compatible) at api.kilo.ai.
 * Device-code flow for browser-based login, or set KILO_API_KEY.
 *
 * This module is bundled by bermudis-pi-goodies. Use /login kilo or
 * KILO_API_KEY after installing the goodies bundle; do not install this file
 * separately alongside the bundle.
 *
 * Design notes (pi 0.82.x):
 *  - Reads auth via the public ModelRegistry API (getApiKeyForProvider /
 *    getProviderAuthStatus). The older `authStorage` map was removed upstream.
 *  - Dynamic model catalog uses the modern ProviderConfig.refreshModels(context)
 *    hook. The framework calls it on startup and after login; when
 *    authenticated it returns the full Kilo catalog, otherwise it returns
 *    nothing and the configured free-model fallback list stays in place.
 */

import type {
  Api,
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

// =============================================================================
// Constants
// =============================================================================

const KILO_API_BASE = process.env.KILO_API_URL || "https://api.kilo.ai";
const KILO_GATEWAY_BASE = `${KILO_API_BASE}/api/gateway`;
// Distinct endpoint for models Kilo routes through the OpenAI Responses API
// (opencode.ai_sdk_provider === "openai" / current gpt-5 & o-series). Using
// chat completions for these is rejected by the gateway ("please use responses").
const KILO_OPENROUTER_BASE = `${KILO_API_BASE}/api/openrouter`;
const KILO_DEVICE_AUTH_ENDPOINT = `${KILO_API_BASE}/api/device-auth/codes`;
const POLL_INTERVAL_MS = 3000;
const MODELS_FETCH_TIMEOUT_MS = 10_000;
const LOGIN_REQUEST_TIMEOUT_MS = 15_000;
// Kilo device-auth tokens are long-lived; treat as effectively non-expiring so
// pi does not force a re-login every session.
const TOKEN_EXPIRATION_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

const KILO_PROVIDER_ID = "kilo";

// =============================================================================
// Device authorization flow
// =============================================================================

interface DeviceAuthResponse {
  code: string;
  verificationUrl: string;
  expiresIn: number;
}

interface DeviceAuthPollResponse {
  status: "pending" | "approved" | "denied" | "expired";
  token?: string;
}

export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Login cancelled"));
    // Remove the abort listener on normal completion; otherwise a login that
    // polls for >~10 iterations would accumulate listeners on the persistent
    // login signal (MaxListenersExceededWarning) and retain timer closures.
    let timeout: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("Login cancelled"));
    };
    timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Combine the login callback signal with a per-request timeout ceiling. */
function loginAbortSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(LOGIN_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

async function initiateDeviceAuth(
  signal?: AbortSignal,
): Promise<DeviceAuthResponse> {
  const response = await fetch(KILO_DEVICE_AUTH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: loginAbortSignal(signal),
  });

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error(
        "Too many pending authorization requests. Please try again later.",
      );
    }
    throw new Error(
      `Failed to initiate device authorization: ${response.status}`,
    );
  }

  return (await response.json()) as DeviceAuthResponse;
}

async function pollDeviceAuth(
  code: string,
  signal?: AbortSignal,
): Promise<DeviceAuthPollResponse> {
  const response = await fetch(`${KILO_DEVICE_AUTH_ENDPOINT}/${code}`, {
    signal: loginAbortSignal(signal),
  });

  if (response.status === 202) return { status: "pending" };
  if (response.status === 403) return { status: "denied" };
  if (response.status === 410) return { status: "expired" };

  if (!response.ok) {
    throw new Error(`Failed to poll device authorization: ${response.status}`);
  }

  return (await response.json()) as DeviceAuthPollResponse;
}

async function loginKilo(
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  callbacks.onProgress?.("Initiating device authorization...");
  const { code, verificationUrl, expiresIn } = await initiateDeviceAuth(
    callbacks.signal,
  );

  callbacks.onAuth({
    url: verificationUrl,
    instructions: `Enter code: ${code}`,
  });
  callbacks.onProgress?.("Waiting for browser authorization...");

  const deadline = Date.now() + expiresIn * 1000;
  while (Date.now() < deadline) {
    if (callbacks.signal?.aborted) throw new Error("Login cancelled");

    await abortableSleep(POLL_INTERVAL_MS, callbacks.signal);
    const result = await pollDeviceAuth(code, callbacks.signal);

    if (result.status === "approved") {
      if (!result.token) {
        throw new Error("Authorization approved but no token received");
      }
      callbacks.onProgress?.("Login successful!");
      return {
        refresh: result.token,
        access: result.token,
        expires: Date.now() + TOKEN_EXPIRATION_MS,
      };
    }
    if (result.status === "denied") {
      throw new Error("Authorization denied by user.");
    }
    if (result.status === "expired") {
      throw new Error("Authorization code expired. Please try again.");
    }

    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    callbacks.onProgress?.(
      `Waiting for browser authorization... (${remaining}s remaining)`,
    );
  }

  throw new Error("Authentication timed out. Please try again.");
}

async function refreshKiloToken(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  // Kilo device-auth tokens are long-lived and not refreshable; if one has
  // expired past our 1-year horizon the user must re-run /login kilo.
  if (credentials.expires > Date.now()) return credentials;
  throw new Error(
    "Kilo token expired. Please run /login kilo to re-authenticate.",
  );
}

// =============================================================================
// Model catalog (OpenRouter-compatible)
// =============================================================================

export interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  max_completion_tokens?: number | null;
  pricing?: {
    prompt?: string | null;
    completion?: string | null;
    input_cache_write?: string | null;
    input_cache_read?: string | null;
  };
  architecture?: {
    input_modalities?: string[] | null;
    output_modalities?: string[] | null;
  };
  top_provider?: { max_completion_tokens?: number | null };
  supported_parameters?: string[];
  opencode?: {
    family?: string;
    prompt?: string;
    /** AI-SDK provider tag Kilo uses to select OpenAI (Responses) vs OpenRouter routing. */
    ai_sdk_provider?: string;
    /** Per-variant reasoning metadata; drives the thinkingLevelMap. */
    variants?: Record<
      string,
      {
        reasoning?: { enabled?: boolean; effort?: string };
        verbosity?: string;
      }
    >;
  };
}

export function parsePrice(price: string | null | undefined): number {
  if (!price) return 0;
  const parsed = parseFloat(price);
  if (isNaN(parsed)) return 0;
  // OpenRouter prices are per-token; pi expects per-million-token.
  return parsed * 1_000_000;
}

export function isFreeModel(m: OpenRouterModel): boolean {
  const prompt = parseFloat(m.pricing?.prompt ?? "1");
  const completion = parseFloat(m.pricing?.completion ?? "1");
  if (prompt !== 0 || completion !== 0) return false;
  // Zero pricing alone is unreliable (some models report "0" but need auth).
  // Trust the :free suffix, Kilo-native ids (no vendor prefix), the
  // kilo-auto/free router, and the kilo/openrouter router families.
  if (m.id === "kilo-auto/free") return true;
  if (m.id.includes(":free")) return true;
  if (!m.id.includes("/")) return true;
  if (m.id.startsWith("kilo/") || m.id.startsWith("openrouter/")) return true;
  return false;
}

/** Whether Kilo serves this model via the OpenAI Responses API. */
export function shouldUseResponsesApi(m: OpenRouterModel): boolean {
  // Kilo's gateway uses opencode.ai_sdk_provider to pick the SDK path; "openai"
  // means the OpenAI SDK (Responses). Matches the maintained Kilo provider.
  if (m.opencode?.ai_sdk_provider === "openai") return true;
  // Metadata can lag the catalog, so also match current OpenAI reasoning /
  // frontier ids directly. (gpt-5* on chat completions yields "please use responses".)
  const shortId = m.id.includes("/") ? (m.id.split("/").pop() ?? m.id) : m.id;
  const s = shortId.toLowerCase();
  return (
    s === "gpt-5" ||
    s.startsWith("gpt-5.") ||
    s.startsWith("gpt-5-") ||
    s.startsWith("o1") ||
    s.startsWith("o3") ||
    s.startsWith("o4")
  );
}

/** Per-model compat for Kilo's gateway. */
export function getKiloModelCompat(
  m: OpenRouterModel,
  api: Api | undefined,
): NonNullable<ProviderModelConfig["compat"]> {
  // Responses-API models take OpenAIResponsesCompat, which has no thinkingFormat.
  // sessionAffinityFormat "openai-nosession" suppresses the underscore `session_id`
  // header, which Kilo's strict OpenAI-compatible gateway rejects (the canonical
  // provider set the pre-0.80.7 `sendSessionIdHeader:false` for exactly this; Pi
  // migrated that field to `sessionAffinityFormat` in 0.80.7 and the canonical
  // missed it). x-client-request-id and prompt_cache_key are still sent.
  if (api === "openai-responses") {
    return {
      sessionAffinityFormat: "openai-nosession",
      supportsLongCacheRetention: false,
    } as NonNullable<ProviderModelConfig["compat"]>;
  }
  // Chat-completions models: Kilo's gateway is OpenRouter-compatible but lives at
  // api.kilo.ai, so pi's URL auto-detection does NOT classify it as OpenRouter.
  // Without this, pi defaults to OpenAI reasoning_effort and skips cache markers.
  //   - thinkingFormat "openrouter"  -> reasoning: { effort }
  //   - supportsStore false           -> Kilo has no OpenAI "store" conversations
  //   - cacheControlFormat "anthropic" for anthropic/* models
  //   - requiresReasoningContentOnAssistantMessages for deepseek-v4 (replays need it)
  return {
    thinkingFormat: "openrouter",
    supportsStore: false,
    ...(m.id.startsWith("anthropic/")
      ? { cacheControlFormat: "anthropic" }
      : {}),
    ...(m.id === "deepseek/deepseek-v4-flash" ||
    m.id === "deepseek/deepseek-v4-pro"
      ? { requiresReasoningContentOnAssistantMessages: true }
      : {}),
  } as NonNullable<ProviderModelConfig["compat"]>;
}

// Pi's selectable thinking levels. Kilo/OpenCode may use variant names such
// as "thinking" instead of Pi level names; see thinkingLevelMapFromVariants.
type PiThinkingLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const PI_THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** Map a Kilo/OpenCode variant to its provider reasoning effort string. */
function mapVariantEffort(
  variants: NonNullable<OpenRouterModel["opencode"]>["variants"],
  key: string,
): string | undefined {
  const variant = variants?.[key];
  if (!variant) return undefined;
  const reasoning = variant.reasoning;
  if (!reasoning) return key;
  if (reasoning.enabled === false || reasoning.effort === "none") return "none";
  return reasoning.effort ?? key;
}

/** Derive a Pi thinkingLevelMap from Kilo/OpenCode per-variant reasoning metadata. */
export function thinkingLevelMapFromVariants(
  variants: NonNullable<OpenRouterModel["opencode"]>["variants"],
): ProviderModelConfig["thinkingLevelMap"] | undefined {
  if (!variants || Object.keys(variants).length === 0) return undefined;

  const map: Partial<Record<PiThinkingLevel, string | null>> = {};
  const off =
    mapVariantEffort(variants, "none") ?? mapVariantEffort(variants, "instant");
  if (off !== undefined) map.off = off;

  for (const level of PI_THINKING_LEVELS) {
    const effort = mapVariantEffort(variants, level);
    map[level] = effort === undefined ? null : effort;
  }

  // Kilo/OpenCode also uses descriptive variant names such as "thinking".
  // Use the declared effort to place those variants at the corresponding Pi
  // level (qwen3.7-flash, for example, declares thinking -> effort: high).
  for (const variantName of Object.keys(variants)) {
    const effort = mapVariantEffort(variants, variantName);
    if (
      !effort ||
      !PI_THINKING_LEVELS.includes(
        effort as (typeof PI_THINKING_LEVELS)[number],
      )
    ) {
      continue;
    }
    const level = effort as (typeof PI_THINKING_LEVELS)[number];
    if (map[level] === null) map[level] = effort;
  }

  return map as ProviderModelConfig["thinkingLevelMap"];
}

/** Resolve a Pi thinkingLevelMap: variant metadata first, then known fallbacks. */
export function getKiloThinkingLevelMap(
  m: OpenRouterModel,
): ProviderModelConfig["thinkingLevelMap"] | undefined {
  const fromVariants = thinkingLevelMapFromVariants(m.opencode?.variants);
  if (fromVariants) return fromVariants;

  if (m.id === "deepseek/deepseek-v4-pro") {
    return {
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    };
  }

  // Safety net for the current frontier OpenAI model while Kilo/OpenRouter
  // model metadata is catching up.
  if (m.id.includes("gpt-5.5")) {
    return {
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    };
  }

  return undefined;
}

export function modelSupportsReasoning(m: OpenRouterModel): boolean {
  if (m.supported_parameters?.includes("reasoning")) return true;

  // Kilo's catalog sometimes describes reasoning through OpenCode variants
  // without also listing "reasoning" in supported_parameters. The variants
  // are still authoritative: an enabled effort variant means Pi must expose
  // the model's thinking controls.
  return Object.values(m.opencode?.variants ?? {}).some(
    (variant) =>
      variant.reasoning?.enabled === true &&
      variant.reasoning.effort !== "none",
  );
}

function mapOpenRouterModel(m: OpenRouterModel): ProviderModelConfig {
  const inputModalities = m.architecture?.input_modalities ?? ["text"];
  const supportsImages = inputModalities.includes("image");
  const supportsReasoning = modelSupportsReasoning(m);
  const maxTokens =
    m.top_provider?.max_completion_tokens ??
    m.max_completion_tokens ??
    Math.ceil(m.context_length * 0.2);
  // Responses-API models get a per-model api + baseUrl override to Kilo's
  // /api/openrouter endpoint; everything else stays on the provider default
  // (openai-completions against /api/gateway).
  const api = shouldUseResponsesApi(m)
    ? ("openai-responses" as const)
    : undefined;

  return {
    id: m.id,
    name: m.name,
    ...(api ? { api, baseUrl: KILO_OPENROUTER_BASE } : {}),
    reasoning: supportsReasoning,
    input: supportsImages ? ["text", "image"] : ["text"],
    cost: {
      input: parsePrice(m.pricing?.prompt),
      output: parsePrice(m.pricing?.completion),
      cacheRead: parsePrice(m.pricing?.input_cache_read),
      cacheWrite: parsePrice(m.pricing?.input_cache_write),
    },
    contextWindow: m.context_length,
    maxTokens,
    thinkingLevelMap: getKiloThinkingLevelMap(m),
    compat: getKiloModelCompat(m, api),
  };
}

/** Combine the fetch ceiling timeout with an optional caller signal. */
function modelsAbortSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

async function fetchKiloModels(options?: {
  token?: string;
  freeOnly?: boolean;
  signal?: AbortSignal;
}): Promise<ProviderModelConfig[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "pi-kilo-provider",
  };
  if (options?.token) headers.Authorization = `Bearer ${options.token}`;

  const response = await fetch(`${KILO_GATEWAY_BASE}/models`, {
    headers,
    signal: modelsAbortSignal(options?.signal),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch models: ${response.status} ${response.statusText}`,
    );
  }

  const json = (await response.json()) as { data?: OpenRouterModel[] };
  if (!json.data || !Array.isArray(json.data)) {
    throw new Error("Invalid models response: missing data array");
  }

  return json.data
    .filter((m) => {
      const outputMods = m.architecture?.output_modalities ?? [];
      if (outputMods.includes("image")) return false; // skip image-generation
      if (options?.freeOnly && !isFreeModel(m)) return false;
      return true;
    })
    .map(mapOpenRouterModel);
}

// =============================================================================
// Provider config
// =============================================================================

const KILO_PROVIDER_CONFIG = {
  baseUrl: KILO_GATEWAY_BASE,
  // "$VAR" is pi's env-interpolation syntax; a bare "KILO_API_KEY" would be
  // treated as a literal key. When unset, this resolves to undefined and the
  // oauth flow / anonymous free-tier access take over.
  apiKey: "$KILO_API_KEY",
  api: "openai-completions" as const,
  headers: {
    "X-KILOCODE-EDITORNAME": "Pi",
    "User-Agent": "pi-kilo-provider",
  },
};

// =============================================================================
// Extension entry point
// =============================================================================

export default async function (pi: ExtensionAPI) {
  // Fallback catalog: free models, usable without authentication. The full
  // catalog is loaded via refreshModels once the user authenticates.
  let freeModels: ProviderModelConfig[] = [];
  // Last successfully fetched authenticated catalog, kept so a transient
  // refresh failure (or an offline pass) doesn't wipe paid models back to the
  // free list. Cleared on logout.
  let lastFullCatalog: ProviderModelConfig[] | null = null;
  try {
    freeModels = await fetchKiloModels({ freeOnly: true });
  } catch (error) {
    console.warn(
      "[kilo] Failed to fetch free models at startup:",
      error instanceof Error ? error.message : error,
    );
  }

  pi.registerProvider(KILO_PROVIDER_ID, {
    ...KILO_PROVIDER_CONFIG,
    models: freeModels,
    oauth: {
      name: "Kilo",
      login: loginKilo,
      refreshToken: refreshKiloToken,
      getApiKey: (cred: OAuthCredentials) => cred.access,
    },
    // Called by the framework on startup (network refresh) and after login /
    // logout. Resolves the bearer token from either credential kind so both
    // OAuth and KILO_API_KEY users receive the full catalog.
    refreshModels: async (context) => {
      const credential = context.credential;
      const token =
        credential?.type === "oauth"
          ? credential.access
          : credential?.type === "api_key"
            ? (credential.key ?? null)
            : null;

      // Logged out (no credential): revert to the public free catalog and drop
      // any cached authenticated list so it can't leak past logout.
      if (!token) {
        lastFullCatalog = null;
        return freeModels;
      }
      // Authenticated but offline / cancelled: serve the last good catalog if
      // we have one, else the free list.
      if (!context.allowNetwork || context.signal?.aborted) {
        return lastFullCatalog ?? freeModels;
      }
      try {
        const models = await fetchKiloModels({
          token,
          signal: context.signal,
        });
        lastFullCatalog = models;
        return models;
      } catch (error) {
        // Transient failure: keep the last authenticated catalog rather than
        // silently replacing it with the free list.
        console.warn(
          "[kilo] refreshModels fetch failed:",
          error instanceof Error ? error.message : error,
        );
        return lastFullCatalog ?? freeModels;
      }
    },
  });
}
