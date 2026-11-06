/**
 * recap — /recap: a one-line recap of the session, on demand or after idle.
 *
 * The configured recap-model (else the session's active model; an explicit
 * `/recap provider/model` overrides both for one run) reads a compact window
 * of the current branch — the newest `recap-turns` user messages (default 2)
 * and everything after the first of them (assistant text, tool calls without
 * results, tool errors), plus the session's first user message and the latest
 * compaction summary — and writes one ≤400-character line:
 * what the session is working on, the latest concrete progress, and what is
 * next. The result is appended as a custom entry (`customType: "recap"`) with
 * a registered entry renderer: visible in the transcript, persisted with the
 * session, and never part of LLM context (appendEntry, not sendMessage).
 *
 * Automatic recaps (both are real model calls, so both are guarded):
 * - on session restore (`session_start` reason "resume"), after a short delay
 *   so the TUI is settled;
 * - after `recap-idle-minutes` (default 10) with no new messages, measured
 *   from the last message_end.
 * Auto runs require at least three user turns and refuse to repeat when no
 * user/assistant message has landed since the last recap entry — resuming a
 * session that already ends in a recap costs nothing. They never notify on
 * failure; the error goes to goodies.log. /recap always runs and notifies.
 *
 * Config keys in ~/.pi/agent/goodies.json (read at extension load):
 *   "recap-idle-minutes": 0 disables the idle timer; default 10.
 *   "recap-on-resume": false disables the resume recap.
 *   "recap-model": "provider/id" model that writes recaps; unset = active model.
 *   "recap-turns": how many recent user messages anchor the window; default 2.
 * `/goodies recap-model|recap-turns` edit the last two; recap-model with no
 * value opens pi's ctrl+l selector.
 * Disabling the whole feature (`/goodies disable recap`) turns off both the
 * command and the hooks. Auto recap generation is cancelled on shutdown and
 * superseded by a newer recap; every background path is a never-reject choke
 * point (a stale ctx after /reload must not kill the TUI).
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  EntryRenderer,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { describeError, extractTextParts, timeoutSignal } from "./json-file.ts";
import { rankCandidates } from "./vision-core.ts";
import { logGoodiesEvent, reportFailure } from "./goodies-log.ts";
import {
  findSummaryModel,
  wrapCommandAutocomplete,
  getRecapIdleMinutes,
  getRecapModel,
  getRecapOnResume,
  getRecapTurns,
  suggestSummaryModels,
} from "./goodies.ts";

export const RECAP_ENTRY_TYPE = "recap";
/** Hard cap for the generated line, matching Claude Code's session recap. */
export const RECAP_MAX_CHARS = 400;
/** Backstop budget for the unpinned transcript lines (~6k tokens). */
export const RECAP_TRANSCRIPT_MAX_CHARS = 24_000;
/** Auto recaps need a real conversation, not one exchange. */
export const RECAP_MIN_USER_TURNS = 3;
const RECAP_REQUEST_TIMEOUT_MS = 60_000;
const RECAP_RESUME_DELAY_MS = 1_200;

/** Test-only: shorten the resume delay so timer wiring is testable. */
let resumeDelayMs = RECAP_RESUME_DELAY_MS;
export function __setRecapResumeDelayMsForTesting(ms: number): void {
  resumeDelayMs = ms;
}

export const RECAP_SYSTEM_PROMPT = [
  "You write the one-line session recap shown to a developer returning to a Pi coding session.",
  "",
  "Cover, in this order:",
  "1. what the session is working on;",
  "2. the latest concrete progress — what was done or attempted, including failures and blockers;",
  "3. what remains or is next, when the transcript shows it.",
  "",
  "Rules:",
  "- At most 400 characters, on one line, with no line breaks.",
  '- Plain prose: no markdown, no bullets, no quotes, no "Recap:" prefix.',
  '- Address the developer as "you".',
  '- Be specific: name files, commands, decisions. Never write generic filler such as "working on code".',
  "- If the work is only beginning, say what it is about.",
  "- Output ONLY the recap text, nothing else.",
].join("\n");

export type RecapTrigger = "manual" | "idle" | "resume";

