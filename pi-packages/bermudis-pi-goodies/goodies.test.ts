import { describe, expect, test, beforeEach } from "bun:test";
import {
  isEnabled,
  setEnabled,
  listFeatures,
  getSummaryModel,
  setSummaryModel,
  getThinkingSummariesEnabled,
  setThinkingSummariesEnabled,
  completeGoodiesArguments,
  __setCompletionModelsForTesting,
  wrapGoodiesAutocomplete,
  findSummaryModel,
  suggestSummaryModels,
  __setConfigPathForTesting,
  type SummaryModelRegistry,
} from "./goodies";
import goodiesDefault from "./goodies";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import {
  readFileSync,
  unlinkSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setGoodiesLogPathForTesting } from "./goodies-log";

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

  test("writes merge with changes another session made since startup", () => {
    // Several pi sessions share ~/.pi/agent/goodies.json, each holding the
    // config it loaded at startup. A write from a long-lived session must not
    // revert what a newer one stored — that is how a configured summary-model
    // kept disappearing behind an unrelated /goodies toggle.
    // Thinking summaries are session-only: enabling them must not touch the
    // file, so other sessions' persisted settings always survive.
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ "summary-model": "other/session-model", tps: false }),
    );
    setThinkingSummariesEnabled(true);
    expect(getThinkingSummariesEnabled()).toBe(true);
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(config["summary-model"]).toBe("other/session-model");
    expect(config.tps).toBe(false);
    expect(config["thinking-summaries"]).toBeUndefined();
  });

  test("corrupt config logs a failure and falls back to defaults", () => {
    // Regression: a bare catch → {} silently reset every feature with zero
    // log output, and the next save overwrote the corrupt file, destroying
    // the evidence. Now the error is logged via reportFailure.
    const logDir = mkdtempSync(join(tmpdir(), "goodies-log-"));
    const logPath = join(logDir, "goodies.log");
    setGoodiesLogPathForTesting(logPath);

    // Write a corrupt config file, then reload via __setConfigPathForTesting
    // (which calls loadConfig internally).
    writeFileSync(CONFIG_PATH, "{ this is not valid json,,,");
    __setConfigPathForTesting(CONFIG_PATH);

    // Defaults: all features enabled.
    expect(isEnabled("clean-tui")).toBe(true);
    expect(isEnabled("kilo")).toBe(true);

    // The failure was logged.
    const log = readFileSync(logPath, "utf-8");
    expect(log).toContain("config_error");
    expect(log).toContain("failed to load config");

    setGoodiesLogPathForTesting(undefined);
  });

  test("non-object config roots (null/true/number/array) log and fall back to defaults", () => {
    // Regression: valid JSON such as null, true, 42, or [] parsed cleanly and
    // bypassed the catch — but later code dereferences config[name] (and
    // delete config[...]) which crashes on null/primitives, or silently
    // misbehaves on arrays. A non-object root is just as unusable as a syntax
    // error, so it must log config_error and return defaults.
    for (const raw of ["null", "true", "42", '"hello"', "[]"]) {
      const logDir = mkdtempSync(join(tmpdir(), "goodies-log-"));
      const logPath = join(logDir, "goodies.log");
      setGoodiesLogPathForTesting(logPath);

      writeFileSync(CONFIG_PATH, raw);
      __setConfigPathForTesting(CONFIG_PATH);

      // Defaults: all features enabled, no crash.
      expect(isEnabled("clean-tui")).toBe(true);
      expect(isEnabled("kilo")).toBe(true);

      const log = readFileSync(logPath, "utf-8");
      expect(log).toContain("config_error");
      expect(log).toContain("failed to load config");

      setGoodiesLogPathForTesting(undefined);
    }
  });

  test("missing config file (ENOENT) stays silent and returns defaults", () => {
    // First run: no goodies.json yet. This is expected, not a failure —
    // loadConfig must NOT log a config_error for ENOENT.
    const logDir = mkdtempSync(join(tmpdir(), "goodies-log-"));
    const logPath = join(logDir, "goodies.log");
    setGoodiesLogPathForTesting(logPath);

    // Point at a path that doesn't exist yet (no file written).
    const missingPath = join(
      mkdtempSync(join(tmpdir(), "goodies-missing-")),
      "goodies.json",
    );
    __setConfigPathForTesting(missingPath);

    expect(isEnabled("clean-tui")).toBe(true);

    // No log entry — ENOENT is not a failure.
    expect(existsSync(logPath)).toBe(false);

    setGoodiesLogPathForTesting(undefined);
  });

  test("config is written atomically (temp file + rename, no partial writes)", () => {
    // The old saveConfig used writeFileSync directly — a crash mid-write
    // left a truncated goodies.json that the bare catch then silently reset.
    // writeJsonFileAtomic writes to a temp file and renames, so the config
    // is either fully old or fully new, never partial.
    setEnabled("clean-tui", false);
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    // The file must be valid JSON (the atomic write completed).
    const config = JSON.parse(raw);
    expect(config["clean-tui"]).toBe(false);
    // No leftover temp files in the directory.
    const dir = CONFIG_PATH.slice(0, CONFIG_PATH.lastIndexOf("/"));
    const { readdirSync } = require("node:fs");
    const files = readdirSync(dir);
    expect(files).toEqual(["goodies.json"]);
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

  test("suggestions rank prefix matches above fragment-only matches", () => {
    // Regression: suggestions were an unranked filter+slice, so the obvious
    // answer could be cut by unrelated models that sat earlier in the
    // registry — "1min/grok-4-fast-nonthinking" (a typo for
    // 1min/grok-4-fast-non-reasoning) surfaced opencode/openrouter models
    // that merely shared the fragments "grok"/"fast".
    const catalog = [
      makeTestModel("opencode", "grok-4.5"),
      makeTestModel("opencode", "grok-4.6"),
      makeTestModel("openrouter", "anthropic/claude-opus-4.7-fast"),
      makeTestModel("1min", "grok-4-fast-non-reasoning"),
    ];
    const typoRegistry: SummaryModelRegistry = {
      find: () => undefined,
      getAvailable: () => catalog,
    };
    const s = suggestSummaryModels(
      typoRegistry,
      "1min/grok-4-fast-nonthinking",
    );
    expect(s[0]).toBe("1min/grok-4-fast-non-reasoning");
    expect(s).toContain("opencode/grok-4.5");
  });
});

