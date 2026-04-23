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
  isSameProjectPath,
  parseSessionText,
  type ParsedSession,
  type SessionSummary,
  type SessionMatch,
  matchFieldLabel,
  formatSessionDate,
  formatSessionChoiceLabel,
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
  if (!requestedFile.endsWith(".jsonl")) {
    throw new Error("Session files must end in .jsonl");
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
      "Search past Pi sessions by keyword, partial UUID, cwd path, date, or transcript content. Returns ranked matches with snippets and file paths. Uses a fast full-text index when available.",
    parameters: Type.Object({
      query: Type.String({
        description: "Search query: keyword, partial UUID, date, cwd path substring, or transcript text.",
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
      "Read the conversation from a past Pi session file. Provide the session file path from session_search or session_list. Optionally pass entry_id to read the branch containing a specific matched entry.",
    parameters: Type.Object({
      file: Type.String({
        description: "Absolute path to the session .jsonl file",
      }),
      entry_id: Type.Optional(
        Type.String({
          description: "Optional entry ID from session_search. Reads the branch anchored at that matching entry.",
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
          description: "Include tool calls and results (default false)",
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

  // ── /sessions command ───────────────────────────────────────────────

  pi.registerCommand("sessions", {
    description: "Browse and list past sessions",
    handler: async (args, ctx) => {
      const summaries = await loadSessionSummaries();
      if (summaries.length === 0) {
        ctx.ui.notify("No sessions found.", "info");
        return;
      }

      const limit = clampPositiveInteger(args ? Number.parseInt(args, 10) : undefined, 20, MAX_LIST_RESULTS);
      const sameProject = summaries.filter((summary) => isSameProjectPath(summary.cwd, ctx.cwd));
      const hits = (sameProject.length > 0 ? sameProject : summaries).slice(0, limit);

      if (hits.length === 0) {
        ctx.ui.notify("No sessions found for this project.", "info");
        return;
      }

      const labelToFile = new Map<string, string>();
      const items = hits.map((summary) => {
        const label = formatSessionChoiceLabel(summary);
        labelToFile.set(label, summary.file);
        return label;
      });

      const choice = await ctx.ui.select("Sessions:", items);
      const file = choice ? labelToFile.get(choice) : undefined;
      if (file) {
        await ctx.switchSession(file);
      }
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
      console.warn("[session-search] No pending context file:", err);
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
      (tui, theme, _kb, done) => new SessionSearchComponent(done, tui, theme),
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
}
