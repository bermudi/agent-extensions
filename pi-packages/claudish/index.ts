/**
 * claudish — a Pi extension that shows a plain-English rewrite of each
 * assistant message, produced by the current pi model by default (whatever
 * you're chatting with), or optionally via ollama, the Anthropic API, or
 * any OpenAI-compatible API.
 *
 * Port of the Claude Code plugin gvzdv/claudish-to-english.
 *
 * It is display-only for chat: the rewrite is appended as a custom session
 * entry (which never participates in LLM context), so the assistant message
 * and the saved transcript keep the original text. An optional second hook
 * rewrites Markdown files into plain English when they are written or edited
 * (opt-in via `mdDir` in the config file; that hook does change bytes on disk).
 *
 * Configuration lives in `<agentDir>/claudish.json` (no env vars). By default
 * both `model` and `provider` are absent and claudish reuses the session's
 * active model via ModelRegistry. Pin them in the config file to override.
 * When provider is set explicitly, auth is resolved from pi's model registry.
 *
 * Every hook fails open — if anything goes wrong (provider down, timeout,
 * missing key), you simply see the original text.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  isEditToolResult,
  isWriteToolResult,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  CONFIG_FILENAME,
  loadConfig,
  type ClConfig,
  type ClProvider,
} from "./config.ts";
import { rewrite, rewriteViaPi, type RewriteOutcome } from "./providers.ts";
import {
  extractText,
  isInside,
  isMarkdownPath,
  proseLength,
  splitFrontmatter,
} from "./text.ts";

// ── Module state ───────────────────────────────────────────────────────────

/** Config path, resolved once at factory invocation. */
let configPath: string;
/** Cached config, loaded at session_start. */
let config: ClConfig | undefined;
/** Once-per-session skip notice. */
let noticeShown = false;

/** Marker written after the frontmatter in overwrite mode (idempotent). */
export const REWRITE_MARKER = "<!-- claudish-to-english:rewritten -->";

const ENTRY_TYPE = "claudish-rewrite";
const COLLAPSED_MAX_LINES = 14;

interface RewriteEntryData {
  text: string;
  at: number;
  /** While true the entry renders a loading placeholder. Flipped to false when the real text lands. */
  pending?: boolean;
}

/** Live Text refs for pending placeholders so we can mutate them in place without a new entry. */
const pendingPlaceholders = new Map<
  number,
  { box: Box; body: Text; header: Text }
>();

function requestRender(ctx: ExtensionContext): void {
  try {
    // Any status change forces the TUI to requestRender, which re-renders the
    // chat container including our mutated Text nodes. Use a throwaway key.
    ctx.ui.setStatus("claudish-refresh", "·");
    ctx.ui.setStatus("claudish-refresh", undefined);
  } catch {
    // No UI (print/json mode or tests) — nothing to invalidate.
  }
}

function getConfig(): ClConfig {
  if (!config) config = loadConfig(configPath).config;
  return config;
}

function debugLog(cfg: ClConfig, line: string): void {
  if (!cfg.debug) return;
  try {
    const dir = join(tmpdir(), "claudish-to-english");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, "debug.log"),
      `[${new Date().toISOString()}] ${line}\n`,
    );
  } catch {
    // logging must never break the session
  }
}

