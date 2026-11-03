import { describe, expect, it } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import {
  filterModels,
  findSelectedIndex,
  getDistinctModelName,
  getModelSelectorSearchText,
  isDefaultModel,
  isDefaultSearch,
  sortModels,
  type ModelItem,
} from "./picker-models.ts";

function model(id: string, provider: string, name?: string): Model<any> {
  return {
    id,
    provider,
    name: name ?? id,
    api: "openai-completions",
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 4096,
  } as unknown as Model<any>;
}

function item(id: string, provider: string, name?: string): ModelItem {
  const m = model(id, provider, name);
  return { provider, id, model: m };
}

const fixtures: ModelItem[] = [
  item("claude-sonnet-4-5", "anthropic", "Claude Sonnet 4.5"),
  item("gpt-5", "openai"),
  item("kilo/glm-5.3", "kilo"),
  item("glm-5.3-flash", "zai", "GLM Flash"),
];

describe("getModelSelectorSearchText", () => {
  it("puts provider text first so provider-prefixed queries rank exact matches", () => {
    const text = getModelSelectorSearchText({
      id: "gpt-5",
      provider: "openai",
      name: "GPT-5",
    });
    expect(text).toBe("openai openai/gpt-5 openai gpt-5 GPT-5");
  });
  it("omits missing name", () => {
    const text = getModelSelectorSearchText({
      id: "gpt-5",
      provider: "openai",
    });
    expect(text).toBe("openai openai/gpt-5 openai gpt-5");
  });
});

describe("getDistinctModelName", () => {
  it("returns names that add words the id lacks", () => {
    expect(
      getDistinctModelName({ id: "kilo/glm-5.3", name: "GLM 5.3 via Kilo" }),
    ).toBe("GLM 5.3 via Kilo");
  });
  it("returns undefined for names that only restate the id", () => {
    expect(
      getDistinctModelName({ id: "glm-5.3-flash", name: "GLM 5.3 Flash" }),
    ).toBeUndefined();
    expect(
      getDistinctModelName({ id: "gpt-5", name: "GPT-5" }),
    ).toBeUndefined();
    expect(getDistinctModelName({ id: "gpt-5", name: "  " })).toBeUndefined();
  });
});

describe("isDefaultSearch", () => {
  it("matches prefixes of 'default'", () => {
    expect(isDefaultSearch("d")).toBe(true);
    expect(isDefaultSearch("Def")).toBe(true);
    expect(isDefaultSearch("default")).toBe(true);
  });
  it("rejects non-prefixes and empty queries", () => {
    expect(isDefaultSearch("dex")).toBe(false);
    expect(isDefaultSearch("defaults")).toBe(false);
    expect(isDefaultSearch("")).toBe(false);
    expect(isDefaultSearch("   ")).toBe(false);
  });
});

describe("isDefaultModel", () => {
  it("compares provider and id", () => {
    expect(
      isDefaultModel(
        { provider: "anthropic", id: "claude-sonnet-4-5" },
        { provider: "anthropic", id: "claude-sonnet-4-5" },
      ),
    ).toBe(true);
    expect(
      isDefaultModel(
        { provider: "anthropic", id: "claude-sonnet-4-5" },
        { provider: "openai", id: "claude-sonnet-4-5" },
      ),
    ).toBe(false);
    expect(
      isDefaultModel(
        { provider: "anthropic", id: "claude-sonnet-4-5" },
        undefined,
      ),
    ).toBe(false);
  });
});

describe("sortModels", () => {
  it("orders current first, default second, then by provider name", () => {
    const current = fixtures[3]!.model;
    const sorted = sortModels(fixtures, current, {
      provider: "openai",
      id: "gpt-5",
    });
    expect(sorted[0]?.model).toBe(current);
    expect(sorted[1]?.id).toBe("gpt-5");
    expect(sorted.map((i) => i.provider)).toEqual([
      "zai",
      "openai",
      "anthropic",
      "kilo",
    ]);
  });
  it("does not mutate the input", () => {
    const before = fixtures.map((i) => i.id);
    sortModels(fixtures, undefined, undefined);
    expect(fixtures.map((i) => i.id)).toEqual(before);
  });
});

describe("filterModels", () => {
  const def = { provider: "openai", id: "gpt-5" };

  it("passes the list through unchanged for an empty query", () => {
    expect(filterModels(fixtures, "", def)).toBe(fixtures);
  });

  it("fuzzy-filters over provider, provider/id, id and name", () => {
    expect(filterModels(fixtures, "sonnet", def).map((i) => i.id)).toEqual([
      "claude-sonnet-4-5",
    ]);
    expect(filterModels(fixtures, "anthropic", def).map((i) => i.id)).toEqual([
      "claude-sonnet-4-5",
    ]);
  });

  it("pins the default model to the top for a 'default' query even when it doesn't match", () => {
    const filtered = filterModels(fixtures, "def", def);
    expect(filtered[0]?.id).toBe("gpt-5");
  });

  it("returns no matches for garbage queries", () => {
    expect(filterModels(fixtures, "zzzzzz", def)).toEqual([]);
  });
});

describe("findSelectedIndex", () => {
  it("finds the current model", () => {
    const current = fixtures[2]!.model;
    expect(findSelectedIndex(fixtures, current, 0)).toBe(2);
  });
  it("clamps the fallback to the list", () => {
    expect(findSelectedIndex(fixtures, undefined, 99)).toBe(3);
    expect(findSelectedIndex([], undefined, 5)).toBe(0);
  });
});
