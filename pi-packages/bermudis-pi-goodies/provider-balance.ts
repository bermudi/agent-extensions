import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { FooterComponent } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const KILO_API_BASE = process.env.KILO_API_URL || "https://api.kilo.ai";
const KILO_BALANCE_ENDPOINT = `${KILO_API_BASE}/api/profile/balance`;
const OPENROUTER_CREDITS_ENDPOINT = "https://openrouter.ai/api/v1/credits";
const ZAI_QUOTA_ENDPOINT = "https://api.z.ai/api/monitor/usage/quota/limit";
const ZAI_CODING_CN_QUOTA_ENDPOINT =
  "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
const CODEX_API_BASE = (
  process.env.CODEX_API_URL ||
  process.env.CHATGPT_BASE_URL ||
  "https://chatgpt.com/backend-api"
).replace(/\/+$/, "");
const CODEX_USAGE_ENDPOINT = `${CODEX_API_BASE}/wham/usage`;
const CODEX_AUTH_CLAIM = "https://api.openai.com/auth";
const BALANCE_FETCH_TIMEOUT_MS = 5_000;
/** Refresh the footer balance every Nth turn end during a run. See turn_end handler. */
const REFRESH_EVERY_N_TURNS = 5;

interface BalanceAdapter {
  fetch(token: string, signal: AbortSignal): Promise<Balance>;
  requiresOAuth?: boolean;
}

interface CodexQuotaWindow {
  usedPercent: number;
  windowSeconds: number;
  /** Unix timestamp in seconds, supplied by Codex when available. */
  resetAt?: number;
}

export interface CodexAdditionalQuota {
  name: string;
  primary: CodexQuotaWindow | null;
  secondary: CodexQuotaWindow | null;
}

export interface CodexQuota {
  primary: CodexQuotaWindow | null;
  secondary: CodexQuotaWindow | null;
  additional: CodexAdditionalQuota[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function objectProperty(
  value: unknown,
  key: string,
): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;
  return asRecord(record[key]);
}

function numericProperty(value: unknown, key: string): number | null {
  const record = asRecord(value);
  if (!record) return null;
  const candidate = record[key];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : null;
}

function stringProperty(value: unknown, key: string): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const candidate = record[key];
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : null;
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64 + padding);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function parseCodexAccountId(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;

  try {
    const payload = asRecord(JSON.parse(decodeBase64Url(parts[1])));
    const auth = payload ? asRecord(payload[CODEX_AUTH_CLAIM]) : null;
    const accountId = auth?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.trim()
      ? accountId.trim()
      : null;
  } catch {
    return null;
  }
}

function parseCodexQuotaWindow(value: unknown): CodexQuotaWindow | null {
  const usedPercent = numericProperty(value, "used_percent");
  const windowSeconds = numericProperty(value, "limit_window_seconds");
  if (usedPercent === null || windowSeconds === null || windowSeconds <= 0) {
    return null;
  }

  // `reset_at` is a Unix timestamp in seconds. It is optional in Codex
  // responses, so an absent or malformed reset timestamp must not discard an
  // otherwise valid usage window.
  const resetAt = numericProperty(value, "reset_at");
  return {
    usedPercent,
    windowSeconds,
    ...(resetAt !== null && resetAt > 0 ? { resetAt } : {}),
  };
}

interface ParsedCodexQuotaWindows {
  primary: CodexQuotaWindow | null;
  secondary: CodexQuotaWindow | null;
}

function parseCodexQuotaWindows(
  value: unknown,
): ParsedCodexQuotaWindows | null {
  const rateLimit = asRecord(value);
  if (!rateLimit) return null;

  const primary = parseCodexQuotaWindow(rateLimit.primary_window);
  const secondary = parseCodexQuotaWindow(rateLimit.secondary_window);
  return primary || secondary ? { primary, secondary } : null;
}

export function parseCodexQuota(value: unknown): CodexQuota | null {
  const payload = asRecord(value);
  if (!payload) return null;

  const base = parseCodexQuotaWindows(payload.rate_limit);
  const additional = Array.isArray(payload.additional_rate_limits)
    ? payload.additional_rate_limits.flatMap((candidate) => {
        const name = stringProperty(candidate, "limit_name");
        const windows = parseCodexQuotaWindows(
          objectProperty(candidate, "rate_limit"),
        );
        return name && windows ? [{ name, ...windows }] : [];
      })
    : [];

  if (!base && additional.length === 0) return null;
  return {
    primary: base?.primary ?? null,
    secondary: base?.secondary ?? null,
    additional,
  };
}

