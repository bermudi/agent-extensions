// @ts-nocheck

// copy-with-model.ts
import { execSync, spawn } from "node:child_process";
import { platform } from "node:os";
function copyToClipboard(text) {
  const p = platform();
  try {
    if (p === "darwin") {
      execSync("pbcopy", { input: text, timeout: 5e3 });
      return;
    }
    if (p === "win32") {
      execSync("clip", { input: text, timeout: 5e3 });
      return;
    }
    if (process.env.WAYLAND_DISPLAY) {
      const proc = spawn("wl-copy", [], {
        stdio: ["pipe", "ignore", "ignore"]
      });
      proc.stdin.on("error", () => {
      });
      proc.stdin.write(text);
      proc.stdin.end();
      proc.unref();
      return;
    }
    if (process.env.DISPLAY) {
      try {
        execSync("xclip -selection clipboard", { input: text, timeout: 5e3 });
      } catch {
        execSync("xsel --clipboard --input", { input: text, timeout: 5e3 });
      }
      return;
    }
  } catch {
    const encoded = Buffer.from(text).toString("base64");
    if (encoded.length <= 1e5) {
      process.stdout.write(`\x1B]52;c;${encoded}\x07`);
      return;
    }
  }
  throw new Error("No clipboard available");
}
function getLastAssistantText(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || msg.role !== "assistant") continue;
    if (msg.stopReason === "aborted" && (!msg.content || msg.content.length === 0))
      continue;
    let text = "";
    for (const block of msg.content ?? []) {
      if (block.type === "text") text += block.text;
    }
    return text.trim() || void 0;
  }
  return void 0;
}
function modelTag(model) {
  return model.id;
}
function wrapInCodeBlock(tag, text) {
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
  const fenceLen = Math.max(3, maxRun + 1);
  const fence = "`".repeat(fenceLen);
  return `${fence}${tag}
${text}
${fence}`;
}
function copy_with_model_default(pi) {
  pi.registerCommand("copy-with-model", {
    description: "Copy last assistant message to clipboard in a code block tagged with the model name",
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
          "error"
        );
      }
    }
  });
}

