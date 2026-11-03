// Instant model picker for Pi: the stock ctrl+l picker minus the on-open
// catalog refresh. Data comes from the session's model snapshot
// (ctx.modelRegistry.getAvailable(), synchronous, zero network), so opening
// it never triggers provider refreshModels calls.
//
// Binding: ctrl+l is a RESERVED keybinding while the built-in
// `app.model.select` action claims it. Free it by remapping the built-in in
// ~/.pi/agent/keybindings.json, e.g.:
//   { "app.model.select": ["ctrl+shift+l"] }
// The effective (user-remapped) config is what pi's extension-shortcut
// conflict check reads (runner.getShortcuts(getEffectiveConfig())), and
// CustomEditor.handleInput consults extension shortcuts before built-in
// actions — so once the built-in moves off ctrl+l, this shortcut takes it.

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ScopedModel,
} from "@earendil-works/pi-coding-agent";
import { type Model } from "@earendil-works/pi-ai";
import { ModelPickerComponent } from "./model-picker.ts";
import { type DefaultModelReference, type ModelItem } from "./picker-models.ts";

function toItems(models: readonly Model<any>[]): ModelItem[] {
  return models.map((model) => ({
    provider: model.provider,
    id: model.id,
    model,
  }));
}

function toItemsFromScoped(scoped: readonly ScopedModel[]): ModelItem[] {
  return scoped.map((scoped) => ({
    provider: scoped.model.provider,
    id: scoped.model.id,
    model: scoped.model,
  }));
}

async function openPicker(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  initialSearchInput?: string,
): Promise<void> {
  // ctx.ui.custom drives a TUI component; there is no picker in other modes.
  if (ctx.mode !== "tui" || !ctx.hasUI) return;

  const settings = pi.getSettings();
  const defaultModel: DefaultModelReference | undefined =
    settings.defaultProvider && settings.defaultModel
      ? { provider: settings.defaultProvider, id: settings.defaultModel }
      : undefined;

  const selected = await ctx.ui.custom<Model<any> | undefined>(
    (tui, theme, keybindings, done) =>
      new ModelPickerComponent({
        tui,
        theme,
        keybindings,
        allItems: toItems(ctx.modelRegistry.getAvailable()),
        scopedItems: toItemsFromScoped(ctx.scopedModels),
        currentModel: ctx.model,
        defaultModel,
        initialSearchInput,
        onSelect: (model) => done(model),
        onCancel: () => done(undefined),
      }),
  );

  if (!selected) return;
  // Session-only switch (pi.setModel never touches the saved default —
  // that's what the stock picker's ctrl+s is for, still reachable on its
  // remapped key). Returns false when the provider has no configured auth.
  const applied = await pi.setModel(selected);
  if (applied) {
    ctx.ui.notify(`Model: ${selected.id}`);
  } else {
    ctx.ui.notify(`No auth configured for ${selected.provider}`, "error");
  }
}

export default function modelPicker(pi: ExtensionAPI): void {
  pi.registerShortcut("ctrl+l", {
    description: "Open model picker (instant, no catalog refresh)",
    handler: (ctx) => openPicker(ctx, pi),
  });

  pi.registerCommand("model-picker", {
    description:
      "Open the instant model picker (optional argument pre-fills the filter)",
    handler: async (args, ctx: ExtensionCommandContext) => {
      await openPicker(ctx, pi, args.trim() || undefined);
    },
  });
}
