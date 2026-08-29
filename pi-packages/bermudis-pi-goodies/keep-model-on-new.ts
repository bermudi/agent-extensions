import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

interface ModelIdentity {
  provider: string;
  id: string;
}

/**
 * Pi normally caches extension modules across a session-runtime replacement,
 * but that cache can be invalidated by another resource loader or /reload.
 * Keep the handoff on globalThis so a fresh import in the same Pi process
 * cannot lose it. The state is still transient and never written to disk.
 */
const pendingModelsKey = Symbol.for(
  "bermudis-pi-goodies.keep-model-on-new.pending-models",
);

type GlobalWithPendingModels = typeof globalThis & {
  [pendingModelsKey]?: Map<string, ModelIdentity>;
};

function getPendingModels(): Map<string, ModelIdentity> {
  const globalState = globalThis as GlobalWithPendingModels;
  return (globalState[pendingModelsKey] ??= new Map());
}

function handoffKey(
  sessionFile: string | undefined,
  ctx: Pick<ExtensionContext, "cwd">,
): string {
  return sessionFile ?? `ephemeral:${ctx.cwd}`;
}

export interface KeepModelOnNewOptions {
  /** Override the process-local handoff store (tests). */
  pendingModels?: Map<string, ModelIdentity>;
}

export default function keepModelOnNew(
  pi: ExtensionAPI,
  options: KeepModelOnNewOptions = {},
): void {
  const handoffs = options.pendingModels ?? getPendingModels();

  pi.on("session_before_switch", (event, ctx) => {
    if (event.reason !== "new" || !ctx.model) return;
    handoffs.set(handoffKey(ctx.sessionManager.getSessionFile(), ctx), {
      provider: ctx.model.provider,
      id: ctx.model.id,
    });
  });

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "new") return;

    const key = handoffKey(event.previousSessionFile, ctx);
    const previous = handoffs.get(key);
    handoffs.delete(key);
    if (!previous) return;
    if (
      ctx.model?.provider === previous.provider &&
      ctx.model.id === previous.id
    ) {
      return;
    }

    const model = ctx.modelRegistry.find(previous.provider, previous.id);
    if (!model) {
      const message = `Could not keep model after /new: ${previous.provider}/${previous.id} is unavailable`;
      // With a UI, notify() renders a persistent warning; console output
      // would only flash raw on the terminal and be wiped by the next
      // repaint. Console is the headless surface.
      if (!ctx.hasUI) console.warn(`[keep-model-on-new] ${message}`);
      ctx.ui.notify(message, "warning");
      return;
    }

    try {
      const restored = await pi.setModel(model);
      if (!restored) {
        const message = `Could not keep model after /new: ${previous.provider}/${previous.id} is not authenticated`;
        if (!ctx.hasUI) console.warn(`[keep-model-on-new] ${message}`);
        ctx.ui.notify(message, "warning");
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!ctx.hasUI)
        console.warn(
          `[keep-model-on-new] Failed to restore ${previous.provider}/${previous.id}: ${detail}`,
        );
      ctx.ui.notify(`Could not keep model after /new: ${detail}`, "warning");
    }
  });
}
