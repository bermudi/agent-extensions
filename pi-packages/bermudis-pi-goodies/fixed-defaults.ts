import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeError,
  unlinkIfPresent,
  writeJsonFileAtomic,
} from "./json-file.ts";

const CONFIG_FILENAME = "fixed-defaults.json";

/**
 * Model active in the session being replaced by `/new`, captured during
 * `session_before_switch`. The factory is re-invoked per session, so this must
 * live at module scope to survive the switch to the new extension instance.
 */
let previousModelForNewSession: { provider: string; id: string } | null = null;
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

  /** Load the override; an absent file is a valid, inactive configuration. */
  load(): LoadResult {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          present: false,
          override: {},
          error: null,
          legacyThinkingLevel: false,
        };
      }
      throw error;
    }

    try {
      const value = JSON.parse(raw) as unknown;
      const legacyThinkingLevel = hasLegacyThinkingLevel(value);
      if (legacyThinkingLevel && !this.warnedLegacyThinkingLevel) {
        console.warn(
          `[fixed-defaults] legacy thinkingLevel found in ${this.path}; it is ignored. Add the policy to model-thinking.json instead.`,
        );
        this.warnedLegacyThinkingLevel = true;
      }
      return {
        present: true,
        override: parseOverride(value),
        error: null,
        legacyThinkingLevel,
      };
    } catch (error) {
      const message = describeError(error);
      console.error(
        `[fixed-defaults] invalid config at ${this.path}:`,
        message,
      );
      return {
        present: true,
        override: {},
        error: message,
        legacyThinkingLevel: false,
      };
    }
  }

  save(override: FixedDefaultsOverride): void {
    writeJsonFileAtomic(this.path, override);
    this.warnedLegacyThinkingLevel = false;
  }

  reset(): void {
    // Deletion is intentionally idempotent: if another process removes the
    // pin after it was loaded, reset has still reached the requested end state.
    unlinkIfPresent(this.path);
    this.warnedLegacyThinkingLevel = false;
  }
}

/** Result of reading the override file: the parsed values plus any error. */
interface LoadResult {
  /** Whether the override file existed when it was read. */
  present: boolean;
  override: FixedDefaultsOverride;
  /** Non-null when the file existed but failed to parse or validate. */
  error: string | null;
  /** True when an old, ignored thinkingLevel field should be migrated. */
  legacyThinkingLevel: boolean;
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

  async function restorePinnedModel(ctx: ExtensionContext): Promise<void> {
    const { override, error } = store.load();
    // A broken or absent override means no pin: leave settings untouched so
    // Pi's native last-selection behavior is preserved rather than guessed at.
    if (error) return;
    const hasModelPin =
      override.provider !== undefined && override.model !== undefined;
    if (!hasModelPin) return;

    await persistModel(ctx, override.provider!, override.model!);
  }

  /**
   * Restore the model that was active before `/new`. Unlike the pin, this only
   * applies to the session being created, so the next fresh `pi` still starts
   * from the pin.
   */
  async function restorePreviousModel(
    ctx: ExtensionContext,
    previous: { provider: string; id: string } | null,
  ): Promise<void> {
    if (!previous) return;
    const model = ctx.modelRegistry.find(previous.provider, previous.id);
    if (!model) return;
    // setModel writes the restored model to settings.json, then its model_select
    // notification re-applies the pin afterwards (see restorePinnedModel), so
    // the active session keeps the previous model while the pin survives.
    await pi.setModel(model);
  }

  function enqueue<T>(
    operation: () => Promise<T>,
    failureMessage: string,
  ): Promise<T> {
    const queued = pending.then(operation);
    // Log once at the queue boundary, then recover only the internal tail so a
    // failed write does not prevent later operations. The returned promise
    // still rejects, allowing commands to notify the user.
    pending = queued.then(
      () => undefined,
      (error: unknown) => {
        console.error(failureMessage, error);
      },
    );
    return queued;
  }

