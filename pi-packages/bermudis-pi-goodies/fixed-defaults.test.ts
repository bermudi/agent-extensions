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
import { dirname, join } from "node:path";
import fixedDefaults from "./fixed-defaults.ts";

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
  options: {
    model?: NonNullable<ExtensionContext["model"]>;
    notifications?: string[];
    modelRegistry?: ExtensionContext["modelRegistry"];
  } = {},
): ExtensionContext {
  const notifications = options.notifications ?? [];
  return {
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    model: options.model,
    modelRegistry: options.modelRegistry ?? {
      find: (provider: string, id: string) => model(provider, id),
    },
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext;
}

class PiHarness {
  level: ReturnType<ExtensionAPI["getThinkingLevel"]> = "high";
  readonly handlers = new Map<string, Handler[]>();
  readonly commands = new Map<string, CommandHandler>();

  setModelCalls: Array<{ provider: string; id: string }> = [];

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
    setModel: async (model: { provider: string; id: string }) => {
      this.setModelCalls.push({ provider: model.provider, id: model.id });
      return true;
    },
  } as unknown as ExtensionAPI;

  async emit(event: string, payload: object, ctx: ExtensionContext) {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(payload as never, ctx);
    }
  }
}

function setup(): {
  directory: string;
  cwd: string;
  agentDir: string;
  settingsPath: string;
  original: Record<string, unknown>;
  pi: PiHarness;
  ctx: ExtensionContext;
} {
  const directory = mkdtempSync(join(tmpdir(), "fixed-defaults-test-"));
  temporaryDirectories.push(directory);
  const cwd = join(directory, "project");
  const agentDir = join(directory, "agent");
  const settingsPath = join(agentDir, "settings.json");
  const original = {
    lastChangelogVersion: "0.83.0",
    defaultProvider: "zai",
    defaultModel: "glm-5.2",
    defaultThinkingLevel: "high",
    hideThinkingBlock: true,
    defaultProjectTrust: "always",
    packages: ["npm:example"],
  };
  mkdirForFile(settingsPath);
  writeFileSync(settingsPath, `${JSON.stringify(original, null, 2)}\n`);

  const pi = new PiHarness();
  return {
    directory,
    cwd,
    agentDir,
    settingsPath,
    original,
    pi,
    ctx: context(cwd),
  };
}

