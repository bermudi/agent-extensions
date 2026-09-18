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
 * A thinking block with text closes the burst as well: models interleave reasoning
 * between tool calls (the OpenAI Responses API emits a reasoning item before
 * every call; interleaved thinking does the same), and a merged burst would
 * render the later call inside the box above the thinking row it follows.
 * Empty thinking is ignored — pi renders no row for it, so grouping across it
 * matches what you see. OpenAI models often emit reasoning items with no
 * actual text; those no longer split bursts.
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
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
  clampThinkingLevel,
  type Api,
  type AssistantMessage,
  type Model,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { logGoodiesEvent, setGoodiesLogPathForTesting } from "./goodies-log.ts";
import { describeError } from "./json-file.ts";
import {
  findSummaryModel,
  getSummaryModel,
  getThinkingSummariesEnabled,
  type SummaryModelRegistry,
} from "./goodies.ts";

/**
 * Process-global contract with @bermudi/pi-codex: its apply_patch/web_search
 * tools render in clean-tui burst style only while this flag is set. Set when
 * this extension loads (index.ts only loads it when the feature is enabled);
 * index.ts clears it when the feature is disabled, so /reload converges.
 * Key is versioned — bump on any contract change. Mirrored by the same
 * Symbol.for key in pi-codex's src/clean-burst.ts.
 */
const CLEAN_TUI_ACTIVE = Symbol.for("bermudis-pi-goodies.clean-tui.active.v1");

export function setCleanTuiActive(active: boolean): void {
  const globals = globalThis as Record<symbol, unknown>;
  if (active) globals[CLEAN_TUI_ACTIVE] = true;
  else delete globals[CLEAN_TUI_ACTIVE];
}

type BuiltInTools = {
  read: ReturnType<typeof createReadTool>;
  bash: ReturnType<typeof createBashTool>;
  edit: ReturnType<typeof createEditTool>;
  write: ReturnType<typeof createWriteTool>;
  find: ReturnType<typeof createFindTool>;
  grep: ReturnType<typeof createGrepTool>;
  ls: ReturnType<typeof createLsTool>;
};

const toolCache = new Map<string, BuiltInTools>();

