/**
 * Collapse built-in tool output for a cleaner TUI focused on agent prose.
 *
 * Tool calls of the same type within one assistant message collapse into a
 * single block to save vertical space. A burst like `read ×3` shares one
 * background box instead of three separate striped rows. Followers in a burst
 * render nothing and are hidden, so N calls cost ~1 row when collapsed.
 *
 * Visible prose always closes the open burst: pi streams a message's text
 * first and creates its tool components during that same stream, so a
 * message's tools visually belong after the prose that precedes them. Without
 * this boundary every same-tool call of an entire agent run accumulates into
 * one mega-block rendered at the first call's position.
 *
 * Thinking blocks split bursts even while empty: providers can populate the
 * text after a tool row has registered. A merged burst would otherwise put
 * the later call above the reasoning row it follows.
 *
 * Messages carrying only tool calls (no prose, no visible thinking) do NOT
 * close the burst: nothing separates their calls from the previous ones, so
 * back-to-back same-tool calls chain into one block. Typed user messages
 * count as prose too.
 *
 * Images are respected: a read that returns an image is never grouped, stays
 * solo, and its image is rendered by Pi's native image layer (outside our
 * Box) even when collapsed. Expanding a burst header (ctrl+e / click)
 * reveals the concatenated outputs of all calls in that burst.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { logGoodiesEvent } from "./goodies-log.ts";
import { isCleanTuiActive, setCleanTuiActive } from "./clean-tui-active.ts";
export { isCleanTuiActive, setCleanTuiActive } from "./clean-tui-active.ts";
import {
  getSummaryModel,
  getThinkingSummariesEnabled,
  type SummaryModelRegistry,
} from "./goodies.ts";
import {
  bindSummaryHistory,
  summaryCache,
  isSummarizable,
  requestSummary,
  resetThinkingRun,
  trackThinkingStream,
  resetSummarySession,
  __setSummaryModelRegistryForTesting as setSummaryRegistry,
  __setSummaryUiForTesting as setSummaryUi,
  type SummaryUi,
} from "./clean-tui-summaries.ts";
export {
  __clearSummaryCache,
  __resetThinkingSummariesForTesting,
  __setSummaryBackoffForTesting,
  __setSummaryBackendForTesting,
  __setSummaryEnabled,
  __setSummaryLogPathForTesting,
  __setSummaryModelRegistryForTesting,
  __setSummaryRequestTimeoutForTesting,
  __setSummaryRetryDelaysForTesting,
  __setSummarySwapMaxAgeForTesting,
  __setSummaryUiForTesting,
  __setThinkingThresholdsForTesting,
  __summaryCacheSizeForTesting,
  convertSummaryResponse,
  humanizeProviderError,
} from "./clean-tui-summaries.ts";

/** Cached built-in tool definitions: the source of truth the overrides below
 *  spread, so every native field (schema, prompt metadata, execution) carries
 *  through and the overrides stay purely presentational. */
type BuiltInTools = {
  read: ReturnType<typeof createReadToolDefinition>;
  bash: ReturnType<typeof createBashToolDefinition>;
  edit: ReturnType<typeof createEditToolDefinition>;
  write: ReturnType<typeof createWriteToolDefinition>;
  find: ReturnType<typeof createFindToolDefinition>;
  grep: ReturnType<typeof createGrepToolDefinition>;
  ls: ReturnType<typeof createLsToolDefinition>;
};

const toolCache = new Map<string, BuiltInTools>();

function createBuiltInTools(cwd: string): BuiltInTools {
  return {
    read: createReadToolDefinition(cwd),
    bash: createBashToolDefinition(cwd),
    edit: createEditToolDefinition(cwd),
    write: createWriteToolDefinition(cwd),
    find: createFindToolDefinition(cwd),
    grep: createGrepToolDefinition(cwd),
    ls: createLsToolDefinition(cwd),
  };
}

function getBuiltInTools(cwd: string): BuiltInTools {
  let tools = toolCache.get(cwd);
  if (!tools) {
    tools = createBuiltInTools(cwd);
    toolCache.set(cwd, tools);
  }
  return tools;
}

export function shortenPath(path: string): string {
  const home = homedir();
  // Only a real subpath of home shortens: a bare startsWith turns a sibling
  // like `/home/me-other/x` into `~-other/x`.
  if (path === home || path.startsWith(`${home}/`))
    return `~${path.slice(home.length)}`;
  return path;
}

function resultText(result: {
  content: Array<{ type: string; text?: string }>;
}): string | undefined {
  const textContent = result.content.find((c) => c.type === "text");
  return textContent?.type === "text" ? textContent.text : undefined;
}

function hasImageContent(result: {
  content: Array<{ type: string; data?: string }>;
}): boolean {
  return result.content.some((c) => c.type === "image" && !!c.data);
}

// ── Burst tracking ──────────────────────────────────────────────
export type Entry = {
  toolCallId: string;
  toolName: string;
  args: any;
  /**
   * Boundary counter: live entries count up (bumped when a boundary block
   * appears — visible text or a thinking block); replayed entries count down
   * (one per boundary in the restored branch). NaN = unknown lineage — never
   * groups. Calls with no boundary between them share a segment.
   */
  seg: number;
  /** Previous tool call in the assistant stream, including non-burst tools.
   *  undefined means no ordering information was delivered yet. */
  previousToolCallId?: string | null;
  boundaryBefore?: boolean;
  /**
   * Monotonic creation number (its position in `entries` is
   * `index - entriesBase`; the base advances when history is pruned).
   */
  index: number;
  result?: {
    content: Array<{ type: string; text?: string; data?: string }>;
    details?: any;
  };
  isError?: boolean;
  hasImage?: boolean;
  /** Content array of the last result seen; detects real mutations vs re-renders. */
  contentRef?: unknown;
  /**
   * When a summary request was first fired for this entry's command. A row
   * whose result landed after this stamp finished while its summary was in
   * flight — it may still swap when the summary lands (viewport-tail safe).
   */
  summaryRequestedAt?: number;
  /** When the first genuine tool result landed (stamped in recordResult). */
  resultAt?: number;
  /** True while only streaming (partial) results have arrived — bash ticks.
   *  The row is still pending; resultAt/isError wait for the final result. */
  isPartial?: boolean;
};

let liveSeg = 0;
/**
 * Boundary blocks (visible text / thinking) already counted for the assistant
 * message currently streaming. Blocks are stable object references across a
 * message's message_update events (pi-ai accumulates the partial in place),
 * so the Set bumps exactly once per block, in content order — covering
 * reasoning items interleaved between tool calls of one message.
 */
let curAssistantBoundaries = new Set<object>();
// NOTE: the dedupe below is by object identity, which is load-bearing for
// pi-ai's in-place accumulator (block references are stable across a
// message's updates). A provider handing a fresh message object per update
// re-counts its boundaries at every registration and degrades to all-solo
// rows — the safe direction (never a wrong merge). Keying by text would be
// worse: distinct empty thinking blocks all have text "", and collapsing
// them would silently merge across boundaries.
/**
 * The assistant message currently streaming. Boundaries are counted lazily —
 * only up to a call's position as it registers (scanBoundariesBeforeTool) and
 * in full when the message closes (flushAssistantBoundaries) — so a provider
 * that delivers the whole message (later boundaries included) at once still
 * splits its calls where the content splits. See scanAssistantBoundaries.
 */
