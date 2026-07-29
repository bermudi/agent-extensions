import { describe, expect, test } from "bun:test";
import {
  abortableSleep,
  formatCredits,
  getKiloModelCompat,
  getKiloThinkingLevelMap,
  isFreeModel,
  parsePrice,
  shouldUseResponsesApi,
  thinkingLevelMapFromVariants,
  type OpenRouterModel,
} from "./kilo.ts";

// Minimal OpenRouterModel factory; isFreeModel only reads id + pricing.
function model(
  id: string,
  pricing?: OpenRouterModel["pricing"],
): OpenRouterModel {
  return { id, name: id, context_length: 8192, pricing };
}

describe("parsePrice", () => {
  test("converts per-token to per-million-token", () => {
    // $0.001 per token == $1000 per million tokens
    expect(parsePrice("0.001")).toBe(1000);
    expect(parsePrice("0.00001")).toBe(10);
  });

  test("handles missing / invalid", () => {
    expect(parsePrice(undefined)).toBe(0);
    expect(parsePrice(null)).toBe(0);
    expect(parsePrice("")).toBe(0);
    expect(parsePrice("not-a-number")).toBe(0);
  });
});

describe("formatCredits", () => {
  test("compact form above 1000", () => {
    expect(formatCredits(1500)).toBe("$1.5k");
    expect(formatCredits(25000)).toBe("$25.0k");
  });

  test("two-decimal form below 1000", () => {
    expect(formatCredits(0)).toBe("$0.00");
    expect(formatCredits(12.5)).toBe("$12.50");
    expect(formatCredits(999.999)).toBe("$1000.00");
  });
});

describe("isFreeModel", () => {
  // Zero pricing is the first gate; a real :free model reports prompt/completion 0.
  const free = { prompt: "0", completion: "0" };

  test(":free suffix and kilo-native ids are free", () => {
    expect(isFreeModel(model("deepseek/deepseek-chat:free", free))).toBe(true);
    expect(isFreeModel(model("kilo-auto/free", free))).toBe(true);
    expect(isFreeModel(model("some-native-model", free))).toBe(true); // no slash
    expect(isFreeModel(model("kilo/whatever", free))).toBe(true);
  });

  test("priced models are not free", () => {
    expect(isFreeModel(model("anthropic/claude", { prompt: "0.003" }))).toBe(
      false,
    );
    expect(
      isFreeModel(
        model("openai/gpt", { prompt: "0.001", completion: "0.002" }),
      ),
    ).toBe(false);
  });

  test("zero-priced but non-free-convention ids are not trusted as free", () => {
    // zero pricing, but no :free / kilo / openrouter marker -> rejected
    expect(isFreeModel(model("random-vendor/model", free))).toBe(false);
  });
});

describe("shouldUseResponsesApi", () => {
  test("true for ai_sdk_provider 'openai'", () => {
    expect(
      shouldUseResponsesApi({
        ...model("openai/gpt-5.6-sol"),
        opencode: { ai_sdk_provider: "openai" },
      }),
    ).toBe(true);
  });

  test("true for current gpt-5 / o-series ids even without the tag", () => {
    expect(shouldUseResponsesApi(model("openai/gpt-5"))).toBe(true);
    expect(shouldUseResponsesApi(model("openai/gpt-5.5"))).toBe(true);
    expect(shouldUseResponsesApi(model("openai/o3-mini"))).toBe(true);
  });

  test("false for other providers", () => {
    expect(
      shouldUseResponsesApi({
        ...model("anthropic/claude-sonnet-4"),
        opencode: { ai_sdk_provider: "anthropic" },
      }),
    ).toBe(false);
    expect(shouldUseResponsesApi(model("meta-llama/llama-4"))).toBe(false);
  });
});

describe("getKiloModelCompat", () => {
  test("chat-completions models get openrouter reasoning format", () => {
    expect(getKiloModelCompat(model("meta-llama/llama-4"), undefined)).toEqual({
      thinkingFormat: "openrouter",
      supportsStore: false,
    });
  });

  test("anthropic chat-completions models also get anthropic cache control", () => {
    expect(
      getKiloModelCompat(model("anthropic/claude-sonnet-4"), undefined),
    ).toEqual({
      thinkingFormat: "openrouter",
      supportsStore: false,
      cacheControlFormat: "anthropic",
    });
  });

  test("responses-API models suppress session_id and long cache retention", () => {
    // openai-nosession drops the underscore `session_id` header that Kilo's
    // strict gateway rejects (post-0.80.7 migration of sendSessionIdHeader).
    expect(
      getKiloModelCompat(model("openai/gpt-5.6-sol"), "openai-responses"),
    ).toEqual({
      sessionAffinityFormat: "openai-nosession",
      supportsLongCacheRetention: false,
    });
  });

  test("deepseek-v4 completions models require reasoning_content on replays", () => {
    expect(
      getKiloModelCompat(model("deepseek/deepseek-v4-pro"), undefined),
    ).toEqual({
      thinkingFormat: "openrouter",
      supportsStore: false,
      requiresReasoningContentOnAssistantMessages: true,
    });
  });
});