function createBuiltInTools(cwd: string): BuiltInTools {
  return {
    read: createReadTool(cwd),
    bash: createBashTool(cwd),
    edit: createEditTool(cwd),
    write: createWriteTool(cwd),
    find: createFindTool(cwd),
    grep: createGrepTool(cwd),
    ls: createLsTool(cwd),
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
type Entry = {
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
  /** Position in `entries`; stable because entries are append-only. */
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
const entries: Entry[] = [];
const entryById = new Map<string, Entry>();
const invalidateById = new Map<string, () => void>();

function upsertEntry(
  toolCallId: string,
  toolName: string,
  args: any,
  invalidate: () => void,
): Entry {
  let e = entryById.get(toolCallId);
  if (!e) {
    let seg: number;
    if (replaying) {
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
      index: entries.length,
    };
    entries.push(e);
    entryById.set(toolCallId, e);
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
  return (message?.content ?? []).some(
    (b: any) =>
      b?.type === "text" &&
      typeof b.text === "string" &&
      b.text.trim().length > 0,
  );
}

/**
 * A burst boundary block: visible prose or thinking with text. Matches pi's
 * rendering, which skips empty thinking runs entirely — an empty reasoning
 * item produces no Thinking... row, so grouping across it matches the screen.
 */
function isBurstBoundaryBlock(block: any): boolean {
  if (!block || typeof block !== "object") return false;
  if (block.type === "thinking")
    return (
      typeof block.thinking === "string" && block.thinking.trim().length > 0
    );
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
  if (a.hasImage || b.hasImage) return false;
  return true;
}

function getBurstForId(
  toolCallId: string,
): { entries: Entry[]; index: number } | null {
  const entry = entryById.get(toolCallId);
  if (!entry) return null;
  const idx = entry.index;
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
  // The changed row itself is NOT invalidated here: pi is already re-rendering
  // it (we are inside its render slot), and invalidating it would synchronously
  // re-enter this code path via updateDisplay -> renderResult -> invalidate.
  const idx = changed.index;
  const ranges: Array<[number, number]> = [];
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
function recordResult(entry: Entry | undefined, result: any, ctx: any) {
  if (!entry || entry.contentRef === result?.content) return;
  entry.contentRef = result?.content;
  entry.result = result;
  entry.resultAt = Date.now();
  entry.isError = !!ctx.isError || !!result.isError;
  entry.hasImage = hasImageContent(result);
  revalidateBurstsAround(entry.toolCallId);
}

// ── AI command summaries (via the user's own provider stack) ────
//
// Long bash commands earn a short "what this does" header. The model is
// whatever `/goodies summary-model <provider/model>` points at, resolved
// against pi's own model registry — same providers, same auth (env keys,
// models.json entries, OAuth token refresh) as the rest of the session.
// There are deliberately no hardcoded endpoints or key files here, and an
// unset summary-model means the feature is off entirely.
interface SummaryBackend {
  summarize(cmd: string, signal: AbortSignal): Promise<string>;
  /**
   * Live summary of an in-progress thinking run (tail of its text).
   * Optional so test backends for the bash path stay two-field objects.
   */
  summarizeThinking?(text: string, signal: AbortSignal): Promise<string>;
}

// Hard floor: commands at or under 80 chars are cheap to read as-is, so no
// summary no matter how many lines. Above that, any command qualifies —
// single-line pipelines benefit at least as much as heredocs.
const SUMMARY_THRESHOLD_CHARS = 80;
// Up to ~a dozen words fit in a handful of tokens, but on OpenAI-compatible
// endpoints reasoning and the answer SHARE max_tokens (pi-ai: "a reasoning-
// heavy turn can consume the whole response and emit no answer") — at the
// old 30-token cap, gpt-oss running its API-default effort returned an empty
// summary every time. 512 gives reasoning headroom; non-reasoning models
// stop at the answer's natural end, so the raised cap costs them nothing.
// When even 512 is out-thought — router models (kilo-auto/free, openrouter
// routers) hop between upstreams per request and some ignore effort hints
// entirely — completeSummaryTurn escalates once to the cap below before
// declaring the empty-summary failure.
const SUMMARY_MAX_TOKENS = 512;
const SUMMARY_REASONING_RETRY_MAX_TOKENS = 4096;
const SUMMARY_PROMPT =
  "Summarize this shell command in less than 13 words, plain English, no quotes, no formatting. " +
  'Examples: "cat >> file << \'EOF\' with 20 lines of log" -> "Appends reboot log to migration file". ' +
  "Command:\n";
// The subject differs from the bash prompt: we are summarizing the agent's
// own in-progress reasoning for a status line, so the answer must read as
// present-tense activity ("Weighing render escalation rules"), not a
// description of an artifact. The request carries the TAIL of the thinking
// text — "what is it thinking about NOW" — not its start.
const THINKING_SUMMARY_PROMPT =
  "A coding agent is mid-reasoning about a task. Summarize what it is currently thinking about in less than 15 words, plain English, no quotes, no formatting. " +
  "Start with the word 'Thinking', e.g. 'Thinking through opcode cycles' or 'Thinking about render rules'. " +
  "Never start with an action verb like Writing or Implementing — it is only thinking, not doing.\nRecent thinking:\n";
// Provider error bodies are not under our control and flow into console
// output plus the log-once dedup set; keep both bounded.
const SUMMARY_ERROR_SNIPPET_CHARS = 200;

const summaryCache = new Map<string, string>();
const pendingSummaries = new Set<string>();
// Commands whose requests were deferred by the inflight cap or a failure
// backoff. Drained whenever a slot frees (request settle) or a later
// renderCall finds capacity — no timers. Cleared on session switch.
const summaryRequestQueue: string[] = [];

// ── Pause indicator (widget) ────────────────────────────────────
//
// pi's TUI prints extension stderr inline, so console.error is a lousy
// failure surface: a 429 body once plastered a screen-width JSON blob across
// the transcript. Failures instead show as a widget line above the editor
// while summaries are paused, and clear themselves on recovery. The console
// line remains only for headless modes (no UI to attach a widget to).
interface SummaryUi {
  hasUI: boolean;
  setWidget(
    key: string,
    content:
      | string[]
      // Themed factory so the widget can match pi's own Thinking... styling
      // (italic thinkingText) instead of rendering as plain white text that
      // reads like assistant prose. Mirrors pi's setWidget overload.
      | ((
          tui: unknown,
          theme: {
            fg: (color: string, text: string) => string;
            italic: (text: string) => string;
          },
        ) => { render: (width: number) => string[]; invalidate: () => void })
      | undefined,
  ): void;
}
const SUMMARY_WIDGET_KEY = "bermudis-pi-goodies.summaries";
let summaryUi: SummaryUi | undefined;
let summaryWidgetShown = false;

export function __setSummaryUiForTesting(ui?: SummaryUi): void {
  summaryUi = ui;
}

function showSummaryPauseWidget(short: string, pauseMs?: number): void {
  if (!summaryUi?.hasUI) return;
  const pause = pauseMs ? ` paused ${Math.round(pauseMs / 1000)}s` : "";
  // Trim harder than the console/file lines: the widget sits above the
  // editor and must not wrap on narrow terminals.
  const brief = short.length > 80 ? `${short.slice(0, 80)}…` : short;
  summaryUi.setWidget(SUMMARY_WIDGET_KEY, [`⏸ summaries${pause} — ${brief}`]);
  summaryWidgetShown = true;
}

function clearSummaryPauseWidget(): void {
  if (!summaryWidgetShown) return;
  summaryWidgetShown = false;
  try {
    summaryUi?.setWidget(SUMMARY_WIDGET_KEY, undefined);
  } catch {
    // A stale UI handle across a session switch must not break the request
    // path — the next failure re-shows the widget with a fresh handle.
  }
}
// A burst of distinct long commands can fan out N simultaneous renders; keep
// concurrent provider requests bounded so we don't hammer the rate limiter.
const SUMMARY_MAX_INFLIGHT = 2;
// A summary is a ~30-token call: if it hasn't landed in 20s, the provider is
// stalled. Without this, a hung request holds its concurrency slot forever,
// the queue behind it never drains, and nothing logs — because nothing
// "failed", it just never came back. pi-ai's timeoutMs is best-effort
// ("providers/SDKs that support it"), so race the promise ourselves.
const SUMMARY_REQUEST_TIMEOUT_MS = 20_000;
let summaryRequestTimeoutMs = SUMMARY_REQUEST_TIMEOUT_MS;
export function __setSummaryRequestTimeoutForTesting(ms: number): void {
  summaryRequestTimeoutMs = ms;
}
// Transient provider failures get up to three quick second chances before
// the failure counts toward the session-wide backoff: upstream 5xx or
// network blips (e.g. a proxy's "no response from upstream within 15s")
// must neither drop the summary nor idle every summary for the 30s base
// cooldown. The pause between retries is progressive — 1s, 5s, 10s — so a
// still-stumbling provider gets room without making the first recovery
// slow. Rate limits (429), other 4xx, config errors, and deterministic
// failures (the empty-summary thinking-model diagnosis) are not retried —
// the backoff machinery owns those, and hammering a rate limiter with
// retries is exactly what it exists to prevent. Retries hold their
// concurrency slot for the whole cycle; at the 20s per-attempt timeout that
// bounds one command's cycle at ~96s, which is acceptable for background
// polish that stays silent while it works.
const SUMMARY_RETRY_DELAYS_MS = [1_000, 5_000, 10_000];
let summaryRetryDelaysMs = SUMMARY_RETRY_DELAYS_MS;
/** One delay per retry — attempts = 1 + length (undefined restores default). */
export function __setSummaryRetryDelaysForTesting(delaysMs?: number[]): void {
  summaryRetryDelaysMs = delaysMs ?? SUMMARY_RETRY_DELAYS_MS;
}
// Retryability is classified from the error message because pi-ai surfaces
// provider failures as plain Errors ("502: {body...} (provider/model)") with
// no status field. Word-boundary + colon-free \b5\d\d\b matches "HTTP 502"
// and the "502: ..." shape alike, while leaving "HTTP 429" and config
// messages unmatchable.
const SUMMARY_RETRYABLE_ERROR_RE =
  /\b5\d\d\b|timed? ?out|connection|econn(reset|refused|aborted)|enotfound|etimedout|eai_again|socket hang up|fetch failed/i;

function isRetryableSummaryError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return SUMMARY_RETRYABLE_ERROR_RE.test(msg);
}
let summaryEnabled = true;

export function __setSummaryEnabled(v: boolean): void {
  summaryEnabled = v;
}
export function __clearSummaryCache(): void {
  summaryCache.clear();
  pendingSummaries.clear();
  summaryRequestQueue.length = 0;
  summaryFailStreak = 0;
  summaryBlockedUntil = 0;
}

function isSummarizable(cmd: string): boolean {
  return cmd.length > SUMMARY_THRESHOLD_CHARS;
}

function normalizeSummary(text: string): string {
  return text
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Normalization happens here — in the consumer — rather than inside a
// transport, so every SummaryBackend feeds the display pipeline identically.

// Render context provably has no model registry (ToolRenderContext), but event
// handler contexts do. session_start seeds the stash; agent_start re-reads it
// because pi can rebuild the model runtime between sessions in one process.
let summaryModelRegistry: SummaryModelRegistry | undefined;
// Render-side work outlives turns, so ctx.signal (undefined outside turns, and
// wrong even inside them) is unusable here. Each session gets a fresh
// controller; switching sessions aborts every in-flight summary request.
let summarySessionAbort = new AbortController();
let summaryBackendOverride: SummaryBackend | undefined;

/** Swap the LLM transport seam for testing (undefined restores the default). */
export function __setSummaryBackendForTesting(backend?: SummaryBackend): void {
  summaryBackendOverride = backend;
}

/** Seed the registry stash directly in tests (normally done by events). */
export function __setSummaryModelRegistryForTesting(
  registry?: SummaryModelRegistry,
): void {
  summaryModelRegistry = registry;
}

async function summarizeViaProvider(
  cmd: string,
  signal: AbortSignal,
): Promise<string> {
  const t = await resolveSummaryTransport();
  const response = await completeSummaryTurn(
    t,
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: SUMMARY_PROMPT + cmd.slice(0, 2000) },
          ],
          timestamp: Date.now(),
        },
      ],
    },
    signal,
  );
  return convertSummaryResponse(response, t.label);
}

