/**
 * Session Reference — lets the agent search and read other Pi sessions as context.
 *
 * Usage: mention a past session in your prompt and the agent will use these tools:
 *   - session_search: find sessions by keyword, UUID, date, cwd, or transcript content
 *   - session_read:   read a session branch/conversation, optionally anchored to a matching entry
 *   - session_list:   list recent sessions
 *
 * Also provides /sessions command for interactive browsing.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
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
  type SearchField,
  type SessionMatch,
  type SessionSummary,
} from "./session-reference-utils.ts";

const SESSIONS_DIR = join(homedir(), ".pi/agent/sessions");
const MAX_SEARCH_RESULTS = 50;
const MAX_LIST_RESULTS = 50;
const MAX_READ_TURNS = 200;

interface CachedSession {
  mtimeMs: number;
  size: number;
  parsed: ParsedSession;
  summary: SessionSummary;
}

interface SearchHit {
  summary: SessionSummary;
  match: SessionMatch;
}

const sessionCache = new Map<string, CachedSession>();

function matchFieldLabel(field: SearchField): string {
  switch (field) {
    case "id":
      return "UUID";
    case "cwd":
      return "CWD";
    case "file":
      return "file path";
    case "timestamp":
      return "timestamp";
    case "name":
      return "session name";
    case "first_user_message":
      return "first user message";
    case "user_message":
      return "user message";
    case "assistant_message":
      return "assistant message";
    case "tool_result":
      return "tool result";
  }
  return field;
}

function formatSessionDate(timestamp: string): string {
  return new Date(timestamp).toLocaleString();
}

function formatSessionChoiceLabel(summary: SessionSummary): string {
  const date = new Date(summary.timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const label = summary.name || summary.firstUserMessage || "(empty)";
  return `${date}  ${label.slice(0, 80)} · ${summary.id.slice(0, 8)}`;
}

async function getAllSessionFiles(): Promise<string[]> {
  const dirs = await readdir(SESSIONS_DIR).catch(() => [] as string[]);
  const files: string[] = [];

  for (const dir of dirs) {
    const dirPath = join(SESSIONS_DIR, dir);
    try {
      const entries = await readdir(dirPath);
      for (const entry of entries) {
        if (entry.endsWith(".jsonl")) {
          files.push(join(dirPath, entry));
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
    fileStat = await stat(filePath);
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
    data = await readFile(filePath, "utf8");
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

  const resolvedSessionsDir = await realpath(SESSIONS_DIR).catch(() => SESSIONS_DIR);
  const resolvedCandidate = resolve(requestedFile);
  if (!isPathWithinDir(resolvedSessionsDir, resolvedCandidate)) {
    throw new Error("Session file must live under ~/.pi/agent/sessions");
  }

  const realCandidate = await realpath(resolvedCandidate).catch(() => {
    throw new Error("Session file not found");
  });

  if (!realCandidate.endsWith(".jsonl") || !isPathWithinDir(resolvedSessionsDir, realCandidate)) {
    throw new Error("Refusing to read files outside ~/.pi/agent/sessions");
  }

  return realCandidate;
}

function filterByCwd(summaries: readonly SessionSummary[], cwdFilter?: string): SessionSummary[] {
  const normalizedFilter = cwdFilter?.trim().toLowerCase();
  if (!normalizedFilter) return [...summaries];
  return summaries.filter((summary) => summary.cwd.toLowerCase().includes(normalizedFilter));
}

function searchSessions(
  summaries: readonly SessionSummary[],
  query: string,
  options: { cwdFilter?: string; limit: number; searchTools?: boolean },
): SearchHit[] {
  const candidates = filterByCwd(summaries, options.cwdFilter);
  const hits: SearchHit[] = [];

  for (const summary of candidates) {
    const match = findSessionMatch(summary, query, { searchTools: options.searchTools });
    if (!match) continue;
    hits.push({ summary, match });
  }

  hits.sort((left, right) => {
    if (right.match.score !== left.match.score) return right.match.score - left.match.score;
    return compareTimestampDesc(left.summary, right.summary);
  });

  return hits.slice(0, options.limit);
}

export default function (pi: ExtensionAPI) {
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

  pi.registerTool({
    name: "session_search",
    label: "Search Sessions",
    description:
      "Search past Pi sessions by keyword, partial UUID, cwd path, date, or transcript content. Returns ranked matches with snippets and file paths. Use session_read to read a matching session branch.",
    promptSnippet: "Search past Pi sessions by keyword or UUID with session_search",
    promptGuidelines: [
      "When the user mentions a past session, conversation, or topic they discussed before, use session_search to find it.",
      "Search now includes transcript content, not just the first user message.",
      "If the user is referring to a session in a project, pass cwd_filter to narrow the search.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "Search query: keyword, partial UUID, date, cwd path substring, or transcript text.",
      }),
      limit: Type.Optional(
        Type.Number({
          description: `Max results to return (default 10, max ${MAX_SEARCH_RESULTS})`,
          default: 10,
        }),
      ),
      cwd_filter: Type.Optional(
        Type.String({
          description: "Optional cwd path substring filter (e.g. 'agent-extensions' or '/home/daniel/build/zeroclaw').",
        }),
      ),
      search_tools: Type.Optional(
        Type.Boolean({
          description: "Also search tool-result text (default false to avoid noisy path-only matches).",
          default: false,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const query = params.query.trim();
      if (!query) {
        return {
          content: [{ type: "text", text: "Query cannot be empty." }],
          details: undefined,
          isError: true,
        };
      }

      const limit = clampPositiveInteger(params.limit, 10, MAX_SEARCH_RESULTS);
      const summaries = await loadSessionSummaries();
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
    promptSnippet: "Read a past session's full conversation with session_read",
    promptGuidelines: [
      "After finding a session with session_search, use session_read to read its conversation.",
      "Prefer max_turns to limit output size — only request the full conversation when needed.",
      "If session_search returned an Entry ID, pass it as entry_id so you read the matching branch instead of a different fork.",
    ],
    parameters: Type.Object({
      file: Type.String({
        description: "Absolute path to the session .jsonl file (from session_search results)",
      }),
      entry_id: Type.Optional(
        Type.String({
          description: "Optional entry ID from session_search. Reads the branch anchored at that matching entry.",
        }),
      ),
      max_turns: Type.Optional(
        Type.Number({
          description: `Max user turns to include (default 50, max ${MAX_READ_TURNS}). Use smaller values to get just the beginning or a summary.`,
          default: 50,
        }),
      ),
      include_tools: Type.Optional(
        Type.Boolean({
          description: "Include tool calls and results in the output (default false for cleaner reading)",
          default: false,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      let filePath: string;
      try {
        filePath = await resolveSessionFilePath(params.file);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to resolve session file: ${message}` }],
          details: undefined,
          isError: true,
        };
      }

      const loaded = await loadSession(filePath);
      if (!loaded) {
        return {
          content: [{ type: "text", text: "Failed to parse session file." }],
          details: undefined,
          isError: true,
        };
      }

      if (params.entry_id && !hasEntryId(loaded.parsed, params.entry_id)) {
        return {
          content: [{ type: "text", text: `Entry ID ${params.entry_id} was not found in that session.` }],
          details: undefined,
          isError: true,
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
      "List recent Pi sessions, optionally filtered by project path. Returns session metadata, sorted by session timestamp. Use session_read to read the full conversation.",
    promptSnippet: "List recent sessions with session_list",
    promptGuidelines: [
      "Use session_list when the user wants to see their recent sessions or find a session by project.",
      "cwd_filter matches a substring of the session cwd.",
    ],
    parameters: Type.Object({
      cwd_filter: Type.Optional(
        Type.String({
          description: "Filter by project path substring (e.g. 'agent-extensions' or '/home/daniel/build/zeroclaw')",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: `Max results (default 20, max ${MAX_LIST_RESULTS})`,
          default: 20,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const limit = clampPositiveInteger(params.limit, 20, MAX_LIST_RESULTS);
      const summaries = filterByCwd(await loadSessionSummaries(), params.cwd_filter).slice(0, limit);

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
}
