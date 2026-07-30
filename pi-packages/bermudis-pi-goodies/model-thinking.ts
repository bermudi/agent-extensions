import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const CONFIG_FILENAME = "model-thinking.json";
const ALL_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

interface ModelThinkingConfig {
  models?: Record<string, ThinkingLevel>;
  providers?: Record<string, ThinkingLevel>;
}

interface ModelRef {
  provider: string;
  id: string;
}

interface PendingProgrammaticSet {
  token: symbol;
  modelKey: string;
  /** Undefined while setThinkingLevel is still on the stack. */
  effectiveLevel?: ThinkingLevel;
}

interface ModelThinkingOptions {
  /** Internal seam used by tests; normal callers use Pi's global agent dir. */
  configPath?: string;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    typeof value === "string" &&
    (ALL_LEVELS as readonly string[]).includes(value)
  );
}

function normalizeRecord(
  value: unknown,
  field: "models" | "providers",
): Record<string, ThinkingLevel> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`\`${field}\` must be an object`);
  }

  const result: Record<string, ThinkingLevel> = {};
  for (const [key, level] of Object.entries(value)) {
    if (!isThinkingLevel(level)) {
      throw new Error(
        `\`${field}.${key}\` must be one of: ${ALL_LEVELS.join(", ")}`,
      );
    }
    result[key] = level;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseConfig(value: unknown): ModelThinkingConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("the top level must be an object");
  }

  const input = value as Record<string, unknown>;
  const unknownKeys = Object.keys(input).filter(
    (key) => key !== "models" && key !== "providers",
  );
  if (unknownKeys.length > 0) {
    throw new Error(`unknown field(s): ${unknownKeys.join(", ")}`);
  }

  return {
    models: normalizeRecord(input.models, "models"),
    providers: normalizeRecord(input.providers, "providers"),
  };
}

function fileStamp(path: string): string | undefined {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

class ConfigStore {
  readonly path: string;
  private initialized = false;
  private cachedStamp: string | undefined;
  private cachedConfig: ModelThinkingConfig = {};

  constructor(path: string) {
    this.path = path;
  }

  load(): ModelThinkingConfig {
    let stamp: string | undefined;
    try {
      stamp = fileStamp(this.path);
    } catch (error) {
      console.error(`[model-thinking] failed to stat ${this.path}:`, error);
      return {};
    }

    if (this.initialized && stamp === this.cachedStamp) {
      return this.cachedConfig;
    }

    this.initialized = true;
    this.cachedStamp = stamp;
    if (stamp === undefined) {
      this.cachedConfig = {};
      return this.cachedConfig;
    }

    try {
      this.cachedConfig = parseConfig(
        JSON.parse(readFileSync(this.path, "utf8")) as unknown,
      );
    } catch (error) {
      console.error(
        `[model-thinking] invalid config at ${this.path}:`,
        error instanceof Error ? error.message : error,
      );
      this.cachedConfig = {};
    }
    return this.cachedConfig;
  }

  save(config: ModelThinkingConfig): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;

    try {
      writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(temporaryPath, this.path);
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The temporary file usually does not exist when the initial write failed.
      }
      throw error;
    }

    this.cachedConfig = config;
    this.cachedStamp = fileStamp(this.path);
    this.initialized = true;
  }

  reset(): boolean {
    try {
      unlinkSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }

    this.initialized = true;
    this.cachedStamp = undefined;
    this.cachedConfig = {};
    return true;
  }
}

function modelKey(model: ModelRef): string {
  return `${model.provider}/${model.id}`;
}

function resolveThinkingLevel(
  config: ModelThinkingConfig,
  model: ModelRef | undefined,
): ThinkingLevel | undefined {
  if (!model) return undefined;
  return config.models?.[modelKey(model)] ?? config.providers?.[model.provider];
}

/**
 * Opt-in per-model thinking policy. A provider or exact model must first be
 * present in model-thinking.json; unmanaged models retain Pi's native behavior.
 */