export interface RecapData {
  v: 1;
  text: string;
  /** Requested model at generation time, "provider/id". */
  model: string;
  createdAt: string;
  trigger: RecapTrigger;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

/** Validate a persisted custom-entry payload; render never throws on junk. */
export function parseRecapData(value: unknown): RecapData | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.text !== "string" || !value.text.trim()) return undefined;
  return {
    v: 1,
    text: value.text,
    model: typeof value.model === "string" ? value.model : "unknown",
    createdAt:
      typeof value.createdAt === "string"
        ? value.createdAt
        : new Date(0).toISOString(),
    trigger:
      value.trigger === "idle" || value.trigger === "resume"
        ? value.trigger
        : "manual",
  };
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** One-line argument summary for a tool call; never dumps huge payloads. */
export function describeToolCall(name: string, args: unknown): string {
  const summary = (() => {
    if (!isRecord(args)) return "";
    for (const key of [
      "command",
      "path",
      "file_path",
      "pattern",
      "query",
      "url",
      "description",
    ]) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    try {
      return JSON.stringify(args);
    } catch {
      return "";
    }
  })();
  const clipped = clip(summary.replace(/\s+/g, " "), 160);
  return clipped ? `[tool] ${name}: ${clipped}` : `[tool] ${name}`;
}

export interface RecapTranscriptOptions {
  /** Character budget for the unpinned (assistant/tool) lines. */
  maxChars?: number;
  /** How many of the newest user messages anchor the window. */
  recentUserTurns?: number;
}

interface TranscriptLine {
  text: string;
  /** User messages are never dropped by the budget. */
  pinned: boolean;
}

function userMessageText(entry: SessionEntry): string | undefined {
  if (entry.type !== "message" || entry.message.role !== "user") {
    return undefined;
  }
  const text = extractTextParts(entry.message.content).join("\n").trim();
  return text || undefined;
}

/**
 * Build the compact transcript the recap model reads: a window onto the
 * branch, not its whole tail.
 *
 * Window = the newest `recentUserTurns` user messages (default 2) and
 * everything after the first of them — assistant text, tool calls (name + main
 * argument, no results), tool errors, displayed extension injections. The
 * session's first user message is pinned in front so the recap knows what the
 * session is *for* even when the latest messages are "ok do it". The newest
 * compaction summary heads the transcript so older context survives.
 *
 * `maxChars` is a backstop for a runaway window: it trims the oldest
 * assistant/tool lines first and never drops a user message.
 * Excluded: thinking, successful tool output, labels, usage bookkeeping.
 */
export function buildRecapTranscript(
  entries: readonly SessionEntry[],
  options: RecapTranscriptOptions = {},
): string {
  const maxChars = options.maxChars ?? RECAP_TRANSCRIPT_MAX_CHARS;
  const turns = Math.max(1, Math.floor(options.recentUserTurns ?? 2));

  let latestCompaction: string | undefined;
  const userIndexes: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.type === "compaction") {
      // Only the newest one is useful: each compaction summarizes everything
      // before it, so older ones are subsets of the newest.
      latestCompaction = entry.summary;
    }
    if (userMessageText(entry) !== undefined) userIndexes.push(i);
  }

  const windowStart =
    userIndexes.length > 0
      ? userIndexes[Math.max(0, userIndexes.length - turns)]!
      : 0;
  const firstUserIndex = userIndexes[0];
  const pinFirst = firstUserIndex !== undefined && firstUserIndex < windowStart;

  const lines: TranscriptLine[] = [];
  const add = (line: string, pinned = false) => {
    const body = line.trim();
    if (body) lines.push({ text: body, pinned });
  };

  if (pinFirst) {
    add(
      `User (session start): ${clip(userMessageText(entries[firstUserIndex]!)!, 2000)}`,
      true,
    );
    // Nothing sits between two adjacent user messages, so no gap to flag.
    if (windowStart - firstUserIndex > 1) {
      lines.push({ text: "[earlier turns omitted]", pinned: true });
    }
  }

  for (let i = windowStart; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "user") {
        const text = userMessageText(entry);
        if (text) add(`User: ${clip(text, 4000)}`, true);
      } else if (message.role === "assistant") {
        const text = extractTextParts(message.content).join("\n");
        if (text.trim()) add(`Assistant: ${clip(text, 4000)}`);
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (isRecord(block) && block.type === "toolCall") {
              const name = typeof block.name === "string" ? block.name : "tool";
              add(describeToolCall(name, block.arguments));
            }
          }
        }
      } else if (message.role === "toolResult" && message.isError) {
        const text = extractTextParts(message.content).join(" ");
        add(`[tool error] ${message.toolName}: ${clip(text, 300)}`);
      }
    } else if (entry.type === "branch_summary") {
      add(`[abandoned branch] ${clip(entry.summary, 3000)}`);
    } else if (entry.type === "custom_message" && entry.display) {
      // Injected context the model answered (side handoffs, external-change
      // diffs, …). Keep it: later turns often refer to it.
      const text = extractTextParts(entry.content).join("\n");
      if (text.trim()) {
        add(`[context: ${entry.customType}] ${clip(text, 3000)}`);
      }
    }
  }

  // Backstop budget: pinned lines are free; spend the rest newest-first.
  let remaining =
    Math.max(maxChars, 0) -
    lines.reduce((n, l) => (l.pinned ? n + l.text.length + 1 : n), 0);
  const keep = new Array<boolean>(lines.length).fill(true);
  let overflowed = false;
  let keptUnpinned = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.pinned) continue;
    const cost = line.text.length + 1;
    // Keep the newest unpinned line even if it alone is over budget; after the
    // first overflow everything older goes, so the kept tail stays contiguous.
    if (overflowed || (cost > remaining && keptUnpinned)) {
      overflowed = true;
      keep[i] = false;
      continue;
    }
    remaining -= cost;
    keptUnpinned = true;
  }

  const out: string[] = [];
  if (latestCompaction?.trim()) {
    out.push(`[earlier session summary] ${clip(latestCompaction, 4000)}`, "");
  }
  let gap = false;
  lines.forEach((line, i) => {
    if (!keep[i]) {
      gap = true;
      return;
    }
    if (gap) out.push("[steps omitted]");
    gap = false;
    out.push(line.text);
  });
  if (gap) out.push("[steps omitted]");
  return out.join("\n").trim();
}

