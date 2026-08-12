import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getLatestCompactionEntry,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize, sep } from "node:path";
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

const HOME_DIR = process.env.HOME ?? homedir();
const RUNS_DIR = join(HOME_DIR, ".pi", "agent", "ketamine", "runs");
const ACTIVE_MARKER_FILE = "active.lock";
const SNAPSHOT_FILE = "trajectory.json";
const DEFAULT_RUN_RETENTION = 5;
const MAX_RUN_RETENTION = 100;
const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_TIMEOUT_MS = 3_600_000; // 1 hour

function makeRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
}

function isRunIdSafe(runId: string): boolean {
  if (typeof runId !== "string" || runId.length === 0 || runId.length > 256) {
    return false;
  }
  if (runId === "." || runId === "..") return false;
  if (/[\\/\x00]/.test(runId)) return false;
  return true;
}

function resolveRunDir(runsDir: string, runId: string): string | undefined {
  if (!isRunIdSafe(runId)) return undefined;
  const resolved = normalize(join(runsDir, runId));
  const normalizedRunsDir = normalize(runsDir);
  const prefix = normalizedRunsDir.endsWith(sep)
    ? normalizedRunsDir
    : normalizedRunsDir + sep;
  if (!resolved.startsWith(prefix) || resolved.length <= prefix.length) {
    return undefined;
  }
  return resolved;
}

export function getRunDirectory(
  runsDir: string,
  runId: string,
): string | undefined {
  return resolveRunDir(runsDir, runId);
}

export function getActiveMarkerPath(runDir: string): string {
  return join(runDir, ACTIVE_MARKER_FILE);
}

export async function writeActiveMarker(runDir: string): Promise<void> {
  const marker = { pid: process.pid, startedAt: new Date().toISOString() };
  await writeFile(getActiveMarkerPath(runDir), JSON.stringify(marker), {
    mode: 0o600,
  });
}

export async function removeActiveMarker(runDir: string): Promise<void> {
  await rm(getActiveMarkerPath(runDir), { force: true });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error) {
      const code = (error as { code: string }).code;
      // The process no longer exists.
      if (code === "ESRCH") return false;
      // The pid is invalid or out of range.
      if (code === "EINVAL") return false;
      // EPERM means a process exists but we cannot signal it.
      if (code === "EPERM") return true;
    }
    // Any other error is treated conservatively as live.
    return true;
  }
}

async function isRunActive(runsDir: string, runId: string): Promise<boolean> {
  const runDir = resolveRunDir(runsDir, runId);
  if (!runDir) return true;
  const markerPath = join(runDir, ACTIVE_MARKER_FILE);
  let content: string;
  try {
    content = await readFile(markerPath, "utf8");
  } catch (error: unknown) {
    // No marker means the run is not active.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "ENOENT"
    ) {
      return false;
    }
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return true;
  }
  if (!parsed || typeof parsed !== "object") return true;
  const pid = (parsed as Record<string, unknown>).pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  return isProcessAlive(pid);
}

export function parseKetamineTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (
    !Number.isFinite(parsed) ||
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    parsed > MAX_TIMEOUT_MS
  ) {
    return DEFAULT_TIMEOUT_MS;
  }
  return parsed;
}

export function parseRunRetention(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_RUN_RETENTION;
  const parsed = Number(raw);
  if (
    !Number.isFinite(parsed) ||
    !Number.isSafeInteger(parsed) ||
    parsed <= 0
  ) {
    return DEFAULT_RUN_RETENTION;
  }
  return Math.min(parsed, MAX_RUN_RETENTION);
}

export async function pruneRunDirectories(
  runsDir: string,
  retention: number,
): Promise<void> {
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code: string }).code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    },
  );
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (directories.length <= retention) return;
  directories.sort((a, b) => b.localeCompare(a));
  const toRemove: string[] = [];
  const candidates = directories.slice(retention);
  for (const name of candidates) {
    if (await isRunActive(runsDir, name)) continue;
    const runDir = resolveRunDir(runsDir, name);
    if (runDir) toRemove.push(runDir);
  }
  await Promise.all(
    toRemove.map((runDir) => rm(runDir, { recursive: true, force: true })),
  );
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
    const snapshotPath = join(runDir, SNAPSHOT_FILE);
    const observerSessionDir = join(runDir, "observer-session");
    let activeMarkerPath: string | undefined;

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

      activeMarkerPath = getActiveMarkerPath(runDir);
      await writeActiveMarker(runDir);

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
      const timeoutMs = parseKetamineTimeoutMs(process.env.KETAMINE_TIMEOUT_MS);
      const timeoutController = new AbortController();
      const timer = setTimeout(
        () => timeoutController.abort(new Error("Ketamine observer timed out")),
        timeoutMs,
      );
      const runSignal = (
        AbortSignal as unknown as { any(signals: AbortSignal[]): AbortSignal }
      ).any([event.signal, timeoutController.signal]);
      let observer: Awaited<ReturnType<typeof runObserver>>;
      try {
        observer = await runObserver({
          cwd: ctx.cwd,
          runDir,
          snapshotPath,
          observerSessionDir,
          model: observerModel,
          thinkingLevel: ctx.thinkingLevel,
          signal: runSignal,
        });
      } finally {
        clearTimeout(timer);
      }
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
      if (activeMarkerPath) {
        await rm(activeMarkerPath, { force: true }).catch((error: unknown) => {
          ctx.ui.notify(
            `Ketamine could not remove active marker: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        });
      }
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

  pi.on("session_compact", async (event, ctx) => {
    const details = event.compactionEntry.details;
    if (!isKetamineCheckpoint(details)) return;

    const runDir = getRunDirectory(RUNS_DIR, details.runId);
    if (!runDir) {
      ctx.ui.notify(
        `Ketamine could not locate run directory for ${details.runId}`,
        "warning",
      );
      return;
    }

    ctx.ui.notify(`Returned from Ketamine observer ${details.runId}`, "info");

    try {
      await rm(join(runDir, SNAPSHOT_FILE), { force: true });
    } catch (error: unknown) {
      ctx.ui.notify(
        `Ketamine could not remove snapshot: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
    try {
      await pruneRunDirectories(
        RUNS_DIR,
        parseRunRetention(process.env.KETAMINE_RUN_RETENTION),
      );
    } catch (error: unknown) {
      ctx.ui.notify(
        `Ketamine could not prune old run directories: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  });
}