export default function modelThinking(
  pi: ExtensionAPI,
  options: ModelThinkingOptions = {},
): void {
  const store = new ConfigStore(
    options.configPath ?? join(getAgentDir(), CONFIG_FILENAME),
  );
  let activeModelKey: string | undefined;
  let pendingProgrammaticSet: PendingProgrammaticSet | undefined;

  function apply(ctx: ExtensionContext, silent: boolean): void {
    const model = ctx.model;
    const level = resolveThinkingLevel(store.load(), model);
    if (!model || level === undefined) return;

    const before = pi.getThinkingLevel();
    const token = Symbol("programmatic thinking-level change");
    pendingProgrammaticSet = {
      token,
      modelKey: modelKey(model),
    };

    try {
      pi.setThinkingLevel(level);
      const after = pi.getThinkingLevel();

      // Pi currently emits synchronously. Retaining the effective level also
      // handles a future deferred emitter and provider capability clamping.
      if (pendingProgrammaticSet?.token === token) {
        pendingProgrammaticSet =
          after === before
            ? undefined
            : {
                token,
                modelKey: modelKey(model),
                effectiveLevel: after,
              };
      }

      if (after !== before && !silent) {
        ctx.ui.notify(`Thinking: ${before} → ${after}`, "info");
      }
    } catch (error) {
      if (pendingProgrammaticSet?.token === token) {
        pendingProgrammaticSet = undefined;
      }
      throw error;
    }
  }

  function rememberUserLevel(
    ctx: ExtensionContext,
    level: ThinkingLevel,
  ): void {
    const model = ctx.model;
    if (!model) return;

    const config = store.load();
    const key = modelKey(model);
    const providerDefault = config.providers?.[model.provider];

    if (providerDefault !== undefined && level === providerDefault) {
      if (config.models?.[key] === undefined) return;
      const models = { ...config.models };
      delete models[key];
      const updated = { ...config };
      if (Object.keys(models).length === 0) delete updated.models;
      else updated.models = models;
      store.save(updated);
      return;
    }

    if (config.models?.[key] === level) return;
    store.save({
      ...config,
      models: { ...config.models, [key]: level },
    });
  }

  pi.on("model_select", (event, ctx) => {
    activeModelKey = modelKey(event.model);
    apply(ctx, event.source === "restore");
  });

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.model) return;
    activeModelKey = modelKey(ctx.model);
    apply(ctx, true);
  });

  pi.on("thinking_level_select", (event, ctx) => {
    const model = ctx.model;
    if (!model) return;
    const currentKey = modelKey(model);

    // Pi clamps/inherits thinking before model_select. At that point ctx.model
    // is already new, while activeModelKey still identifies the previous model.
    if (activeModelKey !== undefined && currentKey !== activeModelKey) return;

    const pending = pendingProgrammaticSet;
    if (
      pending?.modelKey === currentKey &&
      (pending.effectiveLevel === undefined ||
        pending.effectiveLevel === event.level)
    ) {
      pendingProgrammaticSet = undefined;
      return;
    }

    const config = store.load();
    if (resolveThinkingLevel(config, model) === undefined) return;

    try {
      rememberUserLevel(ctx, event.level);
    } catch (error) {
      console.error("[model-thinking] failed to save config:", error);
      ctx.ui.notify("Failed to save model-thinking config.", "error");
    }
  });

  pi.registerCommand("model-thinking", {
    description: "Show, save, or reset model-specific thinking levels",
    handler: async (args, ctx) => {
      const command = args.trim();

      if (command === "set") {
        const model = ctx.model;
        if (!model) {
          ctx.ui.notify(
            "Cannot save thinking level without an active model.",
            "warning",
          );
          return;
        }

        const key = modelKey(model);
        const level = pi.getThinkingLevel();
        try {
          const config = store.load();
          store.save({
            ...config,
            models: { ...config.models, [key]: level },
          });
          ctx.ui.notify(`Saved ${key}: ${level}`, "info");
        } catch (error) {
          console.error(
            "[model-thinking] failed to save current model:",
            error,
          );
          ctx.ui.notify("Failed to save model-thinking config.", "error");
        }
        return;
      }

      if (command === "reset") {
        try {
          const removed = store.reset();
          ctx.ui.notify(
            removed
              ? "Model-thinking config cleared."
              : "No model-thinking config file to clear.",
            "info",
          );
        } catch (error) {
          console.error("[model-thinking] failed to clear config:", error);
          ctx.ui.notify("Failed to clear model-thinking config.", "error");
        }
        return;
      }

      if (command !== "") {
        ctx.ui.notify("Usage: /model-thinking [set|reset]", "warning");
        return;
      }

      const model = ctx.model;
      const config = store.load();
      const resolved = resolveThinkingLevel(config, model);
      const lines = [
        `model: ${model ? modelKey(model) : "none"}`,
        `managed: ${resolved === undefined ? "no" : "yes"}`,
        `file: ${store.path}`,
        `resolved: ${resolved ?? "none — pi handles this model natively"}`,
        `current: ${pi.getThinkingLevel()}`,
        "",
        "run `/model-thinking set` to save this model and level; `/model-thinking reset` to clear all configured levels",
      ];
      const message = lines.join("\n");

      if (ctx.hasUI) ctx.ui.notify(message, resolved ? "info" : "warning");
      else console.log(message);
    },
  });
}
