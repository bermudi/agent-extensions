import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getLatestCompactionEntry,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  KETAMINE_STRATEGY,
  KETAMINE_VERSION,
  applyCheckpoint,
  assertCurationFits,
  buildTrajectoryUnits,
  buildTrajectoryUnitsFromMessages,
  estimateMessageTokens,
  formatFallbackContext,
  isKetamineCheckpoint,
  isOpenAiModel,
  validatePlan,
  type KetamineCheckpoint,
  type TrajectorySnapshot,
} from "./core.ts";
import { runObserver } from "./observer-process.ts";

const RUNS_DIR = join(homedir(), ".pi", "agent", "ketamine", "runs");

function makeRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
}

const observerModelSchema = z.string().regex(/^[^/\s]+\/\S+$/, {
  message: "KETAMINE_MODEL must use provider/model format",
});

function resolveObserverModel(current: { provider: string; id: string }): {
  provider: string;
  id: string;
} {
  const configured = process.env.KETAMINE_MODEL;
  if (!configured) return current;
  const parsed = observerModelSchema.parse(configured);
  const separator = parsed.indexOf("/");
  return {
    provider: parsed.slice(0, separator),
    id: parsed.slice(separator + 1),
  };
}

export default function ketamineExtension(pi: ExtensionAPI) {
  const activeCompactions = new Set<string>();

  // The observer process explicitly loads observer.ts. Never install the launcher
  // into an observer if resource-discovery flags are changed accidentally.
  if (process.env.KETAMINE_OBSERVER === "1") return;

  pi.on("session_before_compact", async (event, ctx) => {
    // OpenAI models keep their provider-native compaction. Ketamine is for
    // models whose exposed reasoning can drive progressive disclosure.
    if (ctx.model && isOpenAiModel(ctx.model.provider, ctx.model.id)) return;

    const sessionId = ctx.sessionManager.getSessionId();
    if (activeCompactions.has(sessionId)) {
      ctx.ui.notify("Ketamine is already curating this session", "warning");
      return { cancel: true };
    }
    activeCompactions.add(sessionId);

    const runId = makeRunId();
    const runDir = join(RUNS_DIR, runId);
    const snapshotPath = join(runDir, "trajectory.json");
    const observerSessionDir = join(runDir, "observer-session");

    try {
      if (!ctx.model) {
        throw new Error("Ketamine requires an active model for its observer");
      }

      const previousCompaction = getLatestCompactionEntry(event.branchEntries);
      let units;
      if (
        previousCompaction &&
        isKetamineCheckpoint(previousCompaction.details)
      ) {
        const nativeMessages = ctx.sessionManager
          .buildContextEntries()
          .flatMap(sessionEntryToContextMessages);
        const effectiveMessages = applyCheckpoint(
          nativeMessages,
          previousCompaction.details,
          new Date(previousCompaction.timestamp).getTime(),
        );
        const terminalMessage = effectiveMessages.at(-1);
        if (
          event.willRetry &&
          terminalMessage?.role === "assistant" &&
          (terminalMessage.stopReason === "error" ||
            terminalMessage.stopReason === "length")
        ) {
          effectiveMessages.pop();
        }
        units = buildTrajectoryUnitsFromMessages(effectiveMessages);
      } else {
        const trajectoryEntries = [...event.branchEntries];
        const terminalEntry = trajectoryEntries.at(-1);
        if (
          event.willRetry &&
          terminalEntry?.type === "message" &&
          terminalEntry.message.role === "assistant" &&
          (terminalEntry.message.stopReason === "error" ||
            terminalEntry.message.stopReason === "length")
        ) {
          trajectoryEntries.pop();
        }
        units = buildTrajectoryUnits(trajectoryEntries);
      }
      if (units.length === 0) {
        throw new Error("The active trajectory has no context-visible turns");
      }

      const sourceMessages = units.flatMap((unit) => unit.messages);
      const sourceEstimatedTokens = estimateMessageTokens(sourceMessages);
      const availableTokens =
        ctx.model.contextWindow - event.preparation.settings.reserveTokens;
      const maxCuratedTokens = Math.max(
        1,
        Math.floor(
          Math.min(sourceEstimatedTokens * 0.85, availableTokens * 0.75),
        ),
      );

      await mkdir(observerSessionDir, { recursive: true, mode: 0o700 });
      await Promise.all([
        chmod(RUNS_DIR, 0o700),
        chmod(runDir, 0o700),
        chmod(observerSessionDir, 0o700),
      ]);

      const snapshot: TrajectorySnapshot = {
        version: 1,
        targetSessionFile: ctx.sessionManager.getSessionFile(),
        targetSessionId: ctx.sessionManager.getSessionId(),
        createdAt: new Date().toISOString(),
        customInstructions: event.customInstructions,
        maxCuratedTokens,
        units,
      };
      await writeFile(snapshotPath, JSON.stringify(snapshot), { mode: 0o600 });

      ctx.ui.setStatus("ketamine", "Ketamine: observer dissociated");
      ctx.ui.notify(
        `Ketamine is curating ${units.length} trajectory turns in a separate Pi session`,
        "info",
      );

      const observerModel = resolveObserverModel({
        provider: ctx.model.provider,
        id: ctx.model.id,
      });
      if (isOpenAiModel(observerModel.provider, observerModel.id)) {
        throw new Error(
          `Ketamine requires a non-OpenAI observer model; received ${observerModel.provider}/${observerModel.id}`,
        );
      }
      const observer = await runObserver({
        cwd: ctx.cwd,
        runDir,
        snapshotPath,
        observerSessionDir,
        model: observerModel,
        thinkingLevel: ctx.thinkingLevel,
        signal: event.signal,
      });
      const plan = validatePlan(observer.plan, units);
      const curatedMessages = assertCurationFits(plan, units, maxCuratedTokens);
      if (curatedMessages.length === 0) {
        throw new Error("Ketamine attempted to drop the entire conversation");
      }

      const estimatedTokens = estimateMessageTokens(curatedMessages);

      const fallbackSummary = formatFallbackContext(curatedMessages);
      if (event.signal.aborted) {
        throw new Error(
          "Ketamine was cancelled before committing its checkpoint",
        );
      }

      // A context-invisible marker gives Pi a valid retained boundary while keeping
      // its simplistic recent suffix out of the model request.
      pi.appendEntry("ketamine-boundary", {
        strategy: KETAMINE_STRATEGY,
        version: KETAMINE_VERSION,
        runId,
        observerSessionDir,
      });
      const boundaryEntryId = ctx.sessionManager.getLeafId();
      if (!boundaryEntryId) {
        throw new Error("Ketamine could not create its context boundary");
      }

      const checkpoint: KetamineCheckpoint = {
        strategy: KETAMINE_STRATEGY,
        version: KETAMINE_VERSION,
        runId,
        observerSessionDir,
        plan,
        curatedMessages,
      };

      ctx.ui.notify(
        `Ketamine curated ${units.length} turns into approximately ${estimatedTokens.toLocaleString()} tokens`,
        "info",
      );

      return {
        compaction: {
          summary: fallbackSummary,
          firstKeptEntryId: boundaryEntryId,
          tokensBefore: event.preparation.tokensBefore,
          usage: observer.usage,
          details: checkpoint,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!event.signal.aborted) {
        ctx.ui.notify(
          `Ketamine failed; native compaction was blocked: ${message}`,
          "error",
        );
      }
      // Failure is closed: never silently replace Ketamine with native compaction.
      return { cancel: true };
    } finally {
      activeCompactions.delete(sessionId);
      ctx.ui.setStatus("ketamine", undefined);
    }
  });

  pi.on("context", (event, ctx) => {
    const compaction = getLatestCompactionEntry(ctx.sessionManager.getBranch());
    if (!compaction || !isKetamineCheckpoint(compaction.details)) return;

    const checkpointTimestamp = new Date(compaction.timestamp).getTime();
    return {
      messages: applyCheckpoint(
        event.messages,
        compaction.details,
        checkpointTimestamp,
      ),
    };
  });

  pi.on("session_compact", (event, ctx) => {
    if (isKetamineCheckpoint(event.compactionEntry.details)) {
      ctx.ui.notify(
        `Returned from Ketamine observer ${event.compactionEntry.details.runId}`,
        "info",
      );
    }
  });
}
