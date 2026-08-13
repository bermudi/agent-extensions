import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelSelectEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import providerBalance, {
  balanceCacheKey,
  codexQuotaToBalance,
  formatBalance,
  formatCodexQuota,
  formatCredits,
  formatZaiQuota,
  parseCodexAccountId,
  parseCodexQuota,
  parseKiloBalance,
  parseOpenRouterCredits,
  parseZaiQuota,
  readCachedBalance,
  writeCachedBalance,
  zaiQuotaToBalance,
} from "./provider-balance.ts";

describe("event latency", () => {
  test("model selection does not await the balance refresh", () => {
    let modelSelectHandler:
      ((event: ModelSelectEvent, ctx: ExtensionContext) => unknown) | undefined;
    providerBalance({
      on(event, handler) {
        if (event === "model_select") {
          modelSelectHandler = handler as typeof modelSelectHandler;
        }
      },
    } as unknown as ExtensionAPI);
    if (!modelSelectHandler) {
      throw new Error("provider-balance did not register model_select");
    }

    const model = { provider: "unmetered-provider" };
    const result = modelSelectHandler(
      { model } as ModelSelectEvent,
      { model } as ExtensionContext,
    );

    expect(result).toBeUndefined();
  });

  test("background refresh failures do not write through the TUI", async () => {
    let modelSelectHandler:
      ((event: ModelSelectEvent, ctx: ExtensionContext) => unknown) | undefined;
    const emitted: Array<{ channel: string; data: unknown }> = [];
    providerBalance({
      on(event, handler) {
        if (event === "model_select") {
          modelSelectHandler = handler as typeof modelSelectHandler;
        }
      },
      events: {
        emit(channel, data) {
          emitted.push({ channel, data });
        },
        on() {
          return () => {};
        },
      },
    } as unknown as ExtensionAPI);
    if (!modelSelectHandler) {
      throw new Error("provider-balance did not register model_select");
    }

    const model = { provider: "openai-codex" };
    const context = {
      model,
      modelRegistry: {
        isUsingOAuth: () => true,
        getApiKeyForProvider: async () => "not-a-jwt",
      },
    } as unknown as ExtensionContext;
    modelSelectHandler({ model } as ModelSelectEvent, context);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(emitted).toEqual([
      {
        channel: "provider-balance:refresh-error",
        data: {
          provider: "openai-codex",
          message: "Codex access token did not contain an account ID",
        },
      },
    ]);
  });
});

describe("idle refresh lifecycle", () => {
  test("refreshes only while idle and clears the recurring timer on shutdown", async () => {
    const handlers = new Map<
      string,
      (event: unknown, ctx: ExtensionContext) => unknown
    >();
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    const cleared: unknown[] = [];
    const setTimeout = ((callback: () => void, delay: number) => {
      scheduled.push({ callback, delay });
      return scheduled.length as unknown as ReturnType<
        typeof globalThis.setTimeout
      >;
    }) as typeof globalThis.setTimeout;
    const clearTimeout = ((timer: unknown) => {
      cleared.push(timer);
    }) as typeof globalThis.clearTimeout;

    providerBalance(
      {
        on(event, handler) {
          handlers.set(
            event,
            handler as (event: unknown, ctx: ExtensionContext) => unknown,
          );
        },
        events: {
          emit() {},
          on() {
            return () => {};
          },
        },
      } as unknown as ExtensionAPI,
      { setTimeout, clearTimeout, random: () => 0.5 },
    );

    let idle = false;
    let apiKeyCalls = 0;
    const ctx = {
      mode: "tui",
      model: { provider: "kilo" },
      isIdle: () => idle,
      ui: { setFooter() {} },
      sessionManager: { getBranch: () => [] },
      modelRegistry: {
        isUsingOAuth: () => false,
        getApiKeyForProvider: async () => {
          apiKeyCalls++;
          return null;
        },
      },
    } as unknown as ExtensionContext;
    const start = handlers.get("session_start");
    const shutdown = handlers.get("session_shutdown");
    if (!start || !shutdown) throw new Error("missing lifecycle handlers");

    start({}, ctx);
    expect(scheduled[0]?.delay).toBe(67_500);
    expect(apiKeyCalls).toBe(1);
    await Promise.resolve();

    scheduled[0]?.callback();
    expect(apiKeyCalls).toBe(1);
    expect(scheduled).toHaveLength(2);

    idle = true;
    scheduled[1]?.callback();
    expect(apiKeyCalls).toBe(2);
    await Promise.resolve();
    expect(scheduled).toHaveLength(3);

    shutdown({}, ctx);
    expect(cleared).toContain(3);
  });
});

