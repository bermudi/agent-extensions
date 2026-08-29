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
 * Textless assistant messages (only thinking + tool calls — the shape models
 * emit when they call tools one at a time) do NOT close the burst: no prose
 * separates their calls from the previous ones, so back-to-back same-tool
 * calls chain into one block until real text appears. Typed user messages
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
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { logGoodiesEvent, setGoodiesLogPathForTesting } from "./goodies-log.ts";
import { describeError } from "./json-file.ts";
import {
  findSummaryModel,
  getSummaryModel,
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

function shortenPath(path: string): string {
  const home = homedir();
  if (path.startsWith(home)) return `~${path.slice(home.length)}`;
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
   * Visible-prose boundary: live entries count up (bumped when visible text
   * appears — assistant text block or typed user message); replayed entries
   * count down (one per prose boundary in the restored branch). NaN = unknown
   * lineage — never groups. Calls with no prose between them share a segment.
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
/** Whether the assistant message currently streaming has shown visible text. */
let curAssistantTextSeen = false;
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
    e = {
      toolCallId,
      toolName,
      args,
      seg: replaying ? (replaySegByToolCallId.get(toolCallId) ?? NaN) : liveSeg,
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
 * A message shows visible prose when it has a non-empty text block. Thinking
 * blocks and tool calls don't count — they render as placeholders/rows, not
 * prose, and must not close a burst.
 */
function hasVisibleText(message: any): boolean {
  return (message?.content ?? []).some(
    (b: any) =>
      b?.type === "text" &&
      typeof b.text === "string" &&
      b.text.trim().length > 0,
  );
}

function shouldGroup(a: Entry, b: Entry): boolean {
  // Grouping is by adjacency + same tool with no visible prose in between.
  // A message's tools execute after its own prose and before the next message
  // streams, so the segment counter (bumped when visible text appears) splits
  // bursts exactly where the conversation visually splits. Textless messages
  // never bump it, so a model calling tools one-per-message still chains into
  // a single block. Live segments count up, replay segments count down — the
  // two domains can never merge. NaN (unknown lineage) compares unequal to
  // everything, so those rows render solo.
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
const SUMMARY_MAX_TOKENS = 512;
const SUMMARY_PROMPT =
  "Summarize this shell command in less than 13 words, plain English, no quotes, no formatting. " +
  'Examples: "cat >> file << \'EOF\' with 20 lines of log" -> "Appends reboot log to migration file". ' +
  "Command:\n";
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
  setWidget(key: string, content: string[] | undefined): void;
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
    .trim()
    .slice(0, SUMMARY_THRESHOLD_CHARS);
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
  const configured = getSummaryModel();
  if (!configured) throw new Error("no summary model configured");
  const registry = summaryModelRegistry;
  if (!registry)
    throw new Error("model registry not captured yet this session");
  const found = findSummaryModel(registry, configured);
  if (!found)
    throw new Error(`summary model "${configured}" not found in registry`);
  const label = `${found.provider}/${found.id}`;
  // getApiKeyAndHeaders resolves env keys, models.json auth, and refreshes
  // OAuth tokens — the one thing a raw endpoint could never do. Safe to call
  // fire-and-forget (pi-codex makes OAuth-refreshing calls the same way).
  const auth = await registry.getApiKeyAndHeaders(found);
  if (!auth.ok) throw new Error(`${auth.error} (${label})`);
  const headers =
    auth.headers && Object.keys(auth.headers).length > 0
      ? auth.headers
      : undefined;
  if (!auth.apiKey && !headers)
    throw new Error(`no API key or headers configured (${label})`);
  const response = await completeSimple(
    found,
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
    {
      apiKey: auth.apiKey,
      headers,
      maxTokens: SUMMARY_MAX_TOKENS,
      signal,
      reasoning: summaryReasoning(found),
    },
  );
  return convertSummaryResponse(response, label);
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
 * - empty text content → Error diagnosing a thinking-model that ate the budget
 * - anything else → the joined text content
 */
export function convertSummaryResponse(
  response: {
    stopReason: string;
    errorMessage?: string;
    content: Array<{ type: string; text?: string }>;
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
  if (!text.trim())
    throw new Error(
      `empty summary — is ${label} a thinking model that cannot disable thinking?`,
    );
  return text;
}

function activeBackend(): SummaryBackend {
  return summaryBackendOverride ?? { summarize: summarizeViaProvider };
}

// Lowest-effort reasoning, but only where silence is broken: on OpenAI-
// compatible endpoints a reasoning model with no mapped "off" (Groq's
// gpt-oss maps off and minimal to null) runs its API-default effort when no
// reasoning parameter is sent — medium for gpt-oss — which burns the shared
// completion budget and returns an empty answer. "minimal" clamps to the
// model's lowest supported level ("low" for gpt-oss). Everything else keeps
// the absent option: non-reasoning models clamp to "off" (no parameter),
// models whose catalog maps "off" to a concrete value already disable
// thinking when nothing is sent, and non-OpenAI adapters enable thinking on
// truthy values (see the retired no-reasoning note in git history).
function summaryReasoning(model: Model<Api>): ThinkingLevel | undefined {
  if (model.api !== "openai-completions" && model.api !== "openai-responses")
    return undefined;
  if (!model.reasoning) return undefined;
  if (typeof model.thinkingLevelMap?.off === "string") return undefined;
  return "minimal";
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
) {
  const msg = describeError(err);
  const pause = pauseMs
    ? `; pausing summaries ${Math.round(pauseMs / 1000)}s`
    : "";
  logGoodiesEvent({
    type: "summary_request",
    outcome: "failed",
    ...(ms === undefined ? {} : { ms }),
    error: msg.slice(0, 300),
    ...(pauseMs ? { pauseMs } : {}),
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
  // Per-request controller so a timeout actually cancels the HTTP request
  // instead of only stopping the wait; chained to the session signal.
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
  const summarizePromise = activeBackend().summarize(cmd, controller.signal);
  // The race below decides the outcome; the underlying promise may settle
  // later (timeout won) — swallow its late rejection so it never becomes
  // unhandled. Late landings are dropped; the queue retries after backoff.
  summarizePromise.catch(() => {});
  Promise.race([summarizePromise, timeout])
    .then((raw) => {
      // Abort check MUST precede any shared-state mutation: a stale promise
      // settling after a session switch would otherwise delete the marker of
      // a newer request for the same command (session_start already cleared
      // the set, so the abandoned branch needs no cleanup).
      if (signal.aborted) return;
      pendingSummaries.delete(cmd);
      summaryFailStreak = 0;
      summaryBlockedUntil = 0;
      summaryCache.set(cmd, normalizeSummary(raw));
      logGoodiesEvent({
        type: "summary_request",
        outcome: "ok",
        ms: Date.now() - requestStartedAt,
        ...redactCommandForLog(cmd),
      });
      clearSummaryPauseWidget();
      invalidateRowsForCommand(cmd);
    })
    .catch((err) => {
      // Always free the slot when the request settled, unless the session
      // itself was aborted (session_start clears pendingSummaries via .clear()).
      // The previous guard only deleted on !signal.aborted && !AbortError —
      // a per-request AbortError (not a session switch) left the command in
      // pendingSummaries forever, permanently burning a concurrency slot
      // with zero log output.
      if (!signal.aborted) pendingSummaries.delete(cmd);
      // Switching sessions aborts in-flight summaries deliberately: that is
      // not a provider failure — neither penalize nor log it.
      if (signal.aborted || (err as Error)?.name === "AbortError") return;
      const pauseMs = noteSummaryFailure(err);
      logSummaryFailure(cmd, err, pauseMs, Date.now() - requestStartedAt);
    })
    .finally(() => {
      clearTimeout(timeoutTimer);
      signal.removeEventListener("abort", onSessionAbort);
      if (!signal.aborted) drainSummaryQueue();
    });
}

/** Start queued requests while capacity allows and no backoff is active. */
function drainSummaryQueue(): void {
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

// Display width a bullet's command text may occupy before ellipsizing.
// Matches the summary floor: a command that qualified for summarization is
// exactly the kind that needs the full 80 columns here too.
const BASH_BULLET_WIDTH = SUMMARY_THRESHOLD_CHARS;

function formatBashHeader(args: any, theme: any): string {
  const cmd = args.command || "...";
  // A summary already says what the command does; the (+N lines) size hint
  // only matters for the raw first-line fallback, where it warns that the
  // shown line isn't the whole command.
  if (isSummarizable(cmd) && summaryCache.has(cmd)) {
    return theme.fg("accent", summaryCache.get(cmd)!);
  }
  // Cap must match BASH_BULLET_WIDTH, not exceed it: when a summary lands it
  // replaces this text, and summaries are capped at SUMMARY_THRESHOLD_CHARS.
  // A larger raw cap means the raw header can wrap where the summary won't,
  // so the swap shrinks total line count mid-run — and pi-tui answers any
  // drop below its high-water mark with a full clear-screen + scrollback wipe
  // (clearOnShrink), i.e. a visible full-screen flash per summarized command
  // (reproduced in panes narrower than ~124 cols; see clean-tui.test.ts
  // "summary swap is height-neutral at 110 columns"). Equal caps keep the
  // swap height-neutral wherever 80 columns fit.
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
    head = head.slice(0, BASH_BULLET_WIDTH) + "…";
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
  // Visible prose is the burst boundary (see shouldGroup / hasVisibleText).
  // Assistant text is detected during streaming — pi creates a message's tool
  // components while that message is still streaming, and text blocks precede
  // its tool calls, so by the time the first tool of a message registers, any
  // prose in that message has already bumped the segment. Textless messages
  // (thinking + tool calls only) never bump it.
  pi.on("message_start", (event, _ctx) => {
    const message = (event as any).message;
    if (!message) return;
    if (message.role === "assistant") {
      // Some providers deliver the complete message at start (no streaming).
      curAssistantTextSeen = hasVisibleText(message);
      if (curAssistantTextSeen) liveSeg++;
    } else if (message.role === "user") {
      // A typed user message is prose; it must split the surrounding bursts.
      if (hasVisibleText(message)) liveSeg++;
    }
  });
  pi.on("message_update", (event, _ctx) => {
    const message = (event as any).message;
    if (message?.role !== "assistant" || curAssistantTextSeen) return;
    // Scanning the accumulating content (rather than matching text_start
    // alone) also covers providers that skip granular streaming events.
    if (hasVisibleText(message)) {
      curAssistantTextSeen = true;
      liveSeg++;
    }
  });
  pi.on("session_start", (_event, ctx) => {
    liveSeg = 0;
    curAssistantTextSeen = false;
    replaying = true;
    entries.length = 0;
    entryById.clear();
    invalidateById.clear();
    pendingSummaries.clear();
    summaryRequestQueue.length = 0;
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
    // branch with one segment per prose boundary, mirroring the live rule.
    // Textless assistant messages keep the current segment; visible text
    // (assistant or typed user) starts a new one. Calls not present in the
    // branch (defensive) get NaN and render solo.
    replaySegByToolCallId.clear();
    const branch = ctx?.sessionManager?.getBranch?.() ?? [];
    let seg = 0;
    for (const entry of branch) {
      const message = entry?.type === "message" ? entry.message : undefined;
      if (!message) continue;
      if (message.role === "assistant") {
        if (hasVisibleText(message)) seg--;
        for (const block of message.content ?? []) {
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
  // Every burst tool (read/bash/write/edit/find/grep/ls) shares one render
  // skeleton: upsert → burst → leader/follower split → grouped box or solo
  // box. Per-tool behavior is a spec of formatters. This deletes ~450 lines of
  // copy-paste and, more importantly, makes the divergence class impossible:
  // the "one failed row paints the whole burst red" bug was fixed twice for
  // bash (b80a14d, then the isGrouped?false rule) but the other six tools still
  // shipped `isGrouped ? entries.some(e => e.isError)` — the shared skeleton
  // carries the single correct rule for all of them.
  type BurstToolSpec = {
    name: string;
    description: any;
    parameters: any;
    /** Bullet line for one entry inside a grouped header. */
    bullet: (entry: Entry, theme: any) => string;
    /** Extra lines appended to the grouped header when expanded (or ""). */
    groupedDetails: (entries: Entry[], theme: any) => string;
    /** Solo (ungrouped) header line, without expanded output. */
    soloHeader: (args: any, theme: any) => string;
    /** Extra lines appended to the solo header when expanded (or ""). */
    soloExpanded: (entry: Entry, args: any, theme: any) => string;
    /** Hook run right after upsertEntry (bash: request a summary). */
    onUpsert?: (entry: Entry, args: any, ctx: any) => void;
  };

  function registerBurstTool(spec: BurstToolSpec): void {
    pi.registerTool({
      name: spec.name,
      label: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      renderShell: "self",
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const tool = (getBuiltInTools(ctx.cwd) as any)[spec.name];
        return tool.execute(toolCallId, params, signal, onUpdate);
      },
      renderCall(args, theme, ctx: any) {
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
        let line = spec.soloHeader(args, theme);
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
        if (!e.result) {
          details.push(
            theme.fg(
              "warning",
              `— $ ${formatBashCommand(e.args.command || "...", theme, 40)}: pending`,
            ),
          );
          continue;
        }
        const txt = resultText(e.result as any)?.trim();
        if (!txt) continue;
        const preview = txt
          .split("\n")
          .slice(0, 12)
          .map((l) => theme.fg("toolOutput", l))
          .join("\n");
        details.push(
          `\n${theme.fg("muted", `— $ ${formatBashCommand(e.args.command || "...", theme, 40)}`)}:\n${preview}`,
        );
      }
      return details.length ? `\n${details.join("\n")}` : "";
    },
    soloHeader(args, theme) {
      const suffix = args.timeout
        ? theme.fg("muted", ` (timeout ${args.timeout}s)`)
        : "";
      return `${theme.fg("toolTitle", theme.bold("$"))} ${formatBashHeader(args, theme)}${suffix}`;
    },
    soloExpanded(entry, args, theme) {
      const parts: string[] = [];
      // Header only showed the first line — reveal the full command.
      if (args.command && args.command.includes("\n"))
        parts.push(theme.fg("toolOutput", args.command));
      if (entry.result) {
        const txt = resultText(entry.result as any)?.trim();
        if (txt)
          parts.push(
            txt
              .split("\n")
              .map((l: string) => theme.fg("toolOutput", l))
              .join("\n"),
          );
      }
      return parts.join("\n");
    },
  });

  // ── write ─────────────────────────────────────────────────────
  registerBurstTool({
    name: "write",
    description: schemaTools.write.description,
    parameters: schemaTools.write.parameters,
    bullet: formatWriteBullet,
    groupedDetails(entries, theme) {
      return entries
        .filter((e) => e.result && resultText(e.result as any))
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
      if (!entry.result) return "";
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
