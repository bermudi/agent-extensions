// pi-fusion: a lead (the pi session's own model) + one persistent sidekick that
// runs in a separate harness (piz core with GLM, or Devin with SWE-2).
// Design: ~/reports/fusion-replica/DESIGN.md. Off until the user runs /fusion.
// Lives in bermudis-pi-goodies as the "fusion" feature (was its own
// pi-packages/fusion package until 2026-11-02 — moved in because pi grants a
// single custom-footer slot, which provider-balance already owns; the same
// package now owns both sides of the "side:"-status badge contract).
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  STATE_ENTRY,
  decideTreeState,
  knownSidekick,
  latestState,
  type FusionState,
} from "./fusion-branch.ts";
import { connectDevin } from "./fusion-devin.ts";
import { createLogger, saveReport } from "./fusion-log.ts";
import { connectPiz } from "./fusion-piz.ts";
import {
  DIRECT_EDIT_NUDGE,
  LEAD_GUIDELINES,
  LEAD_SNIPPET,
  SIDEKICK_TOOL_DESCRIPTION,
  TREE_NAVIGATION_NOTE,
  firstHandoff,
  leadUpdate,
  sidekickAttachedNote,
  treeRestoredNote,
} from "./fusion-prompts.ts";
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
} from "./fusion-types.ts";

const TOOL_NAME = "sidekick";
const REPORT_MESSAGE = "fusion-report";
const NOTE_MESSAGE = "fusion-note";
const MAX_REPORT_CHARS = 40_000;
const STALE_START_MESSAGE =
  "Fusion changed while the sidekick was starting; the start was discarded. Retry if fusion is still on.";
