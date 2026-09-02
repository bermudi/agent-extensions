import { describe, expect, test, beforeEach } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import modelThinking, {
  cliModelSelection,
  explicitCliThinking,
  parseStoredLevels,
} from "./model-thinking.ts";
import { setGoodiesLogPathForTesting } from "./goodies-log.ts";

type Handler = (event: never, ctx: ExtensionContext) => unknown;
type ModelSelectEvent = Extract<ExtensionEvent, { type: "model_select" }>;

interface CommandRegistration {
  description?: string;
  getArgumentCompletions?: (prefix: string) => unknown;
  handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

function makeModel(
  provider: string,
  id: string,
  overrides: Partial<Model<Api>> = {},
): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: `https://${provider}.test/v1`,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8000,
    maxTokens: 100,
    ...overrides,
  } as Model<Api>;
}

class PiHarness {
  readonly handlers = new Map<string, Handler>();
  readonly commands = new Map<string, CommandRegistration>();
  thinkingLevel = "medium";
  readonly notifications: { message: string; type: string }[] = [];

  readonly api = {
    on: (event: string, handler: Handler) => {
      this.handlers.set(event, handler);
    },
    registerCommand: (name: string, options: CommandRegistration) => {
      this.commands.set(name, options);
    },
    getThinkingLevel: () => this.thinkingLevel,
    setThinkingLevel: (level: string) => {
      this.thinkingLevel = level;
    },
  } as unknown as ExtensionAPI;

  constructor(
    readonly levelsPath: string,
    readonly cliArgs: string[] = [],
  ) {}

  load(): void {
    modelThinking(this.api, {
      levelsPath: this.levelsPath,
      cliArgs: this.cliArgs,
    });
  }

  async modelSelect(
    model: Model<Api>,
    source: ModelSelectEvent["source"],
    ctxOverrides: Partial<ExtensionContext> = {},
  ): Promise<void> {
    const ctx = this.context(model, ctxOverrides);
    await this.handlers.get("model_select")?.(
      {
        type: "model_select",
        model,
        previousModel: undefined,
        source,
      } as never,
      ctx,
    );
  }

  async sessionStart(
    reason: SessionStartEvent["reason"],
    model: Model<Api>,
    ctxOverrides: Partial<ExtensionContext> = {},
  ): Promise<void> {
    const ctx = this.context(model, ctxOverrides);
    await this.handlers.get("session_start")?.(
      { type: "session_start", reason } as never,
      ctx,
    );
  }

  async runCommand(args: string, model: Model<Api>): Promise<void> {
    const command = this.commands.get("model-thinking");
    if (!command) throw new Error("model-thinking command not registered");
    await command.handler(args, this.context(model));
  }

  context(
    model: Model<Api>,
    overrides: Partial<ExtensionContext> = {},
  ): ExtensionContext {
    return {
      cwd: "/project",
      hasUI: true,
      mode: "tui",
      model,
      scopedModels: [],
      sessionManager: {
        getEntries: () => [],
      },
      ui: {
        notify: (message: string, type: string) => {
          this.notifications.push({ message, type });
        },
      },
      ...overrides,
    } as unknown as ExtensionContext;
  }
}

let scratchDir: string;
let levelsPath: string;
const scratchDirs: string[] = [];

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "model-thinking-test-"));
  scratchDirs.push(scratchDir);
  levelsPath = join(scratchDir, "thinking-levels.json");
  setGoodiesLogPathForTesting(join(scratchDir, "goodies.log"));
});

describe("parseStoredLevels", () => {
  test("accepts a well-formed map", () => {
    const parsed = parseStoredLevels({
      "zai/glm-5.3": "high",
      "openai-codex/gpt-5.6-sol": "off",
    });
    expect(parsed).toEqual({
      "zai/glm-5.3": "high",
      "openai-codex/gpt-5.6-sol": "off",
    });
  });

  test("rejects non-objects, bad keys, and bad levels", () => {
    expect(() => parseStoredLevels(null)).toThrow();
    expect(() => parseStoredLevels([1, 2])).toThrow();
    expect(() => parseStoredLevels({ "no-slash": "high" })).toThrow();
    expect(() => parseStoredLevels({ "zai/glm": "ultra" })).toThrow();
    expect(() => parseStoredLevels({ "zai/glm": 7 })).toThrow();
  });
});

