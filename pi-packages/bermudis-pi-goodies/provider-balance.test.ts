import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelSelectEvent,
} from "@earendil-works/pi-coding-agent";
import providerBalance, {
  formatCodexQuota,
  formatCredits,
  formatZaiQuota,
  parseCodexAccountId,
  parseCodexQuota,
  parseKiloBalance,
  parseZaiQuota,
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
            },
            {
              type: "TOKENS_LIMIT",
              unit: 3,
              number: 5,
              percentage: 25,
            },
          ],
        },
      }),
    ).toEqual({
      planName: "Pro",
      tokenWindows: [
        { usedPercent: 25, windowSeconds: 18_000 },
        { usedPercent: 40, windowSeconds: 604_800 },
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
    ).toBe("5h 75% left · 7d 60% left");
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
  test("parses whichever base windows the backend returns", () => {
    expect(
      parseCodexQuota({
        rate_limit: {
          primary_window: {
            used_percent: 25,
            limit_window_seconds: 18_000,
          },
          secondary_window: {
            used_percent: 40,
            limit_window_seconds: 604_800,
          },
        },
      }),
    ).toEqual({
      primary: { usedPercent: 25, windowSeconds: 18_000 },
      secondary: { usedPercent: 40, windowSeconds: 604_800 },
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
    ).toBe("5h 75% left · 7d 60% left");
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
    ).toBe("7d 89% left · Spark 7d 100% left");
  });

  test("clamps impossible percentages", () => {
    expect(
      formatCodexQuota({
        primary: { usedPercent: -10, windowSeconds: 60 },
        secondary: { usedPercent: 110, windowSeconds: 90 },
        additional: [],
      }),
    ).toBe("1m 100% left · 2m 0% left");
  });
});
