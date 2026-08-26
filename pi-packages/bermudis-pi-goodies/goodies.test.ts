import { describe, expect, test, beforeEach } from "bun:test";
import {
  isEnabled,
  setEnabled,
  listFeatures,
  getSummaryModel,
  setSummaryModel,
  __setConfigPathForTesting,
} from "./goodies";
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