let curAssistantMessage: any;
// True while pi is replaying persisted history (startup with -c/--continue,
// /resume, /fork). During replay no events fire, so segment boundaries are
// rebuilt from the session branch instead (see session_start).
let replaying = true;
const replaySegByToolCallId = new Map<string, number>();
const previousToolById = new Map<string, string | null>();
const boundaryBeforeById = new Map<string, boolean>();
let lastToolCallId: string | null = null;

function scanToolOrder(message: {
  content?: Array<{ type?: string; id?: string }>;
}): void {
  let boundary = false;
  const content = message.content ?? [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (isBurstBoundaryBlock(block)) boundary = true;
    if (block.type !== "toolCall" || typeof block.id !== "string") continue;
    if (!previousToolById.has(block.id)) {
      previousToolById.set(block.id, lastToolCallId);
      boundaryBeforeById.set(block.id, boundary);
      pruneToolOrderMapsIfNeeded();
      lastToolCallId = block.id;
      // A later event can reveal calls whose components already registered.
      const row = entryById.get(block.id);
      if (row) {
        row.previousToolCallId = previousToolById.get(block.id);
        row.boundaryBefore = boundary;
        revalidateBurstsAround(block.id);
      }
    } else if (boundary && !boundaryBeforeById.get(block.id)) {
      // A thinking/text block may appear after both tool rows were painted.
      boundaryBeforeById.set(block.id, true);
      if (!replaying) {
        // Count the late boundary into the lazy counter now — the Set keeps
        // content order, so calls registering later never double-count it —
        // so the post-boundary segment value exists for the re-stamp below.
        scanAssistantBoundaries(curAssistantMessage, i);
        const row = entryById.get(block.id);
        if (row) {
          row.boundaryBefore = true;
          // The boundary splits the run at `row`. Every already-registered
          // entry after it still carries the pre-boundary segment — without
          // a re-stamp they render as solos instead of one post-boundary
          // group, and never group with calls that register later.
          const stale = row.seg;
          const tail: Entry[] = [];
          for (let k = row.index - entriesBase; k < entries.length; k++) {
            const e = entries[k];
            if (e.seg !== stale) break; // run ended at a counted boundary
            if (e !== row && e.boundaryBefore) break; // split mid-tail
            tail.push(e);
          }
          for (const e of tail) e.seg = liveSeg;
          for (const e of tail) revalidateBurstsAround(e.toolCallId);
        }
      }
    }
    boundary = false;
  }
}

const entries: Entry[] = [];
// `entries[0]`'s position in the monotonic entry numbering. Pruning drops
// from the front (pruneHistoryIfNeeded) and advances this base, so an
// entry's `index` stays stable for its lifetime while its position in the
// array shifts. Callers that need an array position subtract the base.
let entriesBase = 0;
const entryById = new Map<string, Entry>();
const invalidateById = new Map<string, () => void>();
/**
 * Tool calls of the CURRENT run whose final result has not landed. Only these
 * may swap to a summary when one lands (see invalidateRowsForCommand). `!e.result`
 * alone was the old test, and rows left resultless by a crash/interrupt —
 * replayed from a dead session via /resume, or any turn where pi never
 * delivered a result — stayed `!e.result` forever, so a later summary for the
 * same command repainted them anywhere in history: the above-viewport flash
 * again. Filled only for live registrations (never during replay); swept at
 * agent_settled so an abort that skipped the result path cannot leave a
 * zombie behind.
 */
const pendingToolCalls = new Set<string>();
// Ids dropped by pruning. A pruned row can re-render (expanding a burst far
// up the transcript re-creates its component), and a re-registered id must
// NOT join the live burst: its burst context is gone, so it renders solo
// (seg NaN). Bounded; the oldest ids drop off — by then their rows are long
// off-screen.
const prunedToolCallIds = new Set<string>();
const PRUNED_ID_CAP = 2000;

// History cap. `entries` is walked linearly by stampSummaryRequested on
// every bash renderCall and by invalidateRowsForCommand on every summary
// landing, so an unbounded history makes long sessions slower as they grow
// (thousands of finished rows re-scanned per render). Prune down to KEEP
// once MAX is exceeded. Pruned rows keep whatever is already painted on
// screen — pi components hold their own output — but a LATE re-render of a
// pruned row (expanding a burst far up the transcript) re-registers it as a
// solo row: burst context beyond the cap is gone. Cheap by design: entries
// are small metadata; the result payloads belong to pi's components.
let MAX_HISTORY_ENTRIES = 600;
let HISTORY_KEEP_ENTRIES = 400;

/** Shrink the history cap so pruning is exercisable in tests. */
export function __setHistoryCapsForTesting(caps?: {
  max?: number;
  keep?: number;
}): void {
  MAX_HISTORY_ENTRIES = caps?.max ?? 600;
  HISTORY_KEEP_ENTRIES = caps?.keep ?? 400;
}

/** Drop the oldest history once the cap is exceeded (see MAX_HISTORY_ENTRIES). */
function pruneHistoryIfNeeded(): void {
  if (entries.length <= MAX_HISTORY_ENTRIES) return;
  const drop = entries.length - HISTORY_KEEP_ENTRIES;
  for (let i = 0; i < drop; i++) {
    const id = entries[i].toolCallId;
    entryById.delete(id);
    invalidateById.delete(id);
    pendingToolCalls.delete(id);
    prunedToolCallIds.add(id);
    if (prunedToolCallIds.size > PRUNED_ID_CAP) {
      const oldest = prunedToolCallIds.values().next();
      if (!oldest.done) prunedToolCallIds.delete(oldest.value);
    }
  }
  entries.splice(0, drop);
  entriesBase += drop;
}

/**
 * Cap the tool-order maps (previousToolById / boundaryBeforeById) with the
 * same MAX/KEEP rule as the history itself. They gain one entry per tool call
 * ever streamed — burst tool or not — and previously grew unbounded for the
 * life of the process. Insertion order is toolCall order, the same order the
 * entries array fills, so oldest-first eviction gives the same window
 * guarantee: the values are read only while a call's row has yet to register
 * (upsertEntry) or its message is still streaming (the dedupe and
 * late-boundary paths below) — both the newest insertions, long past the cap
 * by the time an id drops off. If a still-streaming id were evicted anyway
 * (a single message with more calls than the keep window), the re-walk would
 * re-set it with a later predecessor — and shouldGroup fails closed on a
 * wrong previousToolCallId (solo row, never a wrong merge), so the failure
 * direction matches the prune's "renders solo" story. Both maps share their
 * key set by construction (set and cleared together, never deleted
 * elsewhere), so evicting through previousToolById keeps them in lockstep.
 */