async function summarizeThinkingViaProvider(
  text: string,
  signal: AbortSignal,
): Promise<string> {
  const t = await resolveSummaryTransport();
  const response = await completeSummaryTurn(
    t,
    {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: THINKING_SUMMARY_PROMPT + text }],
          timestamp: Date.now(),
        },
      ],
    },
    signal,
  );
  return convertSummaryResponse(response, t.label);
}

/**
 * Resolve the configured summary model plus its auth once, for either kind
 * of summary request (bash commands, thinking runs). getApiKeyAndHeaders
 * resolves env keys, models.json auth, and refreshes OAuth tokens — the one
 * thing a raw endpoint could never do. Safe to call fire-and-forget
 * (pi-codex makes OAuth-refreshing calls the same way).
 */
/**
 * Summaries are best-effort: an unconfigured model (or a session whose model
 * registry never arrived) means the feature is OFF, not failing. Those
 * conditions throw this sentinel so every failure path can drop them
 * silently — no log line, no backoff, no pause widget. Config can flip
 * underneath a session at any moment (another pi session rewrites
 * goodies.json on every write), so this must be checked at the failure
 * boundary, not only at the enqueue gates.
 */
function summariesOffError(reason: string): Error {
  const err = new Error(reason);
  err.name = "SummariesOffError";
  return err;
}

function isSummariesOffError(err: unknown): boolean {
  return (err as Error | undefined)?.name === "SummariesOffError";
}

async function resolveSummaryTransport(): Promise<{
  model: Model<Api>;
  label: string;
  apiKey?: string;
  headers?: Record<string, string | null>;
}> {
  const configured = getSummaryModel();
  if (!configured) throw summariesOffError("no summary model configured");
  const registry = summaryModelRegistry;
  if (!registry)
    throw summariesOffError("model registry not captured yet this session");
  const found = findSummaryModel(registry, configured);
  if (!found)
    throw new Error(`summary model "${configured}" not found in registry`);
  const label = `${found.provider}/${found.id}`;
  const auth = await registry.getApiKeyAndHeaders(found);
  if (!auth.ok) throw new Error(`${auth.error} (${label})`);
  const headers =
    auth.headers && Object.keys(auth.headers).length > 0
      ? auth.headers
      : undefined;
  if (!auth.apiKey && !headers)
    throw new Error(`no API key or headers configured (${label})`);
  return { model: found, label, apiKey: auth.apiKey, headers };
}

/** Whether any content block carries non-empty answer text. */
function hasAnswerText(response: {
  content: Array<{ type: string; text?: string }>;
}): boolean {
  return response.content.some(
    (c) => c.type === "text" && (c.text ?? "").trim() !== "",
  );
}

/**
 * Whether a textless response looks like "reasoning consumed the shared
 * completion budget": thinking blocks arrived (their text lives in the
 * `thinking` field, not `text`), or the provider hit the token ceiling
 * before any answer existed. Routers (kilo-auto/free, openrouter/*) make
 * this nondeterministic — every request can land on a different upstream,
 * and thinking upstreams may ignore reasoning-effort hints outright.
 */
function reasoningAteBudget(response: {
  stopReason: string;
  content: Array<{
    type: string;
    text?: string;
    thinking?: string;
    redacted?: boolean;
  }>;
}): boolean {
  if (hasAnswerText(response)) return false;
  if (response.stopReason === "length") return true;
  return response.content.some(
    (c) =>
      c.type === "thinking" &&
      ((c.thinking ?? c.text ?? "").trim() !== "" || c.redacted === true),
  );
}

/**
 * Convert a pi-ai completion response into a summary string or throw the
 * error shape the shared backoff/log/widget path expects. Extracted from
 * summarizeViaProvider so the production error-conversion logic — the code
 * that turns stopReason "aborted"/"error"/empty-content into the Error
 * shapes every failure test depends on — is testable without mocking the
 * wire layer.
 *
 * - "aborted" → AbortError (per-request abort, not a provider failure)
 * - "error"   → Error with the provider's errorMessage (truncated) + label
 * - empty text after reasoning activity → Error naming the eaten budget
 *   (completeSummaryTurn has already retried at a raised cap by this point)
 * - empty text without reasoning activity → the generic thinking-model
 *   diagnosis
 * - anything else → the joined text content
 */
export function convertSummaryResponse(
  response: {
    stopReason: string;
    errorMessage?: string;
    content: Array<{ type: string; text?: string; thinking?: string }>;
  },
  label: string,
): string {
  if (response.stopReason === "aborted") {
    const err = new Error("summary request aborted");
    err.name = "AbortError";
    throw err;
  }
  if (response.stopReason === "error")
    throw new Error(
      `${(response.errorMessage ?? "request failed").slice(0, SUMMARY_ERROR_SNIPPET_CHARS)} (${label})`,
    );
  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  if (!text.trim()) {
    if (reasoningAteBudget(response)) {
      throw new Error(
        `empty summary — ${label} spent the raised token budget on reasoning; try a summary model that can disable thinking`,
      );
    }
    throw new Error(
      `empty summary — is ${label} a thinking model that cannot disable thinking?`,
    );
  }
  return text;
}

function activeBackend(): SummaryBackend {
  return (
    summaryBackendOverride ?? {
      summarize: summarizeViaProvider,
      summarizeThinking: summarizeThinkingViaProvider,
    }
  );
}

// Lowest-effort reasoning, but only where silence is broken — and always the
// model's OWN declared capability, never a hardcoded guess:
//
//  - Non-reasoning models, non-OpenAI adapters (a truthy effort ENABLES
//    thinking there), and models whose map gives "off" a concrete wire
//    value: send nothing. The adapter emits the declared off value itself.
//  - Models with a capability map: request "minimal". completeSimple clamps
//    against the map before anything reaches the wire (pi-ai streamSimple),
//    so the model only ever sees a level it declares, translated to its own
//    dialect word — whether the catalog says low..max, only off+high, or
//    maps minimal to something else entirely.
//  - Map-less models (routers: kilo-auto/free, openrouter/*): there is no
//    translation layer, so the raw word must be one gateways actually
//    document. "minimal" is not — OpenRouter-style wires silently drop it
//    and the random upstream runs its DEFAULT effort, which is exactly the
//    reasoning-eats-the-budget failure. Send the documented floor "low";
//    the raised-cap retry absorbs upstreams that ignore even that.
function summaryReasoning(model: Model<Api>): ThinkingLevel | undefined {
  if (model.api !== "openai-completions" && model.api !== "openai-responses")
    return undefined;
  if (!model.reasoning) return undefined;
  if (typeof model.thinkingLevelMap?.off === "string") return undefined;
  if (model.thinkingLevelMap === undefined) return "low";
  return "minimal";
}