function formatWindowDuration(windowSeconds: number): string {
  const minutes = Math.max(1, Math.round(windowSeconds / 60));
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatResetCountdown(secondsUntilReset: number): string {
  const minutes = Math.max(0, Math.ceil(secondsUntilReset / 60));
  if (minutes === 0) return "now";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  // Spaceless ("3d16h"): the footer is a status bar, not prose.
  return remainingHours === 0 ? `${days}d` : `${days}d${remainingHours}h`;
}

function compactCodexQuotaName(name: string): string {
  return /codex-spark$/i.test(name) ? "Spark" : name;
}

// --- Unified balance model -------------------------------------------------
// Providers differ only in *parsing*; every provider's data is projected to
// the same Balance model and one formatter renders it all. The footer reads
// like a status bar: glyphs carry the meaning, words are dropped.
//   credits      -> "$1.5k"
//   quota window -> "[label ]7d 72%[ ↻4d4h]"   (↻ = resets in)

export interface QuotaWindow {
  /** Remaining quota, 0–100. */
  remainingPercent: number;
  /** Window length in seconds, shown as a compact "7d"/"5h" label. */
  windowSeconds?: number;
  /** Unix-seconds timestamp the window resets at. */
  resetAt?: number;
}

export interface BalanceSegment {
  /** Label for extra windows that need disambiguating (e.g. "Spark"). */
  label?: string;
  /** Prepaid money remaining (Kilo, OpenRouter). */
  credits?: number;
  /** Usage window remaining (z.ai, Codex). */
  quota?: QuotaWindow;
}

export type Balance = BalanceSegment[];

/** Structural shape shared by Codex and z.ai usage windows. */
interface UsedPercentWindow {
  usedPercent: number;
  windowSeconds: number;
  resetAt?: number;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Flip a provider's "used" window into the model's "remaining" window. */
function windowToQuota(window: UsedPercentWindow): QuotaWindow {
  return {
    remainingPercent: 100 - window.usedPercent,
    windowSeconds: window.windowSeconds,
    ...(window.resetAt !== undefined ? { resetAt: window.resetAt } : {}),
  };
}

function formatResetSuffix(resetAt: number | undefined, nowMs: number): string {
  if (
    typeof resetAt !== "number" ||
    !Number.isFinite(resetAt) ||
    resetAt <= 0
  ) {
    return "";
  }
  return ` ↻${formatResetCountdown(resetAt - nowMs / 1000)}`;
}

function formatSegment(segment: BalanceSegment, nowMs: number): string {
  if (segment.credits !== undefined) return formatCredits(segment.credits);
  const quota = segment.quota;
  if (!quota) return "";

  const window = quota.windowSeconds
    ? `${formatWindowDuration(quota.windowSeconds)} `
    : "";
  const percent = `${clampPercent(quota.remainingPercent)}%`;
  const core = `${window}${percent}${formatResetSuffix(quota.resetAt, nowMs)}`;
  return segment.label ? `${segment.label} ${core}` : core;
}

export function formatBalance(balance: Balance, nowMs = Date.now()): string {
  return balance
    .map((segment) => formatSegment(segment, nowMs))
    .filter((segment) => segment.length > 0)
    .join(" · ");
}

export function codexQuotaToBalance(quota: CodexQuota): Balance {
  const segments: BalanceSegment[] = [];
  for (const window of [quota.primary, quota.secondary]) {
    if (window) segments.push({ quota: windowToQuota(window) });
  }
  for (const additional of quota.additional) {
    const label = compactCodexQuotaName(additional.name);
    for (const window of [additional.primary, additional.secondary]) {
      if (window) segments.push({ label, quota: windowToQuota(window) });
    }
  }
  return segments;
}

export function formatCodexQuota(
  quota: CodexQuota,
  nowMs = Date.now(),
): string {
  return formatBalance(codexQuotaToBalance(quota), nowMs);
}

export interface ZaiQuotaWindow {
  usedPercent: number;
  windowSeconds: number;
  /** Unix timestamp in seconds, derived from Z.ai's `nextResetTime`. */
  resetAt?: number;
}

export interface ZaiQuota {
  planName: string | null;
  tokenWindows: ZaiQuotaWindow[];
}

function parseZaiWindowSeconds(unit: number, number: number): number | null {
  if (!Number.isInteger(number) || number <= 0) return null;

  const secondsPerUnit: Record<number, number> = {
    1: 24 * 60 * 60, // days
    3: 60 * 60, // hours
    5: 60, // minutes
    6: 7 * 24 * 60 * 60, // weeks
  };
  const multiplier = secondsPerUnit[unit];
  return multiplier ? number * multiplier : null;
}

function parseZaiUsedPercent(value: unknown): number | null {
  const percentage = numericProperty(value, "percentage");
  if (percentage !== null) return percentage;

  // Older responses sometimes omit `percentage`, but include the raw quota
  // and either `remaining` or `currentValue`. Do not turn an incomplete limit
  // into a false 0% reading.
  const limit = numericProperty(value, "usage");
  if (limit === null || limit <= 0) return null;
  const remaining = numericProperty(value, "remaining");
  const currentValue = numericProperty(value, "currentValue");
  const used =
    remaining !== null
      ? Math.max(limit - remaining, currentValue ?? 0)
      : currentValue;
  return used === null ? null : (used / limit) * 100;
}

function parseZaiResetAt(value: unknown): number | undefined {
  const nextResetTime = numericProperty(value, "nextResetTime");
  if (nextResetTime === null || nextResetTime <= 0) return undefined;

  // Z.ai has returned Unix timestamps in milliseconds. Accept seconds too so
  // a backend representation change cannot turn the countdown into decades.
  return nextResetTime >= 10_000_000_000 ? nextResetTime / 1000 : nextResetTime;
}

export function parseZaiQuota(value: unknown): ZaiQuota | null {
  const payload = asRecord(value);
  if (
    !payload ||
    payload.success !== true ||
    numericProperty(payload, "code") !== 200
  ) {
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
    if (windowSeconds === null) return [];
    const resetAt = parseZaiResetAt(candidate);
    return [
      {
        usedPercent,
        windowSeconds,
        ...(resetAt === undefined ? {} : { resetAt }),
      },
    ];
  });

  if (tokenWindows.length === 0) return null;
  tokenWindows.sort((a, b) => a.windowSeconds - b.windowSeconds);

  const planName =
    stringProperty(data, "planName") ??
    stringProperty(data, "plan") ??
    stringProperty(data, "plan_type") ??
    stringProperty(data, "packageName") ??
    null;
  return { planName, tokenWindows };
}

export function zaiQuotaToBalance(quota: ZaiQuota): Balance {
  return [...quota.tokenWindows]
    .sort((a, b) => a.windowSeconds - b.windowSeconds)
    .map((window) => ({ quota: windowToQuota(window) }));
}

export function formatZaiQuota(quota: ZaiQuota, nowMs = Date.now()): string {
  return formatBalance(zaiQuotaToBalance(quota), nowMs);
}

export function formatCredits(balance: number): string {
  if (balance >= 1000) return `$${(balance / 1000).toFixed(1)}k`;
  return `$${balance.toFixed(2)}`;
}

export function parseKiloBalance(value: unknown): number | null {
  return numericProperty(value, "balance");
}

export function parseOpenRouterCredits(value: unknown): number | null {
  const data = objectProperty(value, "data");
  const totalCredits = numericProperty(data, "total_credits");
  const totalUsage = numericProperty(data, "total_usage");
  if (
    totalCredits === null ||
    totalUsage === null ||
    totalCredits < 0 ||
    totalUsage < 0
  ) {
    return null;
  }
  return Math.max(0, totalCredits - totalUsage);
}

async function fetchKiloBalance(
  token: string,
  signal: AbortSignal,
): Promise<Balance> {
  const timeout = AbortSignal.timeout(BALANCE_FETCH_TIMEOUT_MS);
  const response = await fetch(KILO_BALANCE_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.any([timeout, signal]),
  });
  if (!response.ok) {
    throw new Error(`Kilo balance request failed: ${response.status}`);
  }

  const balance = parseKiloBalance(await response.json());
  if (balance === null) {
    throw new Error("Kilo balance response was invalid");
  }
  return [{ credits: balance }];
}