function pruneToolOrderMapsIfNeeded(): void {
  if (previousToolById.size <= MAX_HISTORY_ENTRIES) return;
  const drop = previousToolById.size - HISTORY_KEEP_ENTRIES;
  let dropped = 0;
  for (const id of previousToolById.keys()) {
    if (dropped >= drop) break;
    previousToolById.delete(id);
    boundaryBeforeById.delete(id);
    dropped++;
  }
}

function upsertEntry(
  toolCallId: string,
  toolName: string,
  args: any,
  invalidate: () => void,
): Entry {
  let e = entryById.get(toolCallId);
  if (!e) {
    let seg: number;
    // Pruned ids re-register as solo rows: their burst context is gone, and
    // stamping the current segment would let a zombie row glue itself into
    // the live burst when its provider never puts toolCall blocks in message
    // content (the previousToolById path can't catch those).
    if (prunedToolCallIds.has(toolCallId)) seg = NaN;
    else if (replaying) {
      seg = replaySegByToolCallId.get(toolCallId) ?? NaN;
    } else {
      // Count the boundaries above this call before reading the counter, so a
      // burst splits exactly where the message content splits — including when
      // a provider delivers the whole message (later boundaries included) at
      // once. Eagerly counting on message_update would bump for boundaries
      // that sit after a call that has not registered yet, merging it with
      // the next call the boundary was meant to separate it from.
      scanBoundariesBeforeTool(toolCallId);
      seg = liveSeg;
    }
    e = {
      toolCallId,
      toolName,
      args,
      seg,
      previousToolCallId: previousToolById.get(toolCallId),
      boundaryBefore: boundaryBeforeById.get(toolCallId),
      index: entries.length + entriesBase,
    };
    entries.push(e);
    entryById.set(toolCallId, e);
    // Live registration of a call whose result has not landed. Replayed rows
    // (startup, /resume) and pruned-id re-registrations (late re-renders of
    // old rows) are not executing calls — a resultless replayed row is
    // exactly the crashed-session zombie this set exists to exclude.
    if (!replaying && !prunedToolCallIds.has(toolCallId))
      pendingToolCalls.add(toolCallId);
    pruneHistoryIfNeeded();
  } else {
    e.args = args;
  }
  if (invalidate) invalidateById.set(toolCallId, invalidate);
  return e;
}

/**
 * A message shows visible prose when it has a non-empty text block. Used for
 * typed user messages and replay user entries; the assistant per-block rule
 * lives in isBurstBoundaryBlock.
 */
function hasVisibleText(message: any): boolean {
  const content = message?.content;
  // pi's extension API allows content: string (user messages); Array
  // methods on a string would throw (contained by pi's runner, but a
  // crashing handler still skips the boundary bump this computes).
  if (typeof content === "string") return content.trim().length > 0;
  return (Array.isArray(content) ? content : []).some(
    (b: any) =>
      b?.type === "text" &&
      typeof b.text === "string" &&
      b.text.trim().length > 0,
  );
}

/**
 * A burst boundary block: visible prose or any thinking item, even if its
 * text is still empty when tool calls register. A reasoning item can gain text
 * later; never move a later call above it based on paint timing.
 */
function isBurstBoundaryBlock(block: any): boolean {
  if (!block || typeof block !== "object") return false;
  if (block.type === "thinking") return true;
  return (
    block.type === "text" &&
    typeof block.text === "string" &&
    block.text.trim().length > 0
  );
}

/** Bump the segment once for every boundary block new since the last scan. */
function scanAssistantBoundaries(message: any, upTo = Infinity): void {
  const content: any[] = message?.content ?? [];
  for (let i = 0; i < content.length && i < upTo; i++) {
    const block = content[i];
    if (!isBurstBoundaryBlock(block) || curAssistantBoundaries.has(block))
      continue;
    curAssistantBoundaries.add(block);
    liveSeg++;
  }
}

/**
 * Count the boundaries that precede `toolCallId` in the current assistant
 * message. Called at registration, so a call's segment reflects only the
 * boundaries above it — that is what keeps an interleaved thinking block
 * splitting two calls even when the whole message (and its later boundaries)
 * arrives at once, as non-streaming providers deliver it.
 *
 * When the id is not in the message content (test rows register independently
 * of the message; some providers omit the block), every currently-present
 * boundary precedes the call by construction — content appends in order — so
 * counting all of them is the same rule.
 */
function scanBoundariesBeforeTool(toolCallId: string): void {
  const content: any[] = curAssistantMessage?.content ?? [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (block?.type === "toolCall" && block.id === toolCallId) {
      scanAssistantBoundaries(curAssistantMessage, i);
      return;
    }
  }
  scanAssistantBoundaries(curAssistantMessage);
}

/**
 * Count the boundaries of the assistant message that just ended, including
 * any after its last tool call. Their only job is to separate that message's
 * tools from the next message's, so they land when the message closes rather
 * than eagerly.
 */
function flushAssistantBoundaries(): void {
  if (curAssistantMessage) scanAssistantBoundaries(curAssistantMessage);
  curAssistantMessage = undefined;
}

function shouldGroup(a: Entry, b: Entry): boolean {
  // Grouping is by adjacency + same tool with no boundary block in between.
  // A message's tools execute after its own prose and before the next message
  // streams, so the segment counter (bumped when a boundary block appears)
  // splits bursts exactly where the conversation visually splits. Messages
  // with no boundary block (no prose, no visible thinking) never bump it, so a model
  // calling tools one-per-message still chains into a single block. Live
  // segments count up, replay segments count down — the two domains can never
  // merge. NaN (unknown lineage) compares unequal to everything, so those
  // rows render solo.
  if (a.seg !== b.seg) return false;
  if (a.toolName !== b.toolName) return false;
  // A different (possibly non-overridden) tool can sit between two rendered
  // rows. Pi reports the actual assistant content before painting its rows.
  if (
    b.previousToolCallId !== undefined &&
    b.previousToolCallId !== a.toolCallId
  )
    return false;
  if (b.boundaryBefore) return false;
  if (a.hasImage || b.hasImage) return false;
  return true;
}

function getBurstForId(
  toolCallId: string,
): { entries: Entry[]; index: number } | null {
  const entry = entryById.get(toolCallId);
  if (!entry) return null;
  const idx = entry.index - entriesBase;
  let start = idx;
  while (start > 0 && shouldGroup(entries[start - 1], entries[start])) start--;
  let end = idx;
  while (
    end + 1 < entries.length &&
    shouldGroup(entries[end], entries[end + 1])
  )
    end++;
  const slice = entries.slice(start, end + 1);
  // slice is uniform toolName due to shouldGroup, but verify: if grouping broke due to name mismatch, slice would be size 1.
  return { entries: slice, index: idx - start };
}

// Maximal groupable run containing entries[i] (pairwise adjacency, same as
// getBurstForId).
function runAround(i: number): [number, number] {
  let start = i;
  while (start > 0 && shouldGroup(entries[start - 1], entries[start])) start--;
  let end = i;
  while (
    end + 1 < entries.length &&
    shouldGroup(entries[end], entries[end + 1])
  )
    end++;
  return [start, end];
}