describe("explicitCliThinking", () => {
  test("detects --thinking and :level suffixes", () => {
    expect(explicitCliThinking(["--thinking", "high"])).toBe(true);
    expect(explicitCliThinking(["--model", "zai/glm-5.3:low"])).toBe(true);
    expect(explicitCliThinking(["--model", "zai/glm-5.3"])).toBe(false);
    expect(explicitCliThinking([])).toBe(false);
  });

  test("mirrors pi semantics: last --model wins, invalid --thinking ignored, trailing flag set nothing", () => {
    expect(
      explicitCliThinking(["--model", "zai/glm:high", "--model", "zai/glm"]),
    ).toBe(false);
    expect(explicitCliThinking(["--thinking", "bogus"])).toBe(false);
    expect(explicitCliThinking(["--model", "zai/glm", "--thinking"])).toBe(
      false,
    );
  });
});

describe("cliModelSelection", () => {
  test("returns provider/id for a bare --model", () => {
    expect(cliModelSelection(["--model", "zai/glm-5.3"])).toEqual({
      provider: "zai",
      id: "glm-5.3",
    });
  });

  test("strips a :level suffix and reports the last --model", () => {
    expect(
      cliModelSelection(["--model", "zai/a:high", "--model", "zai/b:low"]),
    ).toEqual({ provider: "zai", id: "b" });
  });

  test("undefined for no --model, bare names, or trailing flags", () => {
    expect(cliModelSelection([])).toBeUndefined();
    expect(cliModelSelection(["--model", "glm-5.3"])).toBeUndefined();
    expect(cliModelSelection(["--model"])).toBeUndefined();
  });
});

describe("model_select", () => {
  test("applies the stored level on set", async () => {
    const glm = makeModel("zai", "glm-5.3");
    const pi = new PiHarness(levelsPath);
    pi.load();
    await pi.runCommand("high", glm);
    pi.thinkingLevel = "medium"; // pi's own switch choice
    await pi.modelSelect(glm, "set");
    expect(pi.thinkingLevel).toBe("high");
    expect(pi.notifications.at(-1)?.message).toBe("Thinking: medium → high");
  });

  test("applies the stored level on cycle", async () => {
    const glm = makeModel("zai", "glm-5.3");
    const pi = new PiHarness(levelsPath);
    pi.load();
    await pi.runCommand("low", glm);
    pi.thinkingLevel = "max";
    await pi.modelSelect(glm, "cycle");
    expect(pi.thinkingLevel).toBe("low");
  });

  test("restore is left alone", async () => {
    const glm = makeModel("zai", "glm-5.3");
    const pi = new PiHarness(levelsPath);
    pi.load();
    await pi.runCommand("high", glm);
    pi.thinkingLevel = "low"; // the resumed session's level
    await pi.modelSelect(glm, "restore");
    expect(pi.thinkingLevel).toBe("low");
  });

  test("no stored level means no touch", async () => {
    const glm = makeModel("zai", "glm-5.3");
    const pi = new PiHarness(levelsPath);
    pi.load();
    pi.thinkingLevel = "low"; // what pi chose (global default etc.)
    await pi.modelSelect(glm, "set");
    expect(pi.thinkingLevel).toBe("low");
    expect(pi.notifications).toEqual([]);
  });

  test("a scoped pin outranks the sidecar on set (pi does not apply it there)", async () => {
    const glm = makeModel("zai", "glm-5.3");
    const pi = new PiHarness(levelsPath);
    pi.load();
    await pi.runCommand("high", glm);
    const ctx = {
      scopedModels: [{ model: glm, thinkingLevel: "minimal" }],
    };
    pi.thinkingLevel = "max";
    await pi.modelSelect(glm, "set", ctx);
    expect(pi.thinkingLevel).toBe("minimal");
  });

  test("a scoped pin on cycle is left to pi", async () => {
    const glm = makeModel("zai", "glm-5.3");
    const pi = new PiHarness(levelsPath);
    pi.load();
    await pi.runCommand("high", glm);
    const ctx = {
      scopedModels: [{ model: glm, thinkingLevel: "minimal" }],
    };
    pi.thinkingLevel = "minimal"; // pi already applied the pin while cycling
    await pi.modelSelect(glm, "cycle", ctx);
    expect(pi.thinkingLevel).toBe("minimal");
  });

  test("reads the sidecar fresh, so other sessions' saves apply", async () => {
    const glm = makeModel("zai", "glm-5.3");
    const writer = new PiHarness(levelsPath);
    writer.load();
    await writer.runCommand("high", glm);

    const reader = new PiHarness(levelsPath);
    reader.load();
    reader.thinkingLevel = "medium";
    await reader.modelSelect(glm, "set");
    expect(reader.thinkingLevel).toBe("high");
  });
});