// kilo.ts
var KILO_API_BASE = process.env.KILO_API_URL || "https://api.kilo.ai";
var KILO_GATEWAY_BASE = `${KILO_API_BASE}/api/gateway`;
var KILO_OPENROUTER_BASE = `${KILO_API_BASE}/api/openrouter`;
var KILO_DEVICE_AUTH_ENDPOINT = `${KILO_API_BASE}/api/device-auth/codes`;
var POLL_INTERVAL_MS = 3e3;
var MODELS_FETCH_TIMEOUT_MS = 1e4;
var MODELS_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1e3;
var LOGIN_REQUEST_TIMEOUT_MS = 15e3;
var TOKEN_EXPIRATION_MS = 365 * 24 * 60 * 60 * 1e3;
var KILO_PROVIDER_ID = "kilo";
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Login cancelled"));
    let timeout;
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
function loginAbortSignal(signal) {
  const timeout = AbortSignal.timeout(LOGIN_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}
async function initiateDeviceAuth(signal) {
  const response = await fetch(KILO_DEVICE_AUTH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: loginAbortSignal(signal)
  });
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error(
        "Too many pending authorization requests. Please try again later."
      );
    }
    throw new Error(
      `Failed to initiate device authorization: ${response.status}`
    );
  }
  return await response.json();
}
async function pollDeviceAuth(code, signal) {
  const response = await fetch(`${KILO_DEVICE_AUTH_ENDPOINT}/${code}`, {
    signal: loginAbortSignal(signal)
  });
  if (response.status === 202) return { status: "pending" };
  if (response.status === 403) return { status: "denied" };
  if (response.status === 410) return { status: "expired" };
  if (!response.ok) {
    throw new Error(`Failed to poll device authorization: ${response.status}`);
  }
  return await response.json();
}
async function loginKilo(callbacks) {
  callbacks.onProgress?.("Initiating device authorization...");
  const { code, verificationUrl, expiresIn } = await initiateDeviceAuth(
    callbacks.signal
  );
  callbacks.onAuth({
    url: verificationUrl,
    instructions: `Enter code: ${code}`
  });
  callbacks.onProgress?.("Waiting for browser authorization...");
  const deadline = Date.now() + expiresIn * 1e3;
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
        expires: Date.now() + TOKEN_EXPIRATION_MS
      };
    }
    if (result.status === "denied") {
      throw new Error("Authorization denied by user.");
    }
    if (result.status === "expired") {
      throw new Error("Authorization code expired. Please try again.");
    }
    const remaining = Math.ceil((deadline - Date.now()) / 1e3);
    callbacks.onProgress?.(
      `Waiting for browser authorization... (${remaining}s remaining)`
    );
  }
  throw new Error("Authentication timed out. Please try again.");
}
async function refreshKiloToken(credentials) {
  if (credentials.expires > Date.now()) return credentials;
  throw new Error(
    "Kilo token expired. Please run /login kilo to re-authenticate."
  );
}
function parsePrice(price) {
  if (!price) return 0;
  const parsed = parseFloat(price);
  if (isNaN(parsed)) return 0;
  return parsed * 1e6;
}
function isFreeModel(m) {
  const prompt = parseFloat(m.pricing?.prompt ?? "1");
  const completion = parseFloat(m.pricing?.completion ?? "1");
  if (prompt !== 0 || completion !== 0) return false;
  if (m.id === "kilo-auto/free") return true;
  if (m.id.includes(":free")) return true;
  if (!m.id.includes("/")) return true;
  if (m.id.startsWith("kilo/") || m.id.startsWith("openrouter/")) return true;
  return false;
}
function shouldUseResponsesApi(m) {
  if (m.opencode?.ai_sdk_provider === "openai") return true;
  const shortId = m.id.includes("/") ? m.id.split("/").pop() ?? m.id : m.id;
  const s = shortId.toLowerCase();
  return s === "gpt-5" || s.startsWith("gpt-5.") || s.startsWith("gpt-5-") || s.startsWith("o1") || s.startsWith("o3") || s.startsWith("o4");
}
function getKiloModelCompat(m, api) {
  if (api === "openai-responses") {
    return {
      sessionAffinityFormat: "openai-nosession",
      supportsLongCacheRetention: false
    };
  }
  return {
    thinkingFormat: "openrouter",
    supportsStore: false,
    ...m.id.startsWith("anthropic/") ? { cacheControlFormat: "anthropic" } : {},
    ...m.id === "deepseek/deepseek-v4-flash" || m.id === "deepseek/deepseek-v4-pro" ? { requiresReasoningContentOnAssistantMessages: true } : {}
  };
}
var PI_THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
];
function mapVariantEffort(variants, key) {
  const variant = variants?.[key];
  if (!variant) return void 0;
  const reasoning = variant.reasoning;
  if (!reasoning) return key;
  if (reasoning.enabled === false || reasoning.effort === "none") return "none";
  return reasoning.effort ?? key;
}
function thinkingLevelMapFromVariants(variants) {
  if (!variants || Object.keys(variants).length === 0) return void 0;
  const map = {};
  const off = mapVariantEffort(variants, "none") ?? mapVariantEffort(variants, "instant");
  if (off !== void 0) map.off = off;
  for (const level of PI_THINKING_LEVELS) {
    const effort = mapVariantEffort(variants, level);
    map[level] = effort === void 0 ? null : effort;
  }
  for (const variantName of Object.keys(variants)) {
    const effort = mapVariantEffort(variants, variantName);
    if (!effort || !PI_THINKING_LEVELS.includes(
      effort
    )) {
      continue;
    }
    const level = effort;
    if (map[level] === null) map[level] = effort;
  }
  return map;
}
function getKiloThinkingLevelMap(m) {
  const fromVariants = thinkingLevelMapFromVariants(m.opencode?.variants);
  if (fromVariants) return fromVariants;
  if (m.id === "deepseek/deepseek-v4-pro") {
    return {
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: "max"
    };
  }
  if (m.id.includes("gpt-5.5")) {
    return {
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh"
    };
  }
  return void 0;
}
function modelSupportsReasoning(m) {
  if (m.supported_parameters?.includes("reasoning")) return true;
  return Object.values(m.opencode?.variants ?? {}).some(
    (variant) => variant.reasoning?.enabled === true && variant.reasoning.effort !== "none"
  );
}
function mapOpenRouterModel(m) {
  const inputModalities = m.architecture?.input_modalities ?? ["text"];
  const supportsImages = inputModalities.includes("image");
  const supportsReasoning = modelSupportsReasoning(m);
  const maxTokens = m.top_provider?.max_completion_tokens ?? m.max_completion_tokens ?? Math.ceil(m.context_length * 0.2);
  const api = shouldUseResponsesApi(m) ? "openai-responses" : void 0;
  return {
    id: m.id,
    name: m.name,
    ...api ? { api, baseUrl: KILO_OPENROUTER_BASE } : {},
    reasoning: supportsReasoning,
    input: supportsImages ? ["text", "image"] : ["text"],
    cost: {
      input: parsePrice(m.pricing?.prompt),
      output: parsePrice(m.pricing?.completion),
      cacheRead: parsePrice(m.pricing?.input_cache_read),
      cacheWrite: parsePrice(m.pricing?.input_cache_write)
    },
    contextWindow: m.context_length,
    maxTokens,
    thinkingLevelMap: getKiloThinkingLevelMap(m),
    compat: getKiloModelCompat(m, api)
  };
}
var KILO_FREE_MODELS = [
  mapOpenRouterModel({
    id: "kilo-auto/free",
    name: "Auto Free",
    context_length: 256e3,
    top_provider: { max_completion_tokens: 1e4 },
    pricing: {
      prompt: "0",
      completion: "0",
      input_cache_read: "0",
      input_cache_write: "0"
    },
    architecture: {
      input_modalities: ["text"],
      output_modalities: ["text"]
    },
    supported_parameters: ["reasoning"]
  })
];
function modelConfigToStoredModel(model) {
  return {
    ...model,
    provider: KILO_PROVIDER_ID,
    api: model.api ?? "openai-completions",
    baseUrl: model.baseUrl ?? KILO_GATEWAY_BASE
  };
}
function storedModelToConfig(model) {
  if (model.provider !== KILO_PROVIDER_ID) return null;
  return {
    id: model.id,
    name: model.name,
    ...model.api !== "openai-completions" ? { api: model.api } : {},
    ...model.baseUrl !== KILO_GATEWAY_BASE ? { baseUrl: model.baseUrl } : {},
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: model.compat
  };
}
function modelsAbortSignal(signal) {
  const timeout = AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}
