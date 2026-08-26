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
import { completeSimple } from "@earendil-works/pi-ai/compat";
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
// Five-to-eight words fit in 30 completion tokens. We deliberately do NOT
// send a reasoning parameter: pi's own agent maps a session thinking level of
// "off" to `reasoning: undefined` (agent-core agent.js), and pi-ai adapters
// treat an absent option as their explicit no-thinking branch. Passing the
// string "off" instead would be actively harmful on several APIs whose
// branches key on truthiness (Anthropic/Google/Bedrock would enable thinking,
// and budget math over DEFAULT_THINKING_BUDGETS["off"] === undefined yields
// NaN max_tokens), even though clampThinkingLevel tolerates it at runtime.
// Trade-off: OpenAI-family reasoning models keep their API-default effort
// when no parameter is sent — prefer non-thinking models per the README.
const SUMMARY_MAX_TOKENS = 30;
const SUMMARY_PROMPT =
  "Summarize this shell command in 5-8 words, plain English, no quotes, no formatting. " +
  'Examples: "cat >> file << \'EOF\' with 20 lines of log" -> "Appends reboot log to migration file". ' +
  "Command:\n";
// Provider error bodies are not under our control and flow into console
// output plus the log-once dedup set; keep both bounded.
const SUMMARY_ERROR_SNIPPET_CHARS = 200;

const summaryCache = new Map<string, string>();
const pendingSummaries = new Set<string>();
// A burst of distinct long commands can fan out N simultaneous renders; keep
// concurrent provider requests bounded so we don't hammer the rate limiter.
const SUMMARY_MAX_INFLIGHT = 2;
let summaryEnabled = true;

export function __setSummaryEnabled(v: boolean): void {
  summaryEnabled = v;
}
export function __clearSummaryCache(): void {
  summaryCache.clear();
  pendingSummaries.clear();
  summaryFailuresLogged.clear();
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
      // No `reasoning`: see the note above the summary constants.
    },
  );
  // pi-ai encodes request failures in the returned message rather than
  // throwing; convert so the shared failure/backoff path sees them.
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
  return text; // normalized by the consumer, not here
}

function activeBackend(): SummaryBackend {
  return summaryBackendOverride ?? { summarize: summarizeViaProvider };
}

// Summaries are best-effort polish over the heuristic hint, but failures must
// not be silent: log once per distinct cause so a broken provider/key/model
// choice is debuggable instead of a black box. The backend messages embed the
// model label so three plausible providers don't mean guessing which failed.
const summaryFailuresLogged = new Set<string>();
function logSummaryFailure(cmd: string, err: unknown, pauseMs?: number) {
  const msg = err instanceof Error ? err.message : String(err);
  const pause = pauseMs
    ? `; pausing summaries ${Math.round(pauseMs / 1000)}s`
    : "";
  const key = `${msg}${pause}`;
  if (summaryFailuresLogged.has(key)) return;
  summaryFailuresLogged.add(key);
  console.error(
    `[clean-tui] command summary failed (${msg})${pause}; keeping heuristic hint. ` +
      `Command starts: ${JSON.stringify(cmd.slice(0, 60))}`,
  );
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
  // Guard order matters: renderCall fires on every rerender, so all guards
  // here are cheap sync checks, and anything that can differ across rerenders
  // of the same command must not mutate state (mutating in a render path once
  // caused infinite invalidate loops).
  if (
    !summaryEnabled ||
    replaying ||
    !isSummarizable(cmd) ||
    !getSummaryModel() || // unset = feature off: no resolution, no network.
    summaryCache.has(cmd) ||
    pendingSummaries.has(cmd) ||
    Date.now() < summaryBlockedUntil ||
    pendingSummaries.size >= SUMMARY_MAX_INFLIGHT
  )
    return;
  pendingSummaries.add(cmd);
  const signal = summarySessionAbort.signal;
  activeBackend()
    .summarize(cmd, signal)
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
      invalidateRowsForCommand(cmd);
    })
    .catch((err) => {
      if (!signal.aborted && (err as Error)?.name !== "AbortError")
        pendingSummaries.delete(cmd);
      // Switching sessions aborts in-flight summaries deliberately: that is
      // not a provider failure — neither penalize nor log it.
      if (signal.aborted || (err as Error)?.name === "AbortError") return;
      const pauseMs = noteSummaryFailure(err);
      logSummaryFailure(cmd, err, pauseMs);
    });
}