describe("auth transition", () => {
  test("stops polling after 10 failed lookups instead of running forever", async () => {
    const handlers = new Map<
      string,
      (event: unknown, ctx: ExtensionContext) => unknown
    >();
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    const cleared: unknown[] = [];
    const setTimeout = ((callback: () => void, delay: number) => {
      scheduled.push({ callback, delay });
      return scheduled.length as unknown as ReturnType<
        typeof globalThis.setTimeout
      >;
    }) as typeof globalThis.setTimeout;
    const clearTimeout = ((timer: unknown) => {
      cleared.push(timer);
    }) as typeof globalThis.clearTimeout;

    providerBalance(
      {
        on(event, handler) {
          handlers.set(
            event,
            handler as (event: unknown, ctx: ExtensionContext) => unknown,
          );
        },
        events: {
          emit() {},
          on() {
            return () => {};
          },
        },
      } as unknown as ExtensionAPI,
      { setTimeout, clearTimeout, random: () => 0.5 },
    );

    let apiKeyCalls = 0;
    const ctx = {
      mode: "tui",
      model: { provider: "kilo" },
      isIdle: () => false,
      ui: { setFooter() {} },
      sessionManager: { getBranch: () => [] },
      modelRegistry: {
        isUsingOAuth: () => false,
        getApiKeyForProvider: async () => {
          apiKeyCalls++;
          throw new Error("keychain unavailable");
        },
      },
    } as unknown as ExtensionContext;

    const start = handlers.get("session_start");
    const input = handlers.get("input");
    if (!start || !input) throw new Error("missing lifecycle handlers");

    // session_start schedules the idle timer (index 0) and kicks a refresh
    // that calls getApiKeyForProvider once.
    start({}, ctx);
    const refreshCallsAtStart = apiKeyCalls;
    await Promise.resolve();

    // /login for the active provider arms the auth-transition poller.
    input({ text: "/login kilo" }, ctx);

    // The poller is the most recently scheduled timer.
    let pollerIndex = scheduled.length - 1;
    for (let attempt = 1; attempt <= 10; attempt++) {
      scheduled[pollerIndex]?.callback();
      await Promise.resolve();
      // Each failed lookup reschedules (attempts < 10) or stops (attempt 10).
      if (attempt < 10) {
        expect(scheduled.length).toBe(pollerIndex + 2);
        pollerIndex = scheduled.length - 1;
      } else {
        // After the 10th failure the timer must not reschedule.
        expect(scheduled.length).toBe(pollerIndex + 1);
      }
    }

    // Exactly 10 polling lookups, plus the initial session_start refresh.
    expect(apiKeyCalls - refreshCallsAtStart).toBe(10);
  });
});

describe("turn_end cadence", () => {
  function setup(): {
    fire: (event: TurnEndEvent) => void;
    apiKeyCalls: () => number;
  } {
    const handlers = new Map<
      string,
      (event: unknown, ctx: unknown) => unknown
    >();
    providerBalance({
      on(event, handler) {
        handlers.set(
          event,
          handler as (event: unknown, ctx: unknown) => unknown,
        );
      },
      events: {
        emit() {},
        on() {
          return () => {};
        },
      },
    } as unknown as ExtensionAPI);

    const turnEnd = handlers.get("turn_end");
    if (!turnEnd) {
      throw new Error("provider-balance did not register turn_end");
    }

    let apiKeyCalls = 0;
    // A provider with an adapter ("kilo") forces the refresh path to call
    // getApiKeyForProvider before bailing. Returning null avoids any network
    // while making every real refresh attempt observable as one call.
    const ctx = {
      model: { provider: "kilo" },
      modelRegistry: {
        isUsingOAuth: () => false,
        getApiKeyForProvider: async () => {
          apiKeyCalls++;
          return null;
        },
      },
    } as unknown as ExtensionContext;

    return {
      fire: (event: TurnEndEvent) => {
        void turnEnd(event, ctx);
      },
      apiKeyCalls: () => apiKeyCalls,
    };
  }

  function turnEndAt(index: number): TurnEndEvent {
    return {
      type: "turn_end",
      turnIndex: index,
      message: {} as TurnEndEvent["message"],
      toolResults: [],
    };
  }

  test("refreshes on every 5th turn end over a 20-turn run", async () => {
    const { fire, apiKeyCalls } = setup();
    for (let i = 0; i < 20; i++) fire(turnEndAt(i));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // turnIndex 4, 9, 14, 19 -> exactly 4 refresh attempts.
    expect(apiKeyCalls()).toBe(4);
  });

  test("does not refresh before the 5th turn", async () => {
    const { fire, apiKeyCalls } = setup();
    for (let i = 0; i < 4; i++) fire(turnEndAt(i));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(apiKeyCalls()).toBe(0);
  });
});

