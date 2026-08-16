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
      this.selectedModel = model;
      return true;
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

    await pi.emit(
      "model_select",
      { source: "set" },
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
    const pi = new PiHarness();
    modelThinking(pi.api);
    const previousModel = model("anthropic", "unmanaged");
    const newModel = model("opencode", "hy3-free");
    const scopedModels = [scoped("opencode", "hy3-free", "high")];
    const ctx = context(newModel, scopedModels, [], [previousModel]);

    pi.level = "low";
    await pi.emit(
      "session_before_switch",
      { reason: "new" },
      context(previousModel, scopedModels),
    );
    await pi.emit("session_start", { reason: "new" }, ctx);

    expect(pi.selectedModel).toEqual(previousModel);
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