async function fetchOpenRouterBalance(
  token: string,
  signal: AbortSignal,
): Promise<Balance> {
  const timeout = AbortSignal.timeout(BALANCE_FETCH_TIMEOUT_MS);
  const response = await fetch(OPENROUTER_CREDITS_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.any([timeout, signal]),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter balance request failed: ${response.status}`);
  }

  const balance = parseOpenRouterCredits(await response.json());
  if (balance === null) {
    throw new Error("OpenRouter balance response was invalid");
  }
  return [{ credits: balance }];
}

async function fetchZaiQuotaAt(
  endpoint: string,
  token: string,
  signal: AbortSignal,
): Promise<Balance> {
  const timeout = AbortSignal.timeout(BALANCE_FETCH_TIMEOUT_MS);
  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.any([timeout, signal]),
  });
  if (!response.ok) {
    throw new Error(`Z.ai quota request failed: ${response.status}`);
  }

  const quota = parseZaiQuota(await response.json());
  if (quota === null) {
    throw new Error("Z.ai quota response was invalid");
  }
  return zaiQuotaToBalance(quota);
}

async function fetchZaiQuota(
  token: string,
  signal: AbortSignal,
): Promise<Balance> {
  return fetchZaiQuotaAt(ZAI_QUOTA_ENDPOINT, token, signal);
}

async function fetchZaiCodingCnQuota(
  token: string,
  signal: AbortSignal,
): Promise<Balance> {
  return fetchZaiQuotaAt(ZAI_CODING_CN_QUOTA_ENDPOINT, token, signal);
}

async function fetchCodexQuota(
  token: string,
  signal: AbortSignal,
): Promise<Balance> {
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
      "chatgpt-account-id": accountId,
    },
    signal: AbortSignal.any([timeout, signal]),
  });
  if (!response.ok) {
    throw new Error(`Codex quota request failed: ${response.status}`);
  }

  const quota = parseCodexQuota(await response.json());
  if (quota === null) {
    throw new Error("Codex quota response was invalid");
  }
  return codexQuotaToBalance(quota);
}

const BALANCE_ADAPTERS: Readonly<Record<string, BalanceAdapter>> = {
  kilo: { fetch: fetchKiloBalance },
  openrouter: { fetch: fetchOpenRouterBalance },
  zai: { fetch: fetchZaiQuota },
  "zai-coding-cn": { fetch: fetchZaiCodingCnQuota },
  "openai-codex": { fetch: fetchCodexQuota, requiresOAuth: true },
};

type FooterSession = ConstructorParameters<typeof FooterComponent>[0];
type FooterFactory = NonNullable<
  Parameters<ExtensionContext["ui"]["setFooter"]>[0]
>;
type FooterTheme = Parameters<FooterFactory>[1];
type FooterLines = string[];
type ActiveThinkingLevel = "off" | ThinkingLevel;

const THINKING_LEVELS: ReadonlySet<string> = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function normalizeThinkingLevel(value: string): ActiveThinkingLevel {
  return value === "off" || THINKING_LEVELS.has(value)
    ? (value as ActiveThinkingLevel)
    : "off";
}

/**
 * FooterComponent is public, but its constructor takes the internal
 * AgentSession rather than ExtensionContext. This facade supplies exactly the
 * fields FooterComponent reads while keeping the actual session data live.
 */
function restoredThinkingLevel(ctx: ExtensionContext): ActiveThinkingLevel {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === "thinking_level_change") {
      return normalizeThinkingLevel(entry.thinkingLevel);
    }
  }
  return "off";
}

function createFooterSession(
  getContext: () => ExtensionContext,
  getThinkingLevel: () => ActiveThinkingLevel,
): FooterSession {
  const facade = {
    get state() {
      const ctx = getContext();
      return {
        model: ctx.model,
        thinkingLevel: getThinkingLevel(),
      };
    },
    get sessionManager() {
      return getContext().sessionManager;
    },
    modelRuntime: {
      isUsingOAuth(provider: string): boolean {
        const model = getContext().model;
        return model?.provider === provider && model !== undefined
          ? getContext().modelRegistry.isUsingOAuth(model)
          : false;
      },
    },
    getContextUsage() {
      return getContext().getContextUsage();
    },
  };
  return facade as unknown as FooterSession;
}

function addBalanceToWorkingDirectoryLine(
  lines: FooterLines,
  width: number,
  theme: FooterTheme,
  balanceText: string | undefined,
): FooterLines {
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
    Math.max(1, width - visibleWidth(left) - rightWidth),
  );
  return [`${left}${padding}${right}`, ...lines.slice(1)];
}

export default function providerBalance(pi: ExtensionAPI): void {
  let activeContext: ExtensionContext | undefined;
  let balance: Balance | undefined;
  /** Provider the currently-displayed balance belongs to. */
  let displayedProvider: string | undefined;
  let refreshGeneration = 0;
  let refreshController: AbortController | undefined;
  let requestRender: (() => void) | undefined;
  let activeThinkingLevel: ActiveThinkingLevel = "off";

  function clearBalance(): void {
    balance = undefined;
    requestRender?.();
  }

  /** Refresh the balance for whatever model is active. Provider-agnostic: the
   *  adapter registry in refreshBalance decides whether there is anything to
   *  fetch, so this is a no-op for providers without a balance adapter. */
  function refreshForModel(
    ctx: ExtensionContext,
    model: ExtensionContext["model"],
  ): Promise<void> {
    return refreshBalance(ctx, model?.provider, model);
  }

  async function refreshBalance(
    ctx: ExtensionContext,
    provider: string | undefined,
    model: ExtensionContext["model"],
  ): Promise<void> {
    const generation = ++refreshGeneration;
    refreshController?.abort();
    const controller = new AbortController();
    refreshController = controller;

    // Only blank the footer when the displayed value is for a different
    // provider than the one we're about to fetch. A same-provider refresh
    // keeps the last known value on screen until the fresh one lands (an
    // atomic swap), which matters now that we refresh mid-turn rather than
    // once per run — otherwise the number would flicker off on every refresh.
    if (provider !== displayedProvider) {
      displayedProvider = provider;
      clearBalance();
    }

    const providerId = provider;
    const adapter = providerId ? BALANCE_ADAPTERS[providerId] : undefined;
    if (!adapter || !providerId) return;
    if (
      adapter.requiresOAuth &&
      (!model ||
        model.provider !== providerId ||
        !ctx.modelRegistry.isUsingOAuth(model))
    ) {
      return;
    }

    try {
      const token = await ctx.modelRegistry.getApiKeyForProvider(providerId);
      if (!token || generation !== refreshGeneration) return;
      balance = await adapter.fetch(token, controller.signal);
      if (generation === refreshGeneration) requestRender?.();
    } catch (error) {
      if (generation !== refreshGeneration || controller.signal.aborted) return;
      // This is a best-effort background refresh. Writing to stdout/stderr while
      // Pi owns the terminal corrupts the TUI (the text appears in the editor),
      // so expose failures to other extensions without producing terminal output.
      pi.events.emit("provider-balance:refresh-error", {
        provider: providerId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (generation === refreshGeneration) refreshController = undefined;
    }
  }

  function installFooter(ctx: ExtensionContext): void {
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
          () => activeThinkingLevel,
        ),
        footerData,
      );
      const unsubscribeBranchChange = footerData.onBranchChange(() =>
        tui.requestRender(),
      );

      return {
        invalidate: () => footer.invalidate(),
        render: (width: number) =>
          addBalanceToWorkingDirectoryLine(
            footer.render(width),
            width,
            theme,
            balance ? formatBalance(balance) : undefined,
          ),
        dispose: () => {
          unsubscribeBranchChange();
          footer.dispose();
          requestRender = undefined;
        },
      };
    });
  }

  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    activeThinkingLevel = restoredThinkingLevel(ctx);
    installFooter(ctx);
    // Footer data is supplemental. Never hold up session readiness on network.
    void refreshForModel(ctx, ctx.model);
  });

  pi.on("model_select", (event, ctx) => {
    activeContext = ctx;
    // AgentSession awaits model_select handlers before the picker can close.
    // Start the footer refresh, but do not make model selection wait for it.
    void refreshForModel(ctx, event.model ?? ctx.model);
  });

  // After a run fully settles (retries/compaction/continuations done), refresh
  // so the status bar reflects consumption and any external tier change. Fires
  // once per completed run for whatever provider is active; providers without a
  // balance adapter are skipped inside refreshBalance.
  pi.on("agent_settled", (_event, ctx) => {
    activeContext = ctx;
    void refreshForModel(ctx, ctx.model);
  });

  // Live updates during a run. A turn is one assistant response plus its tool
  // results, so turn_end is exactly the granularity at which balance/credits
  // change. Refresh every Nth turn instead of every turn so chatty runs don't
  // hammer provider status endpoints; agent_settled still fires afterward and
  // guarantees a final refresh, so runs shorter than N turns and the trailing
  // turns past the last multiple are never left stale.
  pi.on("turn_end", (event, ctx) => {
    activeContext = ctx;
    if ((event.turnIndex + 1) % REFRESH_EVERY_N_TURNS !== 0) return;
    void refreshForModel(ctx, ctx.model);
  });

  pi.on("thinking_level_select", (event) => {
    activeThinkingLevel = event.level;
    requestRender?.();
  });

  pi.on("session_shutdown", () => {
    refreshController?.abort();
    refreshController = undefined;
    activeContext = undefined;
    activeThinkingLevel = "off";
    requestRender = undefined;
    // Drop the prior session's balance so the next footer doesn't flash a
    // stale value from a different provider before its first refresh lands.
    balance = undefined;
    displayedProvider = undefined;
  });
}
