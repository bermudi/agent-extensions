import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const CONFIG_FILENAME = "fixed-defaults.json";
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

/** Startup defaults compiled into the extension. */
const BUILTIN_DEFAULTS = {
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  thinkingLevel: "max",
} as const;

/** A fully resolved pin: built-in values, possibly overridden per field. */
interface FixedDefaults {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
}

/**
 * Values read from the override file. `thinkingLevel` may layer independently;
 * `provider` and `model` are a coupled pair — a model id is meaningless without
 * its provider, so both must be present if either is. Missing fields fall back
 * to the built-in defaults.
 */
interface FixedDefaultsOverride {
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

interface FixedDefaultsOptions {
  /** Internal seam used by tests; normal callers use Pi's global agent dir. */
  agentDir?: string;
  /** Internal seam used by tests; defaults to <agentDir>/fixed-defaults.json. */
  configPath?: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    typeof value === "string" &&
    (ALL_LEVELS as readonly string[]).includes(value)
  );
}

function parseOverride(value: unknown): FixedDefaultsOverride {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("the top level must be an object");
  }

  const input = value as Record<string, unknown>;
  const unknownKeys = Object.keys(input).filter(
    (key) => key !== "provider" && key !== "model" && key !== "thinkingLevel",
  );
  if (unknownKeys.length > 0) {
    throw new Error(`unknown field(s): ${unknownKeys.join(", ")}`);
  }

  const override: FixedDefaultsOverride = {};
  if (input.provider !== undefined) {
    if (typeof input.provider !== "string" || input.provider.length === 0) {
      throw new Error("`provider` must be a non-empty string");
    }
    override.provider = input.provider;
  }
  if (input.model !== undefined) {
    if (typeof input.model !== "string" || input.model.length === 0) {
      throw new Error("`model` must be a non-empty string");
    }
    override.model = input.model;
  }
  if (input.thinkingLevel !== undefined) {
    if (!isThinkingLevel(input.thinkingLevel)) {
      throw new Error(
        `\`thinkingLevel\` must be one of: ${ALL_LEVELS.join(", ")}`,
      );
    }
    override.thinkingLevel = input.thinkingLevel;
  }

  // provider and model are a coupled pair — a model id is meaningless without
  // its provider. Require both if either is present so a hand-edited partial
  // file can't pin a broken default. thinkingLevel may still layer alone.
  if (
    (override.provider !== undefined && override.model === undefined) ||
    (override.model !== undefined && override.provider === undefined)
  ) {
    throw new Error(
      "`provider` and `model` must be specified together — a model id is meaningless without its provider",
    );
  }

  return override;
}

/**
 * Read/write the override file. Reads are uncached (the file is tiny and the
 * events are rare), so hand edits are picked up without a reload. Writes are
 * atomic via temp file + rename.
 */
class DefaultsStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** Load the override; returns { override: {}, error: null } when missing. */
  load(): LoadResult {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { override: {}, error: null };
      }
      throw error;
    }

    try {
      return {
        override: parseOverride(JSON.parse(raw) as unknown),
        error: null,
      };
    } catch (error) {
      const message = describeError(error);
      console.error(
        `[fixed-defaults] invalid config at ${this.path}:`,
        message,
      );
      return { override: {}, error: message };
    }
  }

  save(override: FixedDefaultsOverride): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;

    try {
      writeFileSync(temporaryPath, `${JSON.stringify(override, null, 2)}\n`, {
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
  }

  reset(): boolean {
    try {
      unlinkSync(this.path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}

/** Result of reading the override file: the parsed values plus any error. */
interface LoadResult {
  override: FixedDefaultsOverride;
  /** Non-null when the file existed but failed to parse or validate. */
  error: string | null;
}

/** Built-ins, overridden per field by the override file when present. */
function effectiveDefaults(store: DefaultsStore): {
  defaults: FixedDefaults;
  error: string | null;
} {
  const { override, error } = store.load();
  return {
    defaults: {
      provider: override.provider ?? BUILTIN_DEFAULTS.provider,
      model: override.model ?? BUILTIN_DEFAULTS.model,
      thinkingLevel: override.thinkingLevel ?? BUILTIN_DEFAULTS.thinkingLevel,
    },
    error,
  };
}

/**
 * Keep Pi's cross-session defaults stable while still allowing model changes in
 * the current session. Pi intentionally saves the last selected model and
 * thinking level, so this runs after those notifications and restores the
 * configured startup defaults in the global settings file.
 *
 * The pinned defaults are the built-in constants, optionally overridden by
 * `<agentDir>/fixed-defaults.json` (`thinkingLevel` may layer independently;
 * `provider` and `model` are a coupled pair). `/fixed-defaults set` pins the
 * currently active model and thinking level there; `/fixed-defaults reset`
 * removes the override; `/fixed-defaults` shows the effective pin.
 */
export default function fixedDefaults(
  pi: ExtensionAPI,
  options: FixedDefaultsOptions = {},
): void {
  const agentDir = options.agentDir ?? getAgentDir();
  const store = new DefaultsStore(
    options.configPath ?? join(agentDir, CONFIG_FILENAME),
  );
  let pending = Promise.resolve();

  async function restore(ctx: ExtensionContext): Promise<void> {
    const { defaults } = effectiveDefaults(store);
    const settings = SettingsManager.create(ctx.cwd, agentDir, {
      projectTrusted: ctx.isProjectTrusted(),
    });
    settings.setDefaultModelAndProvider(defaults.provider, defaults.model);
    settings.setDefaultThinkingLevel(defaults.thinkingLevel);
    await settings.flush();

    const errors = settings.drainErrors();
    if (errors.length > 0) {
      const details = errors
        .map(({ scope, error }) => `${scope}: ${describeError(error)}`)
        .join("; ");
      throw new Error(`failed to persist fixed defaults (${details})`);
    }
  }

  function schedule(ctx: ExtensionContext): Promise<void> {
    const operation = pending.then(() => restore(ctx));
    // Keep later notifications serviceable after one failed write. The
    // original operation is still returned so Pi can report that failure.
    pending = operation.catch((error: unknown) => {
      console.error("[fixed-defaults] failed to restore defaults:", error);
    });
    return operation;
  }

  pi.on("session_start", (_event, ctx) => schedule(ctx));
  pi.on("model_select", (_event, ctx) => schedule(ctx));
  pi.on("thinking_level_select", (_event, ctx) => schedule(ctx));

  pi.registerCommand("fixed-defaults", {
    description:
      "Show, set, or reset the pinned startup model/thinking defaults",
    handler: async (args, ctx) => {
      const command = args.trim();

      if (command === "set") {
        const model = ctx.model;
        if (!model) {
          ctx.ui.notify(
            "Cannot pin defaults without an active model.",
            "warning",
          );
          return;
        }

        const level = pi.getThinkingLevel();
        const override: FixedDefaultsOverride = {
          provider: model.provider,
          model: model.id,
          thinkingLevel: level,
        };
        try {
          store.save(override);
        } catch (error) {
          console.error("[fixed-defaults] failed to save override:", error);
          ctx.ui.notify("Failed to save the new fixed defaults.", "error");
          return;
        }

        try {
          // Bring settings.json in line with the new pin right away instead
          // of waiting for the next model/thinking/session event.
          await schedule(ctx);
        } catch (error) {
          console.error("[fixed-defaults] failed to apply override:", error);
          ctx.ui.notify(
            "Defaults saved, but applying them to settings.json failed.",
            "warning",
          );
          return;
        }

        ctx.ui.notify(
          `Pinned ${model.provider}/${model.id} · thinking ${level} as startup defaults`,
          "info",
        );
        return;
      }

      if (command === "reset") {
        let removed: boolean;
        try {
          removed = store.reset();
        } catch (error) {
          console.error("[fixed-defaults] failed to reset override:", error);
          ctx.ui.notify("Failed to reset fixed defaults.", "error");
          return;
        }

        try {
          await schedule(ctx);
        } catch (error) {
          console.error("[fixed-defaults] failed to apply reset:", error);
          ctx.ui.notify(
            "Override removed, but applying the built-in defaults failed.",
            "warning",
          );
          return;
        }

        ctx.ui.notify(
          removed
            ? "Fixed defaults reset to built-in values."
            : "No fixed-defaults override file to reset.",
          "info",
        );
        return;
      }

      if (command !== "") {
        ctx.ui.notify("Usage: /fixed-defaults [set|reset]", "warning");
        return;
      }

      const { defaults, error } = effectiveDefaults(store);
      const model = ctx.model;
      const lines = [
        `model: ${model ? `${model.provider}/${model.id}` : "none"}`,
        `thinking: ${pi.getThinkingLevel()}`,
        "",
        `pinned provider: ${defaults.provider}`,
        `pinned model: ${defaults.model}`,
        `pinned thinking: ${defaults.thinkingLevel}`,
        `override file: ${store.path}`,
      ];
      if (error) {
        lines.push("", `⚠ override invalid, using built-ins: ${error}`);
      }
      lines.push(
        "",
        "run `/fixed-defaults set` to pin the current model and thinking level; `/fixed-defaults reset` to restore the built-in defaults",
      );
      const message = lines.join("\n");

      if (ctx.hasUI) ctx.ui.notify(message, "info");
      else console.log(message);
    },
  });
}
