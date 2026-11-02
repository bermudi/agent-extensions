// Branch-scoped fusion state. Fusion on/off (and which sidekick) is part of the
// conversation: navigating the session tree to a point restores the state that
// point had, the same way pi restores the branch's tool loadout. One exception:
// a change whose abandoned tail holds no completed assistant turn (only errors,
// aborts, notes, the /fusion entry itself) is "noise" and carries over to the
// new branch — rewinding to retry a failed prompt must not undo a /fusion run
// after it. Pure functions over pi session entries; fusion.ts applies them.
import type { HarnessId } from "./fusion-types.ts";
import { MODEL_CHOICES } from "./fusion-types.ts";

export const STATE_ENTRY = "fusion-state";

export interface FusionState {
  enabled: boolean;
  harness?: HarnessId;
  model?: string;
  /** Harness-side session id; lets a resumed pi session reattach to the same sidekick. */
  sidekickSessionId?: string;
  /** The sidekick already received its doctrine (sent with the first handoff only). */
  sidekickBriefed?: boolean;
}

/** The slice of a pi SessionEntry this module reads; real entries satisfy it. */
export interface BranchEntry {
  id: string;
  type: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string; stopReason?: string };
}

export function isFusionState(value: unknown): value is FusionState {
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

export function readState(entry: BranchEntry): FusionState | undefined {
  if (entry.type !== "custom" || entry.customType !== STATE_ENTRY)
    return undefined;
  return isFusionState(entry.data) ? { ...entry.data } : undefined;
}

/** Same user-visible choice: both off, or both on with the same harness+model. */
export function sameChoice(a: FusionState, b: FusionState): boolean {
  if (a.enabled !== b.enabled) return false;
  return !a.enabled || (a.harness === b.harness && a.model === b.model);
}

/** Latest valid state on a path; no entry means fusion was never enabled there. */
export function latestState(path: readonly BranchEntry[]): FusionState {
  let state: FusionState = { enabled: false };
  for (const entry of path) state = readState(entry) ?? state;
  return state;
}

/**
 * The sidekick session most recently recorded anywhere in the pi session for
 * this harness+model ("one sidekick per pi session"): navigation back onto a
 * fusion branch reattaches the latest sidekick, not the one that branch first
 * saw. The latest matching entry wins even when it carries no id — a fork or a
 * failed attach cleared it on purpose.
 */
export function knownSidekick(
  entries: readonly BranchEntry[],
  choice: FusionState,
): Pick<FusionState, "sidekickSessionId" | "sidekickBriefed"> {
  let found: Pick<FusionState, "sidekickSessionId" | "sidekickBriefed"> = {};
  for (const entry of entries) {
    const s = readState(entry);
    if (s?.enabled && sameChoice(s, choice))
      found = {
        sidekickSessionId: s.sidekickSessionId,
        sidekickBriefed: s.sidekickBriefed,
      };
  }
  return found;
}

const COMPLETED_STOPS = new Set(["stop", "toolUse", "length"]);

/** A real lead turn: an assistant message that finished (not error/aborted/pending). */
export function isCompletedTurn(entry: BranchEntry): boolean {
  return (
    entry.type === "message" &&
    entry.message?.role === "assistant" &&
    COMPLETED_STOPS.has(entry.message.stopReason ?? "")
  );
}

export type TreeDecision =
  /** The target already matches the live choice. */
  | { kind: "same" }
  /** The live choice was made on the abandoned tail with nothing completed after it. */
  | { kind: "carried" }
  /** The target point's own recorded state wins. */
  | { kind: "switched"; target: FusionState };

/**
 * Decide fusion's state after a tree navigation from oldPath (root→old leaf)
 * to newPath (root→new leaf).
 */
export function decideTreeState(
  live: FusionState,
  oldPath: readonly BranchEntry[],
  newPath: readonly BranchEntry[],
): TreeDecision {
  const target = latestState(newPath);
  if (sameChoice(live, target)) return { kind: "same" };
  const onNew = new Set(newPath.map((e) => e.id));
  const abandoned = oldPath.filter((e) => !onNew.has(e.id));
  // Where the live choice took effect on the abandoned tail: the first entry
  // recording it after the last entry recording something else.
  let changeAt = -1;
  abandoned.forEach((entry, i) => {
    const s = readState(entry);
    if (!s) return;
    if (!sameChoice(s, live)) changeAt = -1;
    else if (changeAt < 0) changeAt = i;
  });
  if (changeAt < 0) return { kind: "switched", target };
  const ranSince = abandoned.slice(changeAt + 1).some(isCompletedTurn);
  return ranSince ? { kind: "switched", target } : { kind: "carried" };
}
