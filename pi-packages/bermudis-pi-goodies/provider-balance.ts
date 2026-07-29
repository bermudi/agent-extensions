import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { FooterComponent } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const KILO_API_BASE = process.env.KILO_API_URL || "https://api.kilo.ai";
const KILO_BALANCE_ENDPOINT = `${KILO_API_BASE}/api/profile/balance`;
const BALANCE_FETCH_TIMEOUT_MS = 5_000;

interface BalanceAdapter {
  fetch(token: string, signal: AbortSignal): Promise<string>;
}

function numericProperty(value: unknown, key: string): number | null {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return null;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : null;
}

export function formatCredits(balance: number): string {
  if (balance >= 1000) return `$${(balance / 1000).toFixed(1)}k`;
  return `$${balance.toFixed(2)}`;
}

export function parseKiloBalance(value: unknown): number | null {
  return numericProperty(value, "balance");
}

async function fetchKiloBalance(
  token: string,
  signal: AbortSignal,
): Promise<string> {
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
  return `💰 ${formatCredits(balance)}`;
}

const BALANCE_ADAPTERS: Readonly<Record<string, BalanceAdapter>> = {
  kilo: { fetch: fetchKiloBalance },
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
  let balanceText: string | undefined;
  let refreshGeneration = 0;
  let refreshController: AbortController | undefined;
  let requestRender: (() => void) | undefined;
  let activeThinkingLevel: ActiveThinkingLevel = "off";

  function clearBalance(): void {
    balanceText = undefined;
    requestRender?.();
  }

  async function refreshBalance(
    ctx: ExtensionContext,
    provider: string | undefined,
  ): Promise<void> {
    const generation = ++refreshGeneration;
    refreshController?.abort();
    const controller = new AbortController();
    refreshController = controller;
    clearBalance();

    const providerId = provider;
    const adapter = providerId ? BALANCE_ADAPTERS[providerId] : undefined;
    if (!adapter || !providerId) return;

    try {
      const token = await ctx.modelRegistry.getApiKeyForProvider(providerId);
      if (!token || generation !== refreshGeneration) return;
      balanceText = await adapter.fetch(token, controller.signal);
      if (generation === refreshGeneration) requestRender?.();
    } catch (error) {
      if (generation !== refreshGeneration || controller.signal.aborted) return;
      console.warn(
        `[provider-balance] Failed to refresh ${providerId} balance:`,
        error instanceof Error ? error.message : error,
      );
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
            balanceText,
          ),
        dispose: () => {
          unsubscribeBranchChange();
          footer.dispose();
          requestRender = undefined;
        },
      };
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx;
    activeThinkingLevel = restoredThinkingLevel(ctx);
    installFooter(ctx);
    await refreshBalance(ctx, ctx.model?.provider);
  });

  pi.on("model_select", async (event, ctx) => {
    activeContext = ctx;
    await refreshBalance(ctx, event.model?.provider ?? ctx.model?.provider);
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
  });
}
