import { describe, expect, test, beforeEach } from "bun:test";
import {
  isEnabled,
  setEnabled,
  listFeatures,
  getSummaryModel,
  setSummaryModel,
  findSummaryModel,
  suggestSummaryModels,
  __setConfigPathForTesting,
  type SummaryModelRegistry,
} from "./goodies";
import goodiesDefault from "./goodies";
import type { Api, Model } from "@earendil-works/pi-ai";
import { readFileSync, unlinkSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let CONFIG_PATH: string;

function makeTestModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: `https://${provider}.test/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8000,
    maxTokens: 100,
  };
}

describe("goodies feature toggles", () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "goodies-test-"));
    CONFIG_PATH = join(dir, "goodies.json");
    __setConfigPathForTesting(CONFIG_PATH);
  });

  test("all features default to enabled", () => {
    const features = listFeatures();
    expect(features.length).toBeGreaterThan(0);
    for (const f of features) {
      expect(f.enabled).toBe(true);
    }
  });

  test("disable persists to config file", () => {
    setEnabled("clean-tui", false);
    expect(isEnabled("clean-tui")).toBe(false);
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw);
    expect(config["clean-tui"]).toBe(false);
  });

  test("enable removes the flag", () => {
    setEnabled("clean-tui", false);
    setEnabled("clean-tui", true);
    expect(isEnabled("clean-tui")).toBe(true);
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw);
    expect(config["clean-tui"]).toBe(true);
  });

  test("other features unaffected by one disable", () => {
    setEnabled("clean-tui", false);
    expect(isEnabled("kilo")).toBe(true);
    expect(isEnabled("provider-balance")).toBe(true);
  });

  test("summary-model setting round-trips and persists", () => {
    expect(getSummaryModel()).toBeUndefined();
    setSummaryModel("openai/gpt-oss-20b");
    expect(getSummaryModel()).toBe("openai/gpt-oss-20b");
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    expect(JSON.parse(raw)["summary-model"]).toBe("openai/gpt-oss-20b");
    // reset clears it
    setSummaryModel(undefined);
    expect(getSummaryModel()).toBeUndefined();
    expect(
      JSON.parse(readFileSync(CONFIG_PATH, "utf-8"))["summary-model"],
    ).toBeUndefined();
  });
});

describe("summary-model registry resolution", () => {
  const catalog = [
    makeTestModel("kilo", "xai/grok-4-fast"),
    makeTestModel("zai", "glm-5.3"),
  ];
  const registry: SummaryModelRegistry = {
    find: (provider, id) =>
      catalog.find((m) => m.provider === provider && m.id === id),
    getAvailable: () => catalog,
  };

  test("exact provider/id lookup wins", () => {
    const found = findSummaryModel(registry, "kilo/xai/grok-4-fast");
    expect(found?.provider).toBe("kilo");
    expect(found?.id).toBe("xai/grok-4-fast");
  });

  test("legacy bare-id values fall back to an id search", () => {
    // Pre-rework configs stored ids without a provider prefix; those must
    // keep resolving instead of dying silently.
    const found = findSummaryModel(registry, "glm-5.3");
    expect(found?.provider).toBe("zai");
    expect(found?.id).toBe("glm-5.3");
  });

  test("unknown models resolve to nothing", () => {
    expect(findSummaryModel(registry, "nope/missing")).toBeUndefined();
    expect(findSummaryModel(registry, "missing")).toBeUndefined();
  });

  test("suggestions match any query term against provider and id", () => {
    const s1 = suggestSummaryModels(registry, "kilo/nothing-here");
    expect(s1).toContain("kilo/xai/grok-4-fast");
    expect(s1).not.toContain("zai/glm-5.3");
    const s2 = suggestSummaryModels(registry, "glm");
    expect(s2).toEqual(["zai/glm-5.3"]);
    expect(suggestSummaryModels(registry, "")).toEqual([]);
  });
});

describe("/goodies summary-model handler", () => {
  /** Stub ExtensionAPI capturing the registered command options. */
  function registerGoodies(): {
    handler: (args: string, ctx: never) => Promise<void>;
  } {
    let captured!: { handler: (args: string, ctx: never) => Promise<void> };
    goodiesDefault({
      registerCommand: (_name: string, opts: typeof captured) => {
        captured = opts;
      },
    } as never);
    return captured;
  }

  function fakeCtx(registry?: object) {
    const notices: Array<{ msg: string; level: string }> = [];
    const ctx = {
      modelRegistry: registry,
      ui: {
        notify: (msg: string, level: string) => notices.push({ msg, level }),
      },
    };
    return { ctx, notices };
  }

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "goodies-handler-"));
    __setConfigPathForTesting(join(dir, "goodies.json"));
  });

  const catalog = [makeTestModel("kilo", "xai/grok-4-fast")];
  const registry = {
    find: (provider: string, id: string) =>
      catalog.find((m) => m.provider === provider && m.id === id),
    getAvailable: () => catalog,
  };

  test("valid values store canonically, including legacy bare ids", async () => {
    const cmd = registerGoodies();
    const { ctx, notices } = fakeCtx(registry);
    await cmd.handler("summary-model grok-4-x-typo", ctx as never); // unknown → rejected
    expect(getSummaryModel()).toBeUndefined();
    expect(notices[0].level).toBe("warning");
    expect(notices[0].msg).toContain("kilo/xai/grok-4-fast"); // close match suggested

    await cmd.handler("summary-model xai/grok-4-fast", ctx as never);
    expect(getSummaryModel()).toBe("kilo/xai/grok-4-fast"); // provider prefixed
    expect(notices[1].level).toBe("info");
  });

  test("unknown models are rejected with suggestions; no match changes nothing", async () => {
    setSummaryModel("kilo/xai/grok-4-fast");
    const cmd = registerGoodies();
    const { ctx, notices } = fakeCtx(registry);
    await cmd.handler("summary-model gemini/weird-stuff", ctx as never);
    expect(getSummaryModel()).toBe("kilo/xai/grok-4-fast"); // untouched
    expect(notices[0].level).toBe("warning");
    expect(notices[0].msg).toContain("Unknown model");
    expect(notices[0].msg).not.toContain("kilo/xai/grok-4-fast"); // no near match exists
  });

  test("missing auth warns but still persists; off resets", async () => {
    const warned = { ...registry, hasConfiguredAuth: () => false };
    const cmd = registerGoodies();
    const { ctx, notices } = fakeCtx(warned);
    await cmd.handler("summary-model kilo/xai/grok-4-fast", ctx as never);
    expect(getSummaryModel()).toBe("kilo/xai/grok-4-fast");
    expect(notices[0].level).toBe("info");
    expect(notices[0].msg).toContain("no auth configured");

    await cmd.handler("summary-model off", ctx as never);
    expect(getSummaryModel()).toBeUndefined();
  });

  test("status query mirrors the on/off state", async () => {
    const cmd = registerGoodies();
    const offView = fakeCtx(registry);
    await cmd.handler("summary-model", offView.ctx as never);
    expect(offView.notices[0].msg).toContain("off");

    setSummaryModel("kilo/xai/grok-4-fast");
    const onView = fakeCtx(registry);
    await cmd.handler("summary-model", onView.ctx as never);
    expect(onView.notices[0].msg).toContain("kilo/xai/grok-4-fast");
  });

  test("absent registry degrades to an unvalidated set with a warning", async () => {
    const cmd = registerGoodies();
    const { ctx, notices } = fakeCtx(undefined);
    await cmd.handler("summary-model zai/glm-5.3", ctx as never);
    expect(getSummaryModel()).toBe("zai/glm-5.3");
    expect(notices[0].level).toBe("warning");
    expect(notices[0].msg).toContain("could not validate");
  });
});