function revalidateBurstsAround(changedId: string) {
  const changed = entryById.get(changedId);
  if (!changed) return;
  // Grouping is decided purely by adjacency, so a result arriving can only
  // affect the runs touching the changed entry (its image flag may split a
  // burst; pending/error flags surface on the leader). Rerender those runs —
  // bounded, unlike scanning the whole history per result.
  //
  // The changed row's OWN run is included deliberately. pi's updateDisplay
  // runs renderCall BEFORE renderResult in the same pass, so the box painted
  // when a result arrives still reflects pre-result state. Neighbors were
  // already woken here, but a row with no groupable neighbor had no wake-up
  // at all: a solo row stayed "running" after it finished, a solo failure
  // never turned red, and an image result at the END of a burst never split
  // off into its own row (a middle image only appeared because the next job
  // woke it). The self-wake closes all three.
  //
  // The synchronous re-entry (invalidate -> updateDisplay -> renderResult
  // -> recordResult) terminates immediately: the contentRef check above
  // classifies the replayed wrapper as a plain re-render, not a new result,
  // so no further invalidation fires.
  const idx = changed.index - entriesBase;
  const ranges: Array<[number, number]> = [runAround(idx)];
  if (idx > 0) ranges.push(runAround(idx - 1));
  if (idx + 1 < entries.length) ranges.push(runAround(idx + 1));
  const seen = new Set<number>();
  for (const [s, e] of ranges) {
    for (let i = s; i <= e; i++) {
      if (seen.has(i)) continue;
      seen.add(i);
      const fn = invalidateById.get(entries[i].toolCallId);
      if (fn) fn();
    }
  }
}

/**
 * Record a tool result. pi calls renderResult on EVERY rerender of a row
 * (expand toggles, neighbor invalidations, resizes), not only when a result
 * arrives — its wrapper object is fresh each time but the content array ref is
 * stable. Only a genuinely new result mutates state and triggers revalidation;
 * treating plain re-renders as mutations caused infinite render churn
 * (invalidate -> updateDisplay -> renderResult -> invalidate -> ...).
 */
function recordResult(
  entry: Entry | undefined,
  result: any,
  ctx: any,
  isPartial = false,
) {
  if (!entry) return;
  // A final result may share the content array the last partial delivered —
  // it must still be processed to clear isPartial and stamp completion.
  if (
    entry.contentRef === result?.content &&
    !(isPartial === false && entry.isPartial)
  )
    return;
  entry.contentRef = result?.content;
  entry.result = result;
  // Partial (streaming) results — bash's onUpdate ticks — are not
  // completion: pi keeps its pending background while isPartial, so pending
  // must survive, and resultAt/isError only land with the final result
  // (stamping resultAt on the first tick would also loosen the summary-swap
  // freshness window to start at execution start).
  entry.isPartial = isPartial;
  if (!isPartial) {
    entry.resultAt = Date.now();
    entry.isError = !!ctx.isError || !!result.isError;
    pendingToolCalls.delete(entry.toolCallId);
  }
  entry.hasImage = hasImageContent(result);
  revalidateBurstsAround(entry.toolCallId);
}

/** History sizes for tests (entries cap + id maps must stay in lockstep). */
export function __historyStatsForTesting(): {
  entries: number;
  entryById: number;
  invalidateById: number;
  prunedIds: number;
  previousToolIds: number;
  boundaryBeforeIds: number;
} {
  return {
    entries: entries.length,
    entryById: entryById.size,
    invalidateById: invalidateById.size,
    prunedIds: prunedToolCallIds.size,
    previousToolIds: previousToolById.size,
    boundaryBeforeIds: boundaryBeforeById.size,
  };
}

function bgFor(
  pending: boolean,
  isError: boolean,
  theme: any,
): (s: string) => string {
  if (pending) return (s: string) => theme.bg("toolPendingBg", s);
  if (isError) return (s: string) => theme.bg("toolErrorBg", s);
  return (s: string) => theme.bg("toolSuccessBg", s);
}

function makeBox(
  theme: any,
  pending: boolean,
  isError: boolean,
  text: string,
): Box {
  const box = new Box(1, 0, bgFor(pending, isError, theme));
  box.addChild(new Text(text, 0, 0));
  return box;
}

/**
 * The shared expanded-detail rule (the read view's): preview the first `max`
 * lines, and whenever anything was cut, append a muted "... N more lines"
 * note — a cut with no note reads as the complete output. Every burst tool's
 * grouped details use this so the expanded view stays even across tools;
 * missing info is skipped or guarded by the callers, never interpolated.
 */
export function previewLines(txt: string, theme: any, max = 12): string {
  const lines = txt.split("\n");
  const shown = lines
    .slice(0, max)
    .map((l) => theme.fg("toolOutput", l))
    .join("\n");
  const remaining = lines.length - max;
  return remaining > 0
    ? `${shown}\n${theme.fg("muted", `... ${remaining} more lines`)}`
    : shown;
}

/** Format spec for a burst-style tool. The shared skeleton below carries the
 *  grouped/solo/pending/error rules once for every tool that uses it. */
export type BurstToolSpec = {
  name: string;
  /** Bullet line for one entry inside a grouped header. */
  bullet: (entry: Entry, theme: any) => string;
  /** Extra lines appended to the grouped header when expanded (or ""). */
  groupedDetails: (entries: Entry[], theme: any) => string;
  /** Solo (ungrouped) header line, without expanded output. */
  soloHeader: (args: any, theme: any, ctx: any) => string;
  /** Extra lines appended to the solo header when expanded (or ""). */
  soloExpanded: (entry: Entry, args: any, theme: any) => string;
  /** Hook run right after upsertEntry (bash: request a summary). */
  onUpsert?: (entry: Entry, args: any, ctx: any) => void;
};

/** Max bullets the collapsed grouped header renders. The ×N title sits at
 *  the TOP of the shared box and changes on every new call; once the box
 *  outgrows the viewport, that line is above pi-tui's viewport top and every
 *  new call is answered with a full clear-screen + scrollback wipe
 *  (fullRender on firstChanged < viewportTop — tui-main-screen.js). Keeping
 *  the box shorter than the terminal keeps the title in view, so every burst
 *  update stays a differential render. Height-aware because the failure
 *  threshold is the terminal height, not the burst size: short herdr panes
 *  must cap smaller. The 10-row slack covers the editor + status footer that
 *  share the screen; 15 is the comfortable default when there is no TTY.
 *  Expanded views are opt-in detail and stay uncapped. */
const GROUPED_BULLET_CAP_MAX = 15;
function groupedBulletCap(): number {
  const rows = process.stdout.rows;
  if (typeof rows !== "number" || rows <= 0) return GROUPED_BULLET_CAP_MAX;
  return Math.max(3, Math.min(GROUPED_BULLET_CAP_MAX, rows - 10));
}

/** The shared burst render hooks (renderShell + renderCall + renderResult),
 *  split out of registerBurstTool so extension-owned tools in this package
 *  (vision) can attach the identical skeleton to their own registration —
 *  one implementation of the grouped/solo/pending/error rules, no copy. */