describe("thinkingLevelMapFromVariants", () => {
  test("maps each level from variant reasoning efforts", () => {
    const variants = {
      none: { reasoning: { enabled: false, effort: "none" } },
      low: { reasoning: { enabled: true, effort: "low" } },
      medium: { reasoning: { enabled: true, effort: "medium" } },
      high: { reasoning: { enabled: true, effort: "high" } },
      xhigh: { reasoning: { enabled: true, effort: "xhigh" } },
    };
    expect(thinkingLevelMapFromVariants(variants)).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    });
  });

  test("absent levels become null (unsupported), except off", () => {
    // deepseek-v4-pro only advertises none/high/xhigh.
    const variants = {
      none: { reasoning: { enabled: false, effort: "none" } },
      high: { reasoning: { enabled: true, effort: "high" } },
      xhigh: { reasoning: { enabled: true, effort: "xhigh" } },
    };
    expect(thinkingLevelMapFromVariants(variants)).toEqual({
      off: "none",
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: "xhigh",
    });
  });

  test("a 'max' variant surfaces as xhigh when xhigh is absent", () => {
    const variants = {
      high: { reasoning: { enabled: true, effort: "high" } },
      max: { reasoning: { enabled: true, effort: "max" } },
    };
    const map = thinkingLevelMapFromVariants(variants)!;
    expect(map.xhigh).toBe("max");
  });

  test("empty / missing variants yield undefined", () => {
    expect(thinkingLevelMapFromVariants(undefined)).toBeUndefined();
    expect(thinkingLevelMapFromVariants({})).toBeUndefined();
  });
});

describe("getKiloThinkingLevelMap", () => {
  test("variant-derived map wins when present", () => {
    const m = {
      ...model("deepseek/deepseek-v4-pro"),
      opencode: {
        variants: {
          none: { reasoning: { enabled: false, effort: "none" } },
          high: { reasoning: { enabled: true, effort: "high" } },
          xhigh: { reasoning: { enabled: true, effort: "xhigh" } },
        },
      },
    };
    expect(getKiloThinkingLevelMap(m)).toEqual({
      off: "none",
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: "xhigh",
    });
  });

  test("deepseek-v4-pro fallback when variants are absent", () => {
    expect(getKiloThinkingLevelMap(model("deepseek/deepseek-v4-pro"))).toEqual({
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: "max",
    });
  });
});

describe("abortableSleep", () => {
  test("resolves after the delay", async () => {
    const start = Date.now();
    await abortableSleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  test("rejects immediately when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(abortableSleep(50, ac.signal)).rejects.toThrow(
      "Login cancelled",
    );
  });

  test("removes its abort listener when the sleep resolves (no leak)", async () => {
    // F7: a resolved sleep must remove its abort listener so a login polling
    // many iterations on one persistent signal doesn't accumulate listeners.
    const ac = new AbortController();
    const sig = ac.signal;
    let added = 0;
    let removed = 0;
    const origAdd = sig.addEventListener.bind(sig);
    const origRemove = sig.removeEventListener.bind(sig);
    sig.addEventListener = ((
      type: string,
      fn: EventListenerOrEventListenerObject,
      opts: boolean | AddEventListenerOptions | undefined,
    ) => {
      if (type === "abort") added++;
      return origAdd(type, fn, opts);
    }) as typeof sig.addEventListener;
    sig.removeEventListener = ((
      type: string,
      fn: EventListenerOrEventListenerObject,
      opts: boolean | AddEventListenerOptions | undefined,
    ) => {
      if (type === "abort") removed++;
      return origRemove(type, fn, opts);
    }) as typeof sig.removeEventListener;

    for (let i = 0; i < 5; i++) await abortableSleep(1, sig);

    expect(added).toBe(5);
    expect(removed).toBe(5); // every resolved sleep cleaned up its listener
  });

  test("signal stays usable after many resolved sleeps", async () => {
    const ac = new AbortController();
    for (let i = 0; i < 25; i++) await abortableSleep(1, ac.signal);
    ac.abort();
    await expect(abortableSleep(50, ac.signal)).rejects.toThrow(
      "Login cancelled",
    );
  });
});
