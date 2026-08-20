import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import modelThinking, {
  buildLadder,
  collectLevels,
  cycleLevel,
  LevelsSelectorComponent,
  mergeStoredLevels,
  modelKey,
  parseStoredLevels,
  readStoredLevels,
  writeStoredLevels,
} from "./model-thinking.ts";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type StoredLevel = ThinkingLevel | "off";
type Model = NonNullable<ExtensionContext["model"]>;
type Handler = (event: never, ctx: ExtensionContext) => unknown;

function model(provider: string, id: string): Model {
  return { provider, id } as Model;
}

function levelsPath(): string {
  return join(mkdtempSync(join(tmpdir(), "model-thinking-")), "levels.json");
}

function context(
  activeModel: Model | undefined,
  notifications: string[] = [],
  scopedModels: readonly { model: Model; thinkingLevel?: ThinkingLevel }[] = [],
  sessionEntries: unknown[] = [],
): ExtensionContext {
  return {
    model: activeModel,
    scopedModels,
    mode: "tui",
    hasUI: true,
    sessionManager: {
      getEntries: () => sessionEntries,
    },
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext;
}

class PiHarness {
  level: ThinkingLevel = "off";
  readonly handlers = new Map<string, Handler[]>();
  readonly commands = new Map<
    string,
    (args: string, ctx: ExtensionContext) => Promise<void>
  >();
  /**
   * When set, setThinkingLevel clamps the requested level to the nearest
   * value in this list (like Pi does per model capabilities). When unset,
   * the level is accepted as-is.
   */
  availableLevels: readonly ThinkingLevel[] | undefined;
  /**
   * When true, getThinkingLevel throws — mirroring Pi's "runtime not
   * initialized" stub during extension loading. Used to verify the factory
   * defers all runtime calls to event handlers.
   */
  throwOnGetLevel = false;

  readonly api = {
    on: (event: string, handler: Handler) => {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
    },
    registerCommand: (
      name: string,
      options: {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      },
    ) => {
      this.commands.set(name, options.handler);
    },
    getThinkingLevel: () => {
      if (this.throwOnGetLevel) {
        throw new Error(
          "Extension runtime not initialized. Action methods cannot be called during extension loading.",
        );
      }
      return this.level;
    },
    setThinkingLevel: (level: ThinkingLevel) => {
      const effective = this.clamp(level);
      if (effective === this.level) return;
      const previous = this.level;
      this.level = effective;
      // Pi emits thinking_level_select synchronously inside setThinkingLevel
      // (the handler runs before the first await in emit). Mirror that so
      // the extension's managed-event suppression is exercised.
      for (const handler of this.handlers.get("thinking_level_select") ?? []) {
        handler(
          { level: effective, previousLevel: previous } as never,
          {} as ExtensionContext,
        );
      }
    },
  } as unknown as ExtensionAPI;

  private clamp(level: ThinkingLevel): ThinkingLevel {
    if (!this.availableLevels) return level;
    if (this.availableLevels.includes(level)) return level;
    // Clamp to the nearest supported level (like Pi's clampThinkingLevel).
    const order: readonly ThinkingLevel[] = [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ];
    const requestedRank = order.indexOf(level);
    const available = this.availableLevels
      .slice()
      .sort((a, b) => order.indexOf(a) - order.indexOf(b));
    // Pick the closest available level at or below the requested rank;
    // if none, pick the lowest available above.
    let result: ThinkingLevel | undefined;
    for (const candidate of available) {
      if (order.indexOf(candidate) <= requestedRank) {
        result = candidate;
      }
    }
    return result ?? available[0] ?? "off";
  }

  async emit(
    event: string,
    payload: object,
    ctx: ExtensionContext,
  ): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(payload as never, ctx);
    }
  }
}

async function withArgv(
  args: string[],
  operation: () => Promise<void>,
): Promise<void> {
  const original = process.argv;
  process.argv = args;
  try {
    await operation();
  } finally {
    process.argv = original;
  }
}

/**
 * Flush the macrotask queue so a deferred setTimeout(0) save completes.
 * The extension defers inheritedLevel saves to the next macrotask so that
 * model_select/session_start can cancel Pi-internal thinking_level_select
 * events. Tests that need to observe the saved value must await this.
 */
function flushTimers(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1));
}

