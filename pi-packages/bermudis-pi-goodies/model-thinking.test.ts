import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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
): ExtensionContext {
  return {
    model: activeModel,
    scopedModels,
    mode: "tui",
    hasUI: true,
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
    getThinkingLevel: () => this.level,
    setThinkingLevel: (level: ThinkingLevel) => {
      this.level = level;
    },
  } as unknown as ExtensionAPI;

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
    writeStoredLevels({ "zai/glm-5.3": "high" }, path);
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    pi.level = "xhigh";

    await pi.emit(
      "model_select",
      { model: model("openai", "unmanaged"), source: "set" },
      context(model("openai", "unmanaged")),
    );

    // The sidecar must not carry the prior model's xhigh into an inherited
    // model. Pi's global default was off when the extension initialized.
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

  test("startup with no stored level for the model is untouched", async () => {
    const path = levelsPath();
    writeStoredLevels({ "zai/glm-5.3": "high" }, path);
    const pi = new PiHarness();
    modelThinking(pi.api, { levelsPath: path });
    pi.level = "low";

    await pi.emit(
      "session_start",
      { reason: "startup" },
      context(model("openai", "unmanaged")),
    );

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
});
