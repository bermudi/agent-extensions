import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const FIXED_DEFAULTS = {
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  thinkingLevel: "max",
} as const;

interface FixedDefaultsOptions {
  /** Internal seam used by tests; normal callers use Pi's global agent dir. */
  agentDir?: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keep Pi's cross-session defaults stable while still allowing model changes in
 * the current session. Pi intentionally saves the last selected model and
 * thinking level, so this runs after those notifications and restores the
 * configured startup defaults in the global settings file.
 */
export default function fixedDefaults(
  pi: ExtensionAPI,
  options: FixedDefaultsOptions = {},
): void {
  const agentDir = options.agentDir ?? getAgentDir();
  let pending = Promise.resolve();

  async function restore(ctx: ExtensionContext): Promise<void> {
    const settings = SettingsManager.create(ctx.cwd, agentDir, {
      projectTrusted: ctx.isProjectTrusted(),
    });
    settings.setDefaultModelAndProvider(
      FIXED_DEFAULTS.provider,
      FIXED_DEFAULTS.model,
    );
    settings.setDefaultThinkingLevel(FIXED_DEFAULTS.thinkingLevel);
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
}
