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
  let handoffCounter = 0;
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
    connector = undefined;
    connecting = undefined;
    running = undefined;
    if (current) await current.dispose().catch(() => undefined);
    setStatus();
  };

  const connect = async (
    choice: ModelChoice,
    cwd: string,
    resumeSessionId?: string,
  ): Promise<SidekickConnector> => {
    return deps.connectors[choice.harness]({
      cwd,
      model: choice.model,
      resumeSessionId,
      log,
    });
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
    if (!connecting) {
      const resumeId = state.sidekickSessionId;
      connecting = (async () => {
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
      result = await connecting;
    } finally {
      connecting = undefined;
    }
    connector = result.connector;
    if (state.sidekickSessionId !== connector.sessionId) {
      // A different harness session than the one on record: it has never been briefed.
      state.sidekickSessionId = connector.sessionId;
      state.sidekickBriefed = false;
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
      const path = saveReport(handoffId, report);
      report = `${report.slice(0, MAX_REPORT_CHARS)}\n\n[report truncated; full text: ${path}]`;
    }
    return `${report}\n\n[sidekick handoff #${handoffId} · ${stats.join(" · ")}]`;
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
      const replacedNote = replaced
        ? "Note: the previous sidekick session could not be reattached; this is a NEW sidekick with no memory of earlier handoffs.\n\n"
        : "";

      if (running) {
        const current = running;
        const injected = await sidekick.inject(leadUpdate(params.message));
        if (!injected) {
          throw new Error(
            "The running handoff could not take the update (it may have just finished). Retry the call.",
          );
        }
        log.info("handoff.update_injected", {
          id: current.id,
          chars: params.message.length,
        });
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
        current.deliverAsMessage = false;
        const outcome = await current.promise;
        return {
          content: [
            {
              type: "text",
              text: replacedNote + formatReport(outcome, current.id),
            },
          ],
          details: {
            handoffId: current.id,
            injected: true,
            stopReason: outcome.stopReason,
          },
        };
      }

      // The doctrine rides on the first handoff of each sidekick session only.
      const text = state.sidekickBriefed
        ? params.message
        : firstHandoff(params.message);
      if (!state.sidekickBriefed) {
        state.sidekickBriefed = true;
        persist();
      }
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
        ctx.ui.notify(
          state.enabled
            ? `Fusion on: ${choiceLabel(state)}${running ? ` (handoff #${running.id} running)` : ""}${state.sidekickSessionId ? ` · session ${state.sidekickSessionId}` : ""}`
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
