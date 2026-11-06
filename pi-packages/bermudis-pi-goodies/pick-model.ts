/**
 * pick-model — one interactive model picker for every goodies command that
 * needs one (/side, /goodies recap-model).
 *
 * In the TUI it opens pi's own ctrl+l selector (search box, provider/scope
 * hints, current-model marker) instead of a flat ctx.ui.select list. The
 * selector wants the ModelRuntime the sync ModelRegistry facade wraps; that
 * field is private but stable, so the poke is guarded and any failure falls
 * back to the plain dialog. Outside the TUI (RPC hosts) only the dialog works.
 */

import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import { describeError } from "./json-file.ts";
import { logGoodiesEvent } from "./goodies-log.ts";

type ModelRuntimeParam = ConstructorParameters<
  typeof ModelSelectorComponent
>[2];

/** The model type the selector hands back (the registry's own). */
export type PickedModel = ReturnType<
  ExtensionContext["modelRegistry"]["getAvailable"]
>[number];

/**
 * ModelRegistry is the sync facade extensions get; the model selector wants
 * the ModelRuntime it wraps. The field is private but stable — guard the poke
 * and fall back to a plain selector when it moves.
 */
function extractModelRuntime(
  registry: ExtensionContext["modelRegistry"],
): ModelRuntimeParam | undefined {
  const candidate = (registry as unknown as { runtime?: unknown }).runtime;
  return typeof candidate === "object" && candidate !== null
    ? (candidate as ModelRuntimeParam)
    : undefined;
}

export interface PickModelOptions {
  /** Short owner name for notices and logs, e.g. "side" or "recap". */
  owner: string;
  /** Dialog title for the non-TUI fallback. */
  title: string;
  /** Model the selector marks as current. Defaults to the session's model. */
  current?: PickedModel;
  /** Pre-filled search text for the TUI selector. */
  initialSearch?: string;
  /** Hint appended to the "no UI" notice, e.g. "pass the model as …". */
  noUiHint: string;
}

/**
 * Ask the user for a model. Resolves undefined on cancel or when no UI exists
 * (the user has already been told why).
 */
export async function pickModel(
  ctx: ExtensionCommandContext,
  options: PickModelOptions,
): Promise<PickedModel | undefined> {
  if (ctx.mode === "tui") {
    const runtime = extractModelRuntime(ctx.modelRegistry);
    if (runtime) {
      try {
        return await ctx.ui.custom<PickedModel | undefined>(
          (tui, _theme, _kb, done) =>
            new ModelSelectorComponent(
              tui,
              options.current ?? ctx.model,
              runtime,
              ctx.scopedModels,
              (model) => done(model),
              () => done(undefined),
              options.initialSearch,
            ),
        );
      } catch (error) {
        logGoodiesEvent({
          type: `${options.owner}_picker_fallback`,
          error: describeError(error),
        });
      }
    }
  }
  if (ctx.hasUI) {
    const models = ctx.modelRegistry.getAvailable();
    if (models.length === 0) {
      ctx.ui.notify(`${options.owner}: no models available`, "error");
      return undefined;
    }
    const labels = models.map((m) => `${m.provider}/${m.id}`);
    const picked = await ctx.ui.select(options.title, labels);
    if (picked === undefined) return undefined;
    return models[labels.indexOf(picked)];
  }
  ctx.ui.notify(
    `${options.owner}: no UI available — ${options.noUiHint}`,
    "error",
  );
  return undefined;
}
