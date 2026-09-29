/** AI command and live thinking summaries; independent of burst layout. */
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
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
import type { Entry } from "./clean-tui.ts";

// Only the safe, tail-only row interactions cross into burst state.
let history: {
  entries: Entry[];
  invalidateById: Map<string, () => void>;
  isReplaying: () => boolean;
  /** True while the call's final result has not landed in the CURRENT run. */
  isPending: (toolCallId: string) => boolean;
};
export function bindSummaryHistory(value: typeof history): void {
  history = value;
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
// Provider error bodies are not under our control; the humanizer bounds the
// detail it extracts, and this caps the composed line before the model label
// is appended — belt and braces for the log-once dedup set.
const SUMMARY_ERROR_SNIPPET_CHARS = 200;

export const summaryCache = new Map<string, string>();
// Cache cap: one entry per distinct long command, and the key is the FULL
// command text (heredocs make fat keys), so a long session accumulates
// without bound. FIFO eviction is the right shape — recent commands are the
// ones whose rows still re-render; an evicted command just falls back to
// its raw text if it ever reappears.
const SUMMARY_CACHE_MAX = 200;
export const pendingSummaries = new Set<string>();
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
export interface SummaryUi {
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

export function clearSummaryPauseWidget(): void {
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
  summaryFailureWaveObservedAt = 0;
}

/** Saved-summary count for tests (the cache is capped, not unbounded). */
export function __summaryCacheSizeForTesting(): number {
  return summaryCache.size;
}

export function isSummarizable(cmd: string): boolean {
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

// ── Provider error humanizer ────────────────────────────────────
//
// pi-ai surfaces provider failures as `"<status>: <raw body>"` — the body
// being whatever JSON the endpoint felt like returning, up to 4000 chars,
// sometimes with a second metadata line appended. Slicing that for the
// widget produced gems like `429: {"message":"Provider returned
// error","code":429,"metadata":{"raw":"{\"code\…` — escaped, truncated
// mid-token, and useless. These helpers dig the actual sentences out.

// Plain-English names for the statuses summaries actually hit.
const PROVIDER_STATUS_WORDS: Record<number, string> = {
  400: "bad request",
  401: "auth failed",
  403: "forbidden",
  404: "not found",
  408: "timeout",
  413: "payload too large",
  429: "rate limited",
  500: "server error",
  502: "bad gateway",
  503: "service unavailable",
  504: "gateway timeout",
};
// Longest single sentence kept; longest joined detail. Bounds the widget
// line so the model label isn't always the part that gets cut.
const PROVIDER_ERROR_DETAIL_CAP = 120;
const PROVIDER_ERROR_JOINED_CAP = 160;
// Wrapper phrases gateways put around the upstream error — zero information
// (we know it's an error; that's why this code is running) and they waste
// the widget's 80-char window that the actual reason needs.
const PROVIDER_ERROR_NOISE_RE =
  /^(?:provider returned (?:an )?error|an error occurred|request failed|error)\.?$/i;

/**
 * Collect the human-readable sentences from a parsed provider error body,
 * most-general-first. Gateways commonly wrap the upstream error
 * ("Provider returned error" outside, the real reason encoded as a JSON
 * string inside `metadata.raw`), so JSON-looking strings are unwrapped and
 * recursed. Strings without spaces are skipped as enum-ish tokens
 * ("invalid_request_error", "rate_limit") — they repeat what the message
 * already said. Bounded: 3 strings, depth 4, each length-capped.
 */
function collectProviderErrorStrings(
  value: unknown,
  out: string[] = [],
  depth = 0,
): string[] {
  if (out.length >= 3 || depth > 4) return out;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return out;
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        return collectProviderErrorStrings(JSON.parse(s), out, depth + 1);
      } catch {
        // Not JSON after all — treat as a plain string below.
      }
    }
    if (s.includes(" ")) {
      out.push(
        s.length > PROVIDER_ERROR_DETAIL_CAP
          ? `${s.slice(0, PROVIDER_ERROR_DETAIL_CAP)}…`
          : s,
      );
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectProviderErrorStrings(item, out, depth + 1);
      if (out.length >= 3) break;
    }
    return out;
  }
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    // Preferred keys first so the joined detail leads with the real
    // message, not whatever random field iteration finds first.
    const preferred = ["message", "error", "detail", "reason", "error_message"];
    const visited = new Set<string>();
    for (const key of preferred) {
      if (key in obj) {
        visited.add(key);
        collectProviderErrorStrings(obj[key], out, depth + 1);
        if (out.length >= 3) return out;
      }
    }
    for (const [key, v] of Object.entries(obj)) {
      if (visited.has(key) || ["code", "status", "type", "param"].includes(key))
        continue;
      collectProviderErrorStrings(v, out, depth + 1);
      if (out.length >= 3) return out;
    }
  }
  return out;
}