describe("parseZaiQuota", () => {
  test("parses token windows and ignores MCP time limits", () => {
    expect(
      parseZaiQuota({
        success: true,
        code: 200,
        data: {
          planName: "Pro",
          limits: [
            {
              type: "TIME_LIMIT",
              unit: 5,
              number: 1,
              percentage: 10,
            },
            {
              type: "TOKENS_LIMIT",
              unit: 1,
              number: 7,
              percentage: 40,
              nextResetTime: 1_800_345_600,
            },
            {
              type: "TOKENS_LIMIT",
              unit: 3,
              number: 5,
              percentage: 25,
              nextResetTime: 1_800_000_000_000,
            },
          ],
        },
      }),
    ).toEqual({
      planName: "Pro",
      tokenWindows: [
        {
          usedPercent: 25,
          windowSeconds: 18_000,
          resetAt: 1_800_000_000,
        },
        {
          usedPercent: 40,
          windowSeconds: 604_800,
          resetAt: 1_800_345_600,
        },
      ],
    });
  });

  test("computes usage when percentage is omitted", () => {
    expect(
      parseZaiQuota({
        success: true,
        code: 200,
        data: {
          limits: [
            {
              type: "TOKENS_LIMIT",
              unit: 3,
              number: 5,
              usage: 1000,
              remaining: 750,
            },
          ],
        },
      }),
    ).toEqual({
      planName: null,
      tokenWindows: [{ usedPercent: 25, windowSeconds: 18_000 }],
    });
  });

  test("rejects API errors, unknown windows, and responses without tokens", () => {
    expect(parseZaiQuota(null)).toBeNull();
    expect(parseZaiQuota({ success: false, code: 401 })).toBeNull();
    expect(
      parseZaiQuota({
        success: true,
        code: 200,
        data: {
          limits: [{ type: "TIME_LIMIT", unit: 5, number: 1, percentage: 10 }],
        },
      }),
    ).toBeNull();
    expect(
      parseZaiQuota({
        success: true,
        code: 200,
        data: {
          limits: [
            { type: "TOKENS_LIMIT", unit: 99, number: 5, percentage: 10 },
          ],
        },
      }),
    ).toBeNull();
  });
});

describe("formatZaiQuota", () => {
  test("shows the shortest token window first", () => {
    expect(
      formatZaiQuota({
        planName: "Pro",
        tokenWindows: [
          { usedPercent: 40, windowSeconds: 604_800 },
          { usedPercent: 25, windowSeconds: 18_000 },
        ],
      }),
    ).toBe("5h 75% · 7d 60%");
  });

  test("shows a reset countdown when Z.ai supplies nextResetTime", () => {
    const nowMs = Date.UTC(2026, 0, 1);
    expect(
      formatZaiQuota(
        {
          planName: "Pro",
          tokenWindows: [
            {
              usedPercent: 80,
              windowSeconds: 604_800,
              resetAt: nowMs / 1000 + 3 * 24 * 60 * 60 + 16 * 60 * 60,
            },
          ],
        },
        nowMs,
      ),
    ).toBe("7d 20% ↻3d16h");
  });
});

describe("zaiQuotaToBalance", () => {
  test("sorts windows shortest-first and flips used to remaining", () => {
    expect(
      zaiQuotaToBalance({
        planName: null,
        tokenWindows: [
          { usedPercent: 40, windowSeconds: 604_800 },
          { usedPercent: 25, windowSeconds: 18_000 },
        ],
      }),
    ).toEqual([
      { quota: { remainingPercent: 75, windowSeconds: 18_000 } },
      { quota: { remainingPercent: 60, windowSeconds: 604_800 } },
    ]);
  });
});

