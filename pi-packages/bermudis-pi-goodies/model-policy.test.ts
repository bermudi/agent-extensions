import { afterEach, describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixedDefaults from "./fixed-defaults.ts";
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

function model(
  provider: string,
  id: string,
): NonNullable<ExtensionContext["model"]> {
  return { provider, id } as NonNullable<ExtensionContext["model"]>;
}

class PiHarness {
  level: ThinkingLevel = "max";
  readonly handlers = new Map<string, Handler[]>();
  readonly commands = new Map<string, CommandHandler>();
  private activeContext: ExtensionContext | undefined;

  constructor(private readonly settingsPath: string) {}

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
      if (requested === this.level) return;
      const previousLevel = this.level;
      this.level = requested;

      const settings = JSON.parse(
        readFileSync(this.settingsPath, "utf8"),
      ) as Record<string, unknown>;
      settings.defaultThinkingLevel = requested;
      writeFileSync(
        this.settingsPath,
        `${JSON.stringify(settings, null, 2)}\n`,
      );

      if (this.activeContext) {
        this.dispatchSync(
          "thinking_level_select",
          { type: "thinking_level_select", level: requested, previousLevel },
          this.activeContext,
        );
      }
    },
  } as unknown as ExtensionAPI;

  async emit(event: string, payload: object, ctx: ExtensionContext) {
    const previousContext = this.activeContext;
    this.activeContext = ctx;
    try {
      for (const handler of this.handlers.get(event) ?? []) {
        await handler(payload as never, ctx);
      }
    } finally {
      this.activeContext = previousContext;
    }
  }

  private dispatchSync(event: string, payload: object, ctx: ExtensionContext) {
    for (const handler of this.handlers.get(event) ?? []) {
      void handler(payload as never, ctx);
    }
  }
}

describe("model policy extensions", () => {
  test("a manually created pin affects the next session, not the active model", async () => {
    const directory = mkdtempSync(join(tmpdir(), "model-policy-test-"));
    temporaryDirectories.push(directory);
    const agentDir = join(directory, "agent");
    const cwd = join(directory, "project");
    const settingsPath = join(agentDir, "settings.json");
    const modelThinkingPath = join(agentDir, "model-thinking.json");
    mkdirSync(agentDir, { recursive: true });

    writeFileSync(
      settingsPath,
      `${JSON.stringify(
        {
          defaultProvider: "zai",
          defaultModel: "glm-5.2",
          defaultThinkingLevel: "max",
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(agentDir, "fixed-defaults.json"),
      `${JSON.stringify(
        {
          provider: "opencode",
          model: "deepseek-v4-flash-free",
          thinkingLevel: "max",
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      modelThinkingPath,
      `${JSON.stringify({ models: { "zai/glm-5.2": "high" } }, null, 2)}\n`,
    );

    const pi = new PiHarness(settingsPath);
    // This matches index.ts: model-thinking registers before fixed-defaults.
    modelThinking(pi.api, { configPath: modelThinkingPath });
    fixedDefaults(pi.api, { agentDir });

    const ctx = {
      cwd,
      // Pi selects this model before session_start. fixed-defaults can persist
      // the pin below, but it cannot replace the already active model here.
      model: model("zai", "glm-5.2"),
      hasUI: true,
      isProjectTrusted: () => true,
      ui: { notify() {} },
    } as unknown as ExtensionContext;

    await pi.emit("session_start", { reason: "startup" }, ctx);

    expect(ctx.model).toEqual(model("zai", "glm-5.2"));
    expect(pi.level).toBe("high");
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      defaultProvider: "opencode",
      defaultModel: "deepseek-v4-flash-free",
      defaultThinkingLevel: "high",
    });
  });
});
