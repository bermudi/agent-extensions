/**
 * session-search — Full-text search across all pi sessions.
 *
 * Merges session-reference agent tools (session_search, session_read, session_list)
 * with SQLite FTS5 index, TUI overlay, and summarizer.
 *
 * Agent tools use FTS5 as a fast pre-filter when the index is ready, then load
 * actual session files and run rich scoring / snippet extraction. Falls back to
 * full file scan when the index is cold.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  buildSessionSummary,
  clampPositiveInteger,
  compareTimestampDesc,
  findSessionMatch,
  formatConversation,
  hasEntryId,
  isPathWithinDir,
  parseSessionText,
  type ParsedSession,
  type SessionSummary,
  type SessionMatch,
  matchFieldLabel,
  formatSessionDate,
  filterByCwd,
  searchSessions,
  extractText,
} from "./session-utils";

import {
  updateIndex,
  rebuildIndex,
  getStats,
  closeDb,
  search as ftsSearch,
  listRecent as ftsListRecent,
} from "./indexer";

import type { PaletteAction } from "./types";
import { formatDate, shortenProject } from "./types";
import { SessionSearchComponent } from "./component";
import { summarizeSession } from "./summarizer";
import { parseSearchResumePath, quoteCommandArg } from "./resume";
import { generateHandoffPrompt } from "./handoff";

const SESSIONS_DIR = path.join(os.homedir(), ".pi/agent/sessions");
const MAX_SEARCH_RESULTS = 50;
const MAX_LIST_RESULTS = 50;
const MAX_READ_TURNS = 200;

interface CachedSession {
  mtimeMs: number;
  size: number;
  parsed: ParsedSession;
  summary: SessionSummary;
}

const sessionCache = new Map<string, CachedSession>();

// ── UUID resolution ────────────────────────────────────────────────────

/**
 * Check if a query looks like a UUID (full or partial).
 * Requires at least 8 hex chars at the start, optionally followed by
 * hyphens and more hex chars. This avoids false positives on words
 * like "migrate-to-ai-sdk" (which contains non-hex letters like m, g, t).
 */
function looksLikeUuid(query: string): boolean {
  const normalized = query.trim();
  if (normalized.length < 8) return false;
  return /^[0-9a-f]{8}[0-9a-f-]*$/i.test(normalized);
}

/**
 * Resolve a UUID (full or partial prefix) to session file paths.
 * Scans session directory filenames for matching UUIDs.
 * Filenames follow the pattern: `timestamp_UUID.jsonl`
 */
async function resolveSessionByUuid(uuidPrefix: string): Promise<string[]> {
  const normalized = uuidPrefix.toLowerCase().trim();
  const dirs = await fsp.readdir(SESSIONS_DIR).catch(() => [] as string[]);
  const matches: string[] = [];

  for (const dir of dirs) {
    const dirPath = path.join(SESSIONS_DIR, dir);
    try {
      const entries = await fsp.readdir(dirPath);
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        // UUID is in the filename after the underscore: timestamp_UUID.jsonl
        const underscoreIdx = entry.indexOf("_");
        if (underscoreIdx < 0) continue;
        const fileUuid = entry.slice(underscoreIdx + 1, -6).toLowerCase(); // strip .jsonl
        if (fileUuid.startsWith(normalized)) {
          matches.push(path.join(dirPath, entry));
        }
      }
    } catch {
      // skip unreadable directories
    }
  }
  return matches;
}

function parseDetail(raw: unknown): "outline" | "compact" | "full" | undefined {
  if (raw === "outline" || raw === "compact" || raw === "full") return raw;
  return undefined;
}

async function getAllSessionFiles(): Promise<string[]> {
  const dirs = await fsp.readdir(SESSIONS_DIR).catch(() => [] as string[]);
  const files: string[] = [];

  for (const dir of dirs) {
    const dirPath = path.join(SESSIONS_DIR, dir);
    try {
      const entries = await fsp.readdir(dirPath);
      for (const entry of entries) {
        if (entry.endsWith(".jsonl")) {
          files.push(path.join(dirPath, entry));
        }
      }
    } catch {
      // Ignore unreadable directories.
    }
  }

  return files;
}