async function fetchKiloModels(options) {
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "pi-kilo-provider"
  };
  if (options?.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${KILO_GATEWAY_BASE}/models`, {
    headers,
    signal: modelsAbortSignal(options?.signal)
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch models: ${response.status} ${response.statusText}`
    );
  }
  const json = await response.json();
  if (!json.data || !Array.isArray(json.data)) {
    throw new Error("Invalid models response: missing data array");
  }
  return json.data.filter((m) => {
    const outputMods = m.architecture?.output_modalities ?? [];
    if (outputMods.includes("image")) return false;
    if (options?.freeOnly && !isFreeModel(m)) return false;
    return true;
  }).map(mapOpenRouterModel);
}
var KILO_PROVIDER_CONFIG = {
  baseUrl: KILO_GATEWAY_BASE,
  // "$VAR" is pi's env-interpolation syntax; a bare "KILO_API_KEY" would be
  // treated as a literal key. When unset, this resolves to undefined and the
  // oauth flow / anonymous free-tier access take over.
  apiKey: "$KILO_API_KEY",
  api: "openai-completions",
  headers: {
    "X-KILOCODE-EDITORNAME": "Pi",
    "User-Agent": "pi-kilo-provider"
  }
};
function kilo(pi) {
  let lastFullCatalog = null;
  let lastFullCatalogCheckedAt = 0;
  let refreshInFlight;
  pi.registerProvider(KILO_PROVIDER_ID, {
    ...KILO_PROVIDER_CONFIG,
    models: KILO_FREE_MODELS,
    oauth: {
      name: "Kilo",
      login: loginKilo,
      refreshToken: refreshKiloToken,
      getApiKey: (cred) => cred.access
    },
    // Called by the framework during cache-only startup, background startup
    // refresh, model-picker refreshes, and login. Ordinary picker opens honor a
    // four-hour freshness window; explicit forced refreshes bypass it.
    refreshModels: async (context) => {
      const credential = context.credential;
      const token = credential?.type === "oauth" ? credential.access : credential?.type === "api_key" ? credential.key ?? null : null;
      if (!token) return KILO_FREE_MODELS;
      if (!lastFullCatalog) {
        try {
          const stored = await context.store.read();
          const restored = (stored?.models ?? []).flatMap((model) => {
            const config = storedModelToConfig(model);
            return config ? [config] : [];
          });
          if (restored.length > 0) {
            lastFullCatalog = restored;
            lastFullCatalogCheckedAt = stored?.checkedAt ?? 0;
          }
        } catch (error) {
          console.warn(
            "[kilo] Failed to restore cached models:",
            error instanceof Error ? error.message : error
          );
        }
      }
      const fallback = lastFullCatalog ?? KILO_FREE_MODELS;
      if (!context.allowNetwork || context.signal?.aborted) return fallback;
      if (!context.force && lastFullCatalog && Date.now() - lastFullCatalogCheckedAt < MODELS_REFRESH_INTERVAL_MS) {
        return lastFullCatalog;
      }
      refreshInFlight ??= (async () => {
        try {
          const models = await fetchKiloModels({
            token,
            signal: context.signal
          });
          const checkedAt = Date.now();
          lastFullCatalog = models;
          lastFullCatalogCheckedAt = checkedAt;
          try {
            await context.store.write({
              models: models.map(modelConfigToStoredModel),
              checkedAt
            });
          } catch (error) {
            console.warn(
              "[kilo] Failed to persist refreshed models:",
              error instanceof Error ? error.message : error
            );
          }
          return models;
        } catch (error) {
          console.warn(
            "[kilo] refreshModels fetch failed:",
            error instanceof Error ? error.message : error
          );
          return lastFullCatalog ?? KILO_FREE_MODELS;
        } finally {
          refreshInFlight = void 0;
        }
      })();
      return refreshInFlight;
    }
  });
}

