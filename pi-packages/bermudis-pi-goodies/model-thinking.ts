import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type Model = NonNullable<ExtensionContext["model"]>;

interface PreviousSessionState {
  provider: string;
  id: string;
  thinkingLevel: ThinkingLevel;
}

// The extension factory is recreated when Pi replaces a session. Keep this
// snapshot at module scope so it survives that recreation.
let previousSessionState: PreviousSessionState | null = null;

function sameModel(left: Model, right: Model): boolean {
  return left.provider === right.provider && left.id === right.id;
}

/**
 * Pi's scoped-models configuration is the source of truth for both the cycle
 * list and per-model thinking levels. The native cycle path already applies
 * those levels; this hook fills the two gaps in the native behavior:
 *
 * - selecting a model through the full picker should apply its scoped level;
 *
 * Pi applies the scoped level during startup, including explicit CLI
 * overrides, so the startup hook must leave that resolved value alone.
 *
 * Resume and fork retain the model and level restored by Pi. /new is not a
 * session restore in Pi: it starts from the saved default/scoped model, so we
 * capture and restore the previous session explicitly.
 */
export default function modelThinking(pi: ExtensionAPI): void {
  function applyScopedLevel(ctx: ExtensionContext, silent: boolean): void {
    const model = ctx.model;
    if (!model) return;

    const scoped = ctx.scopedModels.find((entry) =>
      sameModel(entry.model, model),
    );
    const level = scoped?.thinkingLevel as ThinkingLevel | undefined;
    if (level === undefined) return;

    const before = pi.getThinkingLevel();
    pi.setThinkingLevel(level);
    const after = pi.getThinkingLevel();

    if (after !== before && !silent) {
      ctx.ui.notify(`Thinking: ${before} → ${after}`, "info");
    }
  }

  async function restorePreviousSession(
    ctx: ExtensionContext,
    previous: PreviousSessionState,
  ): Promise<void> {
    const model = ctx.modelRegistry.find(previous.provider, previous.id);
    if (!model) {
      console.error(
        `[model-thinking] could not restore ${previous.provider}/${previous.id} after /new: model is unavailable`,
      );
      return;
    }

    try {
      const applied = await pi.setModel(model);
      if (!applied) {
        console.error(
          `[model-thinking] could not restore ${previous.provider}/${previous.id} after /new: provider authentication is unavailable`,
        );
        return;
      }

      // setModel emits model_select, where the scoped policy may apply. The
      // captured session level must have the final word for /new.
      pi.setThinkingLevel(previous.thinkingLevel);
    } catch (error) {
      console.error(
        `[model-thinking] failed to restore ${previous.provider}/${previous.id} after /new:`,
        error,
      );
    }
  }

  pi.on("model_select", (event, ctx) => {
    // A restored session owns its historical thinking level.
    if (event.source === "restore") return;
    applyScopedLevel(ctx, false);
  });

  pi.on("session_start", (event, ctx) => {
    if (event.reason === "new") {
      const previous = previousSessionState;
      previousSessionState = null;
      if (previous) return restorePreviousSession(ctx, previous);
      return;
    }

    // Pi restores these sessions' model and thinking level from the session.
    // Startup is also already resolved by Pi, including --thinking and
    // --model ...:<level>. Reload preserves the current session, so applying
    // the scoped default here would clobber a manual change.
    if (
      event.reason === "startup" ||
      event.reason === "reload" ||
      event.reason === "resume" ||
      event.reason === "fork"
    ) {
      return;
    }
    applyScopedLevel(ctx, true);
  });

  pi.on("session_before_switch", (event, ctx) => {
    if (event.reason !== "new") return;

    const model = ctx.model;
    previousSessionState = model
      ? {
          provider: model.provider,
          id: model.id,
          thinkingLevel: pi.getThinkingLevel(),
        }
      : null;
  });
}
