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
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const CONFIG_FILENAME = "fixed-defaults.json";
/**
 * Values read from the override file. `provider` and `model` are a coupled
 * pair — a model id is meaningless without its provider, so both must be
 * present if either is.
 *
 * `thinkingLevel` was accepted by older versions. It is deliberately ignored
 * for compatibility; model-thinking.ts is now the sole owner of thinking
 * policy.
 */
interface FixedDefaultsOverride {
  provider?: string;
  model?: string;
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

  // provider and model are a coupled pair — a model id is meaningless without
  // its provider. Require both if either is present so a hand-edited partial
  // file can't pin a broken default. The legacy thinkingLevel field is
  // intentionally ignored; model-thinking.ts owns thinking policy.
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

function hasLegacyThinkingLevel(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "thinkingLevel")
  );
}

/**
 * Read/write the override file. Reads are uncached (the file is tiny and the
 * events are rare), so hand edits are picked up without a reload. Writes are
 * atomic via temp file + rename.
 */
class DefaultsStore {
  readonly path: string;
  private warnedLegacyThinkingLevel = false;

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
      const value = JSON.parse(raw) as unknown;
      if (hasLegacyThinkingLevel(value) && !this.warnedLegacyThinkingLevel) {
        console.warn(
          `[fixed-defaults] legacy thinkingLevel found in ${this.path}; it is ignored. Add the policy to model-thinking.json instead.`,
        );
        this.warnedLegacyThinkingLevel = true;
      }
      return { override: parseOverride(value), error: null };
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

  exists(): boolean {
    try {
      statSync(this.path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  reset(): boolean {
    try {
      unlinkSync(this.path);
      this.warnedLegacyThinkingLevel = false;
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

/**
 * Keep Pi's cross-session provider/model defaults stable while still allowing
 * model changes in the current session. Pi intentionally saves the last
 * selected model, so this runs after model-selection notifications and restores
 * the configured startup model in the global settings file.
 *
 * The pin lives in `<agentDir>/fixed-defaults.json` and is the sole source of
 * truth — there are no built-in defaults, so with no override file the
 * extension is dormant and Pi's native last-selection behavior is preserved.
 * `provider` and `model` are a coupled pair. Thinking policy belongs to
 * model-thinking.ts. `/fixed-defaults set` pins the currently active model;
 * `/fixed-defaults reset` stops pinning; `/fixed-defaults` shows the active pin.
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

  async function persistModel(
    ctx: ExtensionContext,
    provider: string,
    modelId: string,
  ): Promise<void> {
    const settings = SettingsManager.create(ctx.cwd, agentDir, {
      projectTrusted: ctx.isProjectTrusted(),
    });
    settings.setDefaultModelAndProvider(provider, modelId);
    await settings.flush();

    const errors = settings.drainErrors();
    if (errors.length > 0) {
      const details = errors
        .map(({ scope, error }) => `${scope}: ${describeError(error)}`)
        .join("; ");
      throw new Error(`failed to persist fixed defaults (${details})`);
    }
  }

  async function restore(ctx: ExtensionContext): Promise<void> {
    const { override, error } = store.load();
    // A broken or absent override means no pin: leave settings untouched so
    // Pi's native last-selection behavior is preserved rather than guessed at.
    if (error) return;
    const hasModelPin =
      override.provider !== undefined && override.model !== undefined;
    if (!hasModelPin) return;

    await persistModel(ctx, override.provider!, override.model!);
  }

  function enqueue(
    operation: () => Promise<void>,
    label: string,
  ): Promise<void> {
    const queued = pending.then(operation);
    // Keep later notifications serviceable after one failed write. The
    // original operation is still returned so the caller can report failure.
    pending = queued.catch((error: unknown) => {
      console.error(label, error);
    });
    return queued;
  }

  function schedule(ctx: ExtensionContext): Promise<void> {
    return enqueue(
      () => restore(ctx),
      "[fixed-defaults] failed to restore defaults:",
    );
  }

  pi.on("session_start", (_event, ctx) => schedule(ctx));
  pi.on("model_select", (_event, ctx) => schedule(ctx));

  pi.registerCommand("fixed-defaults", {
    description: "Show, set, or reset the pinned startup model",
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

        const override: FixedDefaultsOverride = {
          provider: model.provider,
          model: model.id,
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
          // of waiting for the next model/session event.
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
          `Pinned ${model.provider}/${model.id} as the startup model`,
          "info",
        );
        return;
      }

      if (command === "reset") {
        let found = false;
        let removed = false;
        let activeModel: NonNullable<ExtensionContext["model"]> | undefined;
        try {
          await enqueue(async () => {
            if (!store.exists()) return;
            found = true;

            const model = ctx.model;
            if (!model) return;

            // Save the active model before removing the pin. Otherwise the
            // old pinned model remains in settings.json and wins at the next
            // start.
            await persistModel(ctx, model.provider, model.id);
            removed = store.reset();
            activeModel = model;
          }, "[fixed-defaults] failed to reset override:");

          if (!found) {
            ctx.ui.notify("No fixed-defaults override file to reset.", "info");
          } else if (!activeModel) {
            ctx.ui.notify(
              "Cannot reset fixed defaults without an active model; the pin was left in place.",
              "warning",
            );
          } else {
            ctx.ui.notify(
              removed
                ? `Fixed-defaults pin removed. Pi will use ${activeModel.provider}/${activeModel.id} as its last selection.`
                : "No fixed-defaults override file to reset.",
              "info",
            );
          }
        } catch (error) {
          console.error("[fixed-defaults] failed to reset override:", error);
          ctx.ui.notify(
            "Failed to reset fixed defaults; the pin was left in place.",
            "error",
          );
        }
        return;
      }

      if (command !== "") {
        ctx.ui.notify("Usage: /fixed-defaults [set|reset]", "warning");
        return;
      }

      const { override, error } = store.load();
      const model = ctx.model;
      const lines = [
        `model: ${model ? `${model.provider}/${model.id}` : "none"}`,
        `thinking: ${pi.getThinkingLevel()} (managed by model-thinking or Pi)`,
        "",
      ];
      if (error) {
        lines.push(`⚠ override file invalid — no pin active: ${error}`);
      } else if (Object.keys(override).length === 0) {
        lines.push("No pin active. Pi will use your last selection.");
      } else {
        if (override.provider !== undefined && override.model !== undefined) {
          lines.push(`pinned provider: ${override.provider}`);
          lines.push(`pinned model: ${override.model}`);
        }
      }
      lines.push("", `override file: ${store.path}`);
      lines.push(
        "",
        "run `/fixed-defaults set` to pin the current model; `/fixed-defaults reset` to stop pinning",
      );
      const message = lines.join("\n");

      if (ctx.hasUI) ctx.ui.notify(message, "info");
      else console.log(message);
    },
  });
}