// provider-balance.ts
import { FooterComponent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
var KILO_API_BASE2 = process.env.KILO_API_URL || "https://api.kilo.ai";
var KILO_BALANCE_ENDPOINT = `${KILO_API_BASE2}/api/profile/balance`;
var OPENROUTER_CREDITS_ENDPOINT = "https://openrouter.ai/api/v1/credits";
var ZAI_QUOTA_ENDPOINT = "https://api.z.ai/api/monitor/usage/quota/limit";
var ZAI_CODING_CN_QUOTA_ENDPOINT = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
var CODEX_API_BASE = (process.env.CODEX_API_URL || process.env.CHATGPT_BASE_URL || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
var CODEX_USAGE_ENDPOINT = `${CODEX_API_BASE}/wham/usage`;
var CODEX_AUTH_CLAIM = "https://api.openai.com/auth";
var BALANCE_FETCH_TIMEOUT_MS = 5e3;
function asRecord(value) {
  return typeof value === "object" && value !== null ? value : null;
}
function objectProperty(value, key) {
  const record = asRecord(value);
  if (!record) return null;
  return asRecord(record[key]);
}
function numericProperty(value, key) {
  const record = asRecord(value);
  if (!record) return null;
  const candidate = record[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}
function stringProperty(value, key) {
  const record = asRecord(value);
  if (!record) return null;
  const candidate = record[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}
function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - base64.length % 4) % 4);
  const binary = atob(base64 + padding);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function parseCodexAccountId(token) {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = asRecord(JSON.parse(decodeBase64Url(parts[1])));
    const auth = payload ? asRecord(payload[CODEX_AUTH_CLAIM]) : null;
    const accountId = auth?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.trim() ? accountId.trim() : null;
  } catch {
    return null;
  }
}
function parseCodexQuotaWindow(value) {
  const usedPercent = numericProperty(value, "used_percent");
  const windowSeconds = numericProperty(value, "limit_window_seconds");
  if (usedPercent === null || windowSeconds === null || windowSeconds <= 0) {
    return null;
  }
  return { usedPercent, windowSeconds };
}
function parseCodexQuotaWindows(value) {
  const rateLimit = asRecord(value);
  if (!rateLimit) return null;
  const primary = parseCodexQuotaWindow(rateLimit.primary_window);
  const secondary = parseCodexQuotaWindow(rateLimit.secondary_window);
  return primary || secondary ? { primary, secondary } : null;
}
function parseCodexQuota(value) {
  const payload = asRecord(value);
  if (!payload) return null;
  const base = parseCodexQuotaWindows(payload.rate_limit);
  const additional = Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits.flatMap((candidate) => {
    const name = stringProperty(candidate, "limit_name");
    const windows = parseCodexQuotaWindows(
      objectProperty(candidate, "rate_limit")
    );
    return name && windows ? [{ name, ...windows }] : [];
  }) : [];
  if (!base && additional.length === 0) return null;
  return {
    primary: base?.primary ?? null,
    secondary: base?.secondary ?? null,
    additional
  };
}
function formatWindowDuration(windowSeconds) {
  const minutes = Math.max(1, Math.round(windowSeconds / 60));
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}
function formatCodexQuotaWindow(window) {
  const usedPercent = Math.min(100, Math.max(0, window.usedPercent));
  const remainingPercent = Math.round(100 - usedPercent);
  return `${formatWindowDuration(window.windowSeconds)} ${remainingPercent}% left`;
}
function compactCodexQuotaName(name) {
  return /codex-spark$/i.test(name) ? "Spark" : name;
}
function formatCodexQuota(quota) {
  const parts = [quota.primary, quota.secondary].filter((window) => window !== null).map(formatCodexQuotaWindow);
  for (const additional of quota.additional) {
    const name = compactCodexQuotaName(additional.name);
    for (const window of [additional.primary, additional.secondary]) {
      if (window) parts.push(`${name} ${formatCodexQuotaWindow(window)}`);
    }
  }
  return parts.join(" \xB7 ");
}
function parseZaiWindowSeconds(unit, number) {
  if (!Number.isInteger(number) || number <= 0) return null;
  const secondsPerUnit = {
    1: 24 * 60 * 60,
    // days
    3: 60 * 60,
    // hours
    5: 60,
    // minutes
    6: 7 * 24 * 60 * 60
    // weeks
  };
  const multiplier = secondsPerUnit[unit];
  return multiplier ? number * multiplier : null;
}
function parseZaiUsedPercent(value) {
  const percentage = numericProperty(value, "percentage");
  if (percentage !== null) return percentage;
  const limit = numericProperty(value, "usage");
  if (limit === null || limit <= 0) return null;
  const remaining = numericProperty(value, "remaining");
  const currentValue = numericProperty(value, "currentValue");
  const used = remaining !== null ? Math.max(limit - remaining, currentValue ?? 0) : currentValue;
  return used === null ? null : used / limit * 100;
}
function parseZaiQuota(value) {
  const payload = asRecord(value);
  if (!payload || payload.success !== true || numericProperty(payload, "code") !== 200) {
    return null;
  }
  const data = asRecord(payload.data);
  const limits = data?.limits;
  if (!Array.isArray(limits)) return null;
  const tokenWindows = limits.flatMap((candidate) => {
    if (stringProperty(candidate, "type") !== "TOKENS_LIMIT") return [];
    const unit = numericProperty(candidate, "unit");
    const number = numericProperty(candidate, "number");
    const usedPercent = parseZaiUsedPercent(candidate);
    if (unit === null || number === null || usedPercent === null) return [];
    const windowSeconds = parseZaiWindowSeconds(unit, number);
    return windowSeconds === null ? [] : [{ usedPercent, windowSeconds }];
  });
  if (tokenWindows.length === 0) return null;
  tokenWindows.sort((a, b) => a.windowSeconds - b.windowSeconds);
  const planName = stringProperty(data, "planName") ?? stringProperty(data, "plan") ?? stringProperty(data, "plan_type") ?? stringProperty(data, "packageName") ?? null;
  return { planName, tokenWindows };
}
function formatZaiQuota(quota) {
  return [...quota.tokenWindows].sort((a, b) => a.windowSeconds - b.windowSeconds).map(formatCodexQuotaWindow).join(" \xB7 ");
}
function formatCredits(balance) {
  if (balance >= 1e3) return `$${(balance / 1e3).toFixed(1)}k`;
  return `$${balance.toFixed(2)}`;
}
function parseKiloBalance(value) {
  return numericProperty(value, "balance");
}
function parseOpenRouterCredits(value) {
  const data = objectProperty(value, "data");
  const totalCredits = numericProperty(data, "total_credits");
  const totalUsage = numericProperty(data, "total_usage");
  if (totalCredits === null || totalUsage === null || totalCredits < 0 || totalUsage < 0) {
    return null;
  }
  return Math.max(0, totalCredits - totalUsage);
}
async function fetchKiloBalance(token, signal) {
  const timeout = AbortSignal.timeout(BALANCE_FETCH_TIMEOUT_MS);
  const response = await fetch(KILO_BALANCE_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    signal: AbortSignal.any([timeout, signal])
  });
  if (!response.ok) {
    throw new Error(`Kilo balance request failed: ${response.status}`);
  }
  const balance = parseKiloBalance(await response.json());
  if (balance === null) {
    throw new Error("Kilo balance response was invalid");
  }
  return formatCredits(balance);
}
async function fetchOpenRouterBalance(token, signal) {
  const timeout = AbortSignal.timeout(BALANCE_FETCH_TIMEOUT_MS);
  const response = await fetch(OPENROUTER_CREDITS_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    },
    signal: AbortSignal.any([timeout, signal])
  });
  if (!response.ok) {
    throw new Error(`OpenRouter balance request failed: ${response.status}`);
  }
  const balance = parseOpenRouterCredits(await response.json());
  if (balance === null) {
    throw new Error("OpenRouter balance response was invalid");
  }
  return formatCredits(balance);
}
async function fetchZaiQuotaAt(endpoint, token, signal) {
  const timeout = AbortSignal.timeout(BALANCE_FETCH_TIMEOUT_MS);
  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    },
    signal: AbortSignal.any([timeout, signal])
  });
  if (!response.ok) {
    throw new Error(`Z.ai quota request failed: ${response.status}`);
  }
  const quota = parseZaiQuota(await response.json());
  if (quota === null) {
    throw new Error("Z.ai quota response was invalid");
  }
  return formatZaiQuota(quota);
}
async function fetchZaiQuota(token, signal) {
  return fetchZaiQuotaAt(ZAI_QUOTA_ENDPOINT, token, signal);
}
async function fetchZaiCodingCnQuota(token, signal) {
  return fetchZaiQuotaAt(ZAI_CODING_CN_QUOTA_ENDPOINT, token, signal);
}
async function fetchCodexQuota(token, signal) {
  const accountId = parseCodexAccountId(token);
  if (!accountId) {
    throw new Error("Codex access token did not contain an account ID");
  }
  const timeout = AbortSignal.timeout(BALANCE_FETCH_TIMEOUT_MS);
  const response = await fetch(CODEX_USAGE_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "pi",
      originator: "pi",
      "chatgpt-account-id": accountId
    },
    signal: AbortSignal.any([timeout, signal])
  });
  if (!response.ok) {
    throw new Error(`Codex quota request failed: ${response.status}`);
  }
  const quota = parseCodexQuota(await response.json());
  if (quota === null) {
    throw new Error("Codex quota response was invalid");
  }
  return formatCodexQuota(quota);
}
var BALANCE_ADAPTERS = {
  kilo: { fetch: fetchKiloBalance },
  openrouter: { fetch: fetchOpenRouterBalance },
  zai: { fetch: fetchZaiQuota },
  "zai-coding-cn": { fetch: fetchZaiCodingCnQuota },
  "openai-codex": { fetch: fetchCodexQuota, requiresOAuth: true }
};
var THINKING_LEVELS = /* @__PURE__ */ new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);
function normalizeThinkingLevel(value) {
  return value === "off" || THINKING_LEVELS.has(value) ? value : "off";
}
function restoredThinkingLevel(ctx) {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === "thinking_level_change") {
      return normalizeThinkingLevel(entry.thinkingLevel);
    }
  }
  return "off";
}
function createFooterSession(getContext, getThinkingLevel) {
  const facade = {
    get state() {
      const ctx = getContext();
      return {
        model: ctx.model,
        thinkingLevel: getThinkingLevel()
      };
    },
    get sessionManager() {
      return getContext().sessionManager;
    },
    modelRuntime: {
      isUsingOAuth(provider) {
        const model = getContext().model;
        return model?.provider === provider && model !== void 0 ? getContext().modelRegistry.isUsingOAuth(model) : false;
      }
    },
    getContextUsage() {
      return getContext().getContextUsage();
    }
  };
  return facade;
}
function addBalanceToWorkingDirectoryLine(lines, width, theme, balanceText) {
  if (!balanceText || width <= 0) return lines;
  const right = theme.fg("dim", balanceText);
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) {
    return [truncateToWidth(right, width, ""), ...lines.slice(1)];
  }
  const leftLine = lines[0] ?? "";
  const maxLeftWidth = Math.max(0, width - rightWidth - 2);
  const left = truncateToWidth(leftLine, maxLeftWidth, "...");
  const padding = " ".repeat(
    Math.max(1, width - visibleWidth(left) - rightWidth)
  );
  return [`${left}${padding}${right}`, ...lines.slice(1)];
}
function providerBalance(pi) {
  let activeContext;
  let balanceText;
  let refreshGeneration = 0;
  let refreshController;
  let requestRender;
  let activeThinkingLevel = "off";
  function clearBalance() {
    balanceText = void 0;
    requestRender?.();
  }
  function refreshForModel(ctx, model) {
    return refreshBalance(ctx, model?.provider, model);
  }
  async function refreshBalance(ctx, provider, model) {
    const generation = ++refreshGeneration;
    refreshController?.abort();
    const controller = new AbortController();
    refreshController = controller;
    clearBalance();
    const providerId = provider;
    const adapter = providerId ? BALANCE_ADAPTERS[providerId] : void 0;
    if (!adapter || !providerId) return;
    if (adapter.requiresOAuth && (!model || model.provider !== providerId || !ctx.modelRegistry.isUsingOAuth(model))) {
      return;
    }
    try {
      const token = await ctx.modelRegistry.getApiKeyForProvider(providerId);
      if (!token || generation !== refreshGeneration) return;
      balanceText = await adapter.fetch(token, controller.signal);
      if (generation === refreshGeneration) requestRender?.();
    } catch (error) {
      if (generation !== refreshGeneration || controller.signal.aborted) return;
      console.warn(
        `[provider-balance] Failed to refresh ${providerId} balance:`,
        error instanceof Error ? error.message : error
      );
    } finally {
      if (generation === refreshGeneration) refreshController = void 0;
    }
  }
  function installFooter(ctx) {
    if (ctx.mode !== "tui") return;
    activeContext = ctx;
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();
      const footer = new FooterComponent(
        createFooterSession(
          () => {
            if (!activeContext) {
              throw new Error("Provider balance footer is inactive");
            }
            return activeContext;
          },
          () => activeThinkingLevel
        ),
        footerData
      );
      const unsubscribeBranchChange = footerData.onBranchChange(
        () => tui.requestRender()
      );
      return {
        invalidate: () => footer.invalidate(),
        render: (width) => addBalanceToWorkingDirectoryLine(
          footer.render(width),
          width,
          theme,
          balanceText
        ),
        dispose: () => {
          unsubscribeBranchChange();
          footer.dispose();
          requestRender = void 0;
        }
      };
    });
  }
  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    activeThinkingLevel = restoredThinkingLevel(ctx);
    installFooter(ctx);
    void refreshForModel(ctx, ctx.model);
  });
  pi.on("model_select", (event, ctx) => {
    activeContext = ctx;
    void refreshForModel(ctx, event.model ?? ctx.model);
  });
  pi.on("agent_settled", (_event, ctx) => {
    activeContext = ctx;
    void refreshForModel(ctx, ctx.model);
  });
  pi.on("thinking_level_select", (event) => {
    activeThinkingLevel = event.level;
    requestRender?.();
  });
  pi.on("session_shutdown", () => {
    refreshController?.abort();
    refreshController = void 0;
    activeContext = void 0;
    activeThinkingLevel = "off";
    requestRender = void 0;
  });
}