describe("model-thinking sidecar", () => {
  test("round-trips stored levels", () => {
    const path = levelsPath();
    writeStoredLevels({ "zai/glm-5.3": "high", "kilo/x": "off" }, path);
    expect(readStoredLevels(path)).toEqual({
      "zai/glm-5.3": "high",
      "kilo/x": "off",
    });
  });

  test("missing sidecar reads as empty", () => {
    expect(readStoredLevels(join(levelsPath(), "absent.json"))).toEqual({});
  });

  test("rethrows read errors other than a missing file", () => {
    // A directory path fails with EISDIR, not ENOENT: the failure must
    // surface instead of being silently read as an empty sidecar.
    const dir = mkdtempSync(join(tmpdir(), "model-thinking-dir-"));
    expect(() => readStoredLevels(dir)).toThrow();
  });

  test("corrupt sidecar reads as empty and surfaces the failure", () => {
    const path = levelsPath();
    writeFileSync(path, "{not json");
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      expect(readStoredLevels(path)).toEqual({});
    } finally {
      console.error = original;
    }
    expect(errors.length).toBe(1);
  });

  test("rejects invalid shapes and values", () => {
    expect(() => parseStoredLevels([])).toThrow();
    expect(() => parseStoredLevels(null)).toThrow();
    expect(() => parseStoredLevels({ "no-slash": "high" })).toThrow();
    expect(() => parseStoredLevels({ "zai/glm": "bogus" })).toThrow();
    expect(parseStoredLevels({ "zai/glm": "xhigh" })).toEqual({
      "zai/glm": "xhigh",
    });
  });

  test("rejects keys with an empty provider or id", () => {
    expect(() => parseStoredLevels({ "/": "high" })).toThrow();
    expect(() => parseStoredLevels({ "provider/": "high" })).toThrow();
    expect(() => parseStoredLevels({ "/id": "high" })).toThrow();
    expect(parseStoredLevels({ "provider/id": "high" })).toEqual({
      "provider/id": "high",
    });
    expect(parseStoredLevels({ "provider/nested/id": "high" })).toEqual({
      "provider/nested/id": "high",
    });
  });

  test("builds the inherit-first ladder from model support", () => {
    const reasoning = { reasoning: true } as unknown as Model;
    const flat = { reasoning: false } as unknown as Model;
    expect(buildLadder(reasonedModel())).toEqual([
      undefined,
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(buildLadder(flat)).toEqual([undefined, "off"]);
    expect(buildLadder(reasoning)).toContain(undefined);
  });
});

function reasonedModel(): Model {
  return {
    provider: "zai",
    id: "glm",
    reasoning: true,
  } as unknown as Model;
}

describe("cycleLevel", () => {
  const ladder: (StoredLevel | undefined)[] = [undefined, "off", "low", "high"];

  test("forward from inherit enters the first supported level", () => {
    expect(cycleLevel(ladder, undefined, 1)).toBe("off");
  });

  test("forward from the last rung wraps to inherit", () => {
    expect(cycleLevel(ladder, "high", 1)).toBe(undefined);
  });

  test("backward from inherit wraps to the last rung", () => {
    expect(cycleLevel(ladder, undefined, -1)).toBe("high");
  });

  test("backward from the first rung wraps to inherit", () => {
    expect(cycleLevel(ladder, "off", -1)).toBe(undefined);
  });

  test("steps one rung at a time mid-ladder", () => {
    expect(cycleLevel(ladder, "low", 1)).toBe("high");
    expect(cycleLevel(ladder, "high", -1)).toBe("low");
  });

  test("snaps an unsupported stored value to inherit from either direction", () => {
    expect(cycleLevel(ladder, "max", 1)).toBe(undefined);
    expect(cycleLevel(ladder, "max", -1)).toBe(undefined);
  });
});

describe("collectLevels", () => {
  test("drops rows left on inherit and keeps explicit levels", () => {
    expect(
      collectLevels({ "zai/glm": undefined, "kilo/flash": "xhigh" }, [
        { key: "zai/glm" },
        { key: "kilo/flash" },
      ]),
    ).toEqual({ "kilo/flash": "xhigh" });
  });

  test("keeps stored keys for models that are no longer scoped", () => {
    expect(
      collectLevels({ "zai/glm": "high", "old/model": "low" }, [
        { key: "zai/glm" },
      ]),
    ).toEqual({ "zai/glm": "high", "old/model": "low" });
  });

  test("a stored level cycled back to inherit is removed", () => {
    const values: Record<string, StoredLevel | undefined> = {
      "zai/glm": "high",
    };
    values["zai/glm"] = cycleLevel([undefined, "off", "high"], "high", 1);
    expect(collectLevels(values, [{ key: "zai/glm" }])).toEqual({});
  });
});

describe("mergeStoredLevels", () => {
  test("keeps another session's changes to rows left untouched here", () => {
    const rows = [{ key: "zai/glm" }, { key: "kilo/flash" }];
    expect(
      mergeStoredLevels(
        { "zai/glm": "low", "kilo/flash": "off" },
        { "zai/glm": "high", "kilo/flash": "off" },
        { "zai/glm": "low", "kilo/flash": "xhigh" },
        rows,
      ),
    ).toEqual({ "zai/glm": "high", "kilo/flash": "xhigh" });
  });
});

describe("levels selector component", () => {
  const plainTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;

  const UP = "\x1b[A";
  const DOWN = "\x1b[B";
  const LEFT = "\x1b[D";
  const RIGHT = "\x1b[C";
  const ENTER = "\r";
  const ESCAPE = "\x1b";

  const ladder = (...levels: StoredLevel[]): (StoredLevel | undefined)[] => [
    undefined,
    ...levels,
  ];
  const rows = [
    { key: "zai/glm", ladder: ladder("off", "high") },
    { key: "kilo/flash", ladder: ladder("off", "low", "xhigh") },
  ];

  function selector(
    rowList: typeof rows,
    values: Record<string, StoredLevel | undefined> = {},
  ) {
    let calls = 0;
    let cancelled = false;
    let saved: Record<string, StoredLevel> | undefined;
    const component = new LevelsSelectorComponent(
      "Thinking levels",
      rowList,
      undefined,
      values,
      plainTheme,
      (result) => {
        calls += 1;
        cancelled = result === undefined;
        saved = result;
      },
    );
    return {
      component,
      doneCalls: () => calls,
      wasCancelled: () => cancelled,
      saved: () => saved,
    };
  }

  test("navigates with j/k and cycles the selected row", () => {
    const s = selector(rows);
    s.component.handleInput(RIGHT); // row 0: inherit -> off
    s.component.handleInput("j"); // move to row 1
    s.component.handleInput(RIGHT); // row 1: inherit -> off
    s.component.handleInput(ENTER);

    expect(s.doneCalls()).toBe(1);
    expect(s.wasCancelled()).toBe(false);
    expect(s.saved()).toEqual({ "zai/glm": "off", "kilo/flash": "off" });
  });

  test("arrow keys navigate and cycle backward with wrap", () => {
    const s = selector(rows);
    s.component.handleInput(DOWN); // move to row 1
    s.component.handleInput(LEFT); // inherit wraps backward to xhigh
    s.component.handleInput(ENTER);

    expect(s.saved()).toEqual({ "kilo/flash": "xhigh" });
  });

  test("recognizes Kitty keyboard-protocol arrows and vim keys", () => {
    const s = selector(rows);
    s.component.handleInput("\x1b[1;1B"); // Kitty down
    s.component.handleInput("\x1b[108u"); // Kitty l
    s.component.handleInput("\x1b[1;1D"); // Kitty left
    s.component.handleInput("\x1b[104u"); // Kitty h
    s.component.handleInput(ENTER);

    expect(s.saved()).toEqual({ "kilo/flash": "xhigh" });
  });

  test("keeps the selected row in a bounded scrolling window", () => {
    const manyRows = Array.from({ length: 9 }, (_, index) => ({
      key: `provider/model-${index}`,
      ladder: ladder("off"),
    }));
    initTheme(undefined, false);
    const s = selector(manyRows);

    let text = s.component.render(80).join("\n");
    expect(text).toContain("provider/model-0");
    expect(text).toContain("provider/model-6");
    expect(text).not.toContain("provider/model-8");
    expect(text).toContain("(1/9)");

    for (let index = 0; index < 8; index++) s.component.handleInput(DOWN);
    text = s.component.render(80).join("\n");
    expect(text).toContain("provider/model-8");
    expect(text).not.toContain("provider/model-0");
    expect(text).toContain("(9/9)");
  });

  test("k clamps at the top row", () => {
    const s = selector(rows);
    s.component.handleInput("k"); // stays on row 0
    s.component.handleInput(RIGHT); // cycles row 0, not row 1
    s.component.handleInput(ENTER);

    expect(s.saved()).toEqual({ "zai/glm": "off" });
  });

  test("j clamps at the bottom row", () => {
    const s = selector(rows);
    s.component.handleInput("j");
    s.component.handleInput("j"); // clamped on row 1
    s.component.handleInput(RIGHT);
    s.component.handleInput(ENTER);

    expect(s.saved()).toEqual({ "kilo/flash": "off" });
  });

  test("Enter finishes once; later input cannot reopen or flip the result", () => {
    const s = selector(rows);
    s.component.handleInput(RIGHT);
    s.component.handleInput(ENTER);
    s.component.handleInput(RIGHT); // no-op after close
    s.component.handleInput(ESCAPE); // must not turn the save into a cancel

    expect(s.doneCalls()).toBe(1);
    expect(s.wasCancelled()).toBe(false);
    expect(s.saved()).toEqual({ "zai/glm": "off" });
  });

  test("escape cancels without saving", () => {
    const s = selector(rows);
    s.component.handleInput(RIGHT);
    s.component.handleInput(ESCAPE);

    expect(s.doneCalls()).toBe(1);
    expect(s.wasCancelled()).toBe(true);
    expect(s.saved()).toBeUndefined();
  });

  test("renders model keys, inherit labels, and stored levels", () => {
    // DynamicBorder (pi's component) reads pi's global theme in render().
    initTheme(undefined, false);
    const s = selector(rows, { "zai/glm": "high" });
    const text = s.component.render(80).join("\n");

    expect(text).toContain("zai/glm");
    expect(text).toContain("kilo/flash");
    expect(text).toContain("high");
    expect(text).toContain("inherit"); // row 1 has no stored level
  });

  test("native scoped rows are read-only and labeled", () => {
    initTheme(undefined, false);
    let saved: Record<string, StoredLevel> | undefined;
    const component = new LevelsSelectorComponent(
      "Thinking levels",
      [{ key: "zai/glm", ladder: ladder("off", "high"), native: "high" }],
      undefined,
      {},
      plainTheme,
      (result) => {
        saved = result;
      },
    );

    component.handleInput(RIGHT); // no-op for a native scoped row
    component.handleInput(ENTER);

    expect(saved).toEqual({});
    const text = component.render(80).join("\n");
    expect(text).toContain("native: high");
  });
});

describe("model-thinking hooks", () => {
  test("applies the stored level at startup, silently", async () => {
    const path = levelsPath();
    writeStoredLevels({ "zai/glm-5.3": "high" }, path);
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    pi.level = "low";
    const notifications: string[] = [];

    await pi.emit(
      "session_start",
      { reason: "startup" },
      context(model("zai", "glm-5.3"), notifications),
    );

    expect(pi.level).toBe("high");
    expect(notifications).toEqual([]);
  });

  test("does not override explicit CLI thinking", async () => {
    const path = levelsPath();
    writeStoredLevels({ "anthropic/claude": "high" }, path);
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    pi.level = "low";

    await withArgv(
      ["pi", "start", "--model", "anthropic/claude", "--thinking", "low"],
      async () => {
        await pi.emit(
          "session_start",
          { reason: "startup" },
          context(model("anthropic", "claude")),
        );
      },
    );

    expect(pi.level).toBe("low");
  });

  test("does not override a thinking level carried by the CLI model", async () => {
    const path = levelsPath();
    writeStoredLevels({ "zai/glm-5.3": "low" }, path);
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    pi.level = "high";

    await withArgv(["pi", "start", "--model", "zai/glm-5.3:high"], async () => {
      await pi.emit(
        "session_start",
        { reason: "startup" },
        context(model("zai", "glm-5.3")),
      );
    });

    expect(pi.level).toBe("high");
  });

  test("applies the stored level when --thinking is invalid", async () => {
    const path = levelsPath();
    writeStoredLevels({ "anthropic/claude": "high" }, path);
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    pi.level = "low";

    await withArgv(
      ["pi", "start", "--model", "anthropic/claude", "--thinking", "bogus"],
      async () => {
        await pi.emit(
          "session_start",
          { reason: "startup" },
          context(model("anthropic", "claude")),
        );
      },
    );

    expect(pi.level).toBe("high");
  });

  test("applies the stored level when the full picker selects a model", async () => {
    const path = levelsPath();
    writeStoredLevels({ "anthropic/claude": "low" }, path);
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    pi.level = "off";
    const notifications: string[] = [];

    await pi.emit(
      "model_select",
      { model: model("anthropic", "claude"), source: "set" },
      context(model("anthropic", "claude"), notifications),
    );

    expect(pi.level).toBe("low");
    expect(notifications).toEqual(["Thinking: off → low"]);
  });

  test("applies the stored level after Ctrl+P cycling", async () => {
    const path = levelsPath();
    writeStoredLevels({ "zai/glm-5.3": "medium" }, path);
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    pi.level = "high";

    await pi.emit(
      "model_select",
      { model: model("zai", "glm-5.3"), source: "cycle" },
      context(model("zai", "glm-5.3")),
    );

    expect(pi.level).toBe("medium");
  });

  test("does not notify when the level already matches", async () => {
    const path = levelsPath();
    writeStoredLevels({ "zai/glm-5.3": "high" }, path);
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    pi.level = "high";
    const notifications: string[] = [];

    await pi.emit(
      "model_select",
      { model: model("zai", "glm-5.3"), source: "cycle" },
      context(model("zai", "glm-5.3"), notifications),
    );

    expect(notifications).toEqual([]);
  });

  test("snaps the level after /new, with notification", async () => {
    const path = levelsPath();
    writeStoredLevels({ "zai/glm-5.3": "medium" }, path);
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    pi.level = "low";
    const notifications: string[] = [];

    await pi.emit(
      "session_start",
      { reason: "new" },
      context(model("zai", "glm-5.3"), notifications),
    );

    expect(pi.level).toBe("medium");
    expect(notifications).toEqual(["Thinking: low → medium"]);
  });

  test("does not override restored session thinking", async () => {
    const path = levelsPath();
    writeStoredLevels({ "zai/glm-5.3": "high" }, path);
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    pi.level = "medium";
    const ctx = context(model("zai", "glm-5.3"));

    await pi.emit("model_select", { source: "restore" }, ctx);
    await pi.emit("session_start", { reason: "resume" }, ctx);
    await pi.emit("session_start", { reason: "fork" }, ctx);
    await pi.emit("session_start", { reason: "reload" }, ctx);

    expect(pi.level).toBe("medium");
  });

  test("restores the captured global default for an inherited model", async () => {
    const path = levelsPath();
    const inheritedPath = `${path}.default`;
    writeStoredLevels({ "zai/glm-5.3": "high" }, path);
    // A prior session captured "off" as the true global default before any
    // scoped value polluted Pi's settings.
    writeFileSync(inheritedPath, JSON.stringify("off"));
    const pi = new PiHarness();
    pi.level = "xhigh"; // Pi persisted xhigh from a prior session's scoped level
    modelThinking(pi.api, {
      levelsPath: path,
      inheritedLevelPath: inheritedPath,
    });

    await pi.emit(
      "model_select",
      { model: model("openai", "unmanaged"), source: "set" },
      context(model("openai", "unmanaged")),
    );

    // The sidecar must not carry the prior model's xhigh into an inherited
    // model. The extension recovers "off" from its default sidecar.
    expect(pi.level).toBe("off");
  });

  test("keeps the global default when a prior session persisted a scoped level", async () => {
    const path = levelsPath();
    const inheritedPath = `${path}.default`;
    writeStoredLevels({ "zai/glm-5.3": "high" }, path);

    const first = new PiHarness();
    first.level = "low";
    modelThinking(first.api, {
      levelsPath: path,
      inheritedLevelPath: inheritedPath,
    });
    await first.emit(
      "model_select",
      { model: model("zai", "glm-5.3"), source: "set" },
      context(model("zai", "glm-5.3")),
    );
    expect(first.level).toBe("high");

    // Pi persisted high when the first session set its scoped value. A new
    // session must recover low from the extension's default sidecar instead
    // of treating that persisted scoped value as the global default.
    const second = new PiHarness();
    second.level = "high";
    modelThinking(second.api, {
      levelsPath: path,
      inheritedLevelPath: inheritedPath,
    });
    await second.emit(
      "model_select",
      { model: model("openai", "unmanaged"), source: "set" },
      context(model("openai", "unmanaged")),
    );
    expect(second.level).toBe("low");
  });

  test("defers to a native scoped level instead of the sidecar", async () => {
    const path = levelsPath();
    writeStoredLevels({ "zai/glm-5.3": "low" }, path);
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    pi.level = "off";

    // --models "zai/glm-5.3:high" gives the session a native scoped level;
    // pi applied it itself during the cycle; the sidecar's "low" must not
    // stomp it in the model_select handler.
    pi.level = "high";
    await pi.emit(
      "model_select",
      { model: model("zai", "glm-5.3"), source: "cycle" },
      context(
        model("zai", "glm-5.3"),
        [],
        [{ model: model("zai", "glm-5.3"), thinkingLevel: "high" }],
      ),
    );

    expect(pi.level).toBe("high");
  });

  test("applies a native scoped level after direct picker selection", async () => {
    const path = levelsPath();
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    pi.level = "off";

    await pi.emit(
      "model_select",
      { model: model("zai", "glm-5.3"), source: "set" },
      context(
        model("zai", "glm-5.3"),
        [],
        [{ model: model("zai", "glm-5.3"), thinkingLevel: "high" }],
      ),
    );

    expect(pi.level).toBe("high");
  });

  test("applies the sidecar level when the scoped entry has none", async () => {
    const path = levelsPath();
    writeStoredLevels({ "zai/glm-5.3": "medium" }, path);
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    pi.level = "off";

    await pi.emit(
      "model_select",
      { model: model("zai", "glm-5.3"), source: "cycle" },
      context(
        model("zai", "glm-5.3"),
        [],
        [{ model: model("zai", "glm-5.3"), thinkingLevel: undefined }],
      ),
    );

    expect(pi.level).toBe("medium");
  });

  test("stores and looks up by provider/id key", () => {
    expect(modelKey(model("zai", "glm-5.3"))).toBe("zai/glm-5.3");
    expect(modelKey({ provider: "kilo", id: "deepseek/v4" })).toBe(
      "kilo/deepseek/v4",
    );
  });

  test("startup with no stored level recovers the preserved global default", async () => {
    // Issue 2: Pi persists every setThinkingLevel() call as its global
    // default. A prior session's scoped level pollutes it. Ordinary
    // startup must restore the preserved default from the sidecar, not
    // leave the polluted value in place.
    const path = levelsPath();
    const inheritedPath = `${path}.default`;
    writeStoredLevels({ "zai/glm-5.3": "high" }, path);
    writeFileSync(inheritedPath, JSON.stringify("low"));

    const pi = new PiHarness();
    pi.level = "high"; // Pi persisted high from a prior session's scoped level
    modelThinking(pi.api, {
      levelsPath: path,
      inheritedLevelPath: inheritedPath,
    });

    await pi.emit(
      "session_start",
      { reason: "startup" },
      context(model("openai", "unmanaged")),
    );

    // The extension recovers low from its default sidecar instead of
    // treating Pi's polluted high as the global default.
    expect(pi.level).toBe("low");
  });

  test("startup with no stored level and no pollution is a no-op", async () => {
    const path = levelsPath();
    writeStoredLevels({ "zai/glm-5.3": "high" }, path);
    const pi = new PiHarness();
    pi.level = "low"; // Pi's persisted global default — no pollution
    modelThinking(pi.api, { levelsPath: path }); // captures inheritedLevel = low

    await pi.emit(
      "session_start",
      { reason: "startup" },
      context(model("openai", "unmanaged")),
    );

    // inheritedLevel matches Pi's level — setManagedLevel is a no-op.
    expect(pi.level).toBe("low");
  });

  test("keeps the last valid --thinking across an invalid repeat", async () => {
    const path = levelsPath();
    writeStoredLevels({ "anthropic/claude": "high" }, path);
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    pi.level = "low";

    await withArgv(
      [
        "pi",
        "start",
        "--model",
        "anthropic/claude",
        "--thinking",
        "low",
        "--thinking",
        "bogus",
      ],
      async () => {
        await pi.emit(
          "session_start",
          { reason: "startup" },
          context(model("anthropic", "claude")),
        );
      },
    );

    expect(pi.level).toBe("low");
  });

  test("ignores a trailing --thinking without a value", async () => {
    const path = levelsPath();
    writeStoredLevels({ "anthropic/claude": "high" }, path);
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    pi.level = "low";

    await withArgv(["pi", "start", "--thinking"], async () => {
      await pi.emit(
        "session_start",
        { reason: "startup" },
        context(model("anthropic", "claude")),
      );
    });

    expect(pi.level).toBe("high");
  });

  test("ignores a :level suffix on an earlier, overridden --model", async () => {
    const path = levelsPath();
    writeStoredLevels({ "zai/glm-5.3": "low" }, path);
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    pi.level = "high";

    // Pi's parser lets the last --model win; only it carries thinking
    // intent, and it is a plain id here — so the stored level applies.
    await withArgv(
      ["pi", "start", "--model", "zai/glm-5.3:high", "--model", "zai/glm-5.3"],
      async () => {
        await pi.emit(
          "session_start",
          { reason: "startup" },
          context(model("zai", "glm-5.3")),
        );
      },
    );

    expect(pi.level).toBe("low");
  });

  test("ignores equals-form --model=x:level, like pi's parser", async () => {
    const path = levelsPath();
    writeStoredLevels({ "zai/glm-5.3": "low" }, path);
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    pi.level = "high";

    // Pi only parses space-separated --model; the equals form lands in
    // unknownFlags and sets no model or thinking. The mirror must agree,
    // or it would suppress the stored level for a session pi treats as
    // having no explicit thinking.
    await withArgv(["pi", "start", "--model=zai/glm-5.3:high"], async () => {
      await pi.emit(
        "session_start",
        { reason: "startup" },
        context(model("zai", "glm-5.3")),
      );
    });

    expect(pi.level).toBe("low");
  });

  test("applies a stored off level and notifies", async () => {
    const path = levelsPath();
    writeStoredLevels({ "zai/glm-5.3": "off" }, path);
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    pi.level = "high";
    const notifications: string[] = [];

    await pi.emit(
      "model_select",
      { model: model("zai", "glm-5.3"), source: "cycle" },
      context(model("zai", "glm-5.3"), notifications),
    );

    expect(pi.level).toBe("off");
    expect(notifications).toEqual(["Thinking: high → off"]);
  });

  // Issue 1: Pi emits thinking_level_select automatically when switching
  // models or applying native scoped levels — before model_select, in the
  // same macrotask. The extension must not save that as the global default.
  test("model switch with native scoped level does not overwrite the global default", async () => {
    const path = levelsPath();
    const inheritedPath = `${path}.default`;
    const pi = new PiHarness();
    pi.level = "low";
    modelThinking(pi.api, {
      levelsPath: path,
      inheritedLevelPath: inheritedPath,
    });

    // session_start fires first in real Pi, capturing the inherited default
    // (low) before any model switch changes the level.
    await pi.emit(
      "session_start",
      { reason: "startup" },
      context(model("openai", "unmanaged")),
    );

    // Pi cycles to a model natively pinned to high: it emits
    // thinking_level_select(high) then model_select(cycle) in the same
    // macrotask. The extension's model_select handler sees the scoped level
    // and defers to it.
    pi.level = "high"; // Pi applied the scoped level
    await pi.emit(
      "thinking_level_select",
      { level: "high", previousLevel: "low" },
      context(model("zai", "glm-5.3")),
    );
    await pi.emit(
      "model_select",
      {
        model: model("zai", "glm-5.3"),
        previousModel: model("openai", "unmanaged"),
        source: "cycle",
      },
      context(
        model("zai", "glm-5.3"),
        [],
        [{ model: model("zai", "glm-5.3"), thinkingLevel: "high" }],
      ),
    );
    await flushTimers();

    // The global default sidecar must still be low, not high.
    expect(JSON.parse(readFileSync(inheritedPath, "utf8"))).toBe("low");
  });

  test("user thinking-level change is saved as the global default", async () => {
    const path = levelsPath();
    const inheritedPath = `${path}.default`;
    const pi = new PiHarness();
    pi.level = "low";
    modelThinking(pi.api, {
      levelsPath: path,
      inheritedLevelPath: inheritedPath,
    });

    // User cycles thinking level via keybinding: Pi emits
    // thinking_level_select with no following model_select.
    pi.level = "medium";
    await pi.emit(
      "thinking_level_select",
      { level: "medium", previousLevel: "low" },
      context(model("openai", "unmanaged")),
    );
    await flushTimers();

    // The user's choice is saved as the global default.
    expect(JSON.parse(readFileSync(inheritedPath, "utf8"))).toBe("medium");
  });

  // Issue 3: Pi clamps the requested level to model capabilities. The
  // managed-event suppression must not break when the event's level differs
  // from the requested level, and must not leave stale entries when no
  // event fires.
  test("clamping does not break managed-event suppression", async () => {
    const path = levelsPath();
    const inheritedPath = `${path}.default`;
    writeStoredLevels({ "zai/glm-5.3": "high" }, path);
    const pi = new PiHarness();
    // Model only supports off, low, medium — high clamps to medium.
    pi.availableLevels = ["off", "low", "medium"];
    pi.level = "low";
    modelThinking(pi.api, {
      levelsPath: path,
      inheritedLevelPath: inheritedPath,
    });

    await pi.emit(
      "model_select",
      { model: model("zai", "glm-5.3"), source: "set" },
      context(model("zai", "glm-5.3")),
    );
    await flushTimers();

    // The stored level "high" clamped to "medium" — applied correctly.
    expect(pi.level).toBe("medium");
    // The clamped managed event did not overwrite the global default.
    expect(JSON.parse(readFileSync(inheritedPath, "utf8"))).toBe("low");
  });

  test("clamping to the same value leaves no stale suppression", async () => {
    const path = levelsPath();
    const inheritedPath = `${path}.default`;
    writeStoredLevels({ "zai/glm-5.3": "high" }, path);
    const pi = new PiHarness();
    // Model supports off, low, medium — high clamps to medium.
    pi.availableLevels = ["off", "low", "medium"];
    pi.level = "medium"; // already at the clamped value
    modelThinking(pi.api, {
      levelsPath: path,
      inheritedLevelPath: inheritedPath,
    });

    // setManagedLevel(high) clamps to medium which is already the current
    // level — no event fires, no stale counter entry remains.
    await pi.emit(
      "model_select",
      { model: model("zai", "glm-5.3"), source: "set" },
      context(model("zai", "glm-5.3")),
    );
    // Flush the modelSwitchPending flag so the subsequent user change is
    // not suppressed by it (in real Pi the user's key press is a later
    // macrotask, after the flag's setTimeout(0) clear has fired).
    await flushTimers();

    // Now a genuine user change to medium must NOT be suppressed by a
    // stale counter entry from the no-op managed call.
    pi.level = "low"; // user changed to something else first
    await pi.emit(
      "thinking_level_select",
      { level: "medium", previousLevel: "low" },
      context(model("zai", "glm-5.3")),
    );
    await flushTimers();

    // The user's choice is saved — not suppressed by a stale entry.
    expect(JSON.parse(readFileSync(inheritedPath, "utf8"))).toBe("medium");
  });

  // Fix 1: pi.getThinkingLevel() is a runtime action that throws during
  // extension loading (Pi's runtime stub). The factory must defer all
  // runtime calls to event handlers.
  test("factory does not call pi.getThinkingLevel() during loading", () => {
    const path = levelsPath();
    const inheritedPath = `${path}.default`;
    writeFileSync(inheritedPath, JSON.stringify("low"));
    const pi = new PiHarness();
    pi.throwOnGetLevel = true;
    // Must not throw — the factory defers getThinkingLevel() to lazy init.
    modelThinking(pi.api, {
      levelsPath: path,
      inheritedLevelPath: inheritedPath,
    });
  });

  test("lazy init captures the level at first event, not at load time", async () => {
    const path = levelsPath();
    const inheritedPath = `${path}.default`;
    const pi = new PiHarness();
    pi.level = "low";
    // Factory loads with throwOnGetLevel to prove no call happens at load.
    pi.throwOnGetLevel = true;
    modelThinking(pi.api, {
      levelsPath: path,
      inheritedLevelPath: inheritedPath,
    });
    // Runtime is now "initialized" — disable the stub.
    pi.throwOnGetLevel = false;
    pi.level = "low";

    await pi.emit(
      "session_start",
      { reason: "startup" },
      context(model("openai", "unmanaged")),
    );

    expect(pi.level).toBe("low");
    expect(JSON.parse(readFileSync(inheritedPath, "utf8"))).toBe("low");
  });

  // Fix 2: pi --continue and startup-picker resumes emit reason "startup"
  // but carry restored entries. The restored thinking level must survive.
  test("does not overwrite a restored session's level on startup", async () => {
    const path = levelsPath();
    writeStoredLevels({ "zai/glm-5.3": "high" }, path);
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    pi.level = "medium"; // restored from the session

    await pi.emit(
      "session_start",
      { reason: "startup" },
      context(
        model("zai", "glm-5.3"),
        [],
        [],
        [
          { type: "message", id: "x" }, // restored entries
        ],
      ),
    );

    expect(pi.level).toBe("medium");
  });

  test("fresh startup with entries absent still applies the stored level", async () => {
    const path = levelsPath();
    writeStoredLevels({ "zai/glm-5.3": "high" }, path);
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    pi.level = "low";

    await pi.emit(
      "session_start",
      { reason: "startup" },
      context(model("zai", "glm-5.3"), [], [], []), // no entries = fresh
    );

    expect(pi.level).toBe("high");
  });

  // Fix 3: enabledModels "zai/glm:high" + pi --model zai/glm starts at the
  // global level instead of high because Pi doesn't apply the native scoped
  // level on startup and the extension only applied it for source "set".
  test("applies a native scoped level on startup", async () => {
    const path = levelsPath();
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    pi.level = "low"; // global default

    await pi.emit(
      "session_start",
      { reason: "startup" },
      context(
        model("zai", "glm-5.3"),
        [],
        [{ model: model("zai", "glm-5.3"), thinkingLevel: "high" }],
      ),
    );

    expect(pi.level).toBe("high");
  });

  test("applies a native scoped level on /new", async () => {
    const path = levelsPath();
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    pi.level = "low";

    await pi.emit(
      "session_start",
      { reason: "new" },
      context(
        model("zai", "glm-5.3"),
        [],
        [{ model: model("zai", "glm-5.3"), thinkingLevel: "high" }],
      ),
    );

    expect(pi.level).toBe("high");
  });

  // Fix 4: If another extension's thinking_level_select handler awaits,
  // model_select can overtake thinking_level_select. The suppression must
  // work regardless of handler ordering.
  test("model switch re-clamp does not save when model_select fires first", async () => {
    const path = levelsPath();
    const inheritedPath = `${path}.default`;
    writeFileSync(inheritedPath, JSON.stringify("low"));
    const pi = new PiHarness();
    pi.level = "low";
    modelThinking(pi.api, {
      levelsPath: path,
      inheritedLevelPath: inheritedPath,
    });

    // Simulate the bad ordering: model_select runs BEFORE
    // thinking_level_select (another extension's handler delayed ours).
    pi.level = "high"; // Pi applied the scoped level
    await pi.emit(
      "model_select",
      {
        model: model("zai", "glm-5.3"),
        previousModel: model("openai", "unmanaged"),
        source: "cycle",
      },
      context(
        model("zai", "glm-5.3"),
        [],
        [{ model: model("zai", "glm-5.3"), thinkingLevel: "high" }],
      ),
    );
    await pi.emit(
      "thinking_level_select",
      { level: "high", previousLevel: "low" },
      context(model("zai", "glm-5.3")),
    );
    await flushTimers();

    // The global default must still be low, not high.
    expect(JSON.parse(readFileSync(inheritedPath, "utf8"))).toBe("low");
  });

  test("user change after a model switch is still saved", async () => {
    const path = levelsPath();
    const inheritedPath = `${path}.default`;
    writeFileSync(inheritedPath, JSON.stringify("low"));
    const pi = new PiHarness();
    pi.level = "low";
    modelThinking(pi.api, {
      levelsPath: path,
      inheritedLevelPath: inheritedPath,
    });

    // Model switch fires and clears.
    pi.level = "high";
    await pi.emit(
      "model_select",
      {
        model: model("zai", "glm-5.3"),
        previousModel: model("openai", "unmanaged"),
        source: "cycle",
      },
      context(
        model("zai", "glm-5.3"),
        [],
        [{ model: model("zai", "glm-5.3"), thinkingLevel: "high" }],
      ),
    );
    await flushTimers(); // modelSwitchPending clears

    // A genuine user change in a later macrotask is saved.
    pi.level = "medium";
    await pi.emit(
      "thinking_level_select",
      { level: "medium", previousLevel: "high" },
      context(model("zai", "glm-5.3")),
    );
    await flushTimers();

    expect(JSON.parse(readFileSync(inheritedPath, "utf8"))).toBe("medium");
  });
});

describe("/levels command", () => {
  test("warns when no scoped models are configured", async () => {
    const path = levelsPath();
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    const notifications: string[] = [];
    const ctx = {
      ...context(undefined, notifications),
      scopedModels: [],
    } as unknown as ExtensionContext;

    await pi.commands.get("levels")?.("", ctx);

    expect(notifications[0]).toContain("No scoped models");
    expect(readStoredLevels(path)).toEqual({});
  });

  test("saves the edited map and applies it to the active model", async () => {
    const path = levelsPath();
    writeStoredLevels({ "zai/glm-5.3": "low" }, path);
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    const notifications: string[] = [];
    const ctx = {
      ...context(model("zai", "glm-5.3"), notifications),
      scopedModels: [
        { model: model("zai", "glm-5.3"), thinkingLevel: undefined },
        { model: model("kilo", "flash"), thinkingLevel: undefined },
      ],
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
        custom: async <T>() => {
          // Simulate: cycle glm to inherit, set flash to xhigh.
          const stored = readStoredLevels(path);
          delete stored["zai/glm-5.3"];
          return { ...stored, "kilo/flash": "xhigh" } as T;
        },
      },
    } as unknown as ExtensionContext;

    await pi.commands.get("levels")?.("", ctx);

    expect(readStoredLevels(path)).toEqual({ "kilo/flash": "xhigh" });
    // Active model glm has no stored level anymore: nothing to apply.
    expect(notifications).toEqual(["Saved thinking levels"]);
  });

  test("cancel writes nothing", async () => {
    const path = levelsPath();
    writeStoredLevels({ "zai/glm-5.3": "low" }, path);
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    const ctx = {
      ...context(model("zai", "glm-5.3")),
      scopedModels: [
        { model: model("zai", "glm-5.3"), thinkingLevel: undefined },
      ],
      ui: {
        notify() {},
        custom: async <T>() => undefined as T,
      },
    } as unknown as ExtensionContext;

    await pi.commands.get("levels")?.("", ctx);

    expect(readStoredLevels(path)).toEqual({ "zai/glm-5.3": "low" });
  });

  test("applies a saved level change to the active model", async () => {
    const path = levelsPath();
    writeStoredLevels({ "zai/glm-5.3": "off" }, path);
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    pi.level = "high";
    const notifications: string[] = [];
    const ctx = {
      ...context(model("zai", "glm-5.3"), notifications),
      scopedModels: [
        { model: model("zai", "glm-5.3"), thinkingLevel: undefined },
      ],
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
        custom: async <T>() => ({ "zai/glm-5.3": "low" }) as T,
      },
    } as unknown as ExtensionContext;

    await pi.commands.get("levels")?.("", ctx);

    expect(readStoredLevels(path)).toEqual({ "zai/glm-5.3": "low" });
    expect(pi.level).toBe("low");
    expect(notifications).toEqual([
      "Thinking: high → low",
      "Saved thinking levels",
    ]);
  });

  test("preserves stored levels for models that are no longer scoped", async () => {
    const path = levelsPath();
    writeStoredLevels({ "zai/glm-5.3": "low", "old/model": "high" }, path);
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    const notifications: string[] = [];
    const ctx = {
      ...context(model("zai", "glm-5.3"), notifications),
      scopedModels: [
        { model: model("zai", "glm-5.3"), thinkingLevel: undefined },
      ],
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
        custom: async <T>() =>
          ({
            "zai/glm-5.3": "low",
            "old/model": "high",
            "kilo/flash": "xhigh",
          }) as T,
      },
    } as unknown as ExtensionContext;

    await pi.commands.get("levels")?.("", ctx);

    expect(readStoredLevels(path)).toEqual({
      "zai/glm-5.3": "low",
      "old/model": "high",
    });
  });

  test("renders native scoped models as read-only", async () => {
    const path = levelsPath();
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    let component: LevelsSelectorComponent | undefined;
    const ctx = {
      ...context(model("zai", "glm-5.3")),
      scopedModels: [
        { model: model("zai", "glm-5.3"), thinkingLevel: "high" },
        { model: model("kilo", "flash"), thinkingLevel: undefined },
      ],
      ui: {
        notify() {},
        custom: async <T>(
          fn: (
            tui: unknown,
            theme: Theme,
            keybindings: unknown,
            done: (result: T) => void,
          ) => unknown,
        ) => {
          component = fn(
            null,
            {
              fg: (_color: string, text: string) => text,
              bold: (text: string) => text,
            } as Theme,
            null,
            () => {},
          ) as LevelsSelectorComponent;
          return undefined as T;
        },
      },
    } as unknown as ExtensionContext;

    await pi.commands.get("levels")?.("", ctx);

    expect(component).toBeDefined();
    initTheme(undefined, false);
    const text = component!.render(80).join("\n");
    expect(text).toContain("zai/glm-5.3");
    expect(text).toContain("kilo/flash");
    expect(text).toContain("native: high");
    expect(text).toContain("inherit");
  });
});