export function createBurstRenderer(spec: BurstToolSpec): {
  renderShell: "self";
  renderCall: (args: any, theme: any, ctx: any) => any;
  renderResult: (result: any, opts: any, _theme: any, ctx: any) => Container;
} {
  return {
    renderShell: "self",
    renderCall(args: any, theme: any, ctx: any) {
      const entry = upsertEntry(
        ctx.toolCallId,
        spec.name,
        args,
        ctx.invalidate,
      );
      spec.onUpsert?.(entry, args, ctx);
      const burst = getBurstForId(ctx.toolCallId);
      const isGrouped = burst && burst.entries.length > 1;
      const isLeader =
        isGrouped && burst.entries[0].toolCallId === ctx.toolCallId;
      // The burst box is shared by every call in the group, so its background
      // never takes the error color — a failure (the leader included) is
      // marked on its own bullet instead. Pending does aggregate: the box
      // stays in its running state until every call in the burst has landed.
      // (b80a14d "follow the leader" painted the whole block red whenever the
      // first call itself failed; this rule — formerly only on bash — now
      // applies to every burst tool.)
      // A streaming (partial) result keeps its row pending — same semantics
      // as pi's own shell, which holds toolPendingBg while isPartial.
      const pending = isGrouped
        ? burst.entries.some((e) => !e.result || e.isPartial)
        : !entry.result || !!entry.isPartial;
      const isError = isGrouped ? false : !!entry.isError;

      if (isGrouped && !isLeader) {
        // Refresh the leader's header/count. Single hop: a leader's renderCall
        // never invalidates anything, so this cannot loop.
        const lead = invalidateById.get(burst.entries[0].toolCallId);
        if (lead) lead();
        return new Container();
      }

      if (isGrouped && isLeader) {
        let header = `${theme.fg("toolTitle", theme.bold(spec.name))} ${theme.fg("muted", `×${burst.entries.length}`)}`;
        let bullets = burst.entries.map((e) => spec.bullet(e, theme));
        if (!ctx.expanded && bullets.length > groupedBulletCap()) {
          // Collapse to the most recent bullets, newest at the bottom where
          // the eye already is; the hidden count sits under the title (see
          // groupedBulletCap for why this cap is load-bearing).
          const cap = groupedBulletCap();
          const hidden = bullets.length - cap;
          bullets = [
            theme.fg("muted", `… +${hidden} earlier`),
            ...bullets.slice(-cap),
          ];
        }
        header += `\n${bullets.join("\n")}`;
        if (ctx.expanded) {
          const details = spec.groupedDetails(burst.entries, theme);
          if (details) header += details;
        }
        return makeBox(theme, pending, isError, header);
      }

      // solo
      let line = spec.soloHeader(args, theme, ctx);
      // Image parity with grouped bullets: a solo image read is visibly
      // marked too (the image itself is painted by pi's image layer).
      if (entry.hasImage) line += theme.fg("success", " [image]");
      if (ctx.expanded) {
        const extra = spec.soloExpanded(entry, args, theme);
        if (extra) line += `\n${extra}`;
      }
      return makeBox(theme, pending, isError, line);
    },
    renderResult(result: any, opts: any, _theme: any, ctx: any) {
      recordResult(
        entryById.get(ctx.toolCallId),
        result,
        ctx,
        opts?.isPartial === true,
      );
      // All visual work is done in renderCall (unified box); keep the result
      // slot empty. Images are rendered by Pi's ToolExecutionComponent image
      // layer even when we return empty here.
      return new Container();
    },
  };
}

// ── Per-tool helpers ────────────────────────────────────────────
function formatReadHeader(args: any, theme: any): string {
  const path = shortenPath(args.path || "");
  let display = path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
  if (args.offset !== undefined || args.limit !== undefined) {
    const start = args.offset ?? 1;
    const end = args.limit !== undefined ? start + args.limit - 1 : "";
    display += theme.fg("warning", `:${start}${end ? `-${end}` : ""}`);
  }
  return display;
}

function formatReadBullet(entry: Entry, theme: any): string {
  const args = entry.args;
  const path = shortenPath(args.path || "...");
  // Failed calls get red text so a single failure is visible inside a grouped
  // burst without poisoning the whole box's background (see renderCall: the
  // grouped box never takes the error color, whichever call failed).
  const accent = (s: string) => theme.fg(entry.isError ? "error" : "accent", s);
  let line = `  ${theme.fg("muted", "•")} ${accent(path)}`;
  if (args.offset !== undefined || args.limit !== undefined) {
    const start = args.offset ?? 1;
    const end = args.limit !== undefined ? start + args.limit - 1 : "";
    line += theme.fg("warning", `:${start}${end ? `-${end}` : ""}`);
  }
  if (entry.hasImage) line += theme.fg("success", " [image]");
  return line;
}

/**
 * Command display: first line only, capped to fit one terminal row, plus a
 * muted "(+N lines)" hint for heredocs/multi-line commands. Full command
 * stays available via expand — a 30-line heredoc must not cost 30 rows of
 * transcript. `cap` is the TOTAL budget for the line, suffix included: the
 * head is shortened far enough to reserve the hint's own width.
 */
function formatBashCommand(cmd: string, theme: any, cap: number): string {
  const nl = cmd.indexOf("\n");
  let head = nl === -1 ? cmd : cmd.slice(0, nl);
  let suffix = "";
  if (nl !== -1) {
    const extra = cmd.split("\n").length - 1;
    suffix = ` (+${extra} line${extra === 1 ? "" : "s"})`;
  }
  const budget = Math.max(10, cap - suffix.length);
  if (head.length > budget) head = head.slice(0, budget - 1) + "…";
  let out = theme.fg("accent", head);
  if (suffix) out += theme.fg("muted", suffix);
  return out;
}

// Display width a collapsed bash line may occupy before ellipsizing, in
// UTF-16 units (~ columns for CLI text).
const BASH_BULLET_WIDTH = 100;
// Visible width of the grouped bullet prefix: two-space indent + "• " .
const BULLET_PREFIX_WIDTH = 4;
// Chrome around the line's text: the bullet prefix plus the Box's 1-column
// side padding. Solo headers have no prefix, so capping them with the same
// number just leaves margin.
const BASH_LINE_CHROME = BULLET_PREFIX_WIDTH + 2;

/** Total visible budget for one collapsed bash line — prefix, head and the
 *  (+N lines) suffix together — at the CURRENT terminal width. This is the
 *  flicker guard's teeth: the line must wrap to exactly one row, so a landing
 *  summary can never occupy fewer rows than the raw text it replaces (pi-tui
 *  answers a shrink with clearOnShrink — a full clear-screen + scrollback
 *  wipe). Without a TTY (tests, piped output) the fallback is the historical
 *  geometry — the bullet prefix plus a 100-unit head — and never grows past
 *  it, so known-width terminals only ever truncate harder. */
function bashLineCap(): number {
  const legacy = BULLET_PREFIX_WIDTH + BASH_BULLET_WIDTH;
  const cols = process.stdout.columns;
  if (typeof cols !== "number" || cols <= 0) return legacy;
  return Math.max(20, Math.min(legacy, cols - BASH_LINE_CHROME));
}