/**
 * Run one summary completion through pi-ai, shared by both summary kinds so
 * the reasoning-effort compatibility retry and the reasoning-budget retry
 * live in exactly one place.
 *
 * Retry 1 — enum compatibility: some OpenAI-compatible endpoints validate
 * reasoning_effort against their own enum and reject "minimal" outright —
 * observed on Command Code (commandcode/poolside/*): 400 invalid_request_error,
 * param:"reasoning_effort", accepted values low|medium|high|xhigh|max. "low"
 * is the floor of every known enum, so retry once there before surfacing the
 * failure; an endpoint that rejects "low" too would pause as before.
 *
 * Retry 2 — reasoning budget: a response with no answer text whose budget
 * went to thinking (thinking blocks present, or a length cutoff) gets one
 * second chance at a raised cap. This is the router case (kilo-auto/free):
 * each request lands on a random pool upstream (DeepSeek, Nemotron, Qwen,
 * ...) that may ignore the effort hint entirely — no dialect word controls
 * another vendor's thinking. The retry clamps the effort to the model's
 * declared floor (never an undeclared word) and raises the cap — the cap is
 * the lever that works regardless of dialect. Models where summaryReasoning
 * sent no effort keep it absent: for non-OpenAI adapters a truthy effort
 * ENABLES thinking. Still empty after this lands as the raised-budget
 * diagnosis in convertSummaryResponse; the outer timeout still bounds the
 * whole turn, so a slow retry degrades to the ordinary retryable-timeout
 * path.
 */
async function completeSummaryTurn(
  t: Awaited<ReturnType<typeof resolveSummaryTransport>>,
  context: Parameters<typeof completeSimple>[1],
  signal: AbortSignal,
): Promise<AssistantMessage> {
  const firstEffort = summaryReasoning(t.model);
  const options = (
    reasoning: ThinkingLevel | undefined,
    maxTokens: number = SUMMARY_MAX_TOKENS,
  ) => ({
    apiKey: t.apiKey,
    headers: t.headers,
    maxTokens,
    signal,
    reasoning,
  });
  // completeSimple does NOT throw for HTTP errors — it returns an
  // AssistantMessage with stopReason:"error" + errorMessage, so the
  // compatibility check inspects the response, not a catch block.
  let response = await completeSimple(t.model, context, options(firstEffort));
  if (
    response.stopReason === "error" &&
    (response.errorMessage ?? "").includes("reasoning_effort")
  ) {
    response = await completeSimple(t.model, context, options("low"));
  }
  if (reasoningAteBudget(response)) {
    logGoodiesEvent({
      type: "summary_reasoning_retry",
      model: t.label,
      // The upstream a router actually picked — the response's own model
      // field is the only way to know who ate the budget.
      ...(response.responseModel
        ? { responseModel: response.responseModel }
        : {}),
    });
    response = await completeSimple(
      t.model,
      context,
      options(
        firstEffort === undefined
          ? undefined
          : (clampThinkingLevel(t.model, "low") as ThinkingLevel),
        SUMMARY_REASONING_RETRY_MAX_TOKENS,
      ),
    );
  }
  return response;
}

// Summaries are best-effort polish over the heuristic hint, but failures must
// not be silent: every request lands in the structured log with its outcome,
// so request volume and a broken provider/key/model choice are queryable
// instead of a black box. The backend messages embed the model label so three
// plausible providers don't mean guessing which failed.

/**
 * Produce a log-safe reference to a shell command without persisting its raw
 * text. The raw command can carry inline tokens, passwords, private URLs, and
 * personal data — `cmd.slice(0, 200)` leaked all of that into the durable
 * goodies.log for every request, successful or failed. Instead we record a
 * short non-reversible digest (FNV-1a, 32-bit, hex) plus the command length:
 * the digest lets log entries for the same command be correlated, and the
 * length hints at scale, but neither reveals the content.
 */
function redactCommandForLog(cmd: string): { digest: string; len: number } {
  // FNV-1a 32-bit: cheap, non-cryptographic, good enough for log correlation.
  let hash = 0x811c9dc5;
  for (let i = 0; i < cmd.length; i++) {
    hash ^= cmd.charCodeAt(i);
    // Math.imul keeps the 32-bit multiply semantics on the full int range.
    hash = Math.imul(hash, 0x01000193);
  }
  // Force unsigned 32-bit and pad to 8 hex chars.
  const digest = (hash >>> 0).toString(16).padStart(8, "0");
  return { digest, len: cmd.length };
}

function logSummaryFailure(
  cmd: string,
  err: unknown,
  pauseMs?: number,
  ms?: number,
  attempt?: number,
  kind: "bash" | "thinking" = "bash",
) {
  const msg = describeError(err);
  const pause = pauseMs
    ? `; pausing summaries ${Math.round(pauseMs / 1000)}s`
    : "";
  logGoodiesEvent({
    type: "summary_request",
    outcome: "failed",
    kind,
    ...(ms === undefined ? {} : { ms }),
    error: msg.slice(0, 300),
    ...(pauseMs ? { pauseMs } : {}),
    ...(attempt && attempt > 1 ? { attempt } : {}),
    ...redactCommandForLog(cmd),
  });
  // TUI: widget above the editor shows the pause state and clears on
  // recovery. Headless: a short console line (no UI to attach a widget to).
  const short = msg.length > 120 ? `${msg.slice(0, 120)}…` : msg;
  if (summaryUi?.hasUI) {
    showSummaryPauseWidget(short, pauseMs);
  } else {
    console.error(
      `[clean-tui] summary failed (${short})${pause}; details in ~/.pi/agent/goodies.log`,
    );
  }
}

// ── Summary log events ──────────────────────────────────────
//
// console.error is invisible in TUI mode (pi owns the terminal), so everything
// durable goes to the shared JSONL log (goodies-log.ts): one summary_request
// event per attempt — success or failure — so request volume per bash call is
// queryable, plus load/kilo/config events from the rest of the package.

/** Redirect the failure log (tests point this at scratch storage). */
export function __setSummaryLogPathForTesting(path?: string): void {
  setGoodiesLogPathForTesting(path);
}

// Failure backoff: requestSummary runs on every bash renderCall, so after a
// rate-limit (429) each re-render would immediately re-fire the request and
// keep the limiter hot forever. A failure pauses ALL summary requests for a
// doubling cooldown (capped); an explicit Retry-After hint wins over the
// computed delay; the next success resets the streak.
// (The hint arrives as err.retryAfterMs. Today the default provider backend
// cannot produce one — pi-ai surfaces 429s as stopReason:"error" text without
// structured headers — but seam backends may, so the override stays live.)
const SUMMARY_BACKOFF_BASE_MS = 30_000;
const SUMMARY_BACKOFF_CAP_MS = 15 * 60_000;
let summaryBackoffBaseMs = SUMMARY_BACKOFF_BASE_MS;
let summaryBackoffCapMs = SUMMARY_BACKOFF_CAP_MS;
let summaryFailStreak = 0;
let summaryBlockedUntil = 0;