function settingsAt(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("fixed-defaults", () => {
  test("with no override, events leave settings untouched", async () => {
    const { agentDir, settingsPath, original, pi, ctx } = setup();
    fixedDefaults(pi.api, { agentDir });

    await pi.emit("session_start", { reason: "startup" }, ctx);
    await pi.emit(
      "model_select",
      {
        model: { provider: "zai", id: "glm-5.2" },
        previousModel: undefined,
        source: "set",
      },
      ctx,
    );
    await pi.emit(
      "thinking_level_select",
      { level: "high", previousLevel: "max" },
      ctx,
    );

    expect(settingsAt(settingsPath)).toEqual(original);
  });

  test("set pins the active model and applies it immediately", async () => {
    const { agentDir, settingsPath, original, pi, ctx } = setup();
    fixedDefaults(pi.api, { agentDir });
    const handler = pi.commands.get("fixed-defaults")!;
    const notifications: string[] = [];

    await handler(
      "set",
      context(ctx.cwd, { model: model("zai", "glm-5.2"), notifications }),
    );

    // Override file written.
    expect(
      JSON.parse(
        readFileSync(join(agentDir, "fixed-defaults.json"), "utf8"),
      ) as unknown,
    ).toEqual({
      provider: "zai",
      model: "glm-5.2",
    });
    // Settings file updated immediately, without waiting for an event. The
    // thinking default remains owned by Pi/model-thinking.
    expect(settingsAt(settingsPath)).toEqual({
      ...original,
      defaultProvider: "zai",
      defaultModel: "glm-5.2",
    });
    expect(notifications.some((n) => n.includes("zai/glm-5.2"))).toBe(true);
  });

  test("model events restore the pinned override without changing thinking", async () => {
    const { agentDir, settingsPath, original, pi, ctx } = setup();
    fixedDefaults(pi.api, { agentDir });
    const handler = pi.commands.get("fixed-defaults")!;

    await handler("set", context(ctx.cwd, { model: model("zai", "glm-5.2") }));

    // Pi persists the selected model and thinking level before it emits the
    // model event. Reproduce that ordering rather than asking the extension to
    // restore against stale settings.
    writeFileSync(
      settingsPath,
      `${JSON.stringify(
        {
          ...original,
          defaultProvider: "anthropic",
          defaultModel: "claude-sonnet-4",
          defaultThinkingLevel: "low",
        },
        null,
        2,
      )}\n`,
    );
    await pi.emit(
      "model_select",
      {
        model: { provider: "anthropic", id: "claude-sonnet-4" },
        previousModel: { provider: "zai", id: "glm-5.2" },
        source: "set",
      },
      ctx,
    );
    await pi.emit(
      "thinking_level_select",
      { level: "low", previousLevel: "xhigh" },
      ctx,
    );

    expect(settingsAt(settingsPath)).toEqual({
      ...original,
      defaultProvider: "zai",
      defaultModel: "glm-5.2",
      defaultThinkingLevel: "low",
    });
    expect(pi.handlers.has("thinking_level_select")).toBe(false);
  });

  test("reset removes the override and stops pinning", async () => {
    const { agentDir, settingsPath, original, pi, ctx } = setup();
    fixedDefaults(pi.api, { agentDir });
    const handler = pi.commands.get("fixed-defaults")!;
    const notifications: string[] = [];

    await handler("set", context(ctx.cwd, { model: model("zai", "glm-5.2") }));
    expect(existsSync(join(agentDir, "fixed-defaults.json"))).toBe(true);

    const activeModel = model("anthropic", "claude-sonnet-4");
    await handler(
      "reset",
      context(ctx.cwd, { model: activeModel, notifications }),
    );
    expect(existsSync(join(agentDir, "fixed-defaults.json"))).toBe(false);
    expect(
      notifications.some((n) =>
        n.includes("anthropic/claude-sonnet-4 as its last selection"),
      ),
    ).toBe(true);

    // Reset persists the model that is active now, so the former pin cannot
    // remain in settings.json and win the next startup.
    expect(settingsAt(settingsPath)).toEqual({
      ...original,
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4",
    });

    await pi.emit("session_start", { reason: "startup" }, ctx);
    expect(settingsAt(settingsPath)).toEqual({
      ...original,
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4",
    });
  });

  test("session_start with reason new restores the previous model without dropping the pin", async () => {
    const { agentDir, settingsPath, original, pi, ctx } = setup();
    fixedDefaults(pi.api, { agentDir });
    const handler = pi.commands.get("fixed-defaults")!;

    // Pin zai/glm-5.2 as the startup default.
    await handler("set", context(ctx.cwd, { model: model("zai", "glm-5.2") }));

    // The active session was switched to anthropic/claude-sonnet-4.
    const previousCtx = context(ctx.cwd, {
      model: model("anthropic", "claude-sonnet-4"),
    });
    await pi.emit("session_before_switch", { reason: "new" }, previousCtx);

    // The /new runtime starts on the pinned default, then fires session_start
    // with reason "new". The extension should restore the previous session model.
    const newCtx = context(ctx.cwd, { model: model("zai", "glm-5.2") });
    await pi.emit(
      "session_start",
      { reason: "new", previousSessionFile: "/tmp/old.jsonl" },
      newCtx,
    );

    expect(pi.setModelCalls).toEqual([
      { provider: "anthropic", id: "claude-sonnet-4" },
    ]);
    // The pin file remains intact for the next fresh startup.
    expect(
      JSON.parse(
        readFileSync(join(agentDir, "fixed-defaults.json"), "utf8"),
      ) as unknown,
    ).toEqual({ provider: "zai", model: "glm-5.2" });
    // The model_select notification that pi.setModel triggers re-applies the pin.
    await pi.emit(
      "model_select",
      {
        model: { provider: "anthropic", id: "claude-sonnet-4" },
        previousModel: { provider: "zai", id: "glm-5.2" },
        source: "set",
      },
      newCtx,
    );
    expect(settingsAt(settingsPath)).toEqual({
      ...original,
      defaultProvider: "zai",
      defaultModel: "glm-5.2",
    });
  });

  test("session_start with reason new leaves the pin when no previous model was captured", async () => {
    const { agentDir, settingsPath, original, pi, ctx } = setup();
    fixedDefaults(pi.api, { agentDir });
    const handler = pi.commands.get("fixed-defaults")!;

    await handler("set", context(ctx.cwd, { model: model("zai", "glm-5.2") }));

    // No session_before_switch capture (e.g. /new from a session without a model).
    await pi.emit(
      "session_start",
      { reason: "new", previousSessionFile: "/tmp/old.jsonl" },
      context(ctx.cwd, { model: model("zai", "glm-5.2") }),
    );

    expect(pi.setModelCalls).toEqual([]);
    expect(settingsAt(settingsPath)).toEqual({
      ...original,
      defaultProvider: "zai",
      defaultModel: "glm-5.2",
    });
  });

  test("reset without an active model leaves the pin in place", async () => {
    const { agentDir, pi, ctx } = setup();
    fixedDefaults(pi.api, { agentDir });
    const handler = pi.commands.get("fixed-defaults")!;
    const notifications: string[] = [];

    await handler("set", context(ctx.cwd, { model: model("zai", "glm-5.2") }));
    await handler("reset", context(ctx.cwd, { notifications }));

    expect(existsSync(join(agentDir, "fixed-defaults.json"))).toBe(true);
    expect(
      notifications.some((message) => message.includes("active model")),
    ).toBe(true);
  });

  test("legacy thinkingLevel is ignored and does not pin thinking", async () => {
    const { agentDir, settingsPath, original, pi, ctx } = setup();
    writeFileSync(
      join(agentDir, "fixed-defaults.json"),
      `${JSON.stringify(
        { provider: "zai", model: "glm-5.2", thinkingLevel: "max" },
        null,
        2,
      )}\n`,
    );
    fixedDefaults(pi.api, { agentDir });

    await pi.emit("session_start", { reason: "startup" }, ctx);
    await pi.emit(
      "thinking_level_select",
      { level: "low", previousLevel: "high" },
      ctx,
    );

    expect(settingsAt(settingsPath)).toEqual({
      ...original,
      defaultProvider: "zai",
      defaultModel: "glm-5.2",
    });
  });

  test("provider or model alone is rejected and nothing is applied", async () => {
    const { agentDir, settingsPath, original, pi, ctx } = setup();
    writeFileSync(
      join(agentDir, "fixed-defaults.json"),
      `${JSON.stringify({ model: "gpt-5.2-preview" }, null, 2)}\n`,
    );
    fixedDefaults(pi.api, { agentDir });

    await pi.emit("session_start", { reason: "startup" }, ctx);

    expect(settingsAt(settingsPath)).toEqual(original);
  });

  test("reset removes an invalid override without changing settings", async () => {
    const { agentDir, settingsPath, original, pi, ctx } = setup();
    const overridePath = join(agentDir, "fixed-defaults.json");
    writeFileSync(overridePath, "not json\n");
    fixedDefaults(pi.api, { agentDir });
    const handler = pi.commands.get("fixed-defaults")!;

    await handler(
      "reset",
      context(ctx.cwd, { model: model("zai", "glm-5.2") }),
    );

    expect(existsSync(overridePath)).toBe(false);
    expect(settingsAt(settingsPath)).toEqual(original);
  });

  test("reset removes a legacy thinkingLevel-only override without changing settings", async () => {
    const { agentDir, settingsPath, original, pi, ctx } = setup();
    const overridePath = join(agentDir, "fixed-defaults.json");
    writeFileSync(
      overridePath,
      `${JSON.stringify({ thinkingLevel: "max" })}\n`,
    );
    fixedDefaults(pi.api, { agentDir });
    const handler = pi.commands.get("fixed-defaults")!;

    await handler(
      "reset",
      context(ctx.cwd, { model: model("zai", "glm-5.2") }),
    );

    expect(existsSync(overridePath)).toBe(false);
    expect(settingsAt(settingsPath)).toEqual(original);
  });

  test("status shows the effective pin, active model, and override path", async () => {
    const { agentDir, pi, ctx } = setup();
    writeFileSync(
      join(agentDir, "fixed-defaults.json"),
      `${JSON.stringify(
        { provider: "zai", model: "glm-5.2", thinkingLevel: "max" },
        null,
        2,
      )}\n`,
    );
    fixedDefaults(pi.api, { agentDir });
    const handler = pi.commands.get("fixed-defaults")!;
    const notifications: string[] = [];

    await handler(
      "",
      context(ctx.cwd, { model: model("zai", "glm-5.2"), notifications }),
    );

    const message = notifications[0];
    expect(message).toContain("pinned provider: zai");
    expect(message).toContain("pinned model: glm-5.2");
    expect(message).not.toContain("pinned thinking");
    expect(message).not.toContain("\nthinking:");
    expect(message).toContain("legacy thinkingLevel is present but ignored");
    expect(message).toContain("/model-thinking");
    expect(message).toContain(join(agentDir, "fixed-defaults.json"));
  });

  test("set without an active model warns and writes nothing", async () => {
    const { agentDir, settingsPath, original, pi, ctx } = setup();
    fixedDefaults(pi.api, { agentDir });
    const handler = pi.commands.get("fixed-defaults")!;
    const notifications: string[] = [];

    await handler("set", context(ctx.cwd, { notifications }));

    expect(notifications.some((n) => n.includes("active model"))).toBe(true);
    expect(existsSync(join(agentDir, "fixed-defaults.json"))).toBe(false);
    expect(settingsAt(settingsPath)).toEqual(original);
  });

  test("unknown subcommands show usage", async () => {
    const { agentDir, pi, ctx } = setup();
    fixedDefaults(pi.api, { agentDir });
    const handler = pi.commands.get("fixed-defaults")!;
    const notifications: string[] = [];

    await handler("bogus", context(ctx.cwd, { notifications }));

    expect(notifications.some((n) => n.includes("Usage"))).toBe(true);
  });

  test("an invalid override file is ignored and nothing is applied", async () => {
    const { agentDir, settingsPath, original, pi, ctx } = setup();
    writeFileSync(join(agentDir, "fixed-defaults.json"), "not json\n");
    fixedDefaults(pi.api, { agentDir });

    await pi.emit("session_start", { reason: "startup" }, ctx);

    expect(settingsAt(settingsPath)).toEqual(original);
  });

  test("status warns when the override file is invalid", async () => {
    const { agentDir, pi, ctx } = setup();
    writeFileSync(join(agentDir, "fixed-defaults.json"), "not json\n");
    fixedDefaults(pi.api, { agentDir });
    const handler = pi.commands.get("fixed-defaults")!;
    const notifications: string[] = [];

    pi.level = "high";
    await handler(
      "",
      context(ctx.cwd, { model: model("zai", "glm-5.2"), notifications }),
    );

    const message = notifications[0];
    expect(message).toContain("override file invalid");
    expect(message).toContain("no pin active");
    expect(message).not.toContain("pinned model");
  });
});

function mkdirForFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}