/** Kill switch: while the off file exists, rewrites pause (re-checked per event). */
function isKillSwitched(cfg: ClConfig): boolean {
  try {
    return existsSync(cfg.offFile);
  } catch {
    return false;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function maybeNotice(
  ctx: ExtensionContext,
  cfg: ClConfig,
  message: string,
): void {
  if (!cfg.notice || noticeShown) return;
  noticeShown = true;
  try {
    ctx.ui.notify(
      `claudish: ${message} — original text shown unchanged`,
      "warning",
    );
  } catch {
    // UI can be unavailable in print/json modes; ignore
  }
}

function truncateLines(s: string, max: number): string {
  const lines = s.split("\n");
  if (lines.length <= max) return s;
  const extra = lines.length - max;
  return (
    lines.slice(0, max).join("\n") +
    `\n… (${extra} more lines — expand to view)`
  );
}

/**
 * Find the most recent user message at or before session index `from`,
 * for context only.
 */
function findUserQuestionBefore(
  ctx: ExtensionContext,
  from: number,
): string | undefined {
  try {
    const entries = ctx.sessionManager.getEntries();
    for (let i = Math.min(from, entries.length - 1); i >= 0; i--) {
      const e = entries[i];
      if (e && e.type === "message" && e.message?.role === "user") {
        const text = extractText(e.message.content).trim();
        if (text) return text;
      }
    }
  } catch {
    // the question is only context — fail open
  }
  return undefined;
}

/** Find the most recent user message in the session, for context only. */
function findLastUserQuestion(ctx: ExtensionContext): string | undefined {
  return findUserQuestionBefore(ctx, Number.MAX_SAFE_INTEGER);
}

/**
 * Find the last assistant message entry that carries text, skipping error
 * messages and tool-call-only messages. Returns the text and its session
 * index so callers can inspect the entries that follow the message.
 */
function findLastAssistantMessage(
  ctx: ExtensionContext,
): { text: string; index: number } | undefined {
  try {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] as unknown as {
        type: string;
        message?: { role: string; content: unknown; errorMessage?: unknown };
      };
      if (
        e.type === "message" &&
        e.message?.role === "assistant" &&
        !e.message.errorMessage
      ) {
        const t = extractText(e.message.content).trim();
        if (t) return { text: t, index: i };
      }
    }
  } catch {
    // fail open — nothing to explain
  }
  return undefined;
}