export function __setSummaryBackoffForTesting(
  baseMs: number,
  capMs: number,
): void {
  summaryBackoffBaseMs = baseMs;
  summaryBackoffCapMs = capMs;
}

function noteSummaryFailure(err: unknown): number {
  summaryFailStreak++;
  const backoff = Math.min(
    summaryBackoffBaseMs * 2 ** (summaryFailStreak - 1),
    summaryBackoffCapMs,
  );
  const retryAfter = (err as { retryAfterMs?: unknown }).retryAfterMs;
  const delay = Math.min(
    summaryBackoffCapMs,
    Math.max(backoff, typeof retryAfter === "number" ? retryAfter : 0),
  );
  summaryBlockedUntil = Date.now() + delay;
  return delay;
}

function requestSummary(cmd: string): void {
  // Deferred requests drain here too: renderCalls are the heartbeat that
  // notices backoff expiry when nothing else is in flight.
  drainSummaryQueue();
  // Guard order matters: renderCall fires on every rerender, so all guards
  // here are cheap sync checks, and anything that can differ across rerenders
  // of the same command must not mutate state (mutating in a render path once
  // caused infinite invalidate loops).
  if (
    !summaryEnabled ||
    replaying ||
    !isSummarizable(cmd) ||
    !getSummaryModel() || // unset = feature off: no resolution, no network.
    summaryCache.has(cmd)
  )
    return;
  // Stamp before any deferral: a row whose result lands while its summary is
  // queued or in flight may still swap when the summary arrives (see
  // invalidateRowsForCommand) — at landing such rows are at most one summary
  // latency old, so they sit at the viewport tail.
  stampSummaryRequested(cmd);
  if (pendingSummaries.has(cmd) || summaryRequestQueue.includes(cmd)) return;
  if (
    Date.now() < summaryBlockedUntil ||
    pendingSummaries.size >= SUMMARY_MAX_INFLIGHT
  ) {
    // Defer, don't drop: a burst of N commands renders faster than summaries
    // complete, and a dropped request would never retry (its row may not
    // re-render). Drained on settle and on later renderCalls.
    summaryRequestQueue.push(cmd);
    return;
  }
  startSummaryRequest(cmd);
}

function startSummaryRequest(cmd: string): void {
  pendingSummaries.add(cmd);
  const requestStartedAt = Date.now();
  const signal = summarySessionAbort.signal;
  summarizeWithRetries({
    redact: redactCommandForLog(cmd),
    kind: "bash",
    request: (attemptSignal) => activeBackend().summarize(cmd, attemptSignal),
    signal,
  })
    .then((result) => {
      if (result.ok) {
        // Abort check MUST precede any shared-state mutation: a stale promise
        // settling after a session switch would otherwise delete the marker of
        // a newer request for the same command (session_start already cleared
        // the set, so the abandoned branch needs no cleanup).
        if (signal.aborted) return;
        pendingSummaries.delete(cmd);
        summaryFailStreak = 0;
        summaryBlockedUntil = 0;
        summaryCache.set(cmd, normalizeSummary(result.text));
        logGoodiesEvent({
          type: "summary_request",
          outcome: "ok",
          kind: "bash",
          ms: Date.now() - requestStartedAt,
          ...(result.attempts > 1 ? { attempt: result.attempts } : {}),
          ...redactCommandForLog(cmd),
        });
        clearSummaryPauseWidget();
        invalidateRowsForCommand(cmd);
        return;
      }
      // Always free the slot when the request settled, unless the session
      // itself was aborted (session_start clears pendingSummaries via .clear()).
      // The success-path guard alone would leave a per-request AbortError (not
      // a session switch) in pendingSummaries forever, permanently burning a
      // concurrency slot with zero log output.
      if (!signal.aborted) pendingSummaries.delete(cmd);
      // Switching sessions aborts in-flight summaries deliberately: that is
      // not a provider failure — neither penalize nor log it. Same for the
      // feature being switched off underneath the request (config rewrite by
      // another session): drop silently, no backoff, no pause widget.
      if (
        signal.aborted ||
        (result.err as Error)?.name === "AbortError" ||
        isSummariesOffError(result.err)
      )
        return;
      const pauseMs = noteSummaryFailure(result.err);
      logSummaryFailure(
        cmd,
        result.err,
        pauseMs,
        Date.now() - requestStartedAt,
        result.attempts,
      );
    })
    .finally(() => {
      if (!signal.aborted) drainSummaryQueue();
    });
}

/** One summarizeWithRetries outcome: either the raw text, or the error. */
type SummaryJobResult =
  | { ok: true; text: string; attempts: number }
  | { ok: false; err: unknown; attempts: number };

/**
 * Timeout + retry ladder shared by every summary request (bash commands and
 * live thinking runs alike). One AbortController per attempt so a timeout
 * actually cancels that attempt's HTTP request instead of only stopping the
 * wait — and so a retry starts from a fresh, unaborted controller. Each
 * attempt chains itself to the session signal; a session switch aborts all
 * of them. Transient failures (upstream 5xx, stalls, network blips) get up
 * to three quick second chances with progressive delays before the caller's
 * failure handling (backoff, pause widget) engages. Intermediate failures
 * are logged per attempt; the caller logs the final outcome.
 */
async function summarizeWithRetries(job: {
  /** Log-safe reference for the per-attempt failure events. */
  redact: { digest: string; len: number };
  /** Which feature fired the request — lands in the structured log. */
  kind: "bash" | "thinking";
  /** One attempt: an abort-aware provider (or test-backend) call. */
  request: (signal: AbortSignal) => Promise<string>;
  /** Session signal; aborts every attempt and skips retry delays. */
  signal: AbortSignal;
}): Promise<SummaryJobResult> {
  const { redact, kind, request, signal } = job;
  const summarizeOnce = (): Promise<string> => {
    const controller = new AbortController();
    const onSessionAbort = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onSessionAbort, { once: true });
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        controller.abort();
        reject(
          new Error(
            `summary request timed out after ${
              summaryRequestTimeoutMs < 1000
                ? `${summaryRequestTimeoutMs}ms`
                : `${Math.round(summaryRequestTimeoutMs / 1000)}s`
            }`,
          ),
        );
      }, summaryRequestTimeoutMs);
    });
    timeoutTimer?.unref?.();
    const requestPromise = request(controller.signal);
    // The race below decides the outcome; the underlying promise may settle
    // later (timeout won) — swallow its late rejection so it never becomes
    // unhandled. Late landings are dropped; the queue retries after backoff.
    requestPromise.catch(() => {});
    return Promise.race([requestPromise, timeout]).finally(() => {
      clearTimeout(timeoutTimer);
      signal.removeEventListener("abort", onSessionAbort);
    });
  };

  let lastErr: unknown;
  const maxAttempts = summaryRetryDelaysMs.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      // Progressive pause: delays[0] before attempt 2, delays[1] before
      // attempt 3, and so on. Abort-aware: a session switch during the
      // delay must skip the next attempt.
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(
          () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          },
          summaryRetryDelaysMs[attempt - 2] ?? 0,
        );
        timer.unref?.();
        signal.addEventListener("abort", onAbort, { once: true });
      });
      if (signal.aborted) return { ok: false, err: lastErr, attempts: attempt };
    }
    const attemptStartedAt = Date.now();
    try {
      return { ok: true, text: await summarizeOnce(), attempts: attempt };
    } catch (err) {
      lastErr = err;
      if (
        signal.aborted ||
        (err as Error)?.name === "AbortError" ||
        attempt === maxAttempts ||
        !isRetryableSummaryError(err)
      ) {
        return { ok: false, err, attempts: attempt };
      }
      // Intermediate attempt: log it (attempt-numbered) but neither pause
      // nor alarm — the retry owns recovery; backoff and the pause widget
      // engage only when retries are exhausted. A retry holds its
      // concurrency slot for the whole cycle, which bounds queue waits.
      logGoodiesEvent({
        type: "summary_request",
        outcome: "failed",
        kind,
        attempt,
        ms: Date.now() - attemptStartedAt,
        error: describeError(err).slice(0, 300),
        ...redact,
      });
    }
  }
  /* unreachable — the loop returns on its final attempt */
  return { ok: false, err: lastErr, attempts: maxAttempts };
}