// name-with-ai.ts
import { Agent } from "@earendil-works/pi-agent-core";
import {
  streamSimple
} from "@earendil-works/pi-ai/compat";
import {
  convertToLlm
} from "@earendil-works/pi-coding-agent";
var NAMING_PROMPT = [
  "You are a session naming engine. Given a user's message, produce a short, descriptive session name.",
  "",
  "Rules:",
  "- Maximum 60 characters.",
  "- No quotes, no markdown, no punctuation at the end.",
  '- Use imperative or noun-phrase style (e.g. "Refactor auth middleware", "Fix CSS grid layout").',
  '- Be specific, not generic. "Add retry logic to fetch helper" > "Code changes".',
  "- Output ONLY the name. Nothing else."
].join("\n");
function extractLastAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      const parts = [];
      for (const block of msg.content) {
        if (typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block)
          parts.push(block.text ?? "");
      }
      return parts.join("\n").trim();
    }
  }
  return "";
}
function extractText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter(
      (b) => typeof b === "object" && b !== null
    ).map((b) => b.type === "text" ? b.text ?? "" : "").filter(Boolean).join("\n");
  }
  return "";
}
function sanitizeName(raw) {
  return raw.replace(/^["'`]+|["'`]+$/g, "").replace(/^\*+|\*+$/g, "").replace(/^#+\s*/, "").replace(/[.!?:;]+$/, "").replace(/\n/g, " ").trim().slice(0, 60);
}
function nameWithAiExtension(pi) {
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
        ctx.ui.notify("No model selected \u2014 switch to a model first", "warning");
        return;
      }
      const branch = ctx.sessionManager.getBranch();
      const firstUser = branch.find(
        (e) => e.type === "message" && e.message?.role === "user"
      );
      if (!firstUser || firstUser.type !== "message") {
        ctx.ui.notify("Nothing to name yet \u2014 send a message first", "warning");
        return;
      }
      const msgContent = firstUser.message.content;
      const prompt = extractText(msgContent);
      if (!prompt) {
        ctx.ui.notify(
          "First message is empty \u2014 can't generate a name",
          "warning"
        );
        return;
      }
      const snippet = prompt.length > 1e3 ? prompt.slice(0, 997) + "\u2026" : prompt;
      ctx.ui.setStatus("name-with-ai", "Generating name\u2026");
      const abortController = new AbortController();
      const onCtxAbort = () => abortController.abort();
      if (ctx.signal)
        ctx.signal.addEventListener("abort", onCtxAbort, { once: true });
      try {
        const model = ctx.model;
        const agent = new Agent({
          initialState: {
            systemPrompt: NAMING_PROMPT,
            model,
            thinkingLevel: "off",
            messages: []
          },
          convertToLlm,
          streamFn: async (m, context, options) => {
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
            if (!auth.ok)
              throw new Error(
                `Auth failed: ${auth.error}`
              );
            return streamSimple(m, context, {
              ...options,
              apiKey: auth.apiKey,
              headers: auth.headers ?? void 0
            });
          }
        });
        if (abortController.signal.aborted) return;
        const abortHandler = () => {
          try {
            agent.abort();
          } catch {
          }
        };
        abortController.signal.addEventListener("abort", abortHandler, {
          once: true
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
            "AI returned an empty name \u2014 try /name-with-ai <name>",
            "warning"
          );
        }
        abortController.signal.removeEventListener("abort", abortHandler);
      } catch (err) {
        ctx.ui.notify(
          `Naming failed: ${err instanceof Error ? err.message : String(err)}`,
          "error"
        );
      } finally {
        if (ctx.signal) ctx.signal.removeEventListener("abort", onCtxAbort);
        ctx.ui.setStatus("name-with-ai", void 0);
      }
    }
  });
}