describe("parseOpenRouterCredits", () => {
  test("computes remaining credits", () => {
    expect(
      parseOpenRouterCredits({
        data: { total_credits: 10, total_usage: 2.34 },
      }),
    ).toBe(7.66);
  });

  test("clamps usage overshoot to zero", () => {
    expect(
      parseOpenRouterCredits({
        data: { total_credits: 10, total_usage: 10.5 },
      }),
    ).toBe(0);
  });

  test("rejects malformed responses", () => {
    expect(parseOpenRouterCredits(null)).toBeNull();
    expect(parseOpenRouterCredits({})).toBeNull();
    expect(parseOpenRouterCredits({ data: {} })).toBeNull();
    expect(
      parseOpenRouterCredits({
        data: { total_credits: "10", total_usage: 2 },
      }),
    ).toBeNull();
    expect(
      parseOpenRouterCredits({
        data: { total_credits: -1, total_usage: 0 },
      }),
    ).toBeNull();
  });
});

describe("formatCredits", () => {
  test("uses compact notation for large balances", () => {
    expect(formatCredits(1500)).toBe("$1.5k");
    expect(formatCredits(25000)).toBe("$25.0k");
  });

  test("uses cents for ordinary balances", () => {
    expect(formatCredits(0)).toBe("$0.00");
    expect(formatCredits(12.5)).toBe("$12.50");
    expect(formatCredits(999.999)).toBe("$1000.00");
  });
});

describe("parseKiloBalance", () => {
  test("accepts a finite numeric balance", () => {
    expect(parseKiloBalance({ balance: 10.02 })).toBe(10.02);
  });

  test("rejects malformed external responses", () => {
    expect(parseKiloBalance(null)).toBeNull();
    expect(parseKiloBalance({ balance: "10.02" })).toBeNull();
    expect(parseKiloBalance({ balance: Number.NaN })).toBeNull();
    expect(parseKiloBalance({})).toBeNull();
  });
});

describe("parseCodexAccountId", () => {
  function tokenWithPayload(payload: Record<string, unknown>): string {
    const encoded = btoa(JSON.stringify(payload))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return `header.${encoded}.signature`;
  }

  test("reads the account ID from the namespaced auth claim", () => {
    expect(
      parseCodexAccountId(
        tokenWithPayload({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "account-123",
          },
        }),
      ),
    ).toBe("account-123");
  });

  test("rejects malformed or non-Codex tokens", () => {
    expect(parseCodexAccountId("api-key")).toBeNull();
    expect(parseCodexAccountId("header.not-json.signature")).toBeNull();
    expect(
      parseCodexAccountId(
        tokenWithPayload({
          "https://api.openai.com/auth": { chatgpt_account_id: "" },
        }),
      ),
    ).toBeNull();
  });
});

describe("parseCodexQuota", () => {
  test("parses base windows and their reset timestamps", () => {
    expect(
      parseCodexQuota({
        rate_limit: {
          primary_window: {
            used_percent: 25,
            limit_window_seconds: 18_000,
            reset_at: 1_800_000_000,
          },
          secondary_window: {
            used_percent: 40,
            limit_window_seconds: 604_800,
            reset_at: 1_800_345_600,
          },
        },
      }),
    ).toEqual({
      primary: {
        usedPercent: 25,
        windowSeconds: 18_000,
        resetAt: 1_800_000_000,
      },
      secondary: {
        usedPercent: 40,
        windowSeconds: 604_800,
        resetAt: 1_800_345_600,
      },
      additional: [],
    });
  });

  test("parses a weekly base limit and the separate Spark limit", () => {
    expect(
      parseCodexQuota({
        rate_limit: {
          primary_window: {
            used_percent: 11,
            limit_window_seconds: 604_800,
          },
          secondary_window: null,
        },
        additional_rate_limits: [
          {
            limit_name: "GPT-5.3-Codex-Spark",
            metered_feature: "codex_bengalfox",
            rate_limit: {
              primary_window: {
                used_percent: 0,
                limit_window_seconds: 604_800,
              },
              secondary_window: null,
            },
          },
        ],
      }),
    ).toEqual({
      primary: { usedPercent: 11, windowSeconds: 604_800 },
      secondary: null,
      additional: [
        {
          name: "GPT-5.3-Codex-Spark",
          primary: { usedPercent: 0, windowSeconds: 604_800 },
          secondary: null,
        },
      ],
    });
  });

  test("rejects responses without a valid quota window", () => {
    expect(parseCodexQuota(null)).toBeNull();
    expect(parseCodexQuota({ rate_limit: {} })).toBeNull();
    expect(
      parseCodexQuota({
        rate_limit: {
          primary_window: {
            used_percent: 10,
            limit_window_seconds: 0,
          },
        },
      }),
    ).toBeNull();
  });
});

