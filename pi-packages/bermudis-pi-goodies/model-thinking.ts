import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type Model = NonNullable<ExtensionContext["model"]>;
type ModelRef = Pick<Model, "provider" | "id">;

const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

interface PreviousSessionState {
  provider: string;
  id: string;
  thinkingLevel: ThinkingLevel;
}

// The extension factory is recreated when Pi replaces a session. Keep this
// snapshot at module scope so it survives that recreation.
let previousSessionState: PreviousSessionState | null = null;

function sameModel(left: ModelRef, right: ModelRef): boolean {
  return left.provider === right.provider && left.id === right.id;
}

/**
 * Pi resolves scoped thinking for its normal initial-model path, but an
 * explicit plain `--model` takes a different path and falls back to the
 * global level. There is no CLI-selection detail on session_start, so use
 * argv only to distinguish that one case from Pi's already-resolved startup
 * state. Explicit `--thinking` and `--model ...:<level>` remain authoritative.
 *
 * Mirrors Pi's parseArgs semantics for these two flags: the last --model
 * wins, --thinking counts only when its value is a valid level (invalid
 * values are dropped with a CLI warning), and a trailing flag without a
 * value token sets nothing. Degenerate argv where another flag consumes a
 * bare "--model"/"--thinking" as its value is not mirrored.
 *
 * Do not trust the presence of --model alone: an invalid CLI model leaves a
 * restored session's model active. Before touching thinking, confirm that the
 * active model could be Pi's resolution of the CLI pattern. This also mirrors
 * Pi's important ordering for a trailing ":<level>": it fuzzy-matches the
 * complete pattern before splitting a thinking suffix.
 */
function cliPatternMatchesActiveModel(
  pattern: string,
  provider: string | undefined,
  activeModel: Model,
): boolean {
  const normalizedPattern = pattern.trim().toLowerCase();
  if (!normalizedPattern) return false;

  const normalizedProvider = provider?.trim().toLowerCase();
  if (
    normalizedProvider !== undefined &&
    activeModel.provider.toLowerCase() !== normalizedProvider
  ) {
    return false;
  }

  let modelPattern = normalizedPattern;
  const activeProviderPrefix = `${activeModel.provider}/`.toLowerCase();
  if (modelPattern.startsWith(activeProviderPrefix)) {
    modelPattern = modelPattern.slice(activeProviderPrefix.length);
  } else if (
    normalizedProvider === undefined &&
    normalizedPattern.includes("/")
  ) {
    // Without the registry we cannot safely reinterpret an arbitrary slash as
    // a provider separator: model IDs themselves may contain slashes.
    return (
      normalizedPattern ===
      `${activeModel.provider}/${activeModel.id}`.toLowerCase()
    );
  }

  const id = activeModel.id.toLowerCase();
  const name = activeModel.name?.toLowerCase();
  return (
    modelPattern === id ||
    id.includes(modelPattern) ||
    name?.includes(modelPattern) === true
  );
}

function plainCliModelNeedsScopedLevel(
  activeModel: Model | undefined,
): boolean {
  const args = process.argv.slice(2);
  let model: string | undefined;
  let provider: string | undefined;
  let thinking: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--model" && index + 1 < args.length) {
      model = args[++index];
    } else if (arg === "--provider" && index + 1 < args.length) {
      provider = args[++index];
    } else if (arg === "--thinking" && index + 1 < args.length) {
      const level = args[++index];
      if (THINKING_LEVELS.has(level)) thinking = level;
    }
  }
  if (thinking !== undefined) return false;
  if (model === undefined || activeModel === undefined) return false;

  // Pi first attempts the complete pattern. This confirms both that --model
  // actually selected the active model (rather than falling back to a
  // restored session) and that a ":<level>" suffix belongs to its ID.
  if (cliPatternMatchesActiveModel(model, provider, activeModel)) return true;

  // Either the CLI model did not resolve, or Pi split a trailing valid
  // ":<level>" and applied explicit thinking. Both cases must be left alone.
  return false;
}

/**
 * Pi's scoped-models configuration is the source of truth for both the cycle
 * list and per-model thinking levels. The native cycle path already applies
 * those levels; this hook fills the two gaps in the native behavior:
 *
 * - selecting a model through the full picker should apply its scoped level;
 *
 * Pi emits model_select only when the model actually changes, so picking the
 * already-active model in the full picker fires no event and its scoped
 * level cannot be re-applied on that path; a manual level survives until a
 * different model is selected.
 *
 * Pi applies the scoped level during normal startup selection. A plain
 * explicit `--model` is the exception; the startup hook covers that case
 * without overriding explicit CLI thinking choices.
 *
 * Resume and fork retain the model and level restored by Pi. /new is not a
 * session restore in Pi: it starts from the saved default/scoped model, so we
 * capture and restore the previous session explicitly.
 */
export default function modelThinking(pi: ExtensionAPI): void {
  let restoringPreviousSession = false;

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
    // Custom models supplied via --model may be synthesized for the current
    // session and therefore not be present in the registry. If /new already
    // selected that same model, the model itself is successfully restored;
    // only the historical thinking level still needs to be applied.
    if (ctx.model && sameModel(ctx.model, previous)) {
      pi.setThinkingLevel(previous.thinkingLevel);
      return;
    }

    const model = ctx.modelRegistry.find(previous.provider, previous.id);
    if (!model) {
      console.error(
        `[model-thinking] could not restore ${previous.provider}/${previous.id} after /new: model is unavailable`,
      );
      return;
    }

    let applied = false;
    try {
      restoringPreviousSession = true;
      applied = await pi.setModel(model);
      if (!applied) {
        console.error(
          `[model-thinking] could not restore ${previous.provider}/${previous.id} after /new: provider authentication is unavailable`,
        );
        return;
      }
    } catch (error) {
      console.error(
        `[model-thinking] failed to restore ${previous.provider}/${previous.id} after /new:`,
        error,
      );
    } finally {
      restoringPreviousSession = false;
    }

    if (applied) {
      // setModel emits model_select, where the scoped policy may apply. The
      // captured session level must have the final word for /new.
      pi.setThinkingLevel(previous.thinkingLevel);
    }
  }

  pi.on("model_select", (event, ctx) => {
    // A restored session owns its historical thinking level.
    if (event.source === "restore") return;
    // Pi suppresses this event when the selected model equals the active
    // one (see _emitModelSelect), which is why re-selecting the current
    // model in the full picker does not re-apply its scoped level.
    applyScopedLevel(ctx, restoringPreviousSession);
  });

  pi.on("session_start", (event, ctx) => {
    if (event.reason === "new") {
      const previous = previousSessionState;
      previousSessionState = null;
      if (previous) return restorePreviousSession(ctx, previous);
      return;
    }

    // Pi restores these sessions' model and thinking level from the session.
    // Startup is already resolved by Pi except for a plain explicit --model,
    // which bypasses the enabledModels startup selection. Reload preserves
    // the current session, so applying the scoped default there would clobber
    // a manual change.
    if (
      event.reason === "reload" ||
      event.reason === "resume" ||
      event.reason === "fork"
    ) {
      return;
    }
    if (event.reason === "startup" && !plainCliModelNeedsScopedLevel(ctx.model))
      return;
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