async function loadSession(filePath: string): Promise<CachedSession | null> {
  let fileStat;
  try {
    fileStat = await fsp.stat(filePath);
  } catch {
    sessionCache.delete(filePath);
    return null;
  }

  if (!fileStat.isFile()) return null;

  const cached = sessionCache.get(filePath);
  if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
    return cached;
  }

  let data: string;
  try {
    data = await fsp.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const parsed = parseSessionText(data);
  if (!parsed) return null;

  const next: CachedSession = {
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    parsed,
    summary: buildSessionSummary(filePath, parsed),
  };
  sessionCache.set(filePath, next);
  if (sessionCache.size > 500) {
    const oldest = [...sessionCache.entries()]
      .sort((a, b) => a[1].mtimeMs - b[1].mtimeMs)
      .slice(0, sessionCache.size - 400);
    for (const [key] of oldest) sessionCache.delete(key);
  }
  return next;
}

async function loadSessionSummaries(): Promise<SessionSummary[]> {
  const files = await getAllSessionFiles();
  const summaries: SessionSummary[] = [];

  for (const file of files) {
    const loaded = await loadSession(file);
    if (loaded) summaries.push(loaded.summary);
  }

  summaries.sort(compareTimestampDesc);
  return summaries;
}

async function resolveSessionFilePath(requestedFile: string): Promise<string> {
  // Accept bare UUIDs — resolve to session file path
  if (!requestedFile.endsWith(".jsonl")) {
    if (looksLikeUuid(requestedFile)) {
      const matches = await resolveSessionByUuid(requestedFile.trim());
      if (matches.length === 1) {
        return matches[0];
      }
      if (matches.length > 1) {
        throw new Error(
          `Multiple sessions match UUID prefix "${requestedFile}". Use a longer prefix or the full UUID.`,
        );
      }
      throw new Error(`No session found with UUID "${requestedFile}".`);
    }
    throw new Error(
      "Provide an absolute .jsonl file path or a session UUID (8+ hex characters).",
    );
  }

  const resolvedSessionsDir = await fsp.realpath(SESSIONS_DIR).catch(() => SESSIONS_DIR);
  const resolvedCandidate = path.resolve(requestedFile);
  if (!isPathWithinDir(resolvedSessionsDir, resolvedCandidate)) {
    throw new Error("Session file must live under ~/.pi/agent/sessions");
  }

  const realCandidate = await fsp.realpath(resolvedCandidate).catch(() => {
    throw new Error("Session file not found");
  });

  if (!realCandidate.endsWith(".jsonl") || !isPathWithinDir(resolvedSessionsDir, realCandidate)) {
    throw new Error("Refusing to read files outside ~/.pi/agent/sessions");
  }

  return realCandidate;
}