/** Start queued requests while capacity allows and no backoff is active. */
function drainSummaryQueue(): void {
  // The feature can be switched off between enqueue and drain — config is
  // re-read from disk on every write and any pi session can rewrite it. Off
  // means off: drop the deferred requests instead of draining them into
  // requests that resolveSummaryTransport can only refuse.
  if (!getSummaryModel()) {
    summaryRequestQueue.length = 0;
    return;
  }
  while (
    summaryRequestQueue.length > 0 &&
    pendingSummaries.size < SUMMARY_MAX_INFLIGHT &&
    Date.now() >= summaryBlockedUntil
  ) {
    const cmd = summaryRequestQueue.shift()!;
    if (summaryCache.has(cmd) || pendingSummaries.has(cmd)) continue;
    startSummaryRequest(cmd);
  }
}

function stampSummaryRequested(cmd: string): void {
  const now = Date.now();
  for (const e of entries) {
    if (e.args?.command === cmd && e.summaryRequestedAt === undefined)
      e.summaryRequestedAt = now;
  }
}

function invalidateRowsForCommand(cmd: string): void {
  // Refresh rows that are STILL EXECUTING, plus rows that finished while
  // their summary was in flight — at landing those are at most one summary
  // latency old, so they sit at the viewport tail and a differential
  // re-render is safe. This is what makes fast commands (finished before the
  // ~2s summary arrives) visibly summarize at all. Older finished rows —
  // including replayed ones from before a /resume — keep the raw command
  // text: they can sit far above the viewport on a long transcript, and pi's
  // diff renderer answers any change above the viewport with fullRender(true):
  // clear screen + scrollback wipe + full repaint, i.e. the "flicker while pi
  // is working" seen on 0.11.x. The summary stays cached either way, and
  // future rows of the same command render it from the start.
  for (const e of entries) {
    if (e.args?.command !== cmd) continue;
    const finishedDuringFlight =
      e.resultAt !== undefined &&
      e.summaryRequestedAt !== undefined &&
      e.resultAt >= e.summaryRequestedAt &&
      // Strictly younger than the window: a zero window must admit nothing,
      // and stamp/result often land in the same millisecond in tests.
      Date.now() - e.resultAt < summarySwapMaxAgeMs;
    if (!e.result || finishedDuringFlight) {
      const fn = invalidateById.get(e.toolCallId);
      if (fn) fn();
    }
  }
}

// Bounds how long after finishing a row may still swap. Covers the normal
// race (summary lands ~2s after start, row finished ≤2s ago) with margin;
// backoff-delayed landings (30s+) exceed it and correctly keep raw text,
// since such rows may have scrolled above the viewport.
const SUMMARY_SWAP_MAX_AGE_MS = 10_000;
let summarySwapMaxAgeMs = SUMMARY_SWAP_MAX_AGE_MS;

export function __setSummarySwapMaxAgeForTesting(ms: number): void {
  summarySwapMaxAgeMs = ms;
}

// ── Live thinking summaries (widget above the editor) ──────────
//
// While the model streams a thinking run, pi's TUI (with
// hideThinkingBlock) renders one static italic "Thinking..." row per run.
// The only seam to change that text, ctx.ui.setHiddenThinkingLabel, is a
// single GLOBAL string pushed to every assistant message component —
// updating it mid-stream rewrites every past thinking row, and in regular
// tuiMode any rendered change above the viewport top makes pi's diff
// renderer fullRender(true): clear screen + scrollback wipe + repaint (see
// the render-safety rules above; that is the 0.11.x flash class). So the
// live summary instead renders as a widget line above the editor — the
// same always-at-the-tail seam the pause indicator uses — and only while a
// thinking run is actually streaming.
const THINKING_WIDGET_KEY = "bermudis-pi-goodies.thinking";
// Below this the run says as much as a summary would; also keeps OpenAI's
// empty reasoning items (no text at all) from ever costing a request.
const THINKING_SUMMARY_MIN_CHARS = 400;
// One request per run at most every 5s: the widget is polish, not telemetry.
const THINKING_SUMMARY_INTERVAL_MS = 5_000;
// And only when the run actually moved — the natural rate tracks how much
// the model is thinking instead of the clock.
const THINKING_SUMMARY_GROWTH_CHARS = 400;
let thinkingMinChars = THINKING_SUMMARY_MIN_CHARS;
let thinkingIntervalMs = THINKING_SUMMARY_INTERVAL_MS;
let thinkingGrowthChars = THINKING_SUMMARY_GROWTH_CHARS;

export function __setThinkingThresholdsForTesting(opts?: {
  minChars?: number;
  growthChars?: number;
  intervalMs?: number;
}): void {
  thinkingMinChars = opts?.minChars ?? THINKING_SUMMARY_MIN_CHARS;
  thinkingIntervalMs = opts?.intervalMs ?? THINKING_SUMMARY_INTERVAL_MS;
  thinkingGrowthChars = opts?.growthChars ?? THINKING_SUMMARY_GROWTH_CHARS;
}

type ThinkingRun = {
  /**
   * First block of the trailing thinking run. Content blocks are stable
   * object references across a message's message_update events (the burst
   * boundary scanner relies on the same fact), so this identifies the run
   * cheaply while it grows at the tail.
   */
  head: object;
  /** Full run length when the last request fired (throttle bookkeeping). */
  requestedLen: number;
  /** When it fired. */
  requestedAt: number;
};
let thinkingRun: ThinkingRun | undefined;
// Global monotonic request counter: a landing applies to the widget only if
// it is the newest request AND its run is still the active one.
let thinkingSeqCounter = 0;
let thinkingLandedSeq = 0;
let thinkingInflight = false;
let thinkingWidgetShown = false;

export function __resetThinkingSummariesForTesting(): void {
  resetThinkingState();
}