describe("session_start", () => {
  test("fresh startup applies the stored level silently", async () => {
    const glm = makeModel("zai", "glm-5.3");
    const pi = new PiHarness(levelsPath);
    pi.load();
    await pi.runCommand("high", glm);
    pi.thinkingLevel = "max"; // pi's global default at startup
    pi.notifications.length = 0; // drop the save confirmation toast
    await pi.sessionStart("startup", glm);
    expect(pi.thinkingLevel).toBe("high");
    expect(
      pi.notifications.filter((n) => n.message.startsWith("Thinking:")),
    ).toEqual([]);
  });

  test("startup with --thinking suppresses the stored level", async () => {
    const glm = makeModel("zai", "glm-5.3");
    const pi = new PiHarness(levelsPath, ["--thinking", "low"]);
    pi.load();
    await pi.runCommand("high", glm);
    pi.thinkingLevel = "low";
    await pi.sessionStart("startup", glm);
    expect(pi.thinkingLevel).toBe("low");
  });

  test("startup with --model x:level suppresses the stored level", async () => {
    const glm = makeModel("zai", "glm-5.3");
    const pi = new PiHarness(levelsPath, ["--model", "zai/glm-5.3:low"]);
    pi.load();
    await pi.runCommand("high", glm);
    pi.thinkingLevel = "low";
    await pi.sessionStart("startup", glm);
    expect(pi.thinkingLevel).toBe("low");
  });

  test("resumed session (pi --continue) keeps its restored level", async () => {
    const glm = makeModel("zai", "glm-5.3");
    const pi = new PiHarness(levelsPath, ["--continue"]);
    pi.load();
    await pi.runCommand("high", glm);
    pi.thinkingLevel = "low"; // restored from the session file
    await pi.sessionStart("startup", glm, {
      sessionManager: {
        getEntries: () => [{ type: "message" }],
      },
    });
    expect(pi.thinkingLevel).toBe("low");
  });

  test("resumed session with a bare --model applies that model's default", async () => {
    const glm = makeModel("zai", "glm-5.3");
    const pi = new PiHarness(levelsPath, [
      "--continue",
      "--model",
      "zai/glm-5.3",
    ]);
    pi.load();
    await pi.runCommand("high", glm);
    pi.thinkingLevel = "low";
    await pi.sessionStart("startup", glm, {
      sessionManager: {
        getEntries: () => [{ type: "message" }],
      },
    });
    expect(pi.thinkingLevel).toBe("high");
  });

  test("resume, reload, and fork are left alone", async () => {
    const glm = makeModel("zai", "glm-5.3");
    const pi = new PiHarness(levelsPath);
    pi.load();
    await pi.runCommand("high", glm);
    for (const reason of ["resume", "reload", "fork"] as const) {
      pi.thinkingLevel = "low";
      await pi.sessionStart(reason, glm);
      expect(pi.thinkingLevel).toBe("low");
    }
  });

  test("/new notifies when it changes the level", async () => {
    const glm = makeModel("zai", "glm-5.3");
    const pi = new PiHarness(levelsPath);
    pi.load();
    await pi.runCommand("high", glm);
    pi.thinkingLevel = "max";
    await pi.sessionStart("new", glm);
    expect(pi.thinkingLevel).toBe("high");
    expect(pi.notifications.at(-1)?.message).toBe("Thinking: max → high");
  });

  test("/new also applies a scoped pin that pi's new session missed", async () => {
    const glm = makeModel("zai", "glm-5.3");
    const pi = new PiHarness(levelsPath);
    pi.load();
    await pi.runCommand("high", glm);
    pi.thinkingLevel = "max";
    await pi.sessionStart("new", glm, {
      scopedModels: [{ model: glm, thinkingLevel: "low" }],
    });
    expect(pi.thinkingLevel).toBe("low");
  });
});