describe("/goodies summary-model handler", () => {
  /** Stub ExtensionAPI capturing the registered command options. */
  function registerGoodies(): {
    handler: (args: string, ctx: never) => Promise<void>;
  } {
    let captured!: { handler: (args: string, ctx: never) => Promise<void> };
    goodiesDefault({
      on: () => {},
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

describe("/goodies thinking-summaries handler", () => {
  /** Stub ExtensionAPI capturing the registered command options. */
  function registerGoodies(): {
    handler: (args: string, ctx: never) => Promise<void>;
  } {
    let captured!: { handler: (args: string, ctx: never) => Promise<void> };
    goodiesDefault({
      on: () => {},
      registerCommand: (_name: string, opts: typeof captured) => {
        captured = opts;
      },
    } as never);
    return captured;
  }

  function fakeCtx() {
    const notices: Array<{ msg: string; level: string }> = [];
    const ctx = {
      ui: {
        notify: (msg: string, level: string) => notices.push({ msg, level }),
      },
    };
    return { ctx, notices };
  }

  let thinkingConfigPath: string;
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "goodies-thinking-flag-"));
    thinkingConfigPath = join(dir, "goodies.json");
    __setConfigPathForTesting(thinkingConfigPath);
  });

  test("on/off is session-only; default is off", async () => {
    expect(getThinkingSummariesEnabled()).toBe(false);
    const cmd = registerGoodies();
    const { ctx, notices } = fakeCtx();

    await cmd.handler("thinking-summaries on", ctx as never);
    expect(getThinkingSummariesEnabled()).toBe(true);
    expect(notices[0].level).toBe("info");
    // Session-only: the file never carries the key.
    if (existsSync(thinkingConfigPath)) {
      expect(
        JSON.parse(readFileSync(thinkingConfigPath, "utf-8"))[
          "thinking-summaries"
        ],
      ).toBeUndefined();
    }
    // No summary model on the scratch config: says so.
    expect(notices[0].msg).toContain("summary-model");
    expect(notices[0].msg).toContain("this pi run only");

    await cmd.handler("thinking-summaries off", ctx as never);
    expect(getThinkingSummariesEnabled()).toBe(false);
  });

  test("a fresh config scope resets to off", async () => {
    const cmd = registerGoodies();
    const { ctx } = fakeCtx();
    await cmd.handler("thinking-summaries on", ctx as never);
    expect(getThinkingSummariesEnabled()).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "goodies-thinking-fresh-"));
    __setConfigPathForTesting(join(dir, "goodies.json"));
    expect(getThinkingSummariesEnabled()).toBe(false);
  });

  test("on with a summary model set does not nag", async () => {
    setSummaryModel("kilo/xai/grok-4-fast");
    const cmd = registerGoodies();
    const { ctx, notices } = fakeCtx();
    await cmd.handler("thinking-summaries on", ctx as never);
    expect(getThinkingSummariesEnabled()).toBe(true);
    expect(notices[0].msg).not.toContain("summary-model");
  });

  test("anything but on/off is a usage warning and changes nothing", async () => {
    const cmd = registerGoodies();
    const { ctx, notices } = fakeCtx();
    await cmd.handler("thinking-summaries maybe", ctx as never);
    expect(getThinkingSummariesEnabled()).toBe(false);
    expect(notices[0].level).toBe("warning");
    expect(notices[0].msg).toContain("currently off");
  });

  test("list shows the thinking-summaries state", async () => {
    const cmd = registerGoodies();
    const { ctx, notices } = fakeCtx();
    await cmd.handler("list", ctx as never);
    expect(notices[0].msg).toContain(
      "thinking summaries: off — run /goodies thinking-summaries on to enable",
    );
    setThinkingSummariesEnabled(true);
    const after = fakeCtx();
    await cmd.handler("list", after.ctx as never);
    expect(after.notices[0].msg).toContain("thinking summaries: on");
    expect(after.notices[0].msg).toContain("no summary model set");
  });
});

