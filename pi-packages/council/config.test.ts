import { describe, expect, test } from "bun:test";
import { splitModelId } from "./config.ts";

describe("splitModelId", () => {
  test("preserves slashes inside model IDs", () => {
    expect(splitModelId("provider/team/model")).toEqual({
      provider: "provider",
      id: "team/model",
    });
  });

  test("requires an exact provider/model identifier", () => {
    expect(() => splitModelId("model-only")).toThrow("provider/model");
    expect(() => splitModelId("/missing-provider")).toThrow("provider/model");
  });
});
