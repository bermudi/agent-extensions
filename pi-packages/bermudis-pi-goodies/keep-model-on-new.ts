import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

interface ModelIdentity {
  provider: string;
  id: string;
}

/**
 * Extension modules are cached across Pi's session-runtime replacement, while
 * their factories and handlers are recreated. This small handoff therefore
 * survives /new without writing transient state to disk.
 */
const pendingModels = new Map<string, ModelIdentity>();

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
  const handoffs = options.pendingModels ?? pendingModels;

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
      console.warn(`[keep-model-on-new] ${message}`);
      ctx.ui.notify(message, "warning");
      return;
    }

    try {
      await pi.setModel(model);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `[keep-model-on-new] Failed to restore ${previous.provider}/${previous.id}: ${detail}`,
      );
      ctx.ui.notify(`Could not keep model after /new: ${detail}`, "warning");
    }
  });
}
