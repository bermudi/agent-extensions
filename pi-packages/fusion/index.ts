// pi-fusion: a lead (the pi session's own model) + one persistent sidekick that
// runs in a separate harness (piz core with GLM, or Devin with SWE-2).
// Design: ~/reports/fusion-replica/DESIGN.md. Off until the user runs /fusion.
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { connectDevin } from "./devin.ts";
import { createLogger, saveReport } from "./log.ts";
import { connectPiz } from "./piz.ts";
import {
  DIRECT_EDIT_NUDGE,
  LEAD_GUIDELINES,
  LEAD_SNIPPET,
  SIDEKICK_TOOL_DESCRIPTION,
  firstHandoff,
  leadUpdate,
  sidekickAttachedNote,
} from "./prompts.ts";
import {
  HARNESS_LABELS,
  MODEL_CHOICES,
  SIDEKICK_CONTEXT_WINDOW,
  type ConnectOptions,
  type HarnessId,
  type Logger,
  type ModelChoice,
  type SidekickActivity,
  type SidekickConnector,
  type TurnOutcome,
} from "./types.ts";

const TOOL_NAME = "sidekick";
const STATE_ENTRY = "fusion-state";
const REPORT_MESSAGE = "fusion-report";
const NOTE_MESSAGE = "fusion-note";
const MAX_REPORT_CHARS = 40_000;
const EDIT_TOOLS = new Set(["edit", "write", "apply_patch"]);

interface FusionState {
  enabled: boolean;
  harness?: HarnessId;
  model?: string;
  /** Harness-side session id; lets a resumed pi session reattach to the same sidekick. */
  sidekickSessionId?: string;
  /** The sidekick already received its doctrine (sent with the first handoff only). */
  sidekickBriefed?: boolean;
}

interface RunningHandoff {
  id: number;
  /** Epoch at start; a late settlement under a newer epoch must not deliver or mutate. */
  epoch: number;
  promise: Promise<TurnOutcome>;
  /** Report goes to the lead as a message when the handoff ends (block:false). */
  deliverAsMessage: boolean;
  activity: SidekickActivity[];
}

export type ConnectFn = (options: ConnectOptions) => Promise<SidekickConnector>;

export interface FusionDeps {
  connectors: Record<HarnessId, ConnectFn>;
  log: Logger;
}

const defaultDeps = (): FusionDeps => ({
  connectors: { piz: connectPiz, devin: connectDevin },
  log: createLogger(),
});

export default function fusion(pi: ExtensionAPI) {
  createFusion(pi, defaultDeps());
}