export default function sessionSearch(pi: ExtensionAPI): void {
  let indexReady = false;
  let indexing = false;

  // Persist pending context across extension reloads when /new is used.
  const PENDING_DIR = path.join(os.homedir(), ".pi", "agent");
  const PENDING_FILE = path.join(PENDING_DIR, ".session-search-pending.json");

  async function ensureIndex(ctx?: ExtensionContext) {
    if (indexing) return;
    indexing = true;

    try {
      await updateIndex((msg) => {
        ctx?.ui?.setStatus("session-search", `🔍 ${msg}`);
      });
      indexReady = true;
    } catch (err) {
      console.warn("[session-search] Index build failed:", err);
    } finally {
      ctx?.ui?.setStatus("session-search", undefined);
      indexing = false;
    }
  }

  // ── Agent tools ─────────────────────────────────────────────────────

  pi.registerTool({
    name: "session_search",
    label: "Search Sessions",
    description:
      "Search past Pi sessions by keyword, partial UUID, cwd path, date, or transcript content. Returns ranked matches with snippets and file paths. Supports direct UUID lookup (full or partial, 8+ hex chars). Uses a fast full-text index when available.",
    parameters: Type.Object({
      query: Type.String({
        description:
          "Search query: keyword, partial/full UUID (8+ hex chars), date, cwd path substring, or transcript text.",
      }),
      limit: Type.Optional(
        Type.Number({
          description: `Max results (default 10, max ${MAX_SEARCH_RESULTS})`,
          default: 10,
        }),
      ),
      cwd_filter: Type.Optional(
        Type.String({
          description: "Optional cwd path substring filter.",
        }),
      ),
      search_tools: Type.Optional(
        Type.Boolean({
          description: "Also search tool-result text (default false).",
          default: false,
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const query = params.query.trim();
      if (!query) {
        return {
          content: [{ type: "text", text: "Query cannot be empty." }],
          isError: true,
          details: undefined,
        };
      }

      const limit = clampPositiveInteger(params.limit, 10, MAX_SEARCH_RESULTS);
      const isUuidQuery = looksLikeUuid(query);

      // Resolve UUID candidates directly from file system.
      // UUIDs are not indexed in FTS5 content, so FTS5 can't find them.
      const uuidFiles = isUuidQuery ? await resolveSessionByUuid(query) : [];

      let candidatePaths: string[];

      if (indexReady) {
        // Fast path: FTS5 pre-filter. Ask for extra candidates because some may
        // drop out during rich scoring (e.g. tool-only matches when search_tools=false).
        try {
          const ftsResults = ftsSearch(query, limit * 5);
          candidatePaths = ftsResults.map((r) => r.sessionPath);
        } catch (err) {
          console.warn("[session-search] FTS search failed, falling back to full scan:", err);
          candidatePaths = await getAllSessionFiles();
        }
      } else {
        candidatePaths = await getAllSessionFiles();
      }

      // Merge UUID file matches into the candidate pool.
      // Without this, UUID queries return 0 results when FTS5 is warm
      // because session UUIDs are not in the FTS5 content index.
      if (uuidFiles.length > 0) {
        const existing = new Set(candidatePaths);
        for (const f of uuidFiles) {
          if (!existing.has(f)) candidatePaths.push(f);
        }
      }

      // Enrich candidates into SessionSummary objects (cached reads)
      const summaries: SessionSummary[] = [];
      for (const file of candidatePaths) {
        const loaded = await loadSession(file);
        if (loaded) summaries.push(loaded.summary);
      }

      const hits = searchSessions(summaries, query, {
        cwdFilter: params.cwd_filter,
        limit,
        searchTools: params.search_tools ?? false,
      });

      if (hits.length === 0) {
        const scopeText = params.cwd_filter ? ` within cwd matching "${params.cwd_filter}"` : "";
        return {
          content: [
            {
              type: "text",
              text: `No sessions found matching "${query}"${scopeText}. Try a different keyword, a partial UUID, or enable search_tools for tool output.`,
            },
          ],
          details: undefined,
        };
      }

      const text = hits
        .map(({ summary, match }, index) => {
          const label = summary.name || summary.firstUserMessage || "(unnamed)";
          const lines = [
            `## ${index + 1}. ${label}`,
            `- **Date:** ${formatSessionDate(summary.timestamp)}`,
            `- **CWD:** ${summary.cwd}`,
            `- **UUID:** ${summary.id}`,
            `- **File:** ${summary.file}`,
            `- **First message:** ${summary.firstUserMessage || "(empty)"}`,
            `- **Match:** ${matchFieldLabel(match.field)} — ${match.snippet}`,
          ];
          if (match.entryId) {
            lines.push(`- **Entry ID:** ${match.entryId}`);
          }
          return lines.join("\n");
        })
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text:
              `Found ${hits.length} session(s):\n\n${text}\n\n` +
              "Use session_read with the file path to read the matching session. If a result includes Entry ID, pass it as entry_id to read the matching branch.",
          },
        ],
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "session_read",
    label: "Read Session",
    description:
      "Read the conversation from a past Pi session. Accepts an absolute .jsonl file path or a bare session UUID (8+ hex characters). Progressive disclosure: start with detail='outline' (default) to get the conversation skeleton with entry IDs, then drill into specific entries using entry_id + window.",
    parameters: Type.Object({
      file: Type.String({
        description: "Absolute path to the session .jsonl file, or a bare session UUID (8+ hex characters)",
      }),
      entry_id: Type.Optional(
        Type.String({
          description: "Optional entry ID from session_search. Reads the branch anchored at that matching entry.",
        }),
      ),
      detail: Type.Optional(
        Type.Union([Type.Literal("outline"), Type.Literal("compact"), Type.Literal("full")], {
          description:
            "Detail level. 'outline' (default): conversation skeleton with entry IDs, user/assistant text truncated to ~150 chars, tool names only, no results — ideal for surveying a session. 'compact': ~500 chars per message, truncated tool args/results. 'full': untruncated. Use outline first, then drill into specific entry_ids with window.",
          default: "outline",
        }),
      ),
      window: Type.Optional(
        Type.Number({
          description:
            "When entry_id is given, return this many user turns around it instead of the whole branch. E.g. window=3 returns 3 turns before + 3 after the entry. Default: all turns on the branch.",
        }),
      ),
      max_turns: Type.Optional(
        Type.Number({
          description: `Max user turns (default 50, max ${MAX_READ_TURNS})`,
          default: 50,
        }),
      ),
      include_tools: Type.Optional(
        Type.Boolean({
          description: "Include tool calls and results (default false). Ignored in outline mode — tool names are always shown.",
          default: false,
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      let filePath: string;
      try {
        filePath = await resolveSessionFilePath(params.file);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to resolve session file: ${message}` }],
          isError: true,
          details: undefined,
        };
      }

      const loaded = await loadSession(filePath);
      if (!loaded) {
        return {
          content: [{ type: "text", text: "Failed to parse session file." }],
          isError: true,
          details: undefined,
        };
      }

      if (params.entry_id && !hasEntryId(loaded.parsed, params.entry_id)) {
        return {
          content: [{ type: "text", text: `Entry ID ${params.entry_id} was not found in that session.` }],
          isError: true,
          details: undefined,
        };
      }

      const maxTurns = clampPositiveInteger(params.max_turns, 50, MAX_READ_TURNS);
      const conversation = formatConversation(loaded.parsed, {
        includeTools: params.include_tools ?? false,
        maxTurns,
        entryId: params.entry_id,
        detail: parseDetail(params.detail),
        window: params.window,
      });

      const headerInfo = [
        `Session ${loaded.summary.id}`,
        `CWD: ${loaded.summary.cwd}`,
        `Created: ${formatSessionDate(loaded.summary.timestamp)}`,
        conversation.leafEntryId ? `Branch leaf: ${conversation.leafEntryId}` : undefined,
      ]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .join(" | ");

      if (!conversation.text.trim()) {
        return {
          content: [{ type: "text", text: `${headerInfo}\n\n(No conversation messages found on that branch.)` }],
          details: undefined,
        };
      }

      return {
        content: [{ type: "text", text: `${headerInfo}\n\n---\n${conversation.text}` }],
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "session_list",
    label: "List Recent Sessions",
    description:
      "List recent Pi sessions, optionally filtered by project path. Returns session metadata sorted by timestamp. Uses the full-text index when available.",
    parameters: Type.Object({
      cwd_filter: Type.Optional(
        Type.String({
          description: "Filter by project path substring",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: `Max results (default 20, max ${MAX_LIST_RESULTS})`,
          default: 20,
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const limit = clampPositiveInteger(params.limit, 20, MAX_LIST_RESULTS);
      let summaries: SessionSummary[];

      if (indexReady) {
        try {
          const recent = ftsListRecent(limit * 2);
          const loaded = await Promise.all(recent.map((r) => loadSession(r.sessionPath)));
          summaries = loaded
            .filter((c): c is CachedSession => c !== null)
            .map((c) => c.summary)
            .sort(compareTimestampDesc)
            .slice(0, limit);
        } catch (err) {
          console.warn("[session-search] FTS list failed, falling back to full scan:", err);
          summaries = await loadSessionSummaries();
        }
      } else {
        summaries = await loadSessionSummaries();
      }

      summaries = filterByCwd(summaries, params.cwd_filter).slice(0, limit);

      if (summaries.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: params.cwd_filter
                ? `No sessions found for project matching "${params.cwd_filter}".`
                : "No sessions found.",
            },
          ],
          details: undefined,
        };
      }

      const text = summaries
        .map((summary, index) => {
          const label = summary.name || summary.firstUserMessage.slice(0, 80) || "(empty)";
          return [
            `${index + 1}. **${label}** — ${formatSessionDate(summary.timestamp)}`,
            `   CWD: ${summary.cwd}`,
            `   UUID: ${summary.id}`,
            `   File: ${summary.file}`,
          ].join("\n");
        })
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `**${summaries.length} session(s):**\n\n${text}\n\nUse session_read with the file path to read a session's conversation.`,
          },
        ],
        details: undefined,
      };
    },
  });

  // ── Hooks ───────────────────────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    // Build index in the background without binding ctx — the old ctx becomes
    // stale if the session is replaced or reloaded before the timer fires.
    setTimeout(() => ensureIndex(), 100);

    // Inject summary into newly created sessions that were queued via "New + Context".
    if (!('reason' in (event as unknown as Record<string, unknown>) && (event as unknown as Record<string, unknown>).reason === "new")) return;

    try {
      const raw = await fsp.readFile(PENDING_FILE, "utf8");
      const pending = JSON.parse(raw);

      if (
        typeof pending !== "object" || pending === null ||
        typeof pending.sessionPath !== "string" ||
        typeof pending.project !== "string" ||
        typeof pending.timestamp !== "string" ||
        typeof pending.createdAt !== "number"
      ) {
        await fsp.unlink(PENDING_FILE).catch(() => {});
        return;
      }

      // Ignore stale pending files (> 5 minutes)
      if (Date.now() - pending.createdAt > 5 * 60 * 1000) {
        await fsp.unlink(PENDING_FILE).catch(() => {});
        return;
      }

      await fsp.unlink(PENDING_FILE).catch(() => {});

      const session = {
        sessionPath: pending.sessionPath,
        project: pending.project,
        timestamp: pending.timestamp,
      };

      const project = shortenProject(session.project, 40);
      ctx.ui.setStatus("session-search", `🔍 Summarizing ${project}...`);

      try {
        const summary = await summarizeSession(session, ctx, pending.customPrompt);

        pi.sendMessage(
          {
            customType: "session-search-context",
            content:
              `## Session Summary: ${session.project}\n` +
              `**Date:** ${formatDate(session.timestamp)} | **File:** ${session.sessionPath}\n\n` +
              summary,
            display: true,
          },
          { triggerTurn: false },
        );
      } catch (err) {
        console.warn("[session-search] Summary failed, falling back:", err);
        // Fallback: ask the LLM to read the file directly
        pi.sendMessage(
          {
            customType: "session-search-context",
            content:
              `Summary failed. Please read this session file and summarize:\n` +
              `- **Project:** ${session.project}\n` +
              `- **Date:** ${formatDate(session.timestamp)}\n` +
              `- **Session file:** ${session.sessionPath}`,
            display: true,
          },
          { triggerTurn: true },
        );
      } finally {
        ctx.ui.setStatus("session-search", undefined);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[session-search] Error reading pending context file:", err);
      }
    }
  });

  pi.on("session_shutdown", async () => {
    closeDb();
  });

  // ── Open search overlay ─────────────────────────────────────────────

  async function openSearch(ctx: ExtensionContext) {
    if (!indexReady && !indexing) {
      ctx.ui.setStatus("session-search", "🔍 Building index...");
      await ensureIndex(ctx);
    }

    const action = await ctx.ui.custom<PaletteAction>(
      (tui, theme, _kb, done) => new SessionSearchComponent(done, tui, theme, ctx.cwd),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center" as const,
          width: 84,
        } as Record<string, unknown>,
      },
    );

    if (action.type === "cancel") return;

    if (action.type === "resume") {
      const sessionPath = action.session.sessionPath;
      const project = shortenProject(action.session.project, 40);

      const commandCtx = ctx as ExtensionContext & Partial<ExtensionCommandContext>;
      if (typeof commandCtx.switchSession === "function") {
        try {
          const result = await commandCtx.switchSession(sessionPath);
          if (!result.cancelled) {
            // Session switched — old ctx is stale, must not touch it.
            return;
          }
        } catch (err) {
          ctx.ui.notify(`Resume failed: ${err}`, "error");
        }
        return;
      }

      ctx.ui.setEditorText(`/search resume ${quoteCommandArg(sessionPath)}`);
      ctx.ui.notify(`${project} — press Enter to resume this session`, "info");
      return;
    }

    if (action.type === "summarize") {
      const project = shortenProject(action.session.project, 40);
      ctx.ui.setStatus("session-search", `🔍 Summarizing ${project}...`);
      ctx.ui.notify(`Summarizing ${project}...`, "info");

      try {
        const summary = await summarizeSession(action.session, ctx, action.customPrompt);

        pi.sendMessage(
          {
            customType: "session-search-context",
            content:
              `## Session Summary: ${action.session.project}\n` +
              `**Date:** ${formatDate(action.session.timestamp)} | **File:** ${action.session.sessionPath}\n\n` +
              summary,
            display: true,
          },
          { triggerTurn: false, deliverAs: "followUp" },
        );

        ctx.ui.notify(`Summary injected from ${project}`, "info");
      } catch (err) {
        // Ignore stale-context errors — session was replaced while summarizing.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("stale")) {
          ctx.ui.notify(`Summary failed: ${err}`, "error");
        }
      } finally {
        try {
          ctx.ui.setStatus("session-search", undefined);
        } catch {
          /* stale context after session switch */
        }
      }
      return;
    }

    if (action.type === "newSession") {
      const project = shortenProject(action.session.project, 40);

      // Persist to disk so we survive the extension reload on /new.
      // session_start will pick this up in the new session.
      await fsp.mkdir(PENDING_DIR, { recursive: true });
      await fsp.writeFile(
        PENDING_FILE,
        JSON.stringify({
          sessionPath: action.session.sessionPath,
          project: action.session.project,
          timestamp: action.session.timestamp,
          customPrompt: action.customPrompt,
          createdAt: Date.now(),
        }),
        "utf8",
      );

      // Pre-fill /new and tell the user to press Enter
      ctx.ui.setEditorText(`/new`);
      ctx.ui.notify(`${project} — press Enter to start new session with context`, "info");
      return;
    }
  }

  // ── /search command ─────────────────────────────────────────────────

  pi.registerCommand("search", {
    description: "Full-text search across all pi sessions",
    handler: async (args, ctx) => {
      const trimmedArgs = args?.trim() ?? "";
      const resumePath = parseSearchResumePath(trimmedArgs);

      if (resumePath !== null) {
        if (!resumePath) {
          ctx.ui.notify("Usage: /search resume <sessionPath>", "warning");
          return;
        }

        try {
          const result = await ctx.switchSession(resumePath);
          if (!result.cancelled) {
            // Session switched — old ctx is stale, must not touch it.
            return;
          }
        } catch (err) {
          ctx.ui.notify(`Resume failed: ${err}`, "error");
        }
        return;
      }

      if (trimmedArgs === "reindex") {
        ctx.ui.notify("Rebuilding index from scratch...", "info");
        indexReady = false;
        try {
          const count = await rebuildIndex((msg) => ctx.ui.notify(msg, "info"));
          indexReady = true;
          ctx.ui.notify(`Rebuilt index: ${count} sessions`, "info");
        } catch (err) {
          ctx.ui.notify(`Reindex failed: ${err}`, "error");
        }
        return;
      }

      if (trimmedArgs === "stats") {
        try {
          const stats = getStats();
          ctx.ui.notify(
            `Sessions: ${stats.totalSessions} | Chunks: ${stats.totalChunks} | Updated: ${stats.lastUpdated ?? "never"}`,
            "info",
          );
        } catch (err) {
          ctx.ui.notify(`Stats failed: ${err}`, "error");
        }
        return;
      }

      await openSearch(ctx as ExtensionContext);
    },
  });

  // ── /handoff command ──────────────────────────────────────────────────

  pi.registerCommand("handoff", {
    description: "Generate a goal-directed handoff from the current session to a new one",
    handler: async (args, ctx) => {
      const commandCtx = ctx as ExtensionCommandContext;
      const currentFile = ctx.sessionManager.getSessionFile();
      if (!currentFile) {
        ctx.ui.notify("No active session to handoff from", "warning");
        return;
      }

      const sessionId = ctx.sessionManager.getSessionId();
      const cwd = ctx.cwd;

      // Extract timestamp from the session file header (first line)
      // instead of loading the full session through loadSession.
      let timestamp: string;
      try {
        const headerLine = (await fsp.readFile(currentFile, "utf8")).split("\n")[0];
        const header = JSON.parse(headerLine);
        timestamp = header.timestamp ?? new Date().toISOString();
      } catch {
        timestamp = new Date().toISOString();
      }

      const goal = args?.trim() || undefined;
      const MAX_GOAL_LENGTH = 2000;
      if (goal && goal.length > MAX_GOAL_LENGTH) {
        ctx.ui.notify(`Goal too long (${goal.length} chars, max ${MAX_GOAL_LENGTH})`, "warning");
        return;
      }
      const project = shortenProject(cwd, 40);

      ctx.ui.setStatus("session-search", `🔄 Generating handoff${goal ? ` for: ${goal.slice(0, 50)}` : ""}...`);
      ctx.ui.notify(`Generating handoff from ${project}...`, "info");

      try {
        const handoffPrompt = await generateHandoffPrompt(
          currentFile,
          sessionId,
          cwd,
          timestamp,
          ctx as ExtensionContext,
          goal,
        );

        // Create new session linked to current via parentSession.
        // Cast to access withSession — available at runtime but not in the
        // installed @mariozechner/pi-coding-agent type definitions.
        const result = await (commandCtx as any).newSession({
          parentSession: currentFile,
          withSession: async (newCtx: any) => {
            // Inject handoff summary as a custom message (visible to model)
            // ReplacedSessionContext has sendMessage + ui — available at runtime
            // but not in the installed type definitions.
            await newCtx.sendMessage(
              {
                customType: "session-search-handoff",
                content:
                  `## Handoff from ${project}\n` +
                  `**Session:** ${sessionId} | **Date:** ${formatDate(timestamp)}\n\n` +
                  handoffPrompt,
                display: true,
              },
              { triggerTurn: false, deliverAs: "followUp" },
            );

            // Pre-fill editor with the goal or continuation prompt
            const editorText = goal || "Continue from where we left off";
            newCtx.ui.setEditorText(editorText);
            newCtx.ui.notify(
              `Handoff ready — review the context above, edit the prompt below, and press Enter`,
              "info",
            );
          },
        });

        if (result.cancelled) {
          ctx.ui.notify("Handoff cancelled", "warning");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Handoff failed: ${msg}`, "error");
      } finally {
        try {
          ctx.ui.setStatus("session-search", undefined);
        } catch {
          /* stale context after session switch */
        }
      }
    },
  });

  // ── Custom message renderer ─────────────────────────────────────────

  pi.registerMessageRenderer("session-search-context", (message, options, theme) => {
    const rawContent =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? extractText(message.content)
          : "";

    // Parse from "## Session Summary: project" or "**Project:** project" format
    const summaryMatch = rawContent.match(/Session Summary:\s*(.+)/);
    const projectMatch = rawContent.match(/\*\*Project:\*\*\s*(.+)/);
    const dateMatch = rawContent.match(/\*\*Date:\*\*\s*([^|*]+)/);
    const project = summaryMatch?.[1]?.trim() || projectMatch?.[1]?.trim() || "session";
    const date = dateMatch?.[1]?.trim() || "";

    if (options.expanded) {
      const lines: string[] = [];
      lines.push(
        theme.fg("accent", "🔍 ") +
          theme.fg("customMessageLabel", theme.bold("Session context: ")) +
          theme.fg("accent", project) +
          (date ? theme.fg("muted", ` (${date})`) : ""),
      );

      const bodyStart = rawContent.indexOf("\n\n");
      if (bodyStart >= 0) {
        const body = rawContent.slice(bodyStart + 2).trim();
        if (body) {
          lines.push("");
          lines.push(theme.fg("muted", body));
        }
      }

      return new Text(lines.join("\n"), 0, 0);
    }

    const header =
      theme.fg("accent", "🔍 ") +
      theme.fg("customMessageLabel", theme.bold("Session context: ")) +
      theme.fg("accent", project) +
      (date ? theme.fg("muted", ` (${date})`) : "");

    return new Text(header, 0, 0);
  });

  pi.registerMessageRenderer("session-search-handoff", (message, options, theme) => {
    const rawContent =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? extractText(message.content)
          : "";

    const summaryMatch = rawContent.match(/Handoff from\s+(.+)/);
    const project = summaryMatch?.[1]?.trim() || "session";
    const sessionMatch = rawContent.match(/\*\*Session:\*\*\s*([^|*]+)/);
    const dateMatch = rawContent.match(/\*\*Date:\*\*\s*([^*\n]+)/);
    const sessionId = sessionMatch?.[1]?.trim() || "";
    const date = dateMatch?.[1]?.trim() || "";

    if (options.expanded) {
      const lines: string[] = [];
      lines.push(
        theme.fg("accent", "\u{1F504} ") +
          theme.fg("customMessageLabel", theme.bold("Handoff: ")) +
          theme.fg("accent", project) +
          (date ? theme.fg("muted", ` (${date})`) : ""),
      );

      const bodyStart = rawContent.indexOf("\n\n");
      if (bodyStart >= 0) {
        const body = rawContent.slice(bodyStart + 2).trim();
        if (body) {
          lines.push("");
          lines.push(theme.fg("muted", body));
        }
      }

      return new Text(lines.join("\n"), 0, 0);
    }

    const header =
      theme.fg("accent", "\u{1F504} ") +
      theme.fg("customMessageLabel", theme.bold("Handoff: ")) +
      theme.fg("accent", project) +
      (date ? theme.fg("muted", ` (${date})`) : "");

    return new Text(header, 0, 0);
  });
}
