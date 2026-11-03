/**
 * recap — /recap: a one-line recap of the session, on demand or after idle.
 *
 * The session's active model (or an explicit `/recap provider/model`) reads a
 * compact view of the current branch — user/assistant text, tool calls, tool
 * errors, the latest compaction summary — and writes one ≤400-character line:
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
import { logGoodiesEvent, reportFailure } from "./goodies-log.ts";
import {
  findSummaryModel,
  getRecapIdleMinutes,
  getRecapOnResume,
  suggestSummaryModels,
} from "./goodies.ts";

export const RECAP_ENTRY_TYPE = "recap";
/** Hard cap for the generated line, matching Claude Code's session recap. */
export const RECAP_MAX_CHARS = 400;
/** Tail budget for the transcript sent to the model (~6k tokens). */
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

/**
 * Build the compact transcript the recap model reads. Kept as the tail of the
 * branch (the latest work is what a recap is for) with the newest compaction
 * summary kept as a header so older context survives the truncation.
 *
 * Included: user/assistant text, tool calls (name + main argument), tool
 * errors, displayed extension injections (side handoffs, external-change
 * diffs), and the latest compaction summary. Excluded: thinking, successful
 * tool output, labels, model/usage bookkeeping.
 */
export function buildRecapTranscript(
  entries: readonly SessionEntry[],
  maxChars = RECAP_TRANSCRIPT_MAX_CHARS,
): string {
  const lines: string[] = [];
  let latestCompaction: string | undefined;

  const add = (line: string) => {
    const body = line.trim();
    if (body) lines.push(body);
  };

  for (const entry of entries) {
    if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "user") {
        const text = extractTextParts(message.content).join("\n");
        if (text.trim()) add(`User: ${clip(text, 4000)}`);
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
    } else if (entry.type === "compaction") {
      // Only the newest one is useful: each compaction summarizes everything
      // before it, so older ones are subsets of the newest.
      latestCompaction = entry.summary;
    } else if (entry.type === "branch_summary") {
      add(`[abandoned branch] ${clip(entry.summary, 3000)}`);
    } else if (entry.type === "custom_message" && entry.display) {
      // Injected context the model answered (side handoffs, external-change
      // diffs, …). Keep it: later turns often refer to it.
      const text = extractTextParts(entry.content).join("\n");
      if (text.trim())
        add(`[context: ${entry.customType}] ${clip(text, 3000)}`);
    }
  }

  const budget = Math.max(maxChars, 0);
  const tail: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (size + line.length + 1 > budget && tail.length > 0) break;
    tail.unshift(line);
    size += line.length + 1;
  }

  const out: string[] = [];
  if (latestCompaction?.trim()) {
    out.push(`[earlier session summary] ${clip(latestCompaction, 4000)}`, "");
  }
  if (tail.length < lines.length) out.push("[earlier turns omitted]");
  out.push(...tail);
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
  const transcript = buildRecapTranscript(branch);
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
 * "provider/id". Registry reads are sync; undefined just returns null.
 */
export function filterRecapModelCompletions(
  prefix: string,
  registry?: ModelRegistryLike,
): { value: string; label: string }[] | null {
  if (!registry) return null;
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const model of registry.getAvailable()) {
    const ref = `${model.provider}/${model.id}`;
    if (!ref.startsWith(prefix) || seen.has(ref)) continue;
    seen.add(ref);
    matches.push(ref);
  }
  return matches.length > 0
    ? matches.map((ref) => ({ value: ref, label: ref }))
    : null;
}