function invalidateRowsForCommand(cmd: string): void {
  // Only rows that are STILL EXECUTING get refreshed when a summary lands.
  // Executing rows sit at the transcript tail, inside pi's viewport, so the
  // re-render is a cheap differential line update. Finished rows — including
  // replayed ones from before a /resume — can sit far above the viewport on a
  // long transcript, and pi's diff renderer answers any change above the
  // viewport with fullRender(true): clear screen + scrollback wipe + full
  // repaint, i.e. the "flicker while pi is working" seen on 0.11.x (fits any
  // width; reproduced reasoning from tui-main-screen.js `firstChanged <
  // prevViewportTop`). Finished rows simply keep the raw command text, which
  // is more informative than the summary anyway; the summary stays cached
  // and future rows of the same command render it from the start.
  for (const e of entries) {
    if (!e.result && e.args?.command === cmd) {
      const fn = invalidateById.get(e.toolCallId);
      if (fn) fn();
    }
  }
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
  let line = `  ${theme.fg("muted", "•")} ${theme.fg("accent", path)}`;
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
  // poisoning the whole burst's background (see renderCall: box color now
  // follows the leader's status only).
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
  return `  ${theme.fg("muted", "•")} ${theme.fg("accent", path)}${info}`;
}

function formatEditBullet(entry: Entry, theme: any): string {
  const path = shortenPath(entry.args.path || "...");
  return `  ${theme.fg("muted", "•")} ${theme.fg("accent", path)}`;
}

function formatFindBullet(entry: Entry, theme: any): string {
  const pat = entry.args.pattern || "";
  const path = shortenPath(entry.args.path || ".");
  return `  ${theme.fg("muted", "•")} ${theme.fg("accent", pat)}${theme.fg("toolOutput", ` in ${path}`)}`;
}

function formatGrepBullet(entry: Entry, theme: any): string {
  const pat = entry.args.pattern || "";
  const path = shortenPath(entry.args.path || ".");
  const glob = entry.args.glob ? ` (${entry.args.glob})` : "";
  return `  ${theme.fg("muted", "•")} ${theme.fg("accent", `/${pat}/`)}${theme.fg("toolOutput", ` in ${path}${glob}`)}`;
}

function formatLsBullet(entry: Entry, theme: any): string {
  const path = shortenPath(entry.args.path || ".");
  return `  ${theme.fg("muted", "•")} ${theme.fg("accent", path)}`;
}

