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
import type { Api, Model } from "@earendil-works/pi-ai";
import { readFileSync, unlinkSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let CONFIG_PATH: string;

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
  function model(provider: string, id: string): Model<Api> {
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

  const catalog = [model("kilo", "xai/grok-4-fast"), model("zai", "glm-5.3")];
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