const EDIT_TOOLS = new Set(["edit", "write", "apply_patch"]);

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
    // The "side:" prefix is a footer contract: provider-balance's custom
    // footer folds "side:"-prefixed extension statuses into the stats line's
    // right-aligned model readout ("side: SWE-2 Medium/(openai) gpt-6.1-terra
    // • high") and drops the status line; without that footer this stays a
    // plain status line.
    const busy = running ? " ⏳" : "";
    uiCtx.ui.setStatus("fusion", `side: ${choiceLabel(state)}${busy}`);
  };

  const persist = () => {
    pi.appendEntry<FusionState>(STATE_ENTRY, { ...state });
  };

  /** Terminal catch for fire-and-forget chains that touch the extension ctx
   *  (setStatus, sendMessage): after /reload invalidates this instance's ctx,
   *  those calls throw, and a detached rejection is fatal to the host TUI (pi
   *  installs no unhandledRejection handler). */
  const onDetachedFailure =
    (what: string) =>
    (error: unknown): void => {
      log.warn("sidekick.detached_failed", {
        what,
        error: error instanceof Error ? error.message : String(error),
      });
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
        void dropConnector(holder.self, error).catch(
          onDetachedFailure("drop_connector"),
        );
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

  const trackConnecting = (
    attempt: Promise<{ connector: SidekickConnector; replaced: boolean }>,
  ) => {
    connecting = attempt;
    const clear = () => {
      if (connecting === attempt) connecting = undefined;
    };
    void attempt.then(clear, clear);
    return attempt;
  };

  /** The attached sidekick, connecting (or reattaching) on first use. */
  const ensureConnector = async (
    cwd: string,
  ): Promise<{ connector: SidekickConnector; replaced: boolean }> => {
    if (connecting) return connecting;
    if (connector) return { connector, replaced: false };
    const choice = MODEL_CHOICES.find(
      (c) => c.harness === state.harness && c.model === state.model,
    );
    if (!choice)
      throw new Error(
        "Fusion is enabled but no sidekick is configured; run /fusion.",
      );
    const myEpoch = epoch;
    const previousSessionId = state.sidekickSessionId;
    const attempt = (async () => {
      let attached: SidekickConnector;
      if (previousSessionId) {
        try {
          attached = await connect(choice, cwd, previousSessionId);
        } catch (error) {
          log.warn("sidekick.reattach_failed", {
            sessionId: previousSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          if (myEpoch !== epoch) throw new Error(STALE_START_MESSAGE);
          attached = await connect(choice, cwd);
        }
      } else {
        attached = await connect(choice, cwd);
      }
      if (myEpoch !== epoch) {
        // Fusion was turned off / the sidekick swapped while this was starting.
        await attached.dispose().catch(() => undefined);
        throw new Error(STALE_START_MESSAGE);
      }
      connector = attached;
      if (state.sidekickSessionId !== attached.sessionId) {
        // A different harness session than the one on record: it has never been
        // briefed, and nothing was ever measured on it.
        state.sidekickSessionId = attached.sessionId;
        state.sidekickBriefed = false;
        lastContextUsed = undefined;
        persist();
      }
      return {
        connector: attached,
        replaced: previousSessionId !== attached.sessionId,
      };
    })();
    return trackConnecting(attempt);
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
      })
      .catch(onDetachedFailure("handoff_delivery"));
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
        void handoff.promise
          .then(
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
          )
          .catch(onDetachedFailure("briefing_commit"));
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
    const wasEnabled = state.enabled;
    const disposal = disposeConnector();
    state = { enabled: false };
    pendingNote = undefined;
    setToolActive(false);
    setStatus();
    if (wasEnabled) {
      persist();
      log.info("fusion.off", {});
    }
    await disposal;
    ctx.ui.notify(
      wasEnabled
        ? "Fusion off: sidekick stopped and tool removed."
        : "Fusion is already off.",
      "info",
    );
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
    const previousSessionId = state.sidekickSessionId;
    const disposal = disposeConnector();
    const myEpoch = epoch;
    ctx.ui.notify(`Starting sidekick: ${choice.label}…`, "info");
    const attempt = (async () => {
      await disposal;
      if (myEpoch !== epoch) throw new Error(STALE_START_MESSAGE);
      let attached: SidekickConnector;
      try {
        attached = await connect(choice, ctx.cwd);
      } catch (error) {
        if (myEpoch === epoch) {
          const message =
            error instanceof Error ? error.message : String(error);
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
        }
        throw error;
      }
      if (myEpoch !== epoch) {
        // Fusion was turned off or swapped again while this was starting.
        await attached.dispose().catch(() => undefined);
        throw new Error(STALE_START_MESSAGE);
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
      return {
        connector: attached,
        replaced: previousSessionId !== attached.sessionId,
      };
    })();
    trackConnecting(attempt);
    await attempt.catch(() => undefined);
  };

  pi.on("session_start", async (event, ctx) => {
    uiCtx = ctx;
    // A note queued in the previous session must never be delivered in this
    // one (wrong harness/model, "NEW sidekick" for a reattached one). The
    // fork branch below queues this session's own note after this clear.
    pendingNote = undefined;
    await disposeConnector();
    // Branch-scoped: the state the current point of the conversation records;
    // the sidekick session is the latest one the whole pi session knows for
    // that choice (fusion-branch.ts).
    const sm = ctx.sessionManager;
    state = latestState(sm.getBranch());
    if (state.enabled)
      state = {
        ...state,
        ...knownSidekick(sm.getEntries(), state),
      };
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

  pi.on("session_tree", async (event, ctx) => {
    uiCtx = ctx;
    const sm = ctx.sessionManager;
    const pathTo = (leafId: string | null) =>
      leafId === null ? [] : sm.getBranch(leafId);
    const before = state;
    const decision = decideTreeState(
      before,
      pathTo(event.oldLeafId),
      pathTo(event.newLeafId),
    );
    let stoppedHandoff: number | undefined;
    let disposal: Promise<void> | undefined;
    if (decision.kind === "switched") {
      // The target point's own state wins: stop the live sidekick (like
      // /fusion off or a swap) and adopt that point's choice. State is
      // replaced synchronously; the dispose is awaited at the end, as in
      // turnOff.
      stoppedHandoff = running?.id;
      if (before.enabled) disposal = disposeConnector();
      state = decision.target.enabled
        ? {
            ...decision.target,
            ...knownSidekick(sm.getEntries(), decision.target),
          }
        : { enabled: false };
      pendingNote = state.enabled
        ? treeRestoredNote(choiceLabel(state))
        : undefined;
    } else {
      if (decision.kind === "carried") persist(); // record it on the new branch
      pendingNote = state.enabled
        ? (pendingNote ?? TREE_NAVIGATION_NOTE)
        : undefined;
    }
    // Pi restored the target branch's tool loadout; re-apply ours either way.
    setToolActive(state.enabled);
    setStatus();
    const notice = treeNotice(decision.kind, before, state, stoppedHandoff);
    if (notice && ctx.hasUI) ctx.ui.notify(notice, "info");
    log.info("fusion.tree_synced", {
      decision: decision.kind,
      enabled: state.enabled,
      harness: state.harness,
      model: state.model,
      sessionId: state.sidekickSessionId,
      stoppedHandoff,
    });
    await disposal;
  });

  const treeNotice = (
    kind: "same" | "carried" | "switched",
    before: FusionState,
    after: FusionState,
    stoppedHandoff: number | undefined,
  ): string | undefined => {
    if (kind === "same") return undefined;
    if (kind === "carried")
      return after.enabled
        ? `Fusion stays on (${choiceLabel(after)}): nothing completed after /fusion on the branch you left.`
        : "Fusion stays off: nothing completed after /fusion off on the branch you left.";
    const stopped =
      stoppedHandoff !== undefined
        ? ` Handoff #${stoppedHandoff} stopped.`
        : "";
    if (!after.enabled)
      return `Fusion off: this point of the conversation had no sidekick. /fusion re-enables it.${stopped}`;
    return before.enabled
      ? `Fusion switched to ${choiceLabel(after)}: the sidekick this point of the conversation had.${stopped}`
      : `Fusion on (${choiceLabel(after)}): this point of the conversation had the sidekick enabled. /fusion off disables it.`;
  };

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