/** Atomic write: temp file + rename, so a failure never leaves a partial doc. */
function writeAtomic(target: string, content: string): void {
  const tmp = `${target}.claudish-tmp`;
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// ── Runtime resolution ─────────────────────────────────────────────────────

/** Resolve the pi model to use when provider is not pinned. */
function resolvePiModel(
  cfg: ClConfig,
  ctx: ExtensionContext,
): NonNullable<ExtensionContext["model"]> | undefined {
  if (cfg.model) {
    const found = ctx.modelRegistry
      .getAll()
      .find((m) => (m as { id: string }).id === cfg.model);
    if (found) return found as NonNullable<ExtensionContext["model"]>;
    return undefined;
  }
  return ctx.model as NonNullable<ExtensionContext["model"]> | undefined;
}

/**
 * Resolve the provider, model, and API key for the explicit fetch path
 * (when cfg.provider is set). Auth comes from pi's model registry, never
 * from config.
 */
async function resolveFetchRuntime(
  cfg: ClConfig,
  ctx: ExtensionContext,
): Promise<{
  provider: ClProvider;
  model: string;
  apiKey: string | undefined;
}> {
  const provider = cfg.provider as ClProvider;
  const model: string = cfg.model ?? ctx.model?.id ?? "";

  // Resolve auth from pi's model registry for cloud providers. Ollama is
  // local and keyless.
  let apiKey: string | undefined;
  if (provider === "anthropic" || provider === "openai") {
    try {
      apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
    } catch {
      // fail open — rewrite will report the missing key
    }
  }

  return { provider, model, apiKey };
}

// ── Rewrite flows ──────────────────────────────────────────────────────────

async function runDisplayRewrite(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  cfg: ClConfig,
  text: string,
  question: string | undefined,
): Promise<void> {
  // Show a placeholder immediately so the user sees feedback before the LLM
  // round-trip completes (the old flow only appended after the rewrite, leaving
  // ~5-10s of silence). The placeholder is a single custom entry that we
  // mutate in place when the real text lands, so no second entry is needed.
  // Add a fractional random to avoid at collisions when two messages settle
  // in the same millisecond (map key would otherwise overwrite).
  const at = Date.now() + Math.random();
  const placeholderData: RewriteEntryData = { text: "", at, pending: true };
  let placeholderAppended = false;
  try {
    pi.appendEntry<RewriteEntryData>(ENTRY_TYPE, placeholderData);
    placeholderAppended = true;
    debugLog(cfg, `display: placeholder appended for ${text.length} chars`);
  } catch (err) {
    debugLog(cfg, `display: failed to append placeholder — ${errMessage(err)}`);
  }

  debugLog(cfg, `display: rewriting assistant message (${text.length} chars)`);
  let outcome: RewriteOutcome;
  if (cfg.provider) {
    const { provider, model, apiKey } = await resolveFetchRuntime(cfg, ctx);
    outcome = await rewrite({
      config: cfg,
      text,
      userQuestion: question,
      timeoutMs: cfg.displayTimeoutMs,
      provider,
      model,
      apiKey,
    });
  } else {
    const target = resolvePiModel(cfg, ctx);
    outcome = await rewriteViaPi({
      config: cfg,
      text,
      userQuestion: question,
      timeoutMs: cfg.displayTimeoutMs,
      model: target,
      registry: ctx.modelRegistry,
    });
  }

  const pending = pendingPlaceholders.get(at);

  if (!outcome.ok) {
    debugLog(cfg, `display: skipped — ${outcome.reason}`);
    maybeNotice(ctx, cfg, outcome.reason);
    // Fail-open: hide the placeholder so the original text stands alone.
    if (pending) {
      try {
        pending.body.setText("");
        pending.header.setText("");
        pending.box.invalidate();
        requestRender(ctx);
      } catch {}
      pendingPlaceholders.delete(at);
    } else if (placeholderAppended) {
      // Headless / test harness: no live component, mutate the placeholder
      // object directly (same ref as in appended[] / sessionManager).
      placeholderData.text = "";
      placeholderData.pending = false;
    }
    // Persist the hidden state so a reload doesn't resurrect the spinner.
    try {
      const entries = ctx.sessionManager.getEntries();
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i] as unknown as {
          type: string;
          customType?: string;
          data?: RewriteEntryData;
        };
        if (
          e.type === "custom" &&
          e.customType === ENTRY_TYPE &&
          e.data?.at === at
        ) {
          e.data.pending = false;
          e.data.text = "";
          break;
        }
      }
    } catch {}
    return;
  }

  // Success: populate the placeholder in place.
  if (pending) {
    try {
      // Persist for reloads / export.
      const entries = ctx.sessionManager.getEntries();
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i] as unknown as {
          type: string;
          customType?: string;
          data?: RewriteEntryData;
        };
        if (
          e.type === "custom" &&
          e.customType === ENTRY_TYPE &&
          e.data?.at === at
        ) {
          e.data.text = outcome.text;
          e.data.pending = false;
          break;
        }
      }
    } catch {}
    try {
      // Show truncated in the collapsed view; the full text is in data.text
      // so a future rebuild (expand toggle, theme change) renders correctly.
      const collapsed = truncateLines(outcome.text, COLLAPSED_MAX_LINES);
      pending.body.setText(collapsed);
      pending.box.invalidate();
      requestRender(ctx);
    } catch {}
    pendingPlaceholders.delete(at);
    debugLog(
      cfg,
      `display: populated placeholder (${outcome.text.length} chars)`,
    );
    return;
  }

  if (placeholderAppended) {
    // No live component (headless / tests) — mutate the placeholder we already
    // appended. This keeps the invariant of one entry per rewrite.
    placeholderData.text = outcome.text;
    placeholderData.pending = false;
    try {
      const entries = ctx.sessionManager.getEntries();
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i] as unknown as {
          type: string;
          customType?: string;
          data?: RewriteEntryData;
        };
        if (
          e.type === "custom" &&
          e.customType === ENTRY_TYPE &&
          e.data?.at === at
        ) {
          e.data.text = outcome.text;
          e.data.pending = false;
          break;
        }
      }
    } catch {}
    debugLog(
      cfg,
      `display: populated placeholder (headless, ${outcome.text.length} chars)`,
    );
    return;
  }

  // Placeholder never appended (shouldn't happen) — fall back to appending.
  try {
    pi.appendEntry<RewriteEntryData>(ENTRY_TYPE, {
      text: outcome.text,
      at: Date.now(),
    });
    debugLog(cfg, `display: appended rewrite (${outcome.text.length} chars)`);
  } catch (err) {
    debugLog(cfg, `display: failed to append entry — ${errMessage(err)}`);
  }
}