function formatBashHeader(args: any, theme: any): string {
  const cmd = args.command || "...";
  // A summary already says what the command does; the (+N lines) size hint
  // only matters for the raw first-line fallback, where it warns that the
  // shown line isn't the whole command.
  if (isSummarizable(cmd) && summaryCache.has(cmd)) {
    return theme.fg("accent", summaryCache.get(cmd)!);
  }
  // The raw cap is the flicker guard: summaries render uncapped, so a
  // landing summary can grow this line but never shrink it — pi-tui answers
  // only the shrink direction with a full clear-screen + scrollback wipe
  // (clearOnShrink), i.e. the visible full-screen flash per summarized
  // command (the 0.11.x regression; see clean-tui.test.ts "summary swap is
  // height-neutral at 110 columns"). bashLineCap() reserves room for the
  // (+N lines) suffix and the terminal width, so the whole raw line fits
  // one row at any width and the swap keeps or adds rows everywhere.
  return formatBashCommand(cmd, theme, bashLineCap());
}

function formatBashBullet(entry: Entry, theme: any): string {
  const cmd = entry.args.command || "...";
  const bullet = `${theme.fg("muted", "•")} `;
  // Failed calls get red text so a single failure is visible without
  // poisoning the whole burst's background (see renderCall: the grouped box
  // never takes the error color, whichever call failed).
  const accent = (s: string) => theme.fg(entry.isError ? "error" : "accent", s);
  if (isSummarizable(cmd) && summaryCache.has(cmd)) {
    return `  ${bullet}${accent(summaryCache.get(cmd)!)}`;
  }
  const nl = cmd.indexOf("\n");
  let head = nl === -1 ? cmd : cmd.slice(0, nl);
  let suffix = "";
  if (nl !== -1) {
    const extra = cmd.split("\n").length - 1;
    suffix = ` (+${extra} line${extra === 1 ? "" : "s"})`;
  }
  // Same cap discipline as formatBashCommand: head + suffix within one row.
  // Budget is computed on the PLAIN suffix (ANSI added below adds no width).
  const budget = Math.max(
    10,
    bashLineCap() - BULLET_PREFIX_WIDTH - suffix.length,
  );
  if (head.length > budget) head = head.slice(0, budget - 1) + "…";
  let out = `  ${bullet}${accent(head)}`;
  if (suffix) out += theme.fg("muted", suffix);
  return out;
}

function formatWriteBullet(entry: Entry, theme: any): string {
  const path = shortenPath(entry.args.path || "...");
  const lines = entry.args.content ? entry.args.content.split("\n").length : 0;
  const info = lines ? theme.fg("muted", ` (${lines} lines)`) : "";
  const accent = (s: string) => theme.fg(entry.isError ? "error" : "accent", s);
  return `  ${theme.fg("muted", "•")} ${accent(path)}${info}`;
}

function formatEditBullet(entry: Entry, theme: any): string {
  const path = shortenPath(entry.args.path || "...");
  const accent = (s: string) => theme.fg(entry.isError ? "error" : "accent", s);
  return `  ${theme.fg("muted", "•")} ${accent(path)}`;
}

function formatFindBullet(entry: Entry, theme: any): string {
  const pat = entry.args.pattern || "";
  const path = shortenPath(entry.args.path || ".");
  const accent = (s: string) => theme.fg(entry.isError ? "error" : "accent", s);
  return `  ${theme.fg("muted", "•")} ${accent(pat)}${theme.fg("toolOutput", ` in ${path}`)}`;
}

function formatGrepBullet(entry: Entry, theme: any): string {
  const pat = entry.args.pattern || "";
  const path = shortenPath(entry.args.path || ".");
  const glob = entry.args.glob ? ` (${entry.args.glob})` : "";
  const accent = (s: string) => theme.fg(entry.isError ? "error" : "accent", s);
  return `  ${theme.fg("muted", "•")} ${accent(`/${pat}/`)}${theme.fg("toolOutput", ` in ${path}${glob}`)}`;
}

function formatLsBullet(entry: Entry, theme: any): string {
  const path = shortenPath(entry.args.path || ".");
  const accent = (s: string) => theme.fg(entry.isError ? "error" : "accent", s);
  return `  ${theme.fg("muted", "•")} ${accent(path)}`;
}