describe("/goodies argument completion", () => {
  test("subcommands take a trailing space only when they expect an argument", () => {
    expect(completeGoodiesArguments("")?.map((i) => i.value)).toEqual([
      "list",
      "enable ",
      "disable ",
      "summary-model ",
      "thinking-summaries ",
    ]);
    expect(completeGoodiesArguments("en")).toEqual([
      { value: "enable ", label: "enable" },
    ]);
    expect(completeGoodiesArguments("di")).toEqual([
      { value: "disable ", label: "disable" },
    ]);
    expect(completeGoodiesArguments("l")).toEqual([
      { value: "list", label: "list" },
    ]);
  });

  test("enable/disable values complete without a trailing space", () => {
    expect(completeGoodiesArguments("enable co")).toEqual([
      { value: "enable copy-with-model", label: "copy-with-model" },
      { value: "enable copy-trajectory", label: "copy-trajectory" },
    ]);
    expect(completeGoodiesArguments("disable tps")).toEqual([
      { value: "disable tps", label: "tps" },
    ]);
    const all = completeGoodiesArguments("disable ");
    expect(all).toHaveLength(listFeatures().length);
    expect(all?.[0]).toEqual({
      value: "disable copy-with-model",
      label: "copy-with-model",
    });
  });

  test("thinking-summaries completes on/off", () => {
    expect(completeGoodiesArguments("thinking-summaries ")).toEqual([
      { value: "thinking-summaries on", label: "on" },
      { value: "thinking-summaries off", label: "off" },
    ]);
    expect(completeGoodiesArguments("thinking-summaries of")).toEqual([
      { value: "thinking-summaries off", label: "off" },
    ]);
  });

  test("summary-model completes off/default then ranked catalogue models", () => {
    __setCompletionModelsForTesting([
      "zai/glm-5.3-flash",
      "google/gemini-2.5-flash",
      "anthropic/claude-opus-4-6",
    ]);
    // Empty token: clears first, then the whole catalogue alphabetically.
    // Values carry the verb (see the regression test below).
    const all = completeGoodiesArguments("summary-model ")!.map((i) => i.value);
    expect(all.slice(0, 2)).toEqual([
      "summary-model off",
      "summary-model default",
    ]);
    expect(all.slice(2)).toEqual([
      "summary-model anthropic/claude-opus-4-6",
      "summary-model google/gemini-2.5-flash",
      "summary-model zai/glm-5.3-flash",
    ]);
    // Prefix match wins over contains.
    expect(
      completeGoodiesArguments("summary-model google/g")!.map((i) => i.value),
    ).toEqual(["summary-model google/gemini-2.5-flash"]);
    expect(
      completeGoodiesArguments("summary-model zai")!.map((i) => i.value),
    ).toEqual(["summary-model zai/glm-5.3-flash"]);
    // Clear words still complete when they uniquely prefix-match.
    expect(completeGoodiesArguments("summary-model of")).toEqual([
      { value: "summary-model off", label: "off" },
    ]);
    __setCompletionModelsForTesting([]);
  });

  test("summary-model selections keep the verb when pi replaces the argument span", () => {
    // Regression: item values used to be bare ("off", "provider/model") while
    // both of pi's application paths (slash-argument completion and the
    // forced-Tab wrapper) hand the editor prefix: argumentText, and the
    // editor replaces that entire span with item.value — accepting a
    // completion rewrote "/goodies summary-model 1min/gro" into
    // "/goodies 1min/grok-4-fast-non-reasoning", wiping the subcommand.
    __setCompletionModelsForTesting(["1min/grok-4-fast-non-reasoning"]);
    const argumentText = "summary-model 1min/gro";
    const items = completeGoodiesArguments(argumentText)!;
    // pi semantics: line keeps everything before the argument text, then the
    // selected item's value replaces the whole span.
    const applied = `/goodies ${items.find((i) => i.label === "1min/grok-4-fast-non-reasoning")!.value}`;
    expect(applied).toBe(
      "/goodies summary-model 1min/grok-4-fast-non-reasoning",
    );
    __setCompletionModelsForTesting([]);
  });

  test("unknown subcommands and values produce no completions", () => {
    expect(completeGoodiesArguments("frobnicate")).toBeNull();
    expect(completeGoodiesArguments("summary-model some/model")).toBeNull();
    expect(completeGoodiesArguments("enable nope")).toBeNull();
  });
});