async function runMdRewrite(
  ctx: ExtensionContext,
  cfg: ClConfig,
  absPath: string,
  frontmatter: string,
  body: string,
): Promise<void> {
  debugLog(cfg, `md: rewriting ${absPath}`);
  let outcome: RewriteOutcome;
  if (cfg.provider) {
    const { provider, model, apiKey } = await resolveFetchRuntime(cfg, ctx);
    outcome = await rewrite({
      config: cfg,
      text: body,
      timeoutMs: cfg.mdTimeoutMs,
      provider,
      model,
      apiKey,
    });
  } else {
    const target = resolvePiModel(cfg, ctx);
    outcome = await rewriteViaPi({
      config: cfg,
      text: body,
      timeoutMs: cfg.mdTimeoutMs,
      model: target,
      registry: ctx.modelRegistry,
    });
  }
  if (!outcome.ok) {
    debugLog(cfg, `md: skipped — ${outcome.reason}`);
    maybeNotice(ctx, cfg, outcome.reason);
    return;
  }
  try {
    if (cfg.mdMode === "overwrite") {
      // Marker after any frontmatter so the frontmatter stays on line 1.
      writeAtomic(absPath, frontmatter + REWRITE_MARKER + "\n" + outcome.text);
      debugLog(cfg, `md: overwrote ${absPath}`);
    } else {
      const dir = dirname(absPath);
      const base = basename(absPath, ".md");
      const sibling = join(dir, `${base}.${cfg.mdSuffix}.md`);
      writeAtomic(sibling, frontmatter + outcome.text);
      debugLog(cfg, `md: wrote sibling ${sibling}`);
    }
  } catch (err) {
    debugLog(cfg, `md: write failed — ${errMessage(err)}`);
  }
}

// ── Extension ──────────────────────────────────────────────────────────────

export interface ClaudishOptions {
  /** Internal seam used by tests; normal callers use Pi's global agent dir. */
  configPath?: string;
}

