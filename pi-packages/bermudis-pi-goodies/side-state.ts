/**
 * Shared side-session badge state.
 *
 * `side.ts` owns the truth (is a side session active, which model serves
 * it); `provider-balance.ts` renders the badge merged into the stats line's
 * right-hand model readout ("side: (zai) glm-5.3 • max") instead of a
 * separate status line.
 *
 * Why the installed/rendered two-step: pi's footer internals are not public
 * API — the merge rewrites the stats line pi's FooterComponent produced by
 * splitting at its final styled run. If a pi update changes that line shape,
 * the merge must bow out and let /side fall back to the classic status line.
 * So the footer reports per-render whether the merge actually landed, and
 * the badge policy (side.ts) suppresses the status line only while the
 * merge is both installed and proven working.
 */

export interface SideModelRef {
  provider: string;
  id: string;
}

let activeModel: SideModelRef | undefined;
let mergedInstalled = false;
let mergedRendered = false;

const listeners = new Set<() => void>();

function sameModel(
  a: SideModelRef | undefined,
  b: SideModelRef | undefined,
): boolean {
  return (
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      a.provider === b.provider &&
      a.id === b.id)
  );
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** side.ts: the model serving the active side session, or undefined. */
export function setSideSessionModel(model: SideModelRef | undefined): void {
  if (sameModel(activeModel, model)) return;
  activeModel = model;
  emit();
}

export function getSideSessionModel(): SideModelRef | undefined {
  return activeModel;
}

/** provider-balance: its footer now owns (or handed back) the stats line. */
export function setMergedSideBadgeInstalled(installed: boolean): void {
  if (mergedInstalled === installed) return;
  mergedInstalled = installed;
  if (!installed) mergedRendered = false;
  emit();
}

/**
 * provider-balance: whether the latest render with a side session actually
 * merged the badge into the stats line. No-op when unchanged, so the
 * render → emit → applyStatus → render cycle always terminates.
 */
export function setMergedSideBadgeRendered(rendered: boolean): void {
  if (mergedRendered === rendered) return;
  mergedRendered = rendered;
  emit();
}

/** True while the stats-line merge is mounted and proven working. */
export function isMergedSideBadgeActive(): boolean {
  return mergedInstalled && mergedRendered;
}

export function onSideBadgeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: restore the pristine module state (undefined/false/false). */
export function resetSideBadgeState(): void {
  activeModel = undefined;
  mergedInstalled = false;
  mergedRendered = false;
  listeners.clear();
}