function resetThinkingState(): void {
  // Clear through the current handle first (session_start replaces it right
  // after); the try/catch inside covers a handle that already went stale.
  clearThinkingWidget();
  thinkingRun = undefined;
  thinkingLandedSeq = 0;
  thinkingInflight = false;
}

function setThinkingWidget(summary: string): void {
  if (!summaryUi?.hasUI) return;
  // No length cut: the full summary shows, even if it wraps on narrow
  // terminals. Styled exactly like pi's own hidden-thinking row — italic
  // thinkingText — with a leading ellipsis so it reads as continuing
  // thought, never as assistant prose. A plain string[] widget renders as
  // default body text (white), which is why bare summaries cosplayed as
  // assistant messages.
  const line = `\u2026 ${summary}`;
  summaryUi.setWidget(
    THINKING_WIDGET_KEY,
    (_tui, theme) =>
      new Text(theme.italic(theme.fg("thinkingText", line)), 0, 0),
  );
  thinkingWidgetShown = true;
}

function clearThinkingWidget(): void {
  if (!thinkingWidgetShown) return;
  thinkingWidgetShown = false;
  try {
    summaryUi?.setWidget(THINKING_WIDGET_KEY, undefined);
  } catch {
    // A stale UI handle across a session switch must not break the request
    // path — the next landing re-shows the widget with a fresh handle.
  }
}

/** Drop run tracking (new assistant message, settled turn, session switch). */
function resetThinkingRun(): void {
  thinkingRun = undefined;
  clearThinkingWidget();
}

/**
 * Track the trailing thinking run of the streaming assistant message and
 * maybe fire a summary request for it. Runs on every message_update — walks
 * the content from the end, so the cost is bounded by the trailing run, not
 * the whole message.
 */
function trackThinkingStream(message: any): void {
  const content = message?.content;
  if (!Array.isArray(content)) return;
  let i = content.length;
  while (i > 0 && content[i - 1]?.type === "thinking") i--;
  if (i === content.length) {
    // No trailing thinking block: the run closed (text or a tool call
    // streamed after it). Its summary would describe stale activity —
    // the tool row that follows says what is happening now.
    resetThinkingRun();
    return;
  }
  const head = content[i] as object;
  if (thinkingRun?.head !== head) {
    // New run (first one, or a later run after this message moved on to
    // text/tools and back to thinking). Fresh throttle window.
    thinkingRun = { head, requestedLen: 0, requestedAt: 0 };
    clearThinkingWidget();
  }
  const text = (content.slice(i) as Array<{ thinking?: string }>)
    .map((b) => b.thinking ?? "")
    .join("");
  maybeRequestThinkingSummary(text);
}