// zed.ts
import { spawn as spawn2 } from "node:child_process";
function zed_default(pi) {
  const zedBin = process.platform === "linux" ? "zeditor" : "zed";
  pi.registerCommand("z", {
    description: "Open Zed editor on cwd (new window)",
    handler: async (_args, ctx) => {
      const child = spawn2(zedBin, ["--new", ctx.cwd], {
        detached: true,
        stdio: "ignore"
      });
      child.unref();
      ctx.ui.notify(`Opening Zed: ${ctx.cwd}`, "info");
    }
  });
}

// prefer-tools.ts
import {
  isToolCallEventType
} from "@earendil-works/pi-coding-agent";
var RULES = [
  {
    names: ["rm"],
    reason: "rm is blocked \u2014 use `trash` instead (recoverable beats gone)"
  },
  {
    names: ["python", "python3", "pip", "pip3", "pytest", "mypy"],
    reason: "bare python/pip/pytest/mypy are blocked \u2014 use `uv` (e.g. `uv run python`, `uv add`, `uv pip install <pkg>`, `uv run pytest`/`mypy`)"
  }
];
var COMMAND_PREFIX_KEYWORDS = /* @__PURE__ */ new Set([
  "if",
  "while",
  "until",
  "then",
  "else",
  "elif",
  "do",
  "time",
  "!"
]);
var WORD_STOP = " 	\n\r|&;<>()\"'`$";
function matchCommand(name) {
  const base = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  for (const rule of RULES) {
    if (rule.names.includes(base)) return rule.reason;
  }
  return void 0;
}
function readWord(s, i) {
  const start = i;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "	" || c === "\n" || c === "\r") break;
    if (c === "\\" && i + 1 < s.length) {
      i += 2;
      continue;
    }
    if (WORD_STOP.includes(c)) break;
    i++;
  }
  return { word: s.slice(start, i), next: i };
}
function readQuote(s, i, quote, escape) {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (escape && c === "\\" && j + 1 < s.length) {
      j += 2;
      continue;
    }
    if (c === quote) {
      j++;
      break;
    }
    j++;
  }
  return j;
}
function skipBalancedParens(s, i, openLen) {
  let depth = openLen === 3 ? 2 : 1;
  let j = i + openLen;
  while (j < s.length) {
    const c = s[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "'") {
      j = readQuote(s, j, "'", false);
      continue;
    }
    if (c === '"') {
      j = readQuote(s, j, '"', true);
      continue;
    }
    if (c === "`") {
      j = readQuote(s, j, "`", true);
      continue;
    }
    if (c === "$" && s.startsWith("$(", j)) {
      j++;
      continue;
    }
    if (c === "(") {
      depth++;
      j++;
      continue;
    }
    if (c === ")") {
      depth--;
      if (depth === 0) return j + 1;
      j++;
      continue;
    }
    j++;
  }
  return s.length;
}
function skipBalancedBraces(s, i) {
  let depth = 1;
  let j = i + 2;
  while (j < s.length) {
    const c = s[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "'") {
      j = readQuote(s, j, "'", false);
      continue;
    }
    if (c === '"') {
      j = readQuote(s, j, '"', true);
      continue;
    }
    if (c === "`") {
      j = readQuote(s, j, "`", true);
      continue;
    }
    if (c === "$" && s.startsWith("$(", j)) {
      j++;
      continue;
    }
    if (c === "{") {
      depth++;
      j++;
      continue;
    }
    if (c === "}") {
      depth--;
      if (depth === 0) return j + 1;
      j++;
      continue;
    }
    j++;
  }
  return s.length;
}
function readDollar(s, i) {
  if (i >= s.length || s[i] !== "$") return null;
  if (s.startsWith("$'", i)) {
    return { next: readQuote(s, i + 1, "'", true) };
  }
  if (s.startsWith("((", i + 1)) {
    return { next: skipBalancedParens(s, i, 3) };
  }
  if (s.startsWith("(", i + 1)) {
    const end = skipBalancedParens(s, i, 2);
    const closeParen = end > 0 && s[end - 1] === ")" ? 1 : 0;
    const inner = s.slice(i + 2, end - closeParen);
    const reason = detectLegacyTool(inner);
    return { next: end, reason };
  }
  if (s.startsWith("{", i + 1)) {
    return { next: skipBalancedBraces(s, i) };
  }
  if (i + 1 < s.length && /[0-9?@*#\-!$]/.test(s[i + 1])) {
    return { next: i + 2 };
  }
  let j = i + 1;
  while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
  return { next: j };
}
function readOperator(s, i) {
  const c = s[i];
  if (c === "<") {
    if (s.startsWith("<<-", i))
      return { type: "heredoc", next: i + 3, indented: true };
    if (s.startsWith("<<<", i)) return { type: "redirect", next: i + 3 };
    if (s.startsWith("<<", i))
      return { type: "heredoc", next: i + 2, indented: false };
    if (s.startsWith("<>", i) || s.startsWith("<&", i))
      return { type: "redirect", next: i + 2 };
    return { type: "redirect", next: i + 1 };
  }
  if (c === ">") {
    if (s.startsWith(">>", i)) return { type: "redirect", next: i + 2 };
    if (s.startsWith(">&", i)) return { type: "redirect", next: i + 2 };
    return { type: "redirect", next: i + 1 };
  }
  if (c === "&") {
    if (s.startsWith("&>>", i)) return { type: "redirect", next: i + 3 };
    if (s.startsWith("&&", i)) return { type: "separator", next: i + 2 };
    if (s.startsWith("&>", i)) return { type: "redirect", next: i + 2 };
    return { type: "separator", next: i + 1 };
  }
  if (c === "|") {
    if (s.startsWith("||", i)) return { type: "separator", next: i + 2 };
    if (s.startsWith("|&", i)) return { type: "separator", next: i + 2 };
    return { type: "separator", next: i + 1 };
  }
  if (c === ";") {
    if (s.startsWith(";;", i)) return { type: "separator", next: i + 2 };
    if (s.startsWith(";&", i)) return { type: "separator", next: i + 2 };
    return { type: "separator", next: i + 1 };
  }
  if (c === "(" || c === ")") return { type: "separator", next: i + 1 };
  return null;
}
function readHeredocDelimiter(s, i) {
  while (i < s.length && (s[i] === " " || s[i] === "	")) i++;
  if (i >= s.length) return null;
  const c = s[i];
  if (c === "'" || c === '"') {
    const end = readQuote(s, i, c, c === '"');
    return { delimiter: s.slice(i + 1, end - 1), next: end };
  }
  const { word, next } = readWord(s, i);
  if (word.length === 0) return null;
  return { delimiter: word, next };
}
function skipHeredocBody(s, i, delimiter, indented) {
  let pos = i;
  while (pos <= s.length) {
    const nl = s.indexOf("\n", pos);
    const end = nl === -1 ? s.length : nl;
    let line = s.slice(pos, end);
    if (indented) line = line.replace(/^\t+/, "");
    if (line === delimiter) {
      return nl === -1 ? s.length : nl + 1;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return s.length;
}
function detectLegacyTool(command) {
  let i = 0;
  let commandPos = true;
  let sudoNext = false;
  let redirectTarget = false;
  let heredoc = null;
  while (i < command.length) {
    if (heredoc && !heredoc.pending) {
      i = skipHeredocBody(command, i, heredoc.delimiter, heredoc.indented);
      heredoc = null;
      commandPos = true;
      redirectTarget = false;
      sudoNext = false;
      continue;
    }
    const c = command[i];
    if (c === " " || c === "	" || c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      if (heredoc?.pending) {
        heredoc.pending = false;
      } else {
        commandPos = true;
      }
      redirectTarget = false;
      sudoNext = false;
      i++;
      continue;
    }
    if (c === "#") {
      const nl = command.indexOf("\n", i);
      if (nl === -1) break;
      if (heredoc?.pending) heredoc.pending = false;
      i = nl + 1;
      commandPos = true;
      redirectTarget = false;
      sudoNext = false;
      continue;
    }
    const op = readOperator(command, i);
    if (op) {
      i = op.next;
      if (op.type === "separator") {
        commandPos = true;
        redirectTarget = false;
        sudoNext = false;
      } else if (op.type === "redirect") {
        redirectTarget = true;
        sudoNext = false;
      } else if (op.type === "heredoc") {
        const delim = readHeredocDelimiter(command, i);
        if (!delim) break;
        heredoc = {
          delimiter: delim.delimiter,
          indented: op.indented,
          pending: true
        };
        i = delim.next;
        commandPos = false;
        redirectTarget = false;
        sudoNext = false;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i = readQuote(command, i, quote, quote !== "'");
      if (redirectTarget) redirectTarget = false;
      if (sudoNext) sudoNext = false;
      if (commandPos) commandPos = false;
      continue;
    }
    if (c === "$") {
      const d = readDollar(command, i);
      if (d) {
        if (d.reason) return d.reason;
        i = d.next;
        if (redirectTarget) redirectTarget = false;
        if (sudoNext) sudoNext = false;
        if (commandPos) commandPos = false;
      } else {
        i++;
      }
      continue;
    }
    const { word, next } = readWord(command, i);
    if (word.length === 0) {
      i = next;
      continue;
    }
    i = next;
    if (redirectTarget) {
      redirectTarget = false;
      commandPos = false;
      continue;
    }
    if (commandPos) {
      if (word === "sudo") {
        sudoNext = true;
        continue;
      }
      if (sudoNext) {
        if (word.startsWith("-")) continue;
        const reason = matchCommand(word);
        if (reason) return reason;
        sudoNext = false;
      } else {
        const reason = matchCommand(word);
        if (reason) return reason;
      }
      if (!COMMAND_PREFIX_KEYWORDS.has(word)) {
        commandPos = false;
      }
    } else {
      commandPos = false;
    }
  }
  return void 0;
}
function preferTools(pi) {
  pi.on("tool_call", async (event) => {
    if (!isToolCallEventType("bash", event)) return;
    const reason = detectLegacyTool(event.input.command ?? "");
    if (reason) {
      return { block: true, reason };
    }
  });
}

// index.ts
function bermudisPiGoodies(pi) {
  copy_with_model_default(pi);
  nameWithAiExtension(pi);
  zed_default(pi);
  preferTools(pi);
  providerBalance(pi);
  kilo(pi);
}
export {
  bermudisPiGoodies as default
};
