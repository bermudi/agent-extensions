import { afterEach, describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  existsSync,
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

function context(
  cwd: string,
  activeModel: NonNullable<ExtensionContext["model"]>,
  notifications: string[] = [],
): ExtensionContext {
  return {
    cwd,
    model: activeModel,
    hasUI: true,
    isProjectTrusted: () => true,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext;
}

function readSettings(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

class PiHarness {
  readonly handlers = new Map<string, Handler[]>();
  readonly commands = new Map<string, CommandHandler>();

  constructor(
    private readonly settingsPath: string,
    public level: ThinkingLevel = "max",
  ) {}

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
      this.level = requested;

      // Pi marks a changed thinking default for persistence when this API is
      // called. Write it immediately here so the eventual disk state is
      // deterministic without reproducing Pi's debounced flush machinery.
      const settings = readSettings(this.settingsPath);
      settings.defaultThinkingLevel = requested;
      writeFileSync(
        this.settingsPath,
        `${JSON.stringify(settings, null, 2)}\n`,
      );
    },
  } as unknown as ExtensionAPI;

  async emit(event: string, payload: object, ctx: ExtensionContext) {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(payload as never, ctx);
    }
  }

  async selectModel(
    cwd: string,
    previousModel: NonNullable<ExtensionContext["model"]>,
    nextModel: NonNullable<ExtensionContext["model"]>,
  ): Promise<ExtensionContext> {
    // AgentSession saves provider/model before emitting model_select.
    const settings = readSettings(this.settingsPath);
    settings.defaultProvider = nextModel.provider;
    settings.defaultModel = nextModel.id;
    writeFileSync(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

    const nextContext = context(cwd, nextModel);
    await this.emit(
      "model_select",
      {
        model: nextModel,
        previousModel,
        source: "set",
      },
      nextContext,
    );
    return nextContext;
  }
}

interface Fixture {
  agentDir: string;
  cwd: string;
  fixedDefaultsPath: string;
  modelThinkingPath: string;
  settingsPath: string;
}

function fixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "model-policy-test-"));
  temporaryDirectories.push(directory);
  const agentDir = join(directory, "agent");
  mkdirSync(agentDir, { recursive: true });
  return {
    agentDir,
    cwd: join(directory, "project"),
    fixedDefaultsPath: join(agentDir, "fixed-defaults.json"),
    modelThinkingPath: join(agentDir, "model-thinking.json"),
    settingsPath: join(agentDir, "settings.json"),
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function registerPolicies(pi: PiHarness, paths: Fixture): void {
  // This matches the production registration order in index.ts.
  modelThinking(pi.api, { configPath: paths.modelThinkingPath });
  fixedDefaults(pi.api, { agentDir: paths.agentDir });
}

describe("model policy extensions", () => {
  test("a legacy pin cannot override thinking in the current or next fresh session", async () => {
    const paths = fixture();
    writeJson(paths.settingsPath, {
      defaultProvider: "zai",
      defaultModel: "glm-5.2",
      defaultThinkingLevel: "max",
    });
    writeJson(paths.fixedDefaultsPath, {
      provider: "opencode",
      model: "deepseek-v4-flash-free",
      thinkingLevel: "max",
    });
    writeJson(paths.modelThinkingPath, {
      models: {
        "zai/glm-5.2": "high",
        "opencode/deepseek-v4-flash-free": "high",
      },
    });

    const firstPi = new PiHarness(paths.settingsPath);
    registerPolicies(firstPi, paths);
    const firstContext = context(paths.cwd, model("zai", "glm-5.2"));

    await firstPi.emit("session_start", { reason: "startup" }, firstContext);

    // Pi chose GLM before session_start. The pin changes only the saved model;
    // model-thinking alone changes active and persisted thinking.
    expect(firstContext.model).toEqual(model("zai", "glm-5.2"));
    expect(firstPi.level).toBe("high");
    expect(readSettings(paths.settingsPath)).toEqual({
      defaultProvider: "opencode",
      defaultModel: "deepseek-v4-flash-free",
      defaultThinkingLevel: "high",
    });

    // Simulate Pi's next fresh startup resolving the model from settings.json.
    const secondPi = new PiHarness(paths.settingsPath, "high");
    registerPolicies(secondPi, paths);
    const secondContext = context(
      paths.cwd,
      model("opencode", "deepseek-v4-flash-free"),
    );
    await secondPi.emit("session_start", { reason: "startup" }, secondContext);

    expect(secondContext.model).toEqual(
      model("opencode", "deepseek-v4-flash-free"),
    );
    expect(secondPi.level).toBe("high");
    expect(readSettings(paths.settingsPath)).toEqual({
      defaultProvider: "opencode",
      defaultModel: "deepseek-v4-flash-free",
      defaultThinkingLevel: "high",
    });
  });

  test("model selection applies thinking while restoring only the pinned model", async () => {
    const paths = fixture();
    writeJson(paths.settingsPath, {
      defaultProvider: "zai",
      defaultModel: "glm-5.2",
      defaultThinkingLevel: "max",
    });
    writeJson(paths.fixedDefaultsPath, {
      provider: "opencode",
      model: "deepseek-v4-flash-free",
    });
    writeJson(paths.modelThinkingPath, {
      models: { "anthropic/claude-sonnet-4": "low" },
    });

    const pi = new PiHarness(paths.settingsPath);
    registerPolicies(pi, paths);
    await pi.selectModel(
      paths.cwd,
      model("zai", "glm-5.2"),
      model("anthropic", "claude-sonnet-4"),
    );

    expect(pi.level).toBe("low");
    expect(readSettings(paths.settingsPath)).toEqual({
      defaultProvider: "opencode",
      defaultModel: "deepseek-v4-flash-free",
      defaultThinkingLevel: "low",
    });
  });

  test("reset removes only the model pin and preserves thinking policy", async () => {
    const paths = fixture();
    const thinkingConfig = {
      models: { "zai/glm-5.2": "high" },
    };
    writeJson(paths.settingsPath, {
      defaultProvider: "opencode",
      defaultModel: "deepseek-v4-flash-free",
      defaultThinkingLevel: "max",
    });
    writeJson(paths.fixedDefaultsPath, {
      provider: "opencode",
      model: "deepseek-v4-flash-free",
      thinkingLevel: "max",
    });
    writeJson(paths.modelThinkingPath, thinkingConfig);

    const pi = new PiHarness(paths.settingsPath);
    registerPolicies(pi, paths);
    const activeContext = context(paths.cwd, model("zai", "glm-5.2"));
    await pi.emit("session_start", { reason: "startup" }, activeContext);
    await pi.commands.get("fixed-defaults")!("reset", activeContext);

    expect(existsSync(paths.fixedDefaultsPath)).toBe(false);
    expect(JSON.parse(readFileSync(paths.modelThinkingPath, "utf8"))).toEqual(
      thinkingConfig,
    );
    expect(pi.level).toBe("high");
    expect(readSettings(paths.settingsPath)).toEqual({
      defaultProvider: "zai",
      defaultModel: "glm-5.2",
      defaultThinkingLevel: "high",
    });
  });
});