function maybeRequestThinkingSummary(text: string): void {
  const run = thinkingRun;
  if (!run) return;
  if (
    !summaryEnabled ||
    replaying ||
    !getThinkingSummariesEnabled() || // separate opt-in: recurring requests
    !getSummaryModel() || // unset = summaries off entirely
    !summaryUi?.hasUI // headless has no widget to show
  )
    return;
  const backend = activeBackend();
  if (typeof backend.summarizeThinking !== "function") return;
  if (thinkingInflight || Date.now() < summaryBlockedUntil) return;
  if (text.length < thinkingMinChars) return;
  if (
    run.requestedLen > 0 &&
    (Date.now() - run.requestedAt < thinkingIntervalMs ||
      text.length - run.requestedLen < thinkingGrowthChars)
  )
    return;
  run.requestedLen = text.length;
  run.requestedAt = Date.now();
  const seq = ++thinkingSeqCounter;
  const head = run.head;
  thinkingInflight = true;
  const signal = summarySessionAbort.signal;
  const requestStartedAt = Date.now();
  summarizeWithRetries({
    redact: redactCommandForLog(text),
    kind: "thinking",
    request: (attemptSignal) =>
      backend.summarizeThinking!(text.slice(-2000), attemptSignal),
    signal,
  })
    .then((result) => {
      if (result.ok) {
        if (signal.aborted) return;
        // Provider health is shared with bash summaries: one provider, one
        // recovery signal, one pause widget.
        summaryFailStreak = 0;
        summaryBlockedUntil = 0;
        logGoodiesEvent({
          type: "summary_request",
          outcome: "ok",
          kind: "thinking",
          ms: Date.now() - requestStartedAt,
          ...(result.attempts > 1 ? { attempt: result.attempts } : {}),
          ...redactCommandForLog(text),
        });
        clearSummaryPauseWidget();
        // Stale landings stay silent: the run moved on (or closed) while this
        // request was in flight, or a newer request already updated the line.
        if (thinkingRun?.head === head && seq > thinkingLandedSeq) {
          thinkingLandedSeq = seq;
          setThinkingWidget(normalizeSummary(result.text));
        }
        return;
      }
      if (
        !signal.aborted &&
        (result.err as Error)?.name !== "AbortError" &&
        !isSummariesOffError(result.err)
      ) {
        const pauseMs = noteSummaryFailure(result.err);
        logSummaryFailure(
          text,
          result.err,
          pauseMs,
          Date.now() - requestStartedAt,
          result.attempts,
          "thinking",
        );
      }
    })
    .finally(() => {
      if (!signal.aborted) thinkingInflight = false;
    });
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

/** While set, sibling extension tools in this package render in burst style
 *  (same contract @bermudi/pi-codex mirrors via Symbol.for). Set at load,
 *  cleared when the feature is disabled, so /reload converges. Consumers must
 *  read it at registration time — rendering never happens before all
 *  extensions load. */
export function isCleanTuiActive(): boolean {
  return (globalThis as Record<symbol, unknown>)[CLEAN_TUI_ACTIVE] === true;
}

/** Format spec for a burst-style tool. The shared skeleton below carries the
 *  grouped/solo/pending/error rules once for every tool that uses it. */
export type BurstToolSpec = {
  name: string;
  /** Required when registering via registerBurstTool (built-in override);
   *  createBurstRenderer ignores these — the tool keeps its own definition. */
  description?: any;
  parameters?: any;
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

/** The shared burst render hooks (renderShell + renderCall + renderResult),
 *  split out of registerBurstTool so extension-owned tools in this package
 *  (vision) can attach the identical skeleton to their own registration —
 *  one implementation of the grouped/solo/pending/error rules, no copy. */
export function createBurstRenderer(spec: BurstToolSpec): {
  renderShell: "self";
  renderCall: (args: any, theme: any, ctx: any) => any;
  renderResult: (result: any, _opts: any, _theme: any, ctx: any) => Container;
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
      const pending = isGrouped
        ? burst.entries.some((e) => !e.result)
        : !entry.result;
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
        header += `\n${burst.entries.map((e) => spec.bullet(e, theme)).join("\n")}`;
        if (ctx.expanded) {
          const details = spec.groupedDetails(burst.entries, theme);
          if (details) header += details;
        }
        return makeBox(theme, pending, isError, header);
      }

      // solo
      let line = spec.soloHeader(args, theme, ctx);
      if (ctx.expanded) {
        const extra = spec.soloExpanded(entry, args, theme);
        if (extra) line += `\n${extra}`;
      }
      return makeBox(theme, pending, isError, line);
    },
    renderResult(result: any, _opts: any, _theme: any, ctx: any) {
      recordResult(entryById.get(ctx.toolCallId), result, ctx);
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
 * Command display: first line only, hard-capped, plus a muted "(+N lines)"
 * hint for heredocs/multi-line commands. Full command stays available via
 * expand — a 30-line heredoc must not cost 30 rows of transcript.
 */
function formatBashCommand(cmd: string, theme: any, cap: number): string {
  const nl = cmd.indexOf("\n");
  let head = nl === -1 ? cmd : cmd.slice(0, nl);
  if (head.length > cap) head = head.slice(0, cap - 1) + "…";
  let out = theme.fg("accent", head);
  if (nl !== -1) {
    const extra = cmd.split("\n").length - 1;
    out += theme.fg("muted", ` (+${extra} line${extra === 1 ? "" : "s"})`);
  }
  return out;
}

// Display width a bullet's command text may occupy before ellipsizing:
// 99 characters plus the ellipsis itself.
const BASH_BULLET_WIDTH = 100;

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
  // height-neutral at 110 columns"). Wherever the capped raw line fits on
  // one terminal row, the swap keeps or adds rows.
  return formatBashCommand(cmd, theme, BASH_BULLET_WIDTH);
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
  if (head.length > BASH_BULLET_WIDTH)
    head = head.slice(0, BASH_BULLET_WIDTH - 1) + "…";
  let out = `  ${bullet}${accent(head)}`;
  if (nl !== -1) {
    const extra = cmd.split("\n").length - 1;
    out += theme.fg("muted", ` (+${extra} line${extra === 1 ? "" : "s"})`);
  }
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
      summaryModelRegistry = (ctx as { modelRegistry?: SummaryModelRegistry })
        .modelRegistry;
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
  });
  pi.on("session_start", (_event, ctx) => {
    liveSeg = 0;
    curAssistantBoundaries = new Set();
    curAssistantMessage = undefined;
    replaying = true;
    entries.length = 0;
    entryById.clear();
    invalidateById.clear();
    pendingSummaries.clear();
    summaryRequestQueue.length = 0;
    // Thinking widget + run tracking belong to the previous session; the
    // session abort below cancels any in-flight summary request.
    resetThinkingState();
    // Capture the UI handle for the pause widget (guarded: harness stubs and
    // limited contexts lack setWidget), and drop any stale pause indicator
    // left over from the previous session. hasUI comes from the context —
    // ctx.ui carries no such flag, so storing ctx.ui directly left hasUI
    // undefined and every TUI failure took the console.error branch, flashing
    // raw stderr across the terminal; the widget never showed.
    const ui = (ctx as { ui?: Partial<SummaryUi> } | undefined)?.ui;
    const setWidget = ui?.setWidget;
    if (typeof setWidget === "function") {
      summaryUi = {
        hasUI: ctx.hasUI,
        setWidget: (key, content) => setWidget(key, content),
      };
    }
    clearSummaryPauseWidget();
    // Capture the registry slice render context lacks, and cut off any
    // summaries still in flight from the previous session.
    const modelRegistry = (
      ctx as { modelRegistry?: SummaryModelRegistry } | undefined
    )?.modelRegistry;
    if (modelRegistry) summaryModelRegistry = modelRegistry;
    summarySessionAbort.abort();
    summarySessionAbort = new AbortController();
    // Replayed history fires no events: rebuild segment boundaries from the
    // branch with one segment per boundary block, mirroring the live rule.
    // Scanning content in order handles thinking interleaved between tool
    // calls (OpenAI Responses reasoning items). Calls not present in the
    // branch (defensive) get NaN and render solo.
    replaySegByToolCallId.clear();
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
  function registerBurstTool(spec: BurstToolSpec): void {
    pi.registerTool({
      name: spec.name,
      label: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      ...createBurstRenderer(spec),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const tool = (getBuiltInTools(ctx.cwd) as any)[spec.name];
        return tool.execute(toolCallId, params, signal, onUpdate);
      },
    });
  }

  // ── read ──────────────────────────────────────────────────────
  registerBurstTool({
    name: "read",
    description: schemaTools.read.description,
    parameters: schemaTools.read.parameters,
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
        const preview = txt
          .split("\n")
          .slice(0, 12)
          .map((l) => theme.fg("toolOutput", l))
          .join("\n");
        const remaining = txt.split("\n").length - 12;
        let block = `\n${theme.fg("muted", `— ${shortenPath(e.args.path || "...")}`)}:\n${preview}`;
        if (remaining > 0)
          block += `\n${theme.fg("muted", `... ${remaining} more lines`)}`;
        details.push(block);
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
    description: schemaTools.bash.description,
    parameters: schemaTools.bash.parameters,
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
        const preview = txt
          .split("\n")
          .slice(0, 12)
          .map((l) => theme.fg("toolOutput", l))
          .join("\n");
        details.push(`\n${theme.fg("muted", `— $ ${cmd}`)}:\n${preview}`);
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
    description: schemaTools.write.description,
    parameters: schemaTools.write.parameters,
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
    description: schemaTools.edit.description,
    parameters: schemaTools.edit.parameters,
    bullet: formatEditBullet,
    groupedDetails(entries, theme) {
      return entries
        .map((e) => {
          const txt = e.result ? resultText(e.result as any) : undefined;
          return txt
            ? `\n${theme.fg("muted", `— ${shortenPath(e.args.path || "...")}`)}:\n${theme.fg("toolOutput", txt.slice(0, 600))}`
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
    description: schemaTools.find.description,
    parameters: schemaTools.find.parameters,
    bullet: formatFindBullet,
    groupedDetails(entries, theme) {
      return entries
        .map((e) => {
          const txt = e.result
            ? resultText(e.result as any)?.trim()
            : undefined;
          return txt
            ? `\n${theme.fg("muted", `— ${e.args.pattern}`)}:\n${txt
                .split("\n")
                .slice(0, 10)
                .map((l) => theme.fg("toolOutput", l))
                .join("\n")}`
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
    description: schemaTools.grep.description,
    parameters: schemaTools.grep.parameters,
    bullet: formatGrepBullet,
    groupedDetails(entries, theme) {
      return entries
        .map((e) => {
          const txt = e.result
            ? resultText(e.result as any)?.trim()
            : undefined;
          return txt
            ? `\n${theme.fg("muted", `— /${e.args.pattern}/`)}:\n${txt
                .split("\n")
                .slice(0, 10)
                .map((l) => theme.fg("toolOutput", l))
                .join("\n")}`
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
    description: schemaTools.ls.description,
    parameters: schemaTools.ls.parameters,
    bullet: formatLsBullet,
    groupedDetails(entries, theme) {
      return entries
        .map((e) => {
          const txt = e.result
            ? resultText(e.result as any)?.trim()
            : undefined;
          return txt
            ? `\n${theme.fg("muted", `— ${shortenPath(e.args.path || ".")}`)}:\n${txt
                .split("\n")
                .slice(0, 10)
                .map((l) => theme.fg("toolOutput", l))
                .join("\n")}`
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
}