describe("formatCodexQuota", () => {
  test("shows remaining quota with compact window labels", () => {
    expect(
      formatCodexQuota({
        primary: { usedPercent: 25, windowSeconds: 18_000 },
        secondary: { usedPercent: 40, windowSeconds: 604_800 },
        additional: [],
      }),
    ).toBe("5h 75% · 7d 60%");
  });

  test("distinguishes a window's length from its reset countdown", () => {
    const nowMs = Date.UTC(2026, 0, 1);
    expect(
      formatCodexQuota(
        {
          primary: {
            usedPercent: 25,
            windowSeconds: 18_000,
            resetAt: nowMs / 1000 + 2 * 60 * 60,
          },
          secondary: {
            usedPercent: 80,
            windowSeconds: 604_800,
            resetAt: nowMs / 1000 + 3 * 24 * 60 * 60 + 16 * 60 * 60,
          },
          additional: [],
        },
        nowMs,
      ),
    ).toBe("5h 75% ↻2h · 7d 20% ↻3d16h");
  });

  test("includes the named Spark quota", () => {
    expect(
      formatCodexQuota({
        primary: { usedPercent: 11, windowSeconds: 604_800 },
        secondary: null,
        additional: [
          {
            name: "GPT-5.3-Codex-Spark",
            primary: { usedPercent: 0, windowSeconds: 604_800 },
            secondary: null,
          },
        ],
      }),
    ).toBe("7d 89% · Spark 7d 100%");
  });

  test("clamps impossible percentages", () => {
    expect(
      formatCodexQuota({
        primary: { usedPercent: -10, windowSeconds: 60 },
        secondary: { usedPercent: 110, windowSeconds: 90 },
        additional: [],
      }),
    ).toBe("1m 100% · 2m 0%");
  });
});

describe("codexQuotaToBalance", () => {
  test("projects base and named windows to remaining-percent segments", () => {
    expect(
      codexQuotaToBalance({
        primary: { usedPercent: 28, windowSeconds: 604_800 },
        secondary: null,
        additional: [
          {
            name: "GPT-5.3-Codex-Spark",
            primary: { usedPercent: 26, windowSeconds: 604_800 },
            secondary: null,
          },
        ],
      }),
    ).toEqual([
      { quota: { remainingPercent: 72, windowSeconds: 604_800 } },
      {
        label: "Spark",
        quota: { remainingPercent: 74, windowSeconds: 604_800 },
      },
    ]);
  });
});

describe("formatBalance", () => {
  test("renders credits compactly", () => {
    expect(formatBalance([{ credits: 1500 }])).toBe("$1.5k");
    expect(formatBalance([{ credits: 0 }])).toBe("$0.00");
  });

  test("renders a quota window with a reset glyph and no prose", () => {
    const nowMs = Date.UTC(2026, 0, 1);
    expect(
      formatBalance(
        [
          {
            quota: {
              remainingPercent: 72,
              windowSeconds: 604_800,
              resetAt: nowMs / 1000 + 4 * 24 * 60 * 60 + 4 * 60 * 60,
            },
          },
        ],
        nowMs,
      ),
    ).toBe("7d 72% ↻4d4h");
  });

  test("joins labelled windows with a middot", () => {
    const nowMs = Date.UTC(2026, 0, 1);
    expect(
      formatBalance(
        [
          {
            quota: {
              remainingPercent: 72,
              windowSeconds: 604_800,
              resetAt: nowMs / 1000 + 4 * 24 * 60 * 60 + 4 * 60 * 60,
            },
          },
          {
            label: "Spark",
            quota: {
              remainingPercent: 74,
              windowSeconds: 604_800,
              resetAt: nowMs / 1000 + 5 * 24 * 60 * 60 + 4 * 60 * 60,
            },
          },
        ],
        nowMs,
      ),
    ).toBe("7d 72% ↻4d4h · Spark 7d 74% ↻5d4h");
  });

  test("clamps out-of-range remaining percent", () => {
    expect(
      formatBalance([
        { quota: { remainingPercent: 150, windowSeconds: 60 } },
        { quota: { remainingPercent: -20, windowSeconds: 90 } },
      ]),
    ).toBe("1m 100% · 2m 0%");
  });

  test("omits the reset glyph when no timestamp is known", () => {
    expect(
      formatBalance([{ quota: { remainingPercent: 50, windowSeconds: 3600 } }]),
    ).toBe("1h 50%");
  });
});