describe("/model-thinking command", () => {
  test("no args saves the current level for the current model", async () => {
    const glm = makeModel("zai", "glm-5.3");
    const pi = new PiHarness(levelsPath);
    pi.load();
    pi.thinkingLevel = "xhigh";
    await pi.runCommand("", glm);
    expect(pi.notifications.at(-1)?.message).toBe(
      "zai/glm-5.3 thinking default: xhigh",
    );
    expect(JSON.parse(readFileSync(levelsPath, "utf8"))).toEqual({
      "zai/glm-5.3": "xhigh",
    });
  });

  test("explicit level saves and applies now", async () => {
    const glm = makeModel("zai", "glm-5.3");
    const pi = new PiHarness(levelsPath);
    pi.load();
    pi.thinkingLevel = "medium";
    await pi.runCommand("high", glm);
    expect(pi.thinkingLevel).toBe("high");
    expect(pi.notifications.at(-1)?.message).toBe(
      "zai/glm-5.3 thinking default: high",
    );
  });

  test("rejects unsupported levels for the model", async () => {
    const { existsSync } = await import("node:fs");
    const glm = makeModel("zai", "glm-5.3", {
      // supports minimal..high only, like most models
      thinkingLevelMap: {
        off: null,
        minimal: "minimal",
        low: "low",
        medium: "medium",
        high: "high",
      },
    });
    const pi = new PiHarness(levelsPath);
    pi.load();
    await pi.runCommand("max", glm);
    expect(pi.notifications.at(-1)).toMatchObject({ type: "warning" });
    expect(pi.thinkingLevel).toBe("medium"); // untouched
    expect(existsSync(levelsPath)).toBe(false); // nothing was saved
  });

  test("rejects unknown words with usage", async () => {
    const glm = makeModel("zai", "glm-5.3");
    const pi = new PiHarness(levelsPath);
    pi.load();
    await pi.runCommand("turbo", glm);
    expect(pi.notifications.at(-1)?.type).toBe("warning");
    expect(pi.notifications.at(-1)?.message).toContain("Usage");
  });

  test("off removes a saved default", async () => {
    const glm = makeModel("zai", "glm-5.3");
    const pi = new PiHarness(levelsPath);
    pi.load();
    await pi.runCommand("high", glm);
    await pi.runCommand("off", glm);
    expect(pi.notifications.at(-1)?.message).toContain("removed");
    expect(JSON.parse(readFileSync(levelsPath, "utf8"))).toEqual({});
  });

  test("off on an unsaved model is a no-op notice", async () => {
    const glm = makeModel("zai", "glm-5.3");
    const pi = new PiHarness(levelsPath);
    pi.load();
    await pi.runCommand("off", glm);
    expect(pi.notifications.at(-1)?.message).toContain(
      "No thinking default saved",
    );
  });

  test("list shows entries and marks the active model", async () => {
    const glm = makeModel("zai", "glm-5.3");
    const sol = makeModel("openai-codex", "gpt-5.6-sol");
    const pi = new PiHarness(levelsPath);
    pi.load();
    await pi.runCommand("high", glm);
    await pi.runCommand("medium", sol);
    pi.notifications.length = 0;
    await pi.runCommand("list", glm);
    const message = pi.notifications.at(-1)?.message ?? "";
    expect(message).toContain("● zai/glm-5.3: high");
    expect(message).toContain("openai-codex/gpt-5.6-sol: medium");
  });

  test("list with no entries explains how to save one", async () => {
    const glm = makeModel("zai", "glm-5.3");
    const pi = new PiHarness(levelsPath);
    pi.load();
    await pi.runCommand("list", glm);
    expect(pi.notifications.at(-1)?.message).toContain("No per-model");
  });

  test("saves for other models never clobber this one (read-modify-write)", async () => {
    const glm = makeModel("zai", "glm-5.3");
    const sol = makeModel("openai-codex", "gpt-5.6-sol");
    const pi = new PiHarness(levelsPath);
    pi.load();
    await pi.runCommand("high", glm);
    await pi.runCommand("medium", sol);
    expect(JSON.parse(readFileSync(levelsPath, "utf8"))).toEqual({
      "zai/glm-5.3": "high",
      "openai-codex/gpt-5.6-sol": "medium",
    });
  });

  test("a corrupt sidecar degrades to empty instead of crashing", async () => {
    const glm = makeModel("zai", "glm-5.3");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(levelsPath, "{not json");
    const pi = new PiHarness(levelsPath);
    pi.load();
    pi.thinkingLevel = "low";
    await pi.modelSelect(glm, "set");
    expect(pi.thinkingLevel).toBe("low");
    await pi.runCommand("high", glm); // read-degraded-to-empty, then save
    expect(JSON.parse(readFileSync(levelsPath, "utf8"))).toEqual({
      "zai/glm-5.3": "high",
    });
  });

  test("completions cover levels and verbs", () => {
    const glm = makeModel("zai", "glm-5.3");
    const pi = new PiHarness(levelsPath);
    pi.load();
    const completions = pi.commands
      .get("model-thinking")
      ?.getArgumentCompletions?.("") as { value: string }[];
    expect(completions.map((c) => c.value)).toContain("high");
    expect(completions.map((c) => c.value)).toContain("list");
    expect(completions.map((c) => c.value)).toContain("off");
    const filtered = pi.commands
      .get("model-thinking")
      ?.getArgumentCompletions?.("hi") as { value: string }[];
    expect(filtered.map((c) => c.value)).toEqual(["high"]);
  });
});

describe("composition with keep-model-on-new", () => {
  test("the setModel restore after /new fires model_select and applies the default", async () => {
    // What keep-model-on-new does after /new: ctx.model is pi's default
    // model, then it calls pi.setModel(previous) — in real pi that emits
    // model_select with source "set" for the restored model.
    const glm = makeModel("zai", "glm-5.3");
    const pi = new PiHarness(levelsPath);
    pi.load();
    await pi.runCommand("high", glm);

    const afterNew = new PiHarness(levelsPath);
    afterNew.load();
    afterNew.thinkingLevel = "max"; // pi's fresh-session global default
    await afterNew.sessionStart("new", makeModel("zai", "glm-5.3-flash"));
    // keep-model-on-new then restores glm:
    await afterNew.modelSelect(glm, "set");
    expect(afterNew.thinkingLevel).toBe("high");
  });
});

// Sweep scratch dirs on exit; bun test lacks an afterAll that reliably
// pairs with per-test beforeEach dirs here.
process.on("exit", () => {
  for (const dir of scratchDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort — tmpdir cleanup handles the rest.
    }
  }
});
