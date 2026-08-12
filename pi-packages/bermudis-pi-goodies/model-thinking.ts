import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  describeError,
  unlinkIfPresent,
  writeJsonFileAtomic,
} from "./json-file.ts";

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

interface ConfigLoadResult {
  config: ModelThinkingConfig;
  /** Non-null when the file exists but could not be read or validated. */
  error: string | null;
}

class ConfigStore {
  readonly path: string;
  private initialized = false;
  private cachedStamp: string | undefined;
  private cachedResult: ConfigLoadResult = { config: {}, error: null };

  constructor(path: string) {
    this.path = path;
  }

  load(): ConfigLoadResult {
    let stamp: string | undefined;
    try {
      stamp = fileStamp(this.path);
    } catch (error) {
      const message = describeError(error);
      console.error(`[model-thinking] failed to stat ${this.path}:`, message);
      return { config: {}, error: message };
    }

    // Keep retrying a file that previously failed to load. A repair can leave
    // its size and mtime unchanged, so an error result must not be cached by
    // the same stamp as a successful read.
    if (
      this.initialized &&
      stamp === this.cachedStamp &&
      this.cachedResult.error === null
    ) {
      return this.cachedResult;
    }

    this.initialized = true;
    this.cachedStamp = stamp;
    if (stamp === undefined) {
      this.cachedResult = { config: {}, error: null };
      return this.cachedResult;
    }

    try {
      this.cachedResult = {
        config: parseConfig(
          JSON.parse(readFileSync(this.path, "utf8")) as unknown,
        ),
        error: null,
      };
    } catch (error) {
      const message = describeError(error);
      console.error(
        `[model-thinking] invalid config at ${this.path}:`,
        message,
      );
      this.cachedResult = { config: {}, error: message };
    }
    return this.cachedResult;
  }

  save(config: ModelThinkingConfig): void {
    writeJsonFileAtomic(this.path, config);
    this.cachedResult = { config, error: null };
    this.cachedStamp = fileStamp(this.path);
    this.initialized = true;
  }

  reset(): boolean {
    const removed = unlinkIfPresent(this.path);
    this.initialized = true;
    this.cachedStamp = undefined;
    this.cachedResult = { config: {}, error: null };
    return removed;
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
  function apply(ctx: ExtensionContext, silent: boolean): void {
    const model = ctx.model;
    const loaded = store.load();
    // Never treat a broken file as an empty policy: doing so would hide the
    // error and make a later `/model-thinking set` overwrite it.
    if (loaded.error || !model) return;

    const level = resolveThinkingLevel(loaded.config, model);
    if (level === undefined) return;

    const before = pi.getThinkingLevel();
    pi.setThinkingLevel(level);
    const after = pi.getThinkingLevel();

    if (after !== before && !silent) {
      ctx.ui.notify(`Thinking: ${before} → ${after}`, "info");
    }
  }

  pi.on("model_select", (event, ctx) => {
    apply(ctx, event.source === "restore");
  });

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.model) return;
    apply(ctx, true);
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
          const loaded = store.load();
          if (loaded.error) {
            ctx.ui.notify(
              `Cannot save model-thinking config: ${loaded.error}. Repair ${store.path} or run /model-thinking reset first.`,
              "error",
            );
            return;
          }

          store.save({
            ...loaded.config,
            models: { ...loaded.config.models, [key]: level },
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
      const loaded = store.load();
      const resolved = loaded.error
        ? undefined
        : resolveThinkingLevel(loaded.config, model);
      const lines = [
        `model: ${model ? modelKey(model) : "none"}`,
        `managed: ${resolved === undefined ? "no" : "yes"}`,
        `file: ${store.path}`,
        `saved: ${resolved ?? "none — pi handles this model natively"}`,
        `current: ${pi.getThinkingLevel()}`,
        ...(loaded.error
          ? [`⚠ config invalid — no policy applied: ${loaded.error}`]
          : []),
        "",
        "run `/model-thinking set` to save this model and level; `/model-thinking reset` to clear all configured levels",
      ];
      const message = lines.join("\n");

      if (ctx.hasUI) ctx.ui.notify(message, resolved ? "info" : "warning");
      else console.log(message);
    },
  });
}
