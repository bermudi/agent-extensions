import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import modelThinking, {
  buildLadder,
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

  test("leaves models without a stored level alone", async () => {
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

    expect(pi.level).toBe("xhigh");
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
});