export default function cleanTui(pi: ExtensionAPI): void {
  setCleanTuiActive(true);
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

  // ── read ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "read",
    label: "read",
    description: schemaTools.read.description,
    parameters: schemaTools.read.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).read.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme, ctx: any) {
      const entry = upsertEntry(ctx.toolCallId, "read", args, ctx.invalidate);
      const burst = getBurstForId(ctx.toolCallId);
      const isGrouped = burst && burst.entries.length > 1;
      const isLeader =
        isGrouped && burst.entries[0].toolCallId === ctx.toolCallId;
      const pending = isGrouped
        ? burst.entries.some((e) => !e.result)
        : !entry.result;
      const isError = isGrouped
        ? burst.entries.some((e) => e.isError)
        : !!entry.isError;

      if (isGrouped && !isLeader) {
        // Refresh the leader's header/count. Single hop: a leader's renderCall
        // never invalidates anything, so this cannot loop.
        const lead = invalidateById.get(burst.entries[0].toolCallId);
        if (lead) lead();
        return new Container();
      }

      if (isGrouped && isLeader) {
        const count = burst.entries.length;
        let header = `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("muted", `×${count}`)}`;
        const bullets = burst.entries
          .map((e) => formatReadBullet(e, theme))
          .join("\n");
        header += `\n${bullets}`;
        if (ctx.expanded) {
          const details: string[] = [];
          for (const e of burst.entries) {
            if (!e.result) {
              details.push(
                theme.fg("warning", `— ${shortenPath(e.args.path)}: pending`),
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
            let block = `\n${theme.fg("muted", `— ${shortenPath(e.args.path)}`)}:\n${preview}`;
            if (remaining > 0)
              block += `\n${theme.fg("muted", `... ${remaining} more lines`)}`;
            details.push(block);
          }
          if (details.length) header += `\n${details.join("\n")}`;
        }
        return makeBox(theme, pending, isError, header);
      }

      // solo
      let line = `${theme.fg("toolTitle", theme.bold("read"))} ${formatReadHeader(args, theme)}`;
      if (ctx.expanded && entry.result) {
        const txt = resultText(entry.result as any);
        if (txt) {
          const preview = txt
            .split("\n")
            .map((l) => theme.fg("toolOutput", l))
            .join("\n");
          line += `\n${preview}`;
        }
      }
      return makeBox(theme, pending, isError, line);
    },
    renderResult(result: any, _opts: any, _theme: any, ctx: any) {
      recordResult(entryById.get(ctx.toolCallId), result, ctx);
      // All visual work is done in renderCall (unified box); keep result slot empty
      // Images are rendered by Pi's ToolExecutionComponent image layer even when we return empty here
      return new Container();
    },
  });

  // ── bash ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "bash",
    label: "bash",
    description: schemaTools.bash.description,
    parameters: schemaTools.bash.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).bash.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme, ctx: any) {
      if (args.command) requestSummary(args.command);
      const entry = upsertEntry(ctx.toolCallId, "bash", args, ctx.invalidate);
      const burst = getBurstForId(ctx.toolCallId);
      const isGrouped = burst && burst.entries.length > 1;
      const isLeader =
        isGrouped && burst.entries[0].toolCallId === ctx.toolCallId;
      // Box color follows the leader's own status. Aggregating any-pending/
      // any-error over the whole burst paints 37 rows red for one failure;
      // per-entry failures are marked on their own bullet instead
      // (formatBashBullet).
      const pending = !entry.result;
      const isError = !!entry.isError;

      if (isGrouped && !isLeader) {
        // Refresh the leader's header/count. Single hop: a leader's renderCall
        // never invalidates anything, so this cannot loop.
        const lead = invalidateById.get(burst.entries[0].toolCallId);
        if (lead) lead();
        return new Container();
      }

      if (isGrouped && isLeader) {
        const count = burst.entries.length;
        let header = `${theme.fg("toolTitle", theme.bold("bash"))} ${theme.fg("muted", `×${count}`)}`;
        header += `\n${burst.entries.map((e) => formatBashBullet(e, theme)).join("\n")}`;
        if (ctx.expanded) {
          const details: string[] = [];
          for (const e of burst.entries) {
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
          if (details.length) header += `\n${details.join("\n")}`;
        }
        return makeBox(theme, pending, isError, header);
      }

      const suffix = args.timeout
        ? theme.fg("muted", ` (timeout ${args.timeout}s)`)
        : "";
      let line = `${theme.fg("toolTitle", theme.bold("$"))} ${formatBashHeader(args, theme)}${suffix}`;
      if (ctx.expanded && args.command && args.command.includes("\n")) {
        // Header only showed the first line — reveal the full command.
        line += `\n${theme.fg("toolOutput", args.command)}`;
      }
      if (ctx.expanded && entry.result) {
        const txt = resultText(entry.result as any)?.trim();
        if (txt)
          line += `\n${txt
            .split("\n")
            .map((l: string) => theme.fg("toolOutput", l))
            .join("\n")}`;
      }
      return makeBox(theme, pending, isError, line);
    },
    renderResult(result: any, _opts: any, _theme: any, ctx: any) {
      recordResult(entryById.get(ctx.toolCallId), result, ctx);
      return new Container();
    },
  });

  // ── write ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "write",
    label: "write",
    description: schemaTools.write.description,
    parameters: schemaTools.write.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).write.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme, ctx: any) {
      const entry = upsertEntry(ctx.toolCallId, "write", args, ctx.invalidate);
      const burst = getBurstForId(ctx.toolCallId);
      const isGrouped = burst && burst.entries.length > 1;
      const isLeader =
        isGrouped && burst.entries[0].toolCallId === ctx.toolCallId;
      const pending = isGrouped
        ? burst.entries.some((e) => !e.result)
        : !entry.result;
      const isError = isGrouped
        ? burst.entries.some((e) => e.isError)
        : !!entry.isError;
      if (isGrouped && !isLeader) {
        // Refresh the leader's header/count. Single hop: a leader's renderCall
        // never invalidates anything, so this cannot loop.
        const lead = invalidateById.get(burst.entries[0].toolCallId);
        if (lead) lead();
        return new Container();
      }
      if (isGrouped && isLeader) {
        let header = `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("muted", `×${burst.entries.length}`)}`;
        header += `\n${burst.entries.map((e) => formatWriteBullet(e, theme)).join("\n")}`;
        if (ctx.expanded) {
          const details = burst.entries
            .filter((e) => e.result && resultText(e.result as any))
            .map(
              (e) =>
                `\n${theme.fg("muted", `— ${shortenPath(e.args.path)}`)}: ${theme.fg("error", resultText(e.result as any)!)}`,
            )
            .join("");
          if (details) header += details;
        }
        return makeBox(theme, pending, isError, header);
      }
      const path = shortenPath(args.path || "");
      const display = path
        ? theme.fg("accent", path)
        : theme.fg("toolOutput", "...");
      const lines = args.content ? args.content.split("\n").length : 0;
      const info = lines > 0 ? theme.fg("muted", ` (${lines} lines)`) : "";
      let line = `${theme.fg("toolTitle", theme.bold("write"))} ${display}${info}`;
      if (ctx.expanded && entry.result) {
        const txt = resultText(entry.result as any);
        if (txt) line += `\n${theme.fg("error", txt)}`;
      }
      return makeBox(theme, pending, isError, line);
    },
    renderResult(result: any, _opts: any, _theme: any, ctx: any) {
      recordResult(entryById.get(ctx.toolCallId), result, ctx);
      return new Container();
    },
  });

  // ── edit ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "edit",
    label: "edit",
    description: schemaTools.edit.description,
    parameters: schemaTools.edit.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).edit.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme, ctx: any) {
      const entry = upsertEntry(ctx.toolCallId, "edit", args, ctx.invalidate);
      const burst = getBurstForId(ctx.toolCallId);
      const isGrouped = burst && burst.entries.length > 1;
      const isLeader =
        isGrouped && burst.entries[0].toolCallId === ctx.toolCallId;
      const pending = isGrouped
        ? burst.entries.some((e) => !e.result)
        : !entry.result;
      const isError = isGrouped
        ? burst.entries.some((e) => e.isError)
        : !!entry.isError;
      if (isGrouped && !isLeader) {
        // Refresh the leader's header/count. Single hop: a leader's renderCall
        // never invalidates anything, so this cannot loop.
        const lead = invalidateById.get(burst.entries[0].toolCallId);
        if (lead) lead();
        return new Container();
      }
      if (isGrouped && isLeader) {
        let header = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("muted", `×${burst.entries.length}`)}`;
        header += `\n${burst.entries.map((e) => formatEditBullet(e, theme)).join("\n")}`;
        if (ctx.expanded) {
          const details = burst.entries
            .map((e) => {
              const txt = e.result ? resultText(e.result as any) : undefined;
              return txt
                ? `\n${theme.fg("muted", `— ${shortenPath(e.args.path)}`)}:\n${theme.fg("toolOutput", txt.slice(0, 600))}`
                : "";
            })
            .join("");
          if (details) header += details;
        }
        return makeBox(theme, pending, isError, header);
      }
      let line = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", shortenPath(args.path || "..."))}`;
      if (ctx.expanded && entry.result) {
        const txt = resultText(entry.result as any);
        if (txt) line += `\n${theme.fg("toolOutput", txt)}`;
      }
      return makeBox(theme, pending, isError, line);
    },
    renderResult(result: any, _opts: any, _theme: any, ctx: any) {
      recordResult(entryById.get(ctx.toolCallId), result, ctx);
      return new Container();
    },
  });

  // ── find ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "find",
    label: "find",
    description: schemaTools.find.description,
    parameters: schemaTools.find.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).find.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme, ctx: any) {
      const entry = upsertEntry(ctx.toolCallId, "find", args, ctx.invalidate);
      const burst = getBurstForId(ctx.toolCallId);
      const isGrouped = burst && burst.entries.length > 1;
      const isLeader =
        isGrouped && burst.entries[0].toolCallId === ctx.toolCallId;
      const pending = isGrouped
        ? burst.entries.some((e) => !e.result)
        : !entry.result;
      const isError = isGrouped
        ? burst.entries.some((e) => e.isError)
        : !!entry.isError;
      if (isGrouped && !isLeader) {
        // Refresh the leader's header/count. Single hop: a leader's renderCall
        // never invalidates anything, so this cannot loop.
        const lead = invalidateById.get(burst.entries[0].toolCallId);
        if (lead) lead();
        return new Container();
      }
      if (isGrouped && isLeader) {
        let header = `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("muted", `×${burst.entries.length}`)}`;
        header += `\n${burst.entries.map((e) => formatFindBullet(e, theme)).join("\n")}`;
        if (ctx.expanded) {
          const details = burst.entries
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
          if (details) header += details;
        }
        return makeBox(theme, pending, isError, header);
      }
      let line = `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", args.pattern || "")}${theme.fg("toolOutput", ` in ${shortenPath(args.path || ".")}`)}`;
      if (ctx.expanded && entry.result) {
        const txt = resultText(entry.result as any)?.trim();
        if (txt)
          line += `\n${txt
            .split("\n")
            .map((l) => theme.fg("toolOutput", l))
            .join("\n")}`;
      }
      return makeBox(theme, pending, isError, line);
    },
    renderResult(result: any, _opts: any, _theme: any, ctx: any) {
      recordResult(entryById.get(ctx.toolCallId), result, ctx);
      return new Container();
    },
  });

  // ── grep ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "grep",
    label: "grep",
    description: schemaTools.grep.description,
    parameters: schemaTools.grep.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).grep.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme, ctx: any) {
      const entry = upsertEntry(ctx.toolCallId, "grep", args, ctx.invalidate);
      const burst = getBurstForId(ctx.toolCallId);
      const isGrouped = burst && burst.entries.length > 1;
      const isLeader =
        isGrouped && burst.entries[0].toolCallId === ctx.toolCallId;
      const pending = isGrouped
        ? burst.entries.some((e) => !e.result)
        : !entry.result;
      const isError = isGrouped
        ? burst.entries.some((e) => e.isError)
        : !!entry.isError;
      if (isGrouped && !isLeader) {
        // Refresh the leader's header/count. Single hop: a leader's renderCall
        // never invalidates anything, so this cannot loop.
        const lead = invalidateById.get(burst.entries[0].toolCallId);
        if (lead) lead();
        return new Container();
      }
      if (isGrouped && isLeader) {
        let header = `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("muted", `×${burst.entries.length}`)}`;
        header += `\n${burst.entries.map((e) => formatGrepBullet(e, theme)).join("\n")}`;
        if (ctx.expanded) {
          const details = burst.entries
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
          if (details) header += details;
        }
        return makeBox(theme, pending, isError, header);
      }
      let line = `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", `/${args.pattern || ""}/`)}${theme.fg("toolOutput", ` in ${shortenPath(args.path || ".")}`)}`;
      if (args.glob) line += theme.fg("toolOutput", ` (${args.glob})`);
      if (ctx.expanded && entry.result) {
        const txt = resultText(entry.result as any)?.trim();
        if (txt)
          line += `\n${txt
            .split("\n")
            .map((l) => theme.fg("toolOutput", l))
            .join("\n")}`;
      }
      return makeBox(theme, pending, isError, line);
    },
    renderResult(result: any, _opts: any, _theme: any, ctx: any) {
      recordResult(entryById.get(ctx.toolCallId), result, ctx);
      return new Container();
    },
  });

  // ── ls ────────────────────────────────────────────────────────
  pi.registerTool({
    name: "ls",
    label: "ls",
    description: schemaTools.ls.description,
    parameters: schemaTools.ls.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).ls.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme, ctx: any) {
      const entry = upsertEntry(ctx.toolCallId, "ls", args, ctx.invalidate);
      const burst = getBurstForId(ctx.toolCallId);
      const isGrouped = burst && burst.entries.length > 1;
      const isLeader =
        isGrouped && burst.entries[0].toolCallId === ctx.toolCallId;
      const pending = isGrouped
        ? burst.entries.some((e) => !e.result)
        : !entry.result;
      const isError = isGrouped
        ? burst.entries.some((e) => e.isError)
        : !!entry.isError;
      if (isGrouped && !isLeader) {
        // Refresh the leader's header/count. Single hop: a leader's renderCall
        // never invalidates anything, so this cannot loop.
        const lead = invalidateById.get(burst.entries[0].toolCallId);
        if (lead) lead();
        return new Container();
      }
      if (isGrouped && isLeader) {
        let header = `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("muted", `×${burst.entries.length}`)}`;
        header += `\n${burst.entries.map((e) => formatLsBullet(e, theme)).join("\n")}`;
        if (ctx.expanded) {
          const details = burst.entries
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
          if (details) header += details;
        }
        return makeBox(theme, pending, isError, header);
      }
      let line = `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", shortenPath(args.path || "."))}`;
      if (ctx.expanded && entry.result) {
        const txt = resultText(entry.result as any)?.trim();
        if (txt)
          line += `\n${txt
            .split("\n")
            .map((l) => theme.fg("toolOutput", l))
            .join("\n")}`;
      }
      return makeBox(theme, pending, isError, line);
    },
    renderResult(result: any, _opts: any, _theme: any, ctx: any) {
      recordResult(entryById.get(ctx.toolCallId), result, ctx);
      return new Container();
    },
  });
}