  function schedule(
    ctx: ExtensionContext,
    failureMessage = "[fixed-defaults] failed to restore defaults:",
  ): Promise<void> {
    return enqueue(() => restorePinnedModel(ctx), failureMessage);
  }

  pi.on("session_start", (event, ctx) => {
    // `/new` has already selected a model (the pinned default) by the time this
    // fires, so set the model that was active before the switch here. The
    // resulting model_select notification re-applies the pin in settings.json.
    if (event.reason === "new") {
      const previous = previousModelForNewSession;
      previousModelForNewSession = null;
      if (!previous) return;
      // Run outside the shared queue: pi.setModel emits model_select, whose
      // handler enqueues the pin restore. Enqueuing this operation too would
      // deadlock that handler by making it wait on this operation to finish.
      return restorePreviousModel(ctx, previous).catch((error: unknown) => {
        console.error(
          "[fixed-defaults] failed to restore the previous session model after /new:",
          error,
        );
      });
    }
    return schedule(ctx);
  });
  pi.on("model_select", (_event, ctx) => schedule(ctx));

  pi.on("session_before_switch", (event, ctx) => {
    if (event.reason === "new") {
      const model = ctx.model;
      previousModelForNewSession = model
        ? { provider: model.provider, id: model.id }
        : null;
    }
  });

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
          await schedule(ctx, "[fixed-defaults] failed to apply override:");
        } catch {
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
        type ResetResult =
          | { status: "missing" }
          | { status: "removed-inactive" }
          | { status: "no-active-model" }
          | {
              status: "removed";
              model: NonNullable<ExtensionContext["model"]>;
            };

        try {
          const result = await enqueue<ResetResult>(async () => {
            // Load and validate before touching settings. Invalid, legacy-only,
            // and partial files are inactive, so remove them without replacing
            // Pi's last selection with the currently active model.
            const loaded = store.load();
            if (!loaded.present) return { status: "missing" };

            const hasModelPin =
              loaded.error === null &&
              loaded.override.provider !== undefined &&
              loaded.override.model !== undefined;
            if (!hasModelPin) {
              store.reset();
              return { status: "removed-inactive" };
            }

            const model = ctx.model;
            if (!model) return { status: "no-active-model" };

            // Save the active model before removing the valid pin. Otherwise
            // the old pinned model remains in settings.json and wins at the
            // next fresh start.
            await persistModel(ctx, model.provider, model.id);
            store.reset();
            return { status: "removed", model };
          }, "[fixed-defaults] failed to reset override:");

          if (result.status === "missing") {
            ctx.ui.notify("No fixed-defaults override file to reset.", "info");
          } else if (result.status === "removed-inactive") {
            ctx.ui.notify(
              "Inactive or invalid fixed-defaults override removed; settings were left unchanged.",
              "info",
            );
          } else if (result.status === "no-active-model") {
            ctx.ui.notify(
              "Cannot reset fixed defaults without an active model; the pin was left in place.",
              "warning",
            );
          } else {
            ctx.ui.notify(
              `Fixed-defaults pin removed. Pi will use ${result.model.provider}/${result.model.id} as its last selection.`,
              "info",
            );
          }
        } catch {
          ctx.ui.notify(
            "Failed to reset fixed defaults. Pin removal could not be confirmed; settings may already reflect the active model.",
            "error",
          );
        }
        return;
      }

      if (command !== "") {
        ctx.ui.notify("Usage: /fixed-defaults [set|reset]", "warning");
        return;
      }

      const { override, error, legacyThinkingLevel } = store.load();
      const model = ctx.model;
      const lines = [
        `model: ${model ? `${model.provider}/${model.id}` : "none"}`,
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
      if (legacyThinkingLevel) {
        lines.push(
          "",
          "⚠ legacy thinkingLevel is present but ignored; manage it with /model-thinking",
        );
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