describe("shared balance cache", () => {
  async function withCacheDirectory<T>(
    callback: (directory: string) => T | Promise<T>,
  ): Promise<T> {
    const directory = mkdtempSync(join(tmpdir(), "provider-balance-test-"));
    try {
      return await callback(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  test("round-trips a valid account-scoped entry with private permissions", () =>
    withCacheDirectory((directory) => {
      const balance = [
        { credits: 3.5 },
        { quota: { remainingPercent: 72, windowSeconds: 604_800 } },
      ];

      writeCachedBalance("account-a", balance, 1_000, directory);

      expect(readCachedBalance("account-a", 1_001, directory)).toEqual(balance);
      expect(readCachedBalance("account-b", 1_001, directory)).toBeNull();
      const [filename] = Array.from(
        new Bun.Glob("*/*.json").scanSync(directory),
      );
      expect(filename).toBeDefined();
      expect(statSync(join(directory, filename!)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(directory, filename!), "utf8")).not.toContain(
        "account-a",
      );
    }));

  test("rejects expired and future-dated entries at the boundaries", () =>
    withCacheDirectory((directory) => {
      writeCachedBalance("expired", [{ credits: 1 }], 1_000, directory);
      writeCachedBalance("future", [{ credits: 2 }], 2_000, directory);

      expect(readCachedBalance("expired", 1_801_000, directory)).toBeNull();
      expect(readCachedBalance("future", 1_999, directory)).toBeNull();
    }));

  test("separate accounts and older observations cannot overwrite newer data", () =>
    withCacheDirectory((directory) => {
      writeCachedBalance("account-a", [{ credits: 3 }], 1_003, directory);
      writeCachedBalance("account-b", [{ credits: 2 }], 1_002, directory);
      writeCachedBalance("account-a", [{ credits: 1 }], 1_001, directory);

      expect(
        Array.from(new Bun.Glob("*/*.json").scanSync(directory)),
      ).toHaveLength(3);
      expect(readCachedBalance("account-a", 1_004, directory)).toEqual([
        { credits: 3 },
      ]);
      expect(readCachedBalance("account-b", 1_004, directory)).toEqual([
        { credits: 2 },
      ]);
    }));

  test("hardens an existing cache directory", () =>
    withCacheDirectory((parent) => {
      const directory = join(parent, "existing");
      mkdirSync(directory, { mode: 0o755 });
      chmodSync(directory, 0o755);

      writeCachedBalance("account-a", [{ credits: 1 }], 1_000, directory);

      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }));

  test("rejects symlinked cache entries", () =>
    withCacheDirectory((directory) => {
      writeCachedBalance("account-a", [{ credits: 1 }], 1_000, directory);
      writeCachedBalance("account-b", [{ credits: 2 }], 1_000, directory);
      const outside = join(directory, "outside.json");
      writeFileSync(
        outside,
        JSON.stringify({ fetchedAt: 1_000, balance: [{ credits: 99 }] }),
      );
      const accountBDir = join(
        directory,
        createHash("sha256").update("account-b").digest("hex"),
      );
      const accountBJson = join(
        accountBDir,
        Array.from(new Bun.Glob("*.json").scanSync(accountBDir))[0]!,
      );
      unlinkSync(accountBJson);
      symlinkSync(outside, accountBJson);

      expect(readCachedBalance("account-b", 1_001, directory)).toBeNull();
      expect(readCachedBalance("account-a", 1_001, directory)).toEqual([
        { credits: 1 },
      ]);
    }));

  test("isolates ordinary tokens but shares rotating Codex account tokens", () => {
    expect(balanceCacheKey("kilo", "token-a")).not.toBe(
      balanceCacheKey("kilo", "token-b"),
    );
    const token = (account: string, suffix: string) => {
      const payload = btoa(
        JSON.stringify({
          "https://api.openai.com/auth": { chatgpt_account_id: account },
        }),
      );
      return `header.${payload}.${suffix}`;
    };
    expect(balanceCacheKey("openai-codex", token("a", "one"))).toBe(
      balanceCacheKey("openai-codex", token("a", "two")),
    );
    expect(balanceCacheKey("openai-codex", token("a", "one"))).not.toBe(
      balanceCacheKey("openai-codex", token("b", "one")),
    );
  });
});