/**
 * Turn pi-ai's `"<status>: <body>"` provider error string into one bounded,
 * readable line: `429 rate limited — Provider returned error: quota
 * exceeded`. Falls back to the whitespace-compacted body when it isn't
 * JSON; returns the input (compacted) when there's no status prefix.
 */
export function humanizeProviderError(errorMessage: string): string {
  // pi's `!cmd` apiKey refs fail as "Failed to resolve API key for provider
  // \"X\" from shell command: <cmd>" — the useful part is the tail (which
  // command/file), the head is boilerplate the 80-char widget window
  // otherwise eats.
  const authMatch =
    /^Failed to resolve API key for provider "([^"]+)" from shell command: (.+)$/s.exec(
      errorMessage,
    );
  if (authMatch !== null) {
    const [, provider, command] = authMatch;
    const cmd =
      command.length > PROVIDER_ERROR_JOINED_CAP
        ? `${command.slice(0, PROVIDER_ERROR_JOINED_CAP)}…`
        : command;
    return `no API key for ${provider}: ${cmd} failed`;
  }
  const statusMatch = /^(\d{3}):\s*/.exec(errorMessage);
  const status = statusMatch === null ? undefined : Number(statusMatch[1]);
  const body =
    statusMatch === null
      ? errorMessage
      : errorMessage.slice(statusMatch[0].length);
  // formatProviderError composes the body alone, but callers may have
  // appended a second metadata line after it — parse the first line first,
  // then the whole body as a fallback.
  let strings: string[] = [];
  for (const candidate of [body.split("\n", 1)[0], body]) {
    const text = candidate.trim();
    if (!text) continue;
    try {
      strings = collectProviderErrorStrings(JSON.parse(text));
      break;
    } catch {
      // Not JSON — try the next candidate, then fall back to raw text.
    }
  }
  // Drop wrapper noise ("Provider returned error") so the space goes to the
  // actual upstream reason; if a body is ALL noise, keep it anyway.
  const informative = strings.filter((s) => !PROVIDER_ERROR_NOISE_RE.test(s));
  let detail = [
    ...new Set(informative.length > 0 ? informative : strings),
  ].join(": ");
  if (detail.length > PROVIDER_ERROR_JOINED_CAP) {
    detail = `${detail.slice(0, PROVIDER_ERROR_JOINED_CAP)}…`;
  }
  if (!detail) {
    // Non-JSON (or JSON with no sentences): keep the body, compacted, so a
    // multi-line body still renders as one widget line.
    detail = body
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, PROVIDER_ERROR_JOINED_CAP);
  }
  if (status === undefined) return detail || errorMessage;
  const word = PROVIDER_STATUS_WORDS[status];
  const head = word === undefined ? `HTTP ${status}` : `${status} ${word}`;
  return detail ? `${head} — ${detail}` : head;
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
 * - "error"   → Error with the provider's errorMessage (humanized) + label
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
  if (response.stopReason === "error") {
    const raw = response.errorMessage;
    const detail =
      raw === undefined ? "request failed" : humanizeProviderError(raw);
    throw new Error(
      `${detail.slice(0, SUMMARY_ERROR_SNIPPET_CHARS)} (${label})`,
    );
  }
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
  // Humanize here too: errors that arrive thrown (timeouts, pi auth
  // resolution) skip convertSummaryResponse's humanizer. Idempotent for
  // messages that are already humanized.
  const msg = humanizeProviderError(describeError(err));
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
// Settlement time of the failure that most recently advanced the streak.
// Requests already started by then belong to that same concurrent wave,
// even if a slow sibling settles after the resulting cooldown has expired.
let summaryFailureWaveObservedAt = 0;