describe("/goodies forced-Tab autocomplete wrapper", () => {
  function fakeProvider() {
    const calls = { suggestions: 0, applied: 0 };
    const provider: AutocompleteProvider = {
      async getSuggestions() {
        calls.suggestions += 1;
        return { items: [{ value: "src/", label: "src/" }], prefix: "" };
      },
      applyCompletion(lines, cursorLine, cursorCol) {
        calls.applied += 1;
        return { lines, cursorLine, cursorCol };
      },
      shouldTriggerFileCompletion: () => true,
    };
    return { provider, calls };
  }

  const force = { signal: new AbortController().signal, force: true };

  test("Tab in /goodies argument context lists features, never cwd paths", async () => {
    const { provider, calls } = fakeProvider();
    const wrapped = wrapGoodiesAutocomplete(provider);
    const line = "/goodies disable ";
    const result = await wrapped.getSuggestions([line], 0, line.length, force);
    expect(result?.prefix).toBe("disable ");
    expect(result?.items).toHaveLength(listFeatures().length);
    expect(result?.items[0]).toEqual({
      value: "disable copy-with-model",
      label: "copy-with-model",
    });
    expect(calls.suggestions).toBe(0);
  });

  test("claims argument context even with nothing to offer (no path fallback)", async () => {
    const { provider, calls } = fakeProvider();
    const wrapped = wrapGoodiesAutocomplete(provider);
    const line = "/goodies summary-model ";
    expect(wrapped.shouldTriggerFileCompletion([line], 0, line.length)).toBe(
      true,
    );
    // With an empty stashed catalogue the clear words still complete — the
    // claimed context never falls through to file completion.
    const offered = await wrapped.getSuggestions([line], 0, line.length, force);
    expect(offered?.items.map((i) => i.value)).toEqual([
      "summary-model off",
      "summary-model default",
    ]);
    expect(calls.suggestions).toBe(0);
  });

  test("non-forced requests and other lines delegate untouched", async () => {
    const { provider, calls } = fakeProvider();
    const wrapped = wrapGoodiesAutocomplete(provider);
    const line = "/goodies disable ";
    await wrapped.getSuggestions([line], 0, line.length, {
      ...force,
      force: false,
    });
    await wrapped.getSuggestions(["git status"], 0, 10, force);
    // A /goodies-looking line deeper in a multi-line draft is not slash context.
    await wrapped.getSuggestions(["# note", line], 1, line.length, force);
    expect(calls.suggestions).toBe(3);
    expect(wrapped.shouldTriggerFileCompletion(["git status"], 0, 10)).toBe(
      true,
    );
    wrapped.applyCompletion(
      [line],
      0,
      line.length,
      { value: "disable tps", label: "tps" },
      "disable ",
    );
    expect(calls.applied).toBe(1);
  });
});

describe("/goodies autocomplete registration", () => {
  test("session_start installs the wrapper once per extension load", () => {
    let handler!: (event: never, ctx: never) => void;
    const factories: unknown[] = [];
    goodiesDefault({
      on: (event: string, registered: typeof handler) => {
        expect(event).toBe("session_start");
        handler = registered;
      },
      registerCommand: () => {},
    } as never);
    const ctx = {
      ui: {
        addAutocompleteProvider: (factory: unknown) => factories.push(factory),
      },
    };
    handler({} as never, ctx as never);
    handler({} as never, ctx as never);
    expect(factories).toEqual([wrapGoodiesAutocomplete]);
  });
});
