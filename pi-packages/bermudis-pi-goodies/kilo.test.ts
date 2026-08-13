import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import kilo, {
  abortableSleep,
  getKiloModelCompat,
  getKiloThinkingLevelMap,
  isFreeModel,
  modelSupportsReasoning,
  parsePrice,
  shouldUseResponsesApi,
  thinkingLevelMapFromVariants,
  type OpenRouterModel,
} from "./kilo.ts";

function captureKiloProvider(): ProviderConfig {
  let config: ProviderConfig | undefined;
  kilo({
    registerProvider(provider, registeredConfig) {
      if (provider === "kilo") config = registeredConfig;
    },
  } as unknown as ExtensionAPI);
  if (!config) throw new Error("Kilo provider was not registered");
  return config;
}

// Minimal OpenRouterModel factory; isFreeModel only reads id + pricing.
function model(
  id: string,
  pricing?: OpenRouterModel["pricing"],
): OpenRouterModel {
  return { id, name: id, context_length: 8192, pricing };
}

describe("catalog refresh", () => {
  test("extension registration performs no startup fetch", () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (() => {
      fetchCount++;
      throw new Error("unexpected startup fetch");
    }) as typeof fetch;

    try {
      const provider = captureKiloProvider();
      expect(fetchCount).toBe(0);
      expect(provider.models?.map(({ id }) => id)).toEqual(["kilo-auto/free"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reuses a fresh catalog instead of fetching on every picker refresh", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "example/model",
              name: "Example Model",
              context_length: 32_000,
              architecture: {
                input_modalities: ["text"],
                output_modalities: ["text"],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const provider = captureKiloProvider();
      const refreshModels = provider.refreshModels;
      if (!refreshModels)
        throw new Error("Kilo refresh hook was not registered");

      let stored:
        { models: readonly unknown[]; checkedAt?: number } | undefined;
      const context = {
        credential: { type: "api_key", key: "test-key" },
        store: {
          read: async () => stored,
          write: async (entry: {
            models: readonly unknown[];
            checkedAt?: number;
          }) => {
            stored = entry;
          },
          delete: async () => {
            stored = undefined;
          },
        },
        allowNetwork: true,
      } as unknown as Parameters<typeof refreshModels>[0];

      const first = await refreshModels(context);
      const second = await refreshModels(context);

      const reloadedProvider = captureKiloProvider();
      const reloadRefresh = reloadedProvider.refreshModels;
      if (!reloadRefresh)
        throw new Error("Reloaded Kilo refresh hook was not registered");
      const restored = await reloadRefresh({ ...context, allowNetwork: false });

      expect(first.map(({ id }) => id)).toEqual(["example/model"]);
      expect(second.map(({ id }) => id)).toEqual(["example/model"]);
      expect(restored.map(({ id }) => id)).toEqual(["example/model"]);
      expect(fetchCount).toBe(1);
      expect(stored?.models).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not warn when picker cancellation aborts a refresh", async () => {
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    let rejectFetch: ((error: Error) => void) | undefined;
    globalThis.fetch = (() =>
      new Promise<Response>((_resolve, reject) => {
        rejectFetch = reject;
      })) as typeof fetch;
    console.warn = (...args: unknown[]) => warnings.push(args);

    try {
      const provider = captureKiloProvider();
      const refreshModels = provider.refreshModels;
      if (!refreshModels)
        throw new Error("Kilo refresh hook was not registered");

      const controller = new AbortController();
      const context = {
        credential: { type: "api_key", key: "test-key" },
        stored: undefined,
        publish: async () => true,
        allowNetwork: true,
        signal: controller.signal,
      } as unknown as Parameters<typeof refreshModels>[0];

      const refresh = refreshModels(context);
      await Promise.resolve();
      controller.abort();
      rejectFetch?.(new Error("This operation was aborted"));
      await refresh;

      expect(warnings).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
    }
  });

  test("uses the Pi 0.84 stored snapshot and publication API", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "example/model",
              name: "Example Model",
              context_length: 32_000,
              architecture: {
                input_modalities: ["text"],
                output_modalities: ["text"],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const provider = captureKiloProvider();
      const refreshModels = provider.refreshModels;
      if (!refreshModels)
        throw new Error("Kilo refresh hook was not registered");

      let stored:
        { models: readonly unknown[]; checkedAt?: number } | undefined;
      let publishCount = 0;
      const context = {
        credential: { type: "api_key", key: "test-key" },
        stored: undefined,
        allowNetwork: true,
        signal: new AbortController().signal,
        publish: async (publication: {
          persist?: { models: readonly unknown[]; checkedAt?: number } | null;
        }) => {
          publishCount++;
          if (publication.persist) stored = publication.persist;
          return true;
        },
      } as unknown as Parameters<typeof refreshModels>[0];

      const first = await refreshModels(context);
      const reloadedProvider = captureKiloProvider();
      const reloadRefresh = reloadedProvider.refreshModels;
      if (!reloadRefresh)
        throw new Error("Reloaded Kilo refresh hook was not registered");
      const restored = await reloadRefresh({
        ...context,
        stored,
        allowNetwork: false,
      });

      expect(first.map(({ id }) => id)).toEqual(["example/model"]);
      expect(restored.map(({ id }) => id)).toEqual(["example/model"]);
      expect(fetchCount).toBe(1);
      expect(publishCount).toBe(1);
      expect(stored?.models).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

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

describe("modelSupportsReasoning", () => {
  test("trusts the supported_parameters declaration", () => {
    expect(
      modelSupportsReasoning({
        ...model("qwen/qwen3.7-flash"),
        supported_parameters: ["reasoning"],
      }),
    ).toBe(true);
  });

  test("recognizes enabled reasoning variants when the parameter is omitted", () => {
    expect(
      modelSupportsReasoning({
        ...model("qwen/qwen3.7-flash"),
        opencode: {
          variants: {
            instant: { reasoning: { enabled: false, effort: "none" } },
            thinking: { reasoning: { enabled: true, effort: "high" } },
          },
        },
      }),
    ).toBe(true);
  });

  test("does not treat an off-only variant as reasoning support", () => {
    expect(
      modelSupportsReasoning({
        ...model("some-model"),
        opencode: {
          variants: {
            none: { reasoning: { enabled: false, effort: "none" } },
          },
        },
      }),
    ).toBe(false);
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
      max: null,
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
      max: null,
    });
  });

  test("descriptive variants map by their declared effort", () => {
    const variants = {
      instant: { reasoning: { enabled: false, effort: "none" } },
      thinking: { reasoning: { enabled: true, effort: "high" } },
    };
    expect(thinkingLevelMapFromVariants(variants)).toEqual({
      off: "none",
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    });
  });

  test("max remains distinct from xhigh", () => {
    const variants = {
      high: { reasoning: { enabled: true, effort: "high" } },
      xhigh: { reasoning: { enabled: true, effort: "xhigh" } },
      max: { reasoning: { enabled: true, effort: "max" } },
    };
    expect(thinkingLevelMapFromVariants(variants)).toEqual({
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: "xhigh",
      max: "max",
    });
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
      max: null,
    });
  });

  test("deepseek-v4-pro fallback when variants are absent", () => {
    expect(getKiloThinkingLevelMap(model("deepseek/deepseek-v4-pro"))).toEqual({
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
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