/** Count real user turns on the branch. */
export function countUserTurns(entries: readonly SessionEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "user") count += 1;
  }
  return count;
}

/**
 * Auto-recap eligibility: a real conversation (≥3 user turns) with activity
 * after the newest recap entry. A session that already ends in a recap never
 * pays for another one until the user or assistant says something new.
 */
export function shouldAutoRecap(entries: readonly SessionEntry[]): boolean {
  if (countUserTurns(entries) < RECAP_MIN_USER_TURNS) return false;
  let lastRecap = -1;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.type === "custom" && entry.customType === RECAP_ENTRY_TYPE) {
      lastRecap = i;
    }
  }
  if (lastRecap === -1) return true;
  for (let i = lastRecap + 1; i < entries.length; i++) {
    const entry = entries[i]!;
    if (
      entry.type === "message" &&
      (entry.message.role === "user" || entry.message.role === "assistant")
    ) {
      return true;
    }
  }
  return false;
}

/** Clean model output into a single ≤400-character line. */
export function sanitizeRecap(raw: string): string {
  let text = raw.trim();
  if (!text) return "";
  text = text
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  // Models like to open with "Recap: " or its markdown variant.
  text = text.replace(/^\s*\*{0,2}recap\*{0,2}\s*[:—–-]\*{0,2}\s*/i, "");
  text = text
    .replace(/^\s*[*-]\s+/, "")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  text = text.replace(/^["'`*]+|["'`*]+$/g, "").trim();
  if (text.length > RECAP_MAX_CHARS) {
    const cut = text.slice(0, RECAP_MAX_CHARS - 1);
    const lastSpace = cut.lastIndexOf(" ");
    text =
      (lastSpace > RECAP_MAX_CHARS * 0.6
        ? cut.slice(0, lastSpace)
        : cut
      ).trimEnd() + "…";
  }
  return text;
}

/** Renderer for the persisted recap entry: a quiet, wrapped transcript line. */
export const recapEntryRenderer: EntryRenderer<RecapData> = (
  entry,
  _options,
  theme,
) => {
  const data = parseRecapData(entry.data);
  const label = theme.fg("customMessageLabel", "▸ recap");
  const text = data?.text ?? "(unreadable recap entry)";
  return {
    render: (width: number) => {
      const prefix = `${label} `;
      const pad = " ".repeat(visibleWidth(prefix));
      const wrapped = wrapTextWithAnsi(
        text,
        Math.max(16, width - visibleWidth(prefix)),
      );
      if (wrapped.length === 0) return [prefix.trimEnd()];
      return [
        prefix + wrapped[0],
        ...wrapped.slice(1).map((line) => pad + line),
      ];
    },
    invalidate: () => {},
  };
};

/** Thrown when the provider reports the call was aborted (Esc, timeout). */
class RecapAbortedError extends Error {
  constructor() {
    super("recap was aborted");
    this.name = "RecapAbortedError";
  }
}

type ModelRegistryLike = ExtensionContext["modelRegistry"];

function resolveRecapModel(
  ctx: ExtensionContext,
  arg: string | undefined,
): Model<Api> {
  // Precedence: explicit /recap argument, then the configured recap-model,
  // then the session's active model.
  const configured = arg ? undefined : getRecapModel();
  if (configured) {
    const model = findSummaryModel(ctx.modelRegistry, configured);
    if (!model) {
      throw new Error(
        `configured recap-model "${configured}" is not available — fix it with /goodies recap-model`,
      );
    }
    return model;
  }
  if (!arg) {
    if (!ctx.model) {
      throw new Error("no model selected — switch to a model first");
    }
    return ctx.model as Model<Api>;
  }
  const model = findSummaryModel(ctx.modelRegistry, arg);
  if (!model) {
    const suggestions = suggestSummaryModels(ctx.modelRegistry, arg, 3);
    throw new Error(
      `unknown model "${arg}"${
        suggestions.length ? ` — try ${suggestions.join(", ")}` : ""
      }`,
    );
  }
  return model;
}

function safeSetStatus(ctx: ExtensionContext, text: string | undefined): void {
  try {
    ctx.ui.setStatus("recap", text);
  } catch {
    // A stale extension ctx after /reload must not reject a detached chain.
  }
}

interface GenerateRecapOptions {
  trigger: RecapTrigger;
  modelArg?: string;
}

async function generateRecap(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: GenerateRecapOptions,
): Promise<RecapData> {
  const model = resolveRecapModel(ctx, options.modelArg);
  const branch = ctx.sessionManager.getBranch();
  const transcript = buildRecapTranscript(branch, {
    recentUserTurns: getRecapTurns(),
  });
  if (!transcript) {
    throw new Error("nothing to recap yet — this session has no conversation");
  }

  const sessionName = ctx.sessionManager.getSessionName?.();
  const request = [
    `Working directory: ${ctx.cwd}`,
    ...(sessionName ? [`Session name: ${sessionName}`] : []),
    `User turns so far: ${countUserTurns(branch)}`,
    "",
    "Session transcript (most recent last):",
    transcript,
  ].join("\n");

  const started = Date.now();
  const controller = new AbortController();
  // A newer recap supersedes an in-flight one (manual over auto).
  inFlight?.abort();
  inFlight = controller;
  const signal = timeoutSignal(RECAP_REQUEST_TIMEOUT_MS, controller.signal);

  try {
    const response = await ctx.modelRegistry.complete(
      model,
      {
        systemPrompt: RECAP_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            timestamp: Date.now(),
            content: [{ type: "text", text: request }],
          },
        ],
      },
      { signal },
    );

    // complete() RESOLVES failed and aborted calls (stopReason "error" /
    // "aborted", partial text kept) instead of rejecting.
    if (response.stopReason === "aborted") throw new RecapAbortedError();
    if (response.stopReason === "error") {
      throw new Error(
        `model call failed: ${response.errorMessage ?? "unknown error"}`,
      );
    }

    const text = sanitizeRecap(extractTextParts(response.content).join("\n"));
    if (!text) throw new Error("model returned an empty recap");

    const data: RecapData = {
      v: 1,
      text,
      model: `${model.provider}/${model.id}`,
      createdAt: new Date().toISOString(),
      trigger: options.trigger,
    };
    pi.appendEntry(RECAP_ENTRY_TYPE, data);
    logGoodiesEvent({
      type: "recap",
      trigger: options.trigger,
      model: data.model,
      chars: text.length,
      durationMs: Date.now() - started,
    });
    return data;
  } finally {
    if (inFlight === controller) inFlight = undefined;
  }
}

