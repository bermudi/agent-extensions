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

/**
 * Keep Pi's cross-session defaults stable while still allowing model changes in
 * the current session. Pi intentionally saves the last selected model and
 * thinking level, so this runs after those notifications and restores the
 * configured startup defaults in the global settings file.
 *
 * The pin lives in `<agentDir>/fixed-defaults.json` and is the sole source of
 * truth — there are no built-in defaults, so with no override file the
 * extension is dormant and Pi's native last-selection behavior is preserved.
 * `thinkingLevel` may layer independently; `provider` and `model` are a
 * coupled pair. `/fixed-defaults set` pins the currently active model and
 * thinking level; `/fixed-defaults reset` stops pinning; `/fixed-defaults`
 * shows the active pin.
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
    const { override, error } = store.load();
    // A broken or absent override means no pin: leave settings untouched so
    // Pi's native last-selection behavior is preserved rather than guessed at.
    if (error) return;
    const hasModelPin =
      override.provider !== undefined && override.model !== undefined;
    const hasThinkingPin = override.thinkingLevel !== undefined;
    if (!hasModelPin && !hasThinkingPin) return;

    const settings = SettingsManager.create(ctx.cwd, agentDir, {
      projectTrusted: ctx.isProjectTrusted(),
    });
    if (hasModelPin) {
      settings.setDefaultModelAndProvider(override.provider!, override.model!);
    }
    if (hasThinkingPin) {
      settings.setDefaultThinkingLevel(override.thinkingLevel!);
    }
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

        // Removing the override makes future events no-ops; there is nothing
        // to apply to settings.json now. Existing defaults are left as-is so
        // reset means "stop pinning," not "revert to an earlier state."
        ctx.ui.notify(
          removed
            ? "Fixed-defaults pin removed. Pi will use your last selection."
            : "No fixed-defaults override file to reset.",
          "info",
        );
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
        `thinking: ${pi.getThinkingLevel()}`,
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
        if (override.thinkingLevel !== undefined) {
          lines.push(`pinned thinking: ${override.thinkingLevel}`);
        }
      }
      lines.push("", `override file: ${store.path}`);
      lines.push(
        "",
        "run `/fixed-defaults set` to pin the current model and thinking level; `/fixed-defaults reset` to stop pinning",
      );
      const message = lines.join("\n");

      if (ctx.hasUI) ctx.ui.notify(message, "info");
      else console.log(message);
    },
  });
}