export default function (pi: ExtensionAPI, options: ClaudishOptions = {}) {
  configPath = options.configPath ?? join(getAgentDir(), CONFIG_FILENAME);

  // Read config at session start; reset the once-per-session notice.
  pi.on("session_start", (_event, ctx) => {
    config = loadConfig(configPath).config;
    noticeShown = false;
    pendingPlaceholders.clear();
    lastHandledText = undefined;
    lastHandledAt = 0;
    // A pending rewrite entry in a freshly loaded session was written by a
    // previous process that died mid-rewrite (crash/kill) — its rewrite can
    // never land. Flip it to the hidden failed state so it doesn't render an
    // eternal spinner and doesn't make /claudish explain report "already
    // running" forever.
    try {
      const entries = ctx.sessionManager.getEntries();
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i] as unknown as {
          type: string;
          customType?: string;
          data?: RewriteEntryData;
        };
        if (
          e.type === "custom" &&
          e.customType === ENTRY_TYPE &&
          e.data?.pending
        ) {
          e.data.pending = false;
          e.data.text = "";
        }
      }
    } catch {
      // fail open — worst case is the old eternal-spinner behavior
    }
  });

  // The rewrite block: a custom entry that renders in the TUI but never
  // participates in LLM context, so the transcript keeps the original text.
  // While pending it shows a spinner; once the rewrite lands the same entry
  // is mutated in place (no second entry) and the TUI is nudged to re-render.
  pi.registerEntryRenderer<RewriteEntryData>(
    ENTRY_TYPE,
    (entry, { expanded }, theme) => {
      const data = entry.data ?? { text: "", at: 0 };
      if (data.pending) {
        const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
        const header = new Text(
          theme.fg("accent", theme.bold("💬 In plain English:")),
          0,
          0,
        );
        box.addChild(header);
        const body = new Text(
          theme.fg("muted", "⏳ Translating to plain English…"),
          0,
          0,
        );
        box.addChild(body);
        pendingPlaceholders.set(data.at, { box, body, header });
        return box;
      }
      // Hidden placeholder (failed rewrite) — render nothing but keep the
      // entry so the session stays append-only; the Spacer in
      // CustomEntryComponent will still add one blank line which is harmless.
      if (!data.text) return undefined;
      const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
      box.addChild(
        new Text(theme.fg("accent", theme.bold("💬 In plain English:")), 0, 0),
      );
      const body = expanded
        ? data.text
        : truncateLines(data.text, COLLAPSED_MAX_LINES);
      box.addChild(new Text(body, 0, 0));
      return box;
    },
  );

  // Deduplicate message_end vs agent_settled for the same final message.
  let lastHandledText: string | undefined;
  let lastHandledAt = 0;

  async function handleAssistantText(
    text: string,
    ctx: ExtensionContext,
  ): Promise<void> {
    const cfg = getConfig();
    if (!cfg.enabled || isKillSwitched(cfg)) return;
    if (!text || proseLength(text) < cfg.minChars) return;
    // Avoid double placeholder for the same final message (message_end + agent_settled).
    const now = Date.now();
    if (text === lastHandledText && now - lastHandledAt < 5000) return;
    lastHandledText = text;
    lastHandledAt = now;
    const question = findLastUserQuestion(ctx);
    void runDisplayRewrite(pi, ctx, cfg, text, question);
  }

  /**
   * On-demand rewrite of the last assistant message (/claudish explain) —
   * the manual override for "the turn settled before claudish could run":
   * the extension was loaded after the fact, the kill switch was on, or the
   * automatic rewrite failed open. Bypasses the off-file kill switch (an
   * explicit request is the consent) but honors the enabled master switch.
   */
  async function explainLastMessage(ctx: ExtensionContext): Promise<void> {
    const cfg = getConfig();
    if (!cfg.enabled) {
      ctx.ui.notify(
        'claudish: enabled=false in config — set "enabled": true to use /claudish explain',
        "warning",
      );
      return;
    }
    const found = findLastAssistantMessage(ctx);
    if (!found) {
      ctx.ui.notify(
        "claudish: no assistant message to explain in this session",
        "warning",
      );
      return;
    }
    // Skip when this message already has a rewrite or one is in flight; a
    // failed (hidden) rewrite does not count, so explain doubles as a retry.
    try {
      const entries = ctx.sessionManager.getEntries();
      let inFlight = false;
      let explained = false;
      for (let i = found.index + 1; i < entries.length; i++) {
        const e = entries[i] as unknown as {
          type: string;
          customType?: string;
          data?: RewriteEntryData;
        };
        if (e.type === "custom" && e.customType === ENTRY_TYPE) {
          if (e.data?.pending) inFlight = true;
          if (e.data?.text) explained = true;
        }
      }
      if (inFlight) {
        ctx.ui.notify(
          "claudish: a rewrite of the last message is already running",
          "info",
        );
        return;
      }
      if (explained) {
        ctx.ui.notify(
          "claudish: last assistant message already has a rewrite",
          "info",
        );
        return;
      }
    } catch {
      // scan failed — proceed; worst case is a duplicate rewrite
    }
    if (proseLength(found.text) < cfg.minChars) {
      ctx.ui.notify(
        `claudish: last assistant message is too short to explain (prose < minChars=${cfg.minChars})`,
        "warning",
      );
      return;
    }
    const question = findUserQuestionBefore(ctx, found.index - 1);
    // Mark as handled so a concurrent agent_settled cannot double-fire.
    lastHandledText = found.text;
    lastHandledAt = Date.now();
    void runDisplayRewrite(pi, ctx, cfg, found.text, question);
  }

  // Display hook: after an assistant message completes, show a placeholder
  // immediately and rewrite in the background. Fire-and-forget so the stream
  // and the agent loop are never blocked.
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if ((event.message as { errorMessage?: unknown }).errorMessage) return;
    const text = extractText(event.message.content).trim();
    await handleAssistantText(text, ctx);
  });

  // Also trigger on agent_settled so the placeholder appears as soon as the
  // agent is idle, even if the final message was streamed in chunks. The
  // deduplication above prevents a second placeholder for the same text.
  pi.on("agent_settled", async (_event, ctx) => {
    const found = findLastAssistantMessage(ctx);
    if (!found) return;
    await handleAssistantText(found.text, ctx);
  });

  // Markdown file hook (opt-in via mdDir in config): rewrite *.md files
  // written or edited inside the directory. This hook does change bytes.
  pi.on("tool_result", async (event, ctx) => {
    const cfg = getConfig();
    if (!cfg.enabled || !cfg.mdDir || isKillSwitched(cfg)) return;

    // The tool schemas guarantee `path: string`; ToolResultEventBase types it
    // as unknown, so narrow explicitly.
    let relPath: string | undefined;
    if (isWriteToolResult(event)) relPath = event.input.path as string;
    else if (isEditToolResult(event)) relPath = event.input.path as string;
    if (!relPath) return;

    const abs = resolve(ctx.cwd, relPath);
    if (!isMarkdownPath(abs)) return;
    // Resolve a relative mdDir against the session cwd, not the process cwd
    // (they can differ). Absolute paths (the common case, including any
    // ~/expanded value) are used as-is.
    const mdDir = isAbsolute(cfg.mdDir)
      ? cfg.mdDir
      : resolve(ctx.cwd, cfg.mdDir);
    if (!isInside(mdDir, abs)) return;

    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      return; // not readable — fail open
    }

    const { frontmatter, body } = splitFrontmatter(content);
    if (cfg.mdMode === "overwrite" && content.includes(REWRITE_MARKER)) return;
    if (proseLength(body) < cfg.minChars) return;

    void runMdRewrite(ctx, cfg, abs, frontmatter, body);
  });

  // Convenience kill switch, pi-native equivalent of touch/rm on the off file.
  pi.registerCommand("claudish", {
    description:
      "Control claudish plain-English rewrites: /claudish [on|off|status|explain] — explain rewrites the last assistant message on demand",
    handler: async (args, ctx) => {
      const cfg = getConfig();
      const cmd = (args?.trim() || "status").toLowerCase();
      if (cmd === "on") {
        try {
          rmSync(cfg.offFile, { force: true });
        } catch (err) {
          ctx.ui.notify(
            `claudish: cannot resume — ${errMessage(err)}`,
            "error",
          );
          return;
        }
        ctx.ui.notify("claudish: automatic rewrites on", "info");
      } else if (cmd === "off") {
        try {
          mkdirSync(dirname(cfg.offFile), { recursive: true });
          writeFileSync(cfg.offFile, "");
        } catch (err) {
          ctx.ui.notify(`claudish: cannot pause — ${errMessage(err)}`, "error");
          return;
        }
        ctx.ui.notify(
          "claudish: automatic rewrites paused — resume with /claudish on",
          "info",
        );
      } else if (cmd === "explain") {
        await explainLastMessage(ctx);
      } else {
        const state = isKillSwitched(cfg)
          ? "paused (off file present)"
          : "active";
        const sessionModel = ctx.model;
        const providerLabel = cfg.provider ?? "pi";
        const modelLabel =
          cfg.model ??
          sessionModel?.id ??
          "(no model — switch to a model or set `model` in claudish.json)";
        const detail = cfg.provider
          ? `${providerLabel}/${modelLabel}`
          : sessionModel
            ? `pi:${sessionModel.provider}/${modelLabel}`
            : `pi/${modelLabel}`;
        ctx.ui.notify(`claudish: ${state} — ${detail}`, "info");
      }
    },
  });
}