// ── Module state (one extension instance per session runtime) ───────────────

let idleTimer: ReturnType<typeof setTimeout> | undefined;
let resumeTimer: ReturnType<typeof setTimeout> | undefined;
let inFlight: AbortController | undefined;
let modelRegistryRef: ModelRegistryLike | undefined;
let autocompleteWrapped = false;

function clearTimer(which: "idle" | "resume"): void {
  const handle = which === "idle" ? idleTimer : resumeTimer;
  if (handle !== undefined) clearTimeout(handle);
  if (which === "idle") idleTimer = undefined;
  else resumeTimer = undefined;
}

function armTimer(
  callback: () => void,
  ms: number,
): ReturnType<typeof setTimeout> {
  const handle = setTimeout(callback, ms);
  (handle as { unref?: () => void }).unref?.();
  return handle;
}

function scheduleIdleRecap(pi: ExtensionAPI, ctx: ExtensionContext): void {
  try {
    clearTimer("idle");
    if (ctx.mode !== "tui") return;
    const minutes = getRecapIdleMinutes();
    if (!(minutes > 0)) return;
    if (!shouldAutoRecap(ctx.sessionManager.getBranch())) return;

    const sessionId = ctx.sessionManager.getSessionId();
    idleTimer = armTimer(() => {
      idleTimer = undefined;
      void runAutoRecap(pi, ctx, "idle", sessionId);
    }, minutes * 60_000);
  } catch (err) {
    // Stale ctx during /reload, or a config/read failure: scheduling a
    // background nicety must never surface as an extension error.
    reportFailure(
      "recap_error",
      `idle recap scheduling failed: ${describeError(err)}`,
    );
  }
}

