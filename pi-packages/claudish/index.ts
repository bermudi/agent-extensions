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

/** Find the most recent user message in the session, for context only. */
function findLastUserQuestion(ctx: ExtensionContext): string | undefined {
  try {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
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
  if (!outcome.ok) {
    debugLog(cfg, `display: skipped — ${outcome.reason}`);
    maybeNotice(ctx, cfg, outcome.reason);
    return;
  }
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
  pi.on("session_start", () => {
    config = loadConfig(configPath).config;
    noticeShown = false;
  });

  // The rewrite block: a custom entry that renders in the TUI but never
  // participates in LLM context, so the transcript keeps the original text.
  pi.registerEntryRenderer<RewriteEntryData>(
    ENTRY_TYPE,
    (entry, { expanded }, theme) => {
      const data = entry.data ?? { text: "", at: 0 };
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

  // Display hook: after an assistant message completes, rewrite it in the
  // background and append the result. Fire-and-forget so the stream and the
  // agent loop are never blocked on the rewriter.
  pi.on("message_end", async (event, ctx) => {
    const cfg = getConfig();
    if (!cfg.enabled || isKillSwitched(cfg)) return;
    if (event.message.role !== "assistant") return;
    // Skip error messages and pure tool-calling messages.
    if ((event.message as { errorMessage?: unknown }).errorMessage) return;

    const text = extractText(event.message.content).trim();
    if (!text || proseLength(text) < cfg.minChars) return;

    const question = findLastUserQuestion(ctx);
    void runDisplayRewrite(pi, ctx, cfg, text, question);
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
      "Control claudish plain-English rewrites: /claudish [on|off|status]",
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
        ctx.ui.notify("claudish: rewrites on", "info");
      } else if (cmd === "off") {
        try {
          mkdirSync(dirname(cfg.offFile), { recursive: true });
          writeFileSync(cfg.offFile, "");
        } catch (err) {
          ctx.ui.notify(`claudish: cannot pause — ${errMessage(err)}`, "error");
          return;
        }
        ctx.ui.notify(
          "claudish: rewrites paused — resume with /claudish on",
          "info",
        );
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
