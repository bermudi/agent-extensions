import { afterEach, describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import modelThinking from "./model-thinking.ts";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type Handler = (event: never, ctx: ExtensionContext) => unknown;
type CommandHandler = (
  args: string,
  ctx: ExtensionContext,
) => Promise<void> | void;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryConfig(config?: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "model-thinking-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "model-thinking.json");
  if (config !== undefined) {
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  }
  return path;
}

function model(
  provider: string,
  id: string,
): NonNullable<ExtensionContext["model"]> {
  return { provider, id } as NonNullable<ExtensionContext["model"]>;
}

function context(
  activeModel: NonNullable<ExtensionContext["model"]>,
): ExtensionContext {
  return {
    model: activeModel,
    hasUI: true,
    ui: {
      notify() {},
    },
  } as unknown as ExtensionContext;
}

class PiHarness {
  level: ThinkingLevel = "off";
  clamp: (level: ThinkingLevel) => ThinkingLevel = (level) => level;
  readonly handlers = new Map<string, Handler[]>();
  readonly commands = new Map<string, CommandHandler>();
  private activeContext: ExtensionContext | undefined;

  readonly api = {
    on: (event: string, handler: Handler) => {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
    },
    registerCommand: (name: string, command: { handler: CommandHandler }) => {
      this.commands.set(name, command.handler);
    },
    getThinkingLevel: () => this.level,
    setThinkingLevel: (requested: ThinkingLevel) => {
      const next = this.clamp(requested);
      if (next === this.level) return;
      const previousLevel = this.level;
      this.level = next;
      if (!this.activeContext) {
        throw new Error("setThinkingLevel called outside an event");
      }
      this.dispatch(
        "thinking_level_select",
        { type: "thinking_level_select", level: next, previousLevel },
        this.activeContext,
      );
    },
  } as unknown as ExtensionAPI;

  emit(event: string, payload: object, ctx: ExtensionContext): void {
    this.dispatch(event, { type: event, ...payload }, ctx);
  }

  selectThinking(level: ThinkingLevel, ctx: ExtensionContext): void {
    const previousLevel = this.level;
    this.level = level;
    if (level !== previousLevel) {
      this.dispatch(
        "thinking_level_select",
        { type: "thinking_level_select", level, previousLevel },
        ctx,
      );
    }
  }

  private dispatch(
    event: string,
    payload: object,
    ctx: ExtensionContext,
  ): void {
    const previousContext = this.activeContext;
    this.activeContext = ctx;
    try {
      for (const handler of this.handlers.get(event) ?? []) {
        void handler(payload as never, ctx);
      }
    } finally {
      this.activeContext = previousContext;
    }
  }
}

describe("model-thinking", () => {
  test("applies exact model settings before provider defaults", () => {
    const path = temporaryConfig({
      providers: { anthropic: "high" },
      models: { "anthropic/claude-test": "low" },
    });
    const pi = new PiHarness();
    modelThinking(pi.api, { configPath: path });
    const ctx = context(model("anthropic", "claude-test"));

    pi.emit("session_start", { reason: "startup" }, ctx);

    expect(pi.level).toBe("low");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      providers: { anthropic: "high" },
      models: { "anthropic/claude-test": "low" },
    });
  });

  test("supports max and does not remember its own clamped change", () => {
    const path = temporaryConfig({ providers: { openai: "max" } });
    const pi = new PiHarness();
    pi.clamp = (level) => (level === "max" ? "high" : level);
    modelThinking(pi.api, { configPath: path });
    const ctx = context(model("openai", "reasoning-model"));

    pi.emit("session_start", { reason: "startup" }, ctx);

    expect(pi.level).toBe("high");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      providers: { openai: "max" },
    });
  });

  test("does not remember automatic or manual thinking changes", () => {
    const path = temporaryConfig({ providers: { anthropic: "high" } });
    const pi = new PiHarness();
    modelThinking(pi.api, { configPath: path });
    const first = context(model("anthropic", "first"));
    const secondModel = model("anthropic", "second");
    const second = context(secondModel);

    pi.emit("session_start", { reason: "startup" }, first);
    pi.selectThinking("off", second); // Native inheritance/clamping during switch.
    pi.emit(
      "model_select",
      {
        model: secondModel,
        previousModel: first.model,
        source: "set",
      },
      second,
    );
    pi.selectThinking("medium", second); // User selection after model_select.

    expect(pi.level).toBe("medium");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      providers: { anthropic: "high" },
    });
  });

  test("does not alter an exact override when the user changes levels", () => {
    const path = temporaryConfig({
      providers: { anthropic: "high" },
      models: { "anthropic/claude-test": "low" },
    });
    const pi = new PiHarness();
    modelThinking(pi.api, { configPath: path });
    const ctx = context(model("anthropic", "claude-test"));

    pi.emit("session_start", { reason: "startup" }, ctx);
    pi.selectThinking("high", ctx);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      providers: { anthropic: "high" },
      models: { "anthropic/claude-test": "low" },
    });
  });

  test("set saves the current level for the current model and overwrites its entry", async () => {
    const path = temporaryConfig({
      providers: { anthropic: "high" },
      models: {
        "anthropic/claude-test": "low",
        "anthropic/other": "medium",
      },
    });
    const pi = new PiHarness();
    modelThinking(pi.api, { configPath: path });
    const ctx = context(model("anthropic", "claude-test"));
    pi.level = "xhigh";

    await pi.commands.get("model-thinking")!("set", ctx);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      providers: { anthropic: "high" },
      models: {
        "anthropic/claude-test": "xhigh",
        "anthropic/other": "medium",
      },
    });
  });

  test("set can bootstrap an unmanaged model", async () => {
    const path = temporaryConfig();
    const pi = new PiHarness();
    modelThinking(pi.api, { configPath: path });
    const ctx = context(model("unmanaged", "model"));
    pi.level = "xhigh";

    await pi.commands.get("model-thinking")!("set", ctx);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      models: { "unmanaged/model": "xhigh" },
    });
  });

  test("leaves unmanaged models to Pi and does not create a config", () => {
    const path = temporaryConfig();
    const pi = new PiHarness();
    modelThinking(pi.api, { configPath: path });
    const ctx = context(model("unmanaged", "model"));

    pi.emit("session_start", { reason: "startup" }, ctx);
    pi.selectThinking("xhigh", ctx);

    expect(pi.level).toBe("xhigh");
    expect(() => readFileSync(path, "utf8")).toThrow();
  });
});