/** Extension version from the package manifest, for the load line. */
function loadExtensionVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export default function cleanTui(pi: ExtensionAPI): void {
  bindSummaryHistory({
    entries,
    invalidateById,
    isReplaying: () => replaying,
    isPending: (id) => pendingToolCalls.has(id),
  });
  setCleanTuiActive(true);
  // One line per load (pi process start, /reload) so the log answers "was the
  // feature even on, pointing at which model, and running which version"
  // without guessing — stale processes have burned us repeatedly.
  logGoodiesEvent({
    type: "load",
    version: loadExtensionVersion(),
    summaryModel: getSummaryModel() ?? "off",
    thinkingSummaries: getThinkingSummariesEnabled() ? "on" : "off",
  });
  const schemaTools = getBuiltInTools(process.cwd());

  pi.on("agent_start", (_event, ctx) => {
    // First live run after startup/resume: tool calls from here on may group.
    replaying = false;
    // The model runtime may be rebuilt between sessions within one process;
    // re-read the registry so summary resolution stays current.
    if (
      (ctx as { modelRegistry?: SummaryModelRegistry } | undefined)
        ?.modelRegistry
    ) {
      setSummaryRegistry(
        (ctx as { modelRegistry?: SummaryModelRegistry }).modelRegistry,
      );
    }
  });
  // Boundary blocks (visible prose, thinking) are counted lazily, in content
  // order: at registration each tool counts only the boundaries above it
  // (upsertEntry -> scanBoundariesBeforeTool), and a message's trailing
  // boundaries land when it closes. This holds whether the message streams in
  // block-by-block or arrives whole (non-streaming providers), where an eager
  // scan would see later boundaries before the calls they separate have
  // registered. Extension events are emitted before the TUI creates those
  // components (agent-session emits to extensions first).
  pi.on("message_start", (event, _ctx) => {
    const message = (event as any).message;
    if (!message) return;
    if (message.role === "assistant") {
      // Close the previous assistant message first: count its trailing
      // boundaries so the next message's tools cannot group across them.
      flushAssistantBoundaries();
      curAssistantBoundaries = new Set();
      curAssistantMessage = message;
      scanToolOrder(message);
      // A new assistant message brings a fresh content array — its thinking
      // blocks are new objects, so drop the previous message's run tracking.
      resetThinkingRun();
    } else if (message.role === "user") {
      // A typed user message is prose; it must split the surrounding bursts.
      // Close the assistant message that preceded it first, then bump.
      flushAssistantBoundaries();
      curAssistantBoundaries = new Set();
      if (hasVisibleText(message)) liveSeg++;
    }
  });
  pi.on("message_update", (event, _ctx) => {
    const message = (event as any).message;
    if (message?.role !== "assistant") return;
    // Keep the newest message object: boundaries arrive on update events. In
    // real pi the accumulator is mutated in place (same reference), but tests
    // and some providers hand a fresh object — scanBoundariesBeforeTool and
    // flushAssistantBoundaries must read whichever carries the content.
    curAssistantMessage = message;
    scanToolOrder(message);
    // Boundaries are not counted here: registration counts only those above
    // each call and message close flushes the rest (see message_start). The
    // accumulating content is still walked for live thinking summaries.
    trackThinkingStream(message);
  });
  pi.on("agent_settled", () => {
    // Turn fully done (no retry/continuation coming): the thinking widget's
    // last summary is spent. In-flight requests may still land — their
    // run-identity check drops them silently.
    resetThinkingRun();
    // Nothing executes across a settle, so anything still pending is a
    // zombie (an abort that skipped the result path, a missed event). Sweep
    // it: pi fabricates "Operation aborted" results for interrupted calls,
    // but the sweep does not depend on that reaching every row.
    pendingToolCalls.clear();
  });
  pi.on("session_start", (_event, ctx) => {
    liveSeg = 0;
    curAssistantBoundaries = new Set();
    curAssistantMessage = undefined;
    replaying = true;
    entries.length = 0;
    entriesBase = 0;
    entryById.clear();
    invalidateById.clear();
    pendingToolCalls.clear();
    prunedToolCallIds.clear();
    // Capture the UI handle for the pause widget (guarded: harness stubs and
    // limited contexts lack setWidget), and drop any stale pause indicator
    // left over from the previous session. hasUI comes from the context —
    // ctx.ui carries no such flag, so storing ctx.ui directly left hasUI
    // undefined and every TUI failure took the console.error branch, flashing
    // raw stderr across the terminal; the widget never showed.
    const ui = (ctx as { ui?: Partial<SummaryUi> } | undefined)?.ui;
    if (ui && typeof ui.setWidget === "function") {
      // Call through the ui object — never through a detached copy of the
      // method. The receiver IS the link back to pi: today ctx.ui.setWidget
      // arrives as a closure so detaching happens to work, but that is an
      // implementation detail; a prototype method would lose `this` and
      // silently break. Tests inject plain functions, so only calling
      // through the object keeps this honest.
      setSummaryUi({
        hasUI: ctx.hasUI,
        setWidget: (key, content) => ui.setWidget!(key, content),
      });
    }
    // Stop summary work from the previous session before replaying history.
    // Runs after the UI capture so the pause-widget clear goes through the
    // fresh handle, not the previous session's.
    resetSummarySession();
    // Capture the registry slice render context lacks, and cut off any
    // summaries still in flight from the previous session.
    const modelRegistry = (
      ctx as { modelRegistry?: SummaryModelRegistry } | undefined
    )?.modelRegistry;
    if (modelRegistry) setSummaryRegistry(modelRegistry);
    // Replayed history fires no events: rebuild segment boundaries from the
    // branch with one segment per boundary block, mirroring the live rule.
    // Scanning content in order handles thinking interleaved between tool
    // calls (OpenAI Responses reasoning items). Calls not present in the
    // branch (defensive) get NaN and render solo.
    replaySegByToolCallId.clear();
    previousToolById.clear();
    boundaryBeforeById.clear();
    lastToolCallId = null;
    const branch = ctx?.sessionManager?.getBranch?.() ?? [];
    // Replay segments start at -1 and count down; live segments start at 0 and
    // count up. Starting replay at -1 (not 0) keeps the domains disjoint —
    // seg 0 belongs to live only — so a resumed branch's last call can never
    // group with the first call of the next run (see shouldGroup).
    let seg = -1;
    for (const entry of branch) {
      const message = entry?.type === "message" ? entry.message : undefined;
      if (!message) continue;
      if (message.role === "assistant") {
        scanToolOrder(message);
        for (const block of message.content ?? []) {
          if (isBurstBoundaryBlock(block)) {
            seg--;
            continue;
          }
          if (block?.type === "toolCall" && typeof block.id === "string") {
            replaySegByToolCallId.set(block.id, seg);
          }
        }
      } else if (message.role === "user" && hasVisibleText(message)) {
        seg--;
      }
    }
  });

  // ── Shared burst-tool skeleton ─────────────────────────────────
  // registerBurstTool = createBurstRenderer (module-level, shared with
  // vision's own registration) + execute delegation to the cached built-in
  // tool. Every burst tool (read/bash/write/edit/find/grep/ls) shares that one
  // render skeleton, which makes the divergence class impossible: the "one
  // failed row paints the whole burst red" bug was fixed twice for bash
  // (b80a14d, then the isGrouped?false rule) but the other six tools still
  // shipped `isGrouped ? entries.some(e => e.isError)` — the shared skeleton
  // carries the single correct rule for all of them.
  const specs: BurstToolSpec[] = [];
  function registerBurstTool(spec: BurstToolSpec): void {
    specs.push(spec);
  }
  function installBurstTool(spec: BurstToolSpec): void {
    const native = schemaTools[spec.name as keyof BuiltInTools];
    if (!native) throw new Error(`No built-in definition for ${spec.name}`);
    const burst = createBurstRenderer(spec);
    const definition = {
      ...native, // retain promptSnippet/Guidelines, schema, execution mode, preparation and all future metadata
      ...burst,
      async execute(
        toolCallId: string,
        params: never,
        signal: AbortSignal | undefined,
        onUpdate: never,
        ctx: Parameters<typeof native.execute>[4],
      ) {
        const tool = (getBuiltInTools(ctx.cwd) as any)[spec.name];
        return tool.execute(toolCallId, params, signal, onUpdate, ctx);
      },
    };
    // The indexed lookup is a union of seven distinct TypeBox schemas; pi's
    // generic registerTool cannot infer a single schema from that union.
    pi.registerTool(definition as never);
  }

  // ── read ──────────────────────────────────────────────────────
  registerBurstTool({
    name: "read",
    bullet: formatReadBullet,
    groupedDetails(entries, theme) {
      const details: string[] = [];
      for (const e of entries) {
        if (!e.result) {
          details.push(
            theme.fg(
              "warning",
              `— ${shortenPath(e.args.path || "...")}: pending`,
            ),
          );
          continue;
        }
        const txt = resultText(e.result as any);
        if (!txt) continue;
        details.push(
          `\n${theme.fg("muted", `— ${shortenPath(e.args.path || "...")}`)}:\n${previewLines(txt, theme)}`,
        );
      }
      return details.length ? `\n${details.join("\n")}` : "";
    },
    soloHeader(args, theme) {
      return `${theme.fg("toolTitle", theme.bold("read"))} ${formatReadHeader(args, theme)}`;
    },
    soloExpanded(entry, _args, theme) {
      if (!entry.result) return "";
      const txt = resultText(entry.result as any);
      return txt
        ? txt
            .split("\n")
            .map((l) => theme.fg("toolOutput", l))
            .join("\n")
        : "";
    },
  });

  // ── bash ──────────────────────────────────────────────────────
  registerBurstTool({
    name: "bash",
    bullet: formatBashBullet,
    onUpsert(_entry, args, ctx) {
      // Upsert happened just above, so the stamp sees this row's entry.
      // Request only when args are COMPLETE: pi re-renders each row as the
      // JSON args stream in, and every partial command longer than the
      // threshold used to fire its own request — truncated, undisplayable,
      // and queue-blocking. The complete command's request then landed so
      // late the freshness window had closed: bursts summarized their first
      // row only. argsComplete is true in the test harness → request.
      if (ctx.argsComplete !== false && args.command)
        requestSummary(args.command);
    },
    groupedDetails(entries, theme) {
      const details: string[] = [];
      for (const e of entries) {
        // Expanded details show each call's full command, uncapped — same
        // rule as the solo expanded header. Output appends when present;
        // empty output still reveals the command it came from.
        const cmd = theme.fg("accent", e.args.command || "...");
        if (!e.result) {
          details.push(theme.fg("warning", `— $ ${cmd}: pending`));
          continue;
        }
        const txt = resultText(e.result as any)?.trim();
        if (!txt) {
          details.push(`\n${theme.fg("muted", `— $ ${cmd}`)}`);
          continue;
        }
        details.push(
          `\n${theme.fg("muted", `— $ ${cmd}`)}:\n${previewLines(txt, theme)}`,
        );
      }
      return details.length ? `\n${details.join("\n")}` : "";
    },
    soloHeader(args, theme, ctx) {
      const suffix = args.timeout
        ? theme.fg("muted", ` (timeout ${args.timeout}s)`)
        : "";
      // Expanded shows the raw truth: the full command, uncapped — the
      // summary and the (+N lines) hint are compact-view aids, and the whole
      // point of ctrl+o is to reveal what actually ran.
      if (ctx?.expanded)
        return `${theme.fg("toolTitle", theme.bold("$"))} ${theme.fg("accent", args.command || "...")}${suffix}`;
      return `${theme.fg("toolTitle", theme.bold("$"))} ${formatBashHeader(args, theme)}${suffix}`;
    },
    soloExpanded(entry, _args, theme) {
      // The expanded header carries the full command; this adds the output.
      if (!entry.result) return "";
      const txt = resultText(entry.result as any)?.trim();
      if (!txt) return "";
      return txt
        .split("\n")
        .map((l: string) => theme.fg("toolOutput", l))
        .join("\n");
    },
  });

  // ── write ─────────────────────────────────────────────────────
  registerBurstTool({
    name: "write",
    bullet: formatWriteBullet,
    groupedDetails(entries, theme) {
      // pi renders a write result only when the call failed (a success is
      // "Successfully wrote N bytes", which it hides); showing it here in the
      // error color painted every successful expanded write red.
      return entries
        .filter((e) => e.isError && e.result && resultText(e.result as any))
        .map(
          (e) =>
            `\n${theme.fg("muted", `— ${shortenPath(e.args.path || "...")}`)}: ${theme.fg("error", resultText(e.result as any)!)}`,
        )
        .join("");
    },
    soloHeader(args, theme) {
      const path = shortenPath(args.path || "");
      const display = path
        ? theme.fg("accent", path)
        : theme.fg("toolOutput", "...");
      const lines = args.content ? args.content.split("\n").length : 0;
      const info = lines > 0 ? theme.fg("muted", ` (${lines} lines)`) : "";
      return `${theme.fg("toolTitle", theme.bold("write"))} ${display}${info}`;
    },
    soloExpanded(entry, _args, theme) {
      // Matches pi's write renderer: success output stays hidden.
      if (!entry.isError || !entry.result) return "";
      const txt = resultText(entry.result as any);
      return txt ? theme.fg("error", txt) : "";
    },
  });

  // ── edit ──────────────────────────────────────────────────────
  registerBurstTool({
    name: "edit",
    bullet: formatEditBullet,
    groupedDetails(entries, theme) {
      return entries
        .map((e) => {
          const txt = e.result ? resultText(e.result as any) : undefined;
          return txt
            ? `\n${theme.fg("muted", `— ${shortenPath(e.args.path || "...")}`)}:\n${previewLines(txt, theme)}`
            : "";
        })
        .join("");
    },
    soloHeader(args, theme) {
      return `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", shortenPath(args.path || "..."))}`;
    },
    soloExpanded(entry, _args, theme) {
      if (!entry.result) return "";
      const txt = resultText(entry.result as any);
      return txt ? theme.fg("toolOutput", txt) : "";
    },
  });

  // ── find ──────────────────────────────────────────────────────
  registerBurstTool({
    name: "find",
    bullet: formatFindBullet,
    groupedDetails(entries, theme) {
      return entries
        .map((e) => {
          const txt = e.result
            ? resultText(e.result as any)?.trim()
            : undefined;
          return txt
            ? `\n${theme.fg("muted", `— ${e.args.pattern ?? ""}`)}:\n${previewLines(txt, theme)}`
            : "";
        })
        .join("");
    },
    soloHeader(args, theme) {
      return `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", args.pattern || "")}${theme.fg("toolOutput", ` in ${shortenPath(args.path || ".")}`)}`;
    },
    soloExpanded(entry, _args, theme) {
      if (!entry.result) return "";
      const txt = resultText(entry.result as any)?.trim();
      return txt
        ? txt
            .split("\n")
            .map((l) => theme.fg("toolOutput", l))
            .join("\n")
        : "";
    },
  });

  // ── grep ──────────────────────────────────────────────────────
  registerBurstTool({
    name: "grep",
    bullet: formatGrepBullet,
    groupedDetails(entries, theme) {
      return entries
        .map((e) => {
          const txt = e.result
            ? resultText(e.result as any)?.trim()
            : undefined;
          return txt
            ? `\n${theme.fg("muted", `— /${e.args.pattern ?? ""}/`)}:\n${previewLines(txt, theme)}`
            : "";
        })
        .join("");
    },
    soloHeader(args, theme) {
      let line = `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", `/${args.pattern || ""}/`)}${theme.fg("toolOutput", ` in ${shortenPath(args.path || ".")}`)}`;
      if (args.glob) line += theme.fg("toolOutput", ` (${args.glob})`);
      return line;
    },
    soloExpanded(entry, _args, theme) {
      if (!entry.result) return "";
      const txt = resultText(entry.result as any)?.trim();
      return txt
        ? txt
            .split("\n")
            .map((l) => theme.fg("toolOutput", l))
            .join("\n")
        : "";
    },
  });

  // ── ls ────────────────────────────────────────────────────────
  registerBurstTool({
    name: "ls",
    bullet: formatLsBullet,
    groupedDetails(entries, theme) {
      return entries
        .map((e) => {
          const txt = e.result
            ? resultText(e.result as any)?.trim()
            : undefined;
          return txt
            ? `\n${theme.fg("muted", `— ${shortenPath(e.args.path || ".")}`)}:\n${previewLines(txt, theme)}`
            : "";
        })
        .join("");
    },
    soloHeader(args, theme) {
      return `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", shortenPath(args.path || "."))}`;
    },
    soloExpanded(entry, _args, theme) {
      if (!entry.result) return "";
      const txt = resultText(entry.result as any)?.trim();
      return txt
        ? txt
            .split("\n")
            .map((l) => theme.fg("toolOutput", l))
            .join("\n")
        : "";
    },
  });
  for (const spec of specs) installBurstTool(spec);
}
