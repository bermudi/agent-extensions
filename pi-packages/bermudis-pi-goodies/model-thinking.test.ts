import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import modelThinking from "./model-thinking.ts";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type Model = NonNullable<ExtensionContext["model"]>;
type Handler = (event: never, ctx: ExtensionContext) => unknown;

function model(
  provider: string,
  id: string,
): NonNullable<ExtensionContext["model"]> {
  return { provider, id } as NonNullable<ExtensionContext["model"]>;
}

function context(
  activeModel: Model,
  scopedModels: readonly {
    model: Model;
    thinkingLevel?: ThinkingLevel;
  }[],
  notifications: string[] = [],
  registryModels: readonly Model[] = [],
): ExtensionContext {
  return {
    model: activeModel,
    scopedModels,
    hasUI: true,
    modelRegistry: {
      find(provider: string, id: string) {
        return [
          activeModel,
          ...scopedModels.map((entry) => entry.model),
          ...registryModels,
        ].find(
          (candidate) => candidate.provider === provider && candidate.id === id,
        );
      },
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
  selectedModel: Model | undefined;
  private currentContext: ExtensionContext | undefined;
  readonly handlers = new Map<string, Handler[]>();

  readonly api = {
    on: (event: string, handler: Handler) => {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
    },
    getThinkingLevel: () => this.level,
    setThinkingLevel: (level: ThinkingLevel) => {
      this.level = level;
    },
    setModel: async (model: Model) => {
      const previousModel = this.currentContext?.model;
      this.selectedModel = model;
      if (this.currentContext) {
        await this.emit(
          "model_select",
          { model, previousModel, source: "set" },
          { ...this.currentContext, model },
        );
      }
      return true;
    },
  } as unknown as ExtensionAPI;

  async emit(
    event: string,
    payload: object,
    ctx: ExtensionContext,
  ): Promise<void> {
    this.currentContext = ctx;
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(payload as never, ctx);
    }
  }
}

function scoped(
  provider: string,
  id: string,
  thinkingLevel?: ThinkingLevel,
): {
  model: NonNullable<ExtensionContext["model"]>;
  thinkingLevel?: ThinkingLevel;
} {
  return { model: model(provider, id), thinkingLevel };
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

describe("model-thinking", () => {
  test("does not override Pi's resolved startup level", async () => {
    const pi = new PiHarness();
    modelThinking(pi.api);
    const activeModel = model("zai", "glm-5.2");
    pi.level = "low";

    await pi.emit(
      "session_start",
      { reason: "startup" },
      context(activeModel, [scoped("zai", "glm-5.2", "high")]),
    );

    expect(pi.level).toBe("low");
  });

  test("applies the scoped level for a plain explicit CLI model", async () => {
    const pi = new PiHarness();
    modelThinking(pi.api);
    const activeModel = model("zai", "glm-5.2");
    pi.level = "low";

    await withArgv(["pi", "start", "--model", "zai/glm-5.2"], async () => {
      await pi.emit(
        "session_start",
        { reason: "startup" },
        context(activeModel, [scoped("zai", "glm-5.2", "high")]),
      );
    });

    expect(pi.level).toBe("high");
  });

  test("does not override explicit CLI thinking", async () => {
    const pi = new PiHarness();
    modelThinking(pi.api);
    const activeModel = model("zai", "glm-5.2");
    pi.level = "low";

    await withArgv(
      ["pi", "start", "--model", "zai/glm-5.2", "--thinking", "low"],
      async () => {
        await pi.emit(
          "session_start",
          { reason: "startup" },
          context(activeModel, [scoped("zai", "glm-5.2", "high")]),
        );
      },
    );

    expect(pi.level).toBe("low");
  });

  test("does not override a thinking level in the CLI model", async () => {
    const pi = new PiHarness();
    modelThinking(pi.api);
    const activeModel = model("zai", "glm-5.2");
    pi.level = "low";

    await withArgv(
      ["pi", "start", "--model", "zai/glm-5.2:medium"],
      async () => {
        await pi.emit(
          "session_start",
          { reason: "startup" },
          context(activeModel, [scoped("zai", "glm-5.2", "high")]),
        );
      },
    );

    expect(pi.level).toBe("low");
  });

  test("applies the scoped level of the last --model when several are given", async () => {
    const pi = new PiHarness();
    modelThinking(pi.api);
    // Pi's parser lets the last --model win, so only "b" matters; the
    // ":low" suffix on the first occurrence must not suppress the scoped
    // level of the effective model.
    const activeModel = model("anthropic", "claude-test");
    pi.level = "low";

    await withArgv(
      [
        "pi",
        "start",
        "--model",
        "zai/glm-5.2:low",
        "--model",
        "anthropic/claude-test",
      ],
      async () => {
        await pi.emit(
          "session_start",
          { reason: "startup" },
          context(activeModel, [scoped("anthropic", "claude-test", "high")]),
        );
      },
    );

    expect(pi.level).toBe("high");
  });

  test("applies the scoped level when --thinking is invalid", async () => {
    const pi = new PiHarness();
    modelThinking(pi.api);
    // Pi drops invalid --thinking values with a CLI warning, leaving the
    // plain explicit model on the global level; the scoped level applies.
    const activeModel = model("anthropic", "claude-test");
    pi.level = "low";

    await withArgv(
      [
        "pi",
        "start",
        "--model",
        "anthropic/claude-test",
        "--thinking",
        "bogus",
      ],
      async () => {
        await pi.emit(
          "session_start",
          { reason: "startup" },
          context(activeModel, [scoped("anthropic", "claude-test", "high")]),
        );
      },
    );

    expect(pi.level).toBe("high");
  });

  test("keeps the last valid --thinking authoritative across an invalid repeat", async () => {
    const pi = new PiHarness();
    modelThinking(pi.api);
    // Pi keeps the earlier valid "low"; the invalid repeat is dropped, so
    // explicit CLI thinking still wins over the scoped level.
    const activeModel = model("anthropic", "claude-test");
    pi.level = "low";

    await withArgv(
      [
        "pi",
        "start",
        "--model",
        "anthropic/claude-test",
        "--thinking",
        "low",
        "--thinking",
        "bogus",
      ],
      async () => {
        await pi.emit(
          "session_start",
          { reason: "startup" },
          context(activeModel, [scoped("anthropic", "claude-test", "high")]),
        );
      },
    );

    expect(pi.level).toBe("low");
  });

  test("does not override the level carried by the last --model", async () => {
    const pi = new PiHarness();
    modelThinking(pi.api);
    // The last --model carries its own ":high" level, which Pi applies; a
    // scoped entry for that model must not stomp the explicit pattern.
    const activeModel = model("zai", "glm-5.2");
    pi.level = "high";

    await withArgv(
      [
        "pi",
        "start",
        "--model",
        "anthropic/claude-test",
        "--model",
        "zai/glm-5.2:high",
      ],
      async () => {
        await pi.emit(
          "session_start",
          { reason: "startup" },
          context(activeModel, [scoped("zai", "glm-5.2", "low")]),
        );
      },
    );

    expect(pi.level).toBe("high");
  });

  test("ignores a trailing --model without a value", async () => {
    const pi = new PiHarness();
    modelThinking(pi.api);
    // Pi's parser requires a following token; a trailing --model sets
    // nothing and startup takes the normal already-resolved path.
    const activeModel = model("zai", "glm-5.2");
    pi.level = "low";

    await withArgv(["pi", "start", "--model"], async () => {
      await pi.emit(
        "session_start",
        { reason: "startup" },
        context(activeModel, [scoped("zai", "glm-5.2", "high")]),
      );
    });

    expect(pi.level).toBe("low");
  });

  test("does not override a manual level on reload", async () => {
    const pi = new PiHarness();
    modelThinking(pi.api);
    const activeModel = model("zai", "glm-5.2");
    pi.level = "low";

    await pi.emit(
      "session_start",
      { reason: "reload" },
      context(activeModel, [scoped("zai", "glm-5.2", "high")]),
    );

    expect(pi.level).toBe("low");
  });

  test("applies a scoped level when the full model picker selects a model", async () => {
    const pi = new PiHarness();
    modelThinking(pi.api);
    const activeModel = model("anthropic", "claude-test");
    const notifications: string[] = [];

    // Pi emits model_select (source "set") only when the picked model
    // differs from the active one, with ctx.model already updated to the
    // picked model. Re-selecting the active model fires no event at all —
    // a documented limitation, not a case this handler can cover.
    await pi.emit(
      "model_select",
      {
        model: activeModel,
        previousModel: model("zai", "glm-5.2"),
        source: "set",
      },
      context(
        activeModel,
        [scoped("anthropic", "claude-test", "low")],
        notifications,
      ),
    );

    expect(pi.level).toBe("low");
    expect(notifications).toEqual(["Thinking: off → low"]);
  });

  test("does not override restored session thinking", async () => {
    const pi = new PiHarness();
    modelThinking(pi.api);
    pi.level = "medium";
    const activeModel = model("zai", "glm-5.2");
    const ctx = context(activeModel, [scoped("zai", "glm-5.2", "high")]);

    await pi.emit("model_select", { source: "restore" }, ctx);
    await pi.emit("session_start", { reason: "resume" }, ctx);
    await pi.emit("session_start", { reason: "fork" }, ctx);

    expect(pi.level).toBe("medium");
  });

  test("restores both model and thinking level after /new", async () => {
    const oldPi = new PiHarness();
    modelThinking(oldPi.api);
    const newPi = new PiHarness();
    modelThinking(newPi.api);
    const previousModel = model("anthropic", "managed");
    const newModel = model("opencode", "hy3-free");
    const scopedModels = [
      scoped("anthropic", "managed", "low"),
      scoped("opencode", "hy3-free", "high"),
    ];
    const notifications: string[] = [];
    const ctx = context(newModel, scopedModels, notifications, [previousModel]);

    oldPi.level = "medium";
    await oldPi.emit(
      "session_before_switch",
      { reason: "new" },
      context(previousModel, scopedModels),
    );
    newPi.level = "high";
    await newPi.emit("session_start", { reason: "new" }, ctx);

    expect(newPi.selectedModel).toEqual(previousModel);
    expect(newPi.level).toBe("medium");
    expect(notifications).toEqual([]);
  });

  test("restores thinking for an active custom model absent from the registry", async () => {
    const pi = new PiHarness();
    modelThinking(pi.api);
    const previousModel = model("custom-provider", "custom-model");
    const newModel = model("opencode", "hy3-free");
    const newContext = context(newModel, [
      scoped("opencode", "hy3-free", "high"),
    ]);
    const customContext = {
      ...newContext,
      model: previousModel,
      modelRegistry: {
        find() {
          return undefined;
        },
      },
    } as unknown as ExtensionContext;

    pi.level = "low";
    await pi.emit(
      "session_before_switch",
      { reason: "new" },
      context(previousModel, []),
    );
    pi.level = "high";
    await pi.emit("session_start", { reason: "new" }, customContext);

    expect(pi.selectedModel).toBeUndefined();
    expect(pi.level).toBe("low");
  });

  test("leaves models without a scoped level alone", async () => {
    const pi = new PiHarness();
    modelThinking(pi.api);
    pi.level = "xhigh";
    const activeModel = model("openai", "unmanaged");

    await pi.emit(
      "model_select",
      { source: "set" },
      context(activeModel, [scoped("zai", "glm-5.2", "high")]),
    );

    expect(pi.level).toBe("xhigh");
  });

  test("does not notify when the native cycle already applied the level", async () => {
    const pi = new PiHarness();
    modelThinking(pi.api);
    pi.level = "high";
    const notifications: string[] = [];
    const activeModel = model("zai", "glm-5.2");

    await pi.emit(
      "model_select",
      { source: "cycle" },
      context(activeModel, [scoped("zai", "glm-5.2", "high")], notifications),
    );

    expect(pi.level).toBe("high");
    expect(notifications).toEqual([]);
  });
});