/**
 * One never-reject path for every background recap. A stale ctx (pi's runner
 * dies ~700ms before /reload swaps sessions) or a provider failure is logged,
 * never thrown: pi installs no unhandledRejection handler.
 */
async function runAutoRecap(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  trigger: "idle" | "resume",
  expectedSessionId: string,
): Promise<void> {
  let statusSet = false;
  try {
    if (ctx.mode !== "tui") return;
    if (ctx.sessionManager.getSessionId() !== expectedSessionId) return;
    if (!ctx.isIdle()) return;
    if (!shouldAutoRecap(ctx.sessionManager.getBranch())) return;

    safeSetStatus(ctx, "writing recap…");
    statusSet = true;
    await generateRecap(pi, ctx, { trigger });
  } catch (err) {
    if (!(err instanceof RecapAbortedError)) {
      reportFailure(
        "recap_error",
        `auto recap (${trigger}) failed: ${describeError(err)}`,
      );
    }
  } finally {
    if (statusSet) safeSetStatus(ctx, undefined);
  }
}

export default function recapExtension(pi: ExtensionAPI): void {
  pi.registerEntryRenderer(RECAP_ENTRY_TYPE, recapEntryRenderer);

  pi.registerCommand("recap", {
    description: "Generate a one-line recap of this session",
    getArgumentCompletions: (prefix) =>
      filterRecapModelCompletions(prefix, modelRegistryRef),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const modelArg = args.trim() || undefined;
      clearTimer("idle");
      safeSetStatus(ctx, "recap: waiting for the current turn…");
      try {
        await ctx.waitForIdle();
        safeSetStatus(ctx, "writing recap…");
        await generateRecap(pi, ctx, { trigger: "manual", modelArg });
      } catch (err) {
        if (!(err instanceof RecapAbortedError)) {
          ctx.ui.notify(`recap: ${describeError(err)}`, "error");
        }
      } finally {
        safeSetStatus(ctx, undefined);
      }
    },
  });

  pi.on("session_start", (event, ctx) => {
    modelRegistryRef = ctx.modelRegistry; // for /recap argument completions
    if (!autocompleteWrapped) {
      autocompleteWrapped = true;
      // Tab after `/recap ` would otherwise list cwd paths (see goodies.ts).
      try {
        ctx.ui.addAutocompleteProvider(
          wrapCommandAutocomplete("recap", (prefix) =>
            filterRecapModelCompletions(prefix, modelRegistryRef),
          ),
        );
      } catch (err) {
        reportFailure(
          "recap_error",
          `recap autocomplete not installed: ${describeError(err)}`,
        );
      }
    }
    clearTimer("idle");
    clearTimer("resume");
    if (event.reason !== "resume") return;
    if (ctx.mode !== "tui" || !getRecapOnResume()) return;
    if (!shouldAutoRecap(ctx.sessionManager.getBranch())) return;

    const sessionId = ctx.sessionManager.getSessionId();
    resumeTimer = armTimer(() => {
      resumeTimer = undefined;
      // Let the resumed TUI paint its header/transcript first.
      void runAutoRecap(pi, ctx, "resume", sessionId);
    }, resumeDelayMs);
  });

  // Every real message restarts the idle clock; tool results included, so a
  // long agent run never trips the timer between steps.
  pi.on("message_end", (_event, ctx) => {
    scheduleIdleRecap(pi, ctx);
  });

  pi.on("session_shutdown", () => {
    clearTimer("idle");
    clearTimer("resume");
    inFlight?.abort();
    inFlight = undefined;
  });
}

/**
 * /recap argument completion: every chat model the registry can serve, as
 * "provider/id", ranked like the /goodies model completions (prefix hits
 * first, then substring hits — "glm" finds "kilo/glm-5"). Registry reads are
 * sync; undefined just returns null.
 */
export function filterRecapModelCompletions(
  prefix: string,
  registry?: ModelRegistryLike,
): { value: string; label: string }[] | null {
  if (!registry) return null;
  const refs = [
    ...new Set(registry.getAvailable().map((m) => `${m.provider}/${m.id}`)),
  ];
  const ranked = rankCandidates(refs, prefix.trim().toLowerCase());
  return ranked.length > 0
    ? ranked.slice(0, 30).map((ref) => ({ value: ref, label: ref }))
    : null;
}