export function __setSummaryBackoffForTesting(
  baseMs: number,
  capMs: number,
): void {
  summaryBackoffBaseMs = baseMs;
  summaryBackoffCapMs = capMs;
}

function noteSummaryFailure(err: unknown, requestStartedAt: number): number {
  // Two requests may already be in flight when the provider first says 429.
  // They are one failure wave, not two independent probes: counting both
  // used to turn a single pair of simultaneous 429s into 30s then 60s.
  // A request that started before the current cooldown was established
  // inherits that cooldown without advancing the streak.
  if (
    summaryFailStreak > 0 &&
    requestStartedAt <= summaryFailureWaveObservedAt
  ) {
    // A sibling response can carry a stronger Retry-After than the first
    // failure. It still does not advance the streak, but its provider hint
    // must extend the shared cooldown.
    const retryAfter = (err as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof retryAfter === "number") {
      summaryBlockedUntil = Math.max(
        summaryBlockedUntil,
        Date.now() + Math.min(summaryBackoffCapMs, retryAfter),
      );
    }
    return Math.max(0, summaryBlockedUntil - Date.now());
  }
  summaryFailStreak++;
  summaryFailureWaveObservedAt = Date.now();
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

/** Only a request admitted after the latest failure is a recovery probe. */
function noteSummarySuccess(requestStartedAt: number): boolean {
  if (
    summaryFailStreak > 0 &&
    requestStartedAt <= summaryFailureWaveObservedAt
  ) {
    return false;
  }
  summaryFailStreak = 0;
  summaryBlockedUntil = 0;
  summaryFailureWaveObservedAt = 0;
  return true;
}

export function requestSummary(cmd: string): void {
  // Deferred requests drain here too: renderCalls are the heartbeat that
  // notices backoff expiry when nothing else is in flight.
  drainSummaryQueue();
  // Guard order matters: renderCall fires on every rerender, so all guards
  // here are cheap sync checks, and anything that can differ across rerenders
  // of the same command must not mutate state (mutating in a render path once
  // caused infinite invalidate loops).
  if (
    !summaryEnabled ||
    history.isReplaying() ||
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
    pendingSummaries.size >=
      (summaryFailStreak > 0 ? 1 : SUMMARY_MAX_INFLIGHT) ||
    (summaryFailStreak > 0 && thinkingInflight)
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
        const recovered = noteSummarySuccess(requestStartedAt);
        summaryCache.set(cmd, normalizeSummary(result.text));
        while (summaryCache.size > SUMMARY_CACHE_MAX) {
          const oldest = summaryCache.keys().next().value;
          if (oldest === undefined) break;
          summaryCache.delete(oldest);
        }
        logGoodiesEvent({
          type: "summary_request",
          outcome: "ok",
          kind: "bash",
          ms: Date.now() - requestStartedAt,
          ...(result.attempts > 1 ? { attempt: result.attempts } : {}),
          ...redactCommandForLog(cmd),
        });
        if (recovered) clearSummaryPauseWidget();
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
      const pauseMs = noteSummaryFailure(result.err, requestStartedAt);
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
      const text = await summarizeOnce();
      // A response that only normalizes to nothing (quotes-only, bare
      // whitespace) is no summary: throw the same deterministic failure
      // convertSummaryResponse throws for blank answers. Caching the empty
      // string would render as the command's whole summary line (blanking
      // it) and suppress every future re-request, while silently dropping
      // the result would re-fire a provider call on every rerender — the
      // non-retryable failure path (log + backoff) is the established
      // treatment for empty summaries.
      if (normalizeSummary(text) === "") {
        throw new Error("empty summary — model output normalizes to nothing");
      }
      return { ok: true, text, attempts: attempt };
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
    pendingSummaries.size <
      (summaryFailStreak > 0 ? 1 : SUMMARY_MAX_INFLIGHT) &&
    // After a failure, recovery is half-open: only one provider request
    // (bash or thinking) may probe at once. A success restores normal
    // concurrency; another failure advances the cooldown exactly once.
    (summaryFailStreak === 0 || !thinkingInflight) &&
    Date.now() >= summaryBlockedUntil
  ) {
    const cmd = summaryRequestQueue.shift()!;
    if (summaryCache.has(cmd) || pendingSummaries.has(cmd)) continue;
    startSummaryRequest(cmd);
  }
}

function stampSummaryRequested(cmd: string): void {
  const now = Date.now();
  for (const e of history.entries) {
    if (e.args?.command === cmd && e.summaryRequestedAt === undefined)
      e.summaryRequestedAt = now;
  }
}

function invalidateRowsForCommand(cmd: string): void {
  // Refresh rows that are STILL EXECUTING, plus rows that finished while
  // their summary was in flight — at landing those are at most one summary
  // latency old, so they sit at the viewport tail and a differential
  // re-render is safe. This is what makes fast commands (finished before the
  // ~2s summary arrives) visibly summarize at all. Still-executing means
  // pending in the CURRENT run: `!e.result` alone also matched rows left
  // resultless by a crash or interrupt (replayed zombies from a dead
  // session included), and repainting those anywhere in history is the
  // above-viewport fullRender flash this function exists to prevent.
  // Older finished rows — including replayed ones from before a /resume —
  // keep the raw command text: they can sit far above the viewport on a long
  // transcript, and pi's diff renderer answers any change above the viewport
  // with fullRender(true): clear screen + scrollback wipe + full repaint,
  // i.e. the "flicker while pi is working" seen on 0.11.x. The summary stays
  // cached either way, and future rows of the same command render it from
  // the start.
  for (const e of history.entries) {
    if (e.args?.command !== cmd) continue;
    const finishedDuringFlight =
      e.resultAt !== undefined &&
      e.summaryRequestedAt !== undefined &&
      e.resultAt >= e.summaryRequestedAt &&
      // Strictly younger than the window: a zero window must admit nothing,
      // and stamp/result often land in the same millisecond in tests.
      Date.now() - e.resultAt < summarySwapMaxAgeMs;
    if (history.isPending(e.toolCallId) || finishedDuringFlight) {
      const fn = history.invalidateById.get(e.toolCallId);
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

export function resetThinkingState(): void {
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
export function resetThinkingRun(): void {
  thinkingRun = undefined;
  clearThinkingWidget();
}

/**
 * Track the trailing thinking run of the streaming assistant message and
 * maybe fire a summary request for it. Runs on every message_update — walks
 * the content from the end, so the cost is bounded by the trailing run, not
 * the whole message.
 */
export function trackThinkingStream(message: {
  content?: Array<{ type?: string; thinking?: string }>;
}): void {
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
    history.isReplaying() ||
    !getThinkingSummariesEnabled() || // separate opt-in: recurring requests
    !getSummaryModel() || // unset = summaries off entirely
    !summaryUi?.hasUI // headless has no widget to show
  )
    return;
  const backend = activeBackend();
  if (typeof backend.summarizeThinking !== "function") return;
  if (
    thinkingInflight ||
    Date.now() < summaryBlockedUntil ||
    (summaryFailStreak > 0 && pendingSummaries.size > 0)
  )
    return;
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
        const recovered = noteSummarySuccess(requestStartedAt);
        logGoodiesEvent({
          type: "summary_request",
          outcome: "ok",
          kind: "thinking",
          ms: Date.now() - requestStartedAt,
          ...(result.attempts > 1 ? { attempt: result.attempts } : {}),
          ...redactCommandForLog(text),
        });
        if (recovered) clearSummaryPauseWidget();
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
        const pauseMs = noteSummaryFailure(result.err, requestStartedAt);
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
      if (!signal.aborted) {
        thinkingInflight = false;
        // A thinking request may be the sole half-open recovery probe while
        // completed bash rows wait in the queue. Its success restores normal
        // concurrency, so release those rows without requiring a later render.
        drainSummaryQueue();
      }
    });
}

/** Session switch: stop pending requests before replaying another branch. */
export function resetSummarySession(): void {
  pendingSummaries.clear();
  summaryRequestQueue.length = 0;
  resetThinkingState();
  clearSummaryPauseWidget();
  summarySessionAbort.abort();
  summarySessionAbort = new AbortController();
}