export function createFusion(pi: ExtensionAPI, deps: FusionDeps) {
  const { log } = deps;
  let state: FusionState = { enabled: false };
  let connector: SidekickConnector | undefined;
  let connecting:
    Promise<{ connector: SidekickConnector; replaced: boolean }> | undefined;
  let running: RunningHandoff | undefined;
  /**
   * Bumped whenever the attached sidekick is torn down or replaced. A connect
   * that finishes under an older epoch belongs to a choice that no longer
   * exists (fusion off, swap, shutdown) and must be discarded, not installed.
   */
  let epoch = 0;
  let handoffCounter = 0;
  /** Last context use a handoff reported; reset when the sidekick session is gone. */
  let lastContextUsed: number | undefined;
  /** Note attached to the next lead run (sidekick attached/replaced). */
  let pendingNote: string | undefined;
  let nudgedThisRun = false;
  let uiCtx: ExtensionContext | undefined;

  const choiceLabel = (s: FusionState) =>
    MODEL_CHOICES.find((c) => c.harness === s.harness && c.model === s.model)
      ?.label ?? `${s.harness}/${s.model}`;

  const setStatus = () => {
    if (!uiCtx?.hasUI) return;
    if (!state.enabled) {
      uiCtx.ui.setStatus("fusion", undefined);
      return;
    }
    const busy = running ? " ⏳" : "";
    uiCtx.ui.setStatus("fusion", `⚡ ${choiceLabel(state)}${busy}`);
  };

  const persist = () => {
    pi.appendEntry<FusionState>(STATE_ENTRY, { ...state });
  };

  const setToolActive = (active: boolean) => {
    const tools = new Set(pi.getActiveTools());
    if (active) tools.add(TOOL_NAME);
    else tools.delete(TOOL_NAME);
    pi.setActiveTools([...tools]);
  };

  const disposeConnector = async () => {
    const current = connector;
    epoch++;
    connector = undefined;
    connecting = undefined;
    running = undefined;
    lastContextUsed = undefined;
    if (current) await current.dispose().catch(() => undefined);
    setStatus();
  };

  /**
   * Drop a connector whose transport died on its own. The dead object is
   * disposed even when it is no longer the installed connector (a swap may
   * have replaced it already); the recorded session id is kept so the next
   * handoff can reattach.
   */
  const dropConnector = async (dead: SidekickConnector, error: Error) => {
    if (connector === dead) connector = undefined;
    log.warn("sidekick.connector_dropped", { error: error.message });
    try {
      await dead.dispose();
    } catch (disposeError) {
      log.warn("sidekick.drop_cleanup_failed", {
        error:
          disposeError instanceof Error
            ? disposeError.message
            : String(disposeError),
      });
    }
    setStatus();
  };

  const connect = async (
    choice: ModelChoice,
    cwd: string,
    resumeSessionId?: string,
  ): Promise<SidekickConnector> => {
    // The connector learns it died only after it exists, so hand onClosed a
    // holder; a close before assignment is recorded and answered with a
    // dispose + rejection below rather than installing a dead connector.
    const holder: { self?: SidekickConnector; closedReason?: Error } = {};
    const created = await deps.connectors[choice.harness]({
      cwd,
      model: choice.model,
      resumeSessionId,
      log,
      onClosed: (error) => {
        if (!holder.self) {
          holder.closedReason = error;
          return;
        }
        void dropConnector(holder.self, error);
      },
    });
    holder.self = created;
    if (holder.closedReason) {
      await dropConnector(created, holder.closedReason);
      throw new Error(
        `sidekick transport closed during startup: ${holder.closedReason.message}`,
      );
    }
    return created;
  };

  /** The attached sidekick, connecting (or reattaching) on first use. */
  const ensureConnector = async (
    cwd: string,
  ): Promise<{ connector: SidekickConnector; replaced: boolean }> => {
    if (connector) return { connector, replaced: false };
    const choice = MODEL_CHOICES.find(
      (c) => c.harness === state.harness && c.model === state.model,
    );
    if (!choice)
      throw new Error(
        "Fusion is enabled but no sidekick is configured; run /fusion.",
      );
    const myEpoch = epoch;
    let attempt = connecting;
    if (!attempt) {
      const resumeId = state.sidekickSessionId;
      attempt = connecting = (async () => {
        if (resumeId) {
          try {
            return {
              connector: await connect(choice, cwd, resumeId),
              replaced: false,
            };
          } catch (error) {
            log.warn("sidekick.reattach_failed", {
              sessionId: resumeId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return {
          connector: await connect(choice, cwd),
          replaced: resumeId !== undefined,
        };
      })();
    }
    let result: { connector: SidekickConnector; replaced: boolean };
    try {
      result = await attempt;
    } finally {
      if (connecting === attempt) connecting = undefined;
    }
    if (myEpoch !== epoch) {
      // Fusion was turned off / the sidekick swapped while this was starting.
      await result.connector.dispose().catch(() => undefined);
      throw new Error(
        "Fusion changed while the sidekick was starting; the start was discarded. Retry if fusion is still on.",
      );
    }
    connector = result.connector;
    if (state.sidekickSessionId !== connector.sessionId) {
      // A different harness session than the one on record: it has never been
      // briefed, and nothing was ever measured on it.
      state.sidekickSessionId = connector.sessionId;
      state.sidekickBriefed = false;
      lastContextUsed = undefined;
      persist();
    }
    return result;
  };

  const formatReport = (outcome: TurnOutcome, handoffId: number): string => {
    const stats: string[] = [`stop: ${outcome.stopReason}`];
    if (outcome.contextUsed !== undefined) {
      stats.push(
        `sidekick context: ${Math.round(outcome.contextUsed / 1000)}K/${SIDEKICK_CONTEXT_WINDOW / 1000}K`,
      );
    }
    let report =
      outcome.report.trim() || "(the sidekick ended without a final message)";
    if (report.length > MAX_REPORT_CHARS) {
      let where: string;
      try {
        where = `full text: ${saveReport(handoffId, report)}`;
      } catch (error) {
        // Saving the rest is auxiliary; never lose the report itself over it.
        log.warn("report.save_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        where = "the full text could not be saved";
      }
      report = `${report.slice(0, MAX_REPORT_CHARS)}\n\n[report truncated; ${where}]`;
    }
    const warnings = (outcome.warnings ?? []).map((w) => `\n[warning: ${w}]`);
    return `${report}${warnings.join("")}\n\n[sidekick handoff #${handoffId} · ${stats.join(" · ")}]`;
  };

  const startHandoff = (
    sidekick: SidekickConnector,
    text: string,
    deliverAsMessage: boolean,
    signal: AbortSignal,
    onActivity: (activity: SidekickActivity[]) => void,
  ): RunningHandoff => {
    const id = ++handoffCounter;
    const activity: SidekickActivity[] = [];
    const handoff: RunningHandoff = {
      id,
      epoch,
      deliverAsMessage,
      activity,
      promise: sidekick.prompt(
        text,
        {
          onActivity: (item) => {
            activity.push(item);
            if (activity.length > 200) activity.shift();
            onActivity(activity);
          },
        },
        signal,
      ),
    };
    running = handoff;
    setStatus();
    log.info("handoff.started", {
      id,
      harness: sidekick.harness,
      chars: text.length,
      deliverAsMessage,
    });
    void handoff.promise
      .then(
        (outcome) => {
          log.info("handoff.finished", {
            id,
            stopReason: outcome.stopReason,
            contextUsed: outcome.contextUsed,
            inputTokens: outcome.inputTokens,
            outputTokens: outcome.outputTokens,
          });
          // Teardown/swap/session change since the start makes this outcome
          // stale: it must neither deliver nor mutate current state.
          if (handoff.epoch !== epoch) return;
          if (outcome.contextUsed !== undefined)
            lastContextUsed = outcome.contextUsed;
          if (handoff.deliverAsMessage) {
            pi.sendMessage(
              {
                customType: REPORT_MESSAGE,
                content: `Sidekick report (handoff #${id}):\n\n${formatReport(outcome, id)}`,
                display: true,
                details: { handoffId: id, stopReason: outcome.stopReason },
              },
              { triggerTurn: true, deliverAs: "followUp" },
            );
          }
        },
        (error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          log.error("handoff.failed", { id, error: message });
          if (handoff.epoch !== epoch) return;
          if (handoff.deliverAsMessage) {
            pi.sendMessage(
              {
                customType: REPORT_MESSAGE,
                content: `Sidekick handoff #${id} failed: ${message}`,
                display: true,
                details: { handoffId: id, error: message },
              },
              { triggerTurn: true, deliverAs: "followUp" },
            );
          }
        },
      )
      .finally(() => {
        if (running === handoff) running = undefined;
        setStatus();
      });
    return handoff;
  };

  const progressText = (activity: SidekickActivity[]): string =>
    activity
      .slice(-8)
      .map((a) =>
        a.kind === "tool"
          ? `→ ${a.text}`
          : a.kind === "status"
            ? `· ${a.text}`
            : a.text,
      )
      .map((line) => line.split("\n")[0]!.slice(0, 200))
      .join("\n");

  pi.registerTool({
    name: TOOL_NAME,
    label: "Sidekick",
    description: SIDEKICK_TOOL_DESCRIPTION,
    promptSnippet: LEAD_SNIPPET,
    promptGuidelines: LEAD_GUIDELINES,
    parameters: Type.Object({
      message: Type.String({
        description: "The brief, or an update for the running handoff.",
      }),
      block: Type.Optional(
        Type.Boolean({
          description:
            "Wait for the report (default true). false = report arrives later.",
        }),
      ),
    }),
    // Registration must not activate it: only /fusion turns it on.
    defaultActive: false,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!state.enabled) {
        throw new Error("Fusion is off. The user turns it on with /fusion.");
      }
      const block = params.block !== false;
      const { connector: sidekick, replaced } = await ensureConnector(ctx.cwd);
      // Esc during a slow connect must not start the very handoff it cancelled
      // (an already-aborted signal never fires its listener).
      if (signal?.aborted)
        throw new Error("Cancelled before the handoff started.");
      const replacedNote = replaced
        ? "Note: the previous sidekick session could not be reattached; this is a NEW sidekick with no memory of earlier handoffs.\n\n"
        : "";

      if (running) {
        const current = running;
        // A blocking caller takes over the report. Flip the flag BEFORE the
        // inject round-trip: the handoff may finish during it, and its report
        // must go to exactly one place.
        if (block) current.deliverAsMessage = false;
        const injected = await sidekick.inject(leadUpdate(params.message));
        if (!injected && !block) {
          throw new Error(
            "The running handoff could not take the update (it may have just finished). Retry the call.",
          );
        }
        if (injected) {
          log.info("handoff.update_injected", {
            id: current.id,
            chars: params.message.length,
          });
        }
        if (!block) {
          return {
            content: [
              {
                type: "text",
                text: `Update delivered into running handoff #${current.id}. Its report will arrive as a message.`,
              },
            ],
            details: { handoffId: current.id, injected: true },
          };
        }
        // Wait for the running handoff; its report comes back here instead of as a message.
        const outcome = await current.promise;
        const undelivered = injected
          ? ""
          : "Note: your update was NOT delivered (the handoff had just ended). This is that handoff's report; send the update as a new handoff.\n\n";
        return {
          content: [
            {
              type: "text",
              text:
                replacedNote + undelivered + formatReport(outcome, current.id),
            },
          ],
          details: {
            handoffId: current.id,
            injected,
            stopReason: outcome.stopReason,
          },
        };
      }

      // The doctrine rides on the first handoff of each sidekick session only.
      const needsBriefing = !state.sidekickBriefed;
      const text = needsBriefing
        ? firstHandoff(params.message)
        : params.message;
      const controller = new AbortController();
      if (block)
        signal?.addEventListener("abort", () => controller.abort(), {
          once: true,
        });
      const handoff = startHandoff(
        sidekick,
        text,
        !block,
        controller.signal,
        (activity) => {
          if (block) {
            onUpdate?.({
              content: [{ type: "text", text: progressText(activity) }],
              details: { handoffId: handoffCounter },
            });
          }
        },
      );
      if (needsBriefing) {
        // Mark briefed only once the sidekick actually took the handoff; a
        // rejected first delivery must not strand the sidekick without doctrine.
        const briefedSession = sidekick.sessionId;
        void handoff.promise.then(
          () => {
            if (
              handoff.epoch === epoch &&
              state.sidekickSessionId === briefedSession &&
              !state.sidekickBriefed
            ) {
              state.sidekickBriefed = true;
              persist();
            }
          },
          () => undefined,
        );
      }
      if (!block) {
        return {
          content: [
            {
              type: "text",
              text: `${replacedNote}Handoff #${handoff.id} started. Its report will arrive as a message; do parallel work meanwhile, and don't guess at what it will say.`,
            },
          ],
          details: { handoffId: handoff.id, block: false },
        };
      }
      const outcome = await handoff.promise;
      return {
        content: [
          {
            type: "text",
            text: replacedNote + formatReport(outcome, handoff.id),
          },
        ],
        details: {
          handoffId: handoff.id,
          stopReason: outcome.stopReason,
          contextUsed: outcome.contextUsed,
        },
      };
    },
  });

  pi.registerCommand("fusion", {
    description:
      "Attach a sidekick (piz GLM or Devin SWE-2) and enable the sidekick tool; /fusion off disables",
    getArgumentCompletions: (prefix) =>
      ["off", "status"]
        .filter((v) => v.startsWith(prefix))
        .map((v) => ({ value: v, label: v })),
    handler: async (args, ctx) => {
      uiCtx = ctx;
      const arg = args.trim();
      if (arg === "status") {
        const context =
          lastContextUsed === undefined
            ? "context unknown"
            : `context ${Math.round(lastContextUsed / 1000)}K/${SIDEKICK_CONTEXT_WINDOW / 1000}K`;
        ctx.ui.notify(
          state.enabled
            ? `Fusion on: ${choiceLabel(state)}${running ? ` (handoff #${running.id} running)` : ""}${state.sidekickSessionId ? ` · session ${state.sidekickSessionId}` : ""} · ${context}`
            : "Fusion is off.",
          "info",
        );
        return;
      }
      if (arg === "off") {
        await turnOff(ctx);
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(
          "/fusion needs an interactive UI to pick the sidekick.",
          "error",
        );
        return;
      }
      await pickAndAttach(ctx);
    },
  });

  const turnOff = async (ctx: ExtensionCommandContext) => {
    if (!state.enabled) {
      ctx.ui.notify("Fusion is already off.", "info");
      return;
    }
    await disposeConnector();
    state = { enabled: false };
    persist();
    setToolActive(false);
    setStatus();
    log.info("fusion.off", {});
    ctx.ui.notify("Fusion off: sidekick stopped and tool removed.", "info");
  };

  const pickAndAttach = async (ctx: ExtensionCommandContext) => {
    const harnesses = [...new Set(MODEL_CHOICES.map((c) => c.harness))];
    const harnessOptions = harnesses.map((h) => HARNESS_LABELS[h]);
    if (state.enabled) harnessOptions.push("Turn fusion off");
    const pickedHarness = await ctx.ui.select(
      "Fusion: choose the sidekick harness",
      harnessOptions,
    );
    if (!pickedHarness) return;
    if (pickedHarness === "Turn fusion off") {
      await turnOff(ctx);
      return;
    }
    const harness = harnesses[harnessOptions.indexOf(pickedHarness)]!;
    const models = MODEL_CHOICES.filter((c) => c.harness === harness);
    let choice = models[0]!;
    if (models.length > 1) {
      const pickedModel = await ctx.ui.select(
        `Fusion: choose the ${harness} model`,
        models.map((m) => m.label),
      );
      if (!pickedModel) return;
      choice = models.find((m) => m.label === pickedModel)!;
    }
    if (running) {
      const ok = await ctx.ui.confirm(
        "Replace the sidekick?",
        `Handoff #${running.id} is still running and will be stopped.`,
      );
      if (!ok) return;
    }

    const wasEnabled = state.enabled;
    await disposeConnector();
    const myEpoch = epoch;
    ctx.ui.notify(`Starting sidekick: ${choice.label}…`, "info");
    let attached: SidekickConnector;
    try {
      attached = await connect(choice, ctx.cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("fusion.attach_failed", {
        harness: choice.harness,
        model: choice.model,
        error: message,
      });
      ctx.ui.notify(
        `Fusion: could not start ${choice.label}: ${message}`,
        "error",
      );
      if (wasEnabled) {
        // The previous sidekick is gone; keep the tool but force a fresh connect on next use.
        state.sidekickSessionId = undefined;
        state.sidekickBriefed = false;
        persist();
      }
      return;
    }
    if (myEpoch !== epoch) {
      // Fusion was turned off or swapped again while this was starting.
      await attached.dispose().catch(() => undefined);
      return;
    }
    connector = attached;
    state = {
      enabled: true,
      harness: choice.harness,
      model: choice.model,
      sidekickSessionId: attached.sessionId,
      sidekickBriefed: false,
    };
    persist();
    setToolActive(true);
    pendingNote = sidekickAttachedNote(
      `${HARNESS_LABELS[choice.harness]} · ${choice.label}`,
      false,
    );
    setStatus();
    log.info("fusion.on", {
      harness: choice.harness,
      model: choice.model,
      sessionId: attached.sessionId,
    });
    ctx.ui.notify(`Fusion on: sidekick ${choice.label} ready.`, "info");
  };

  pi.on("session_start", async (event, ctx) => {
    uiCtx = ctx;
    await disposeConnector();
    state = { enabled: false };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type === "custom" &&
        entry.customType === STATE_ENTRY &&
        isFusionState(entry.data)
      ) {
        state = { ...entry.data };
      }
    }
    if (state.enabled && event.reason === "fork") {
      // The parent session may still drive the original sidekick; a fork gets its own.
      state.sidekickSessionId = undefined;
      state.sidekickBriefed = false;
      persist();
      pendingNote = sidekickAttachedNote(choiceLabel(state), false);
    }
    setToolActive(state.enabled);
    setStatus();
  });

  pi.on("session_shutdown", async () => {
    await disposeConnector();
  });

  pi.on("before_agent_start", async () => {
    nudgedThisRun = false;
    if (!pendingNote || !state.enabled) return;
    const note = pendingNote;
    pendingNote = undefined;
    return {
      message: { customType: NOTE_MESSAGE, content: note, display: true },
    };
  });

  pi.on("tool_result", async (event) => {
    if (!state.enabled || nudgedThisRun || event.isError) return;
    if (!EDIT_TOOLS.has(event.toolName) || event.parentToolCallId) return;
    nudgedThisRun = true;
    return {
      content: [...event.content, { type: "text", text: DIRECT_EDIT_NUDGE }],
    };
  });
}

function isFusionState(value: unknown): value is FusionState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.enabled !== "boolean") return false;
  if (!v.enabled) return true;
  return (
    (v.harness === "piz" || v.harness === "devin") &&
    typeof v.model === "string" &&
    MODEL_CHOICES.some((c) => c.harness === v.harness && c.model === v.model)
  );
}
