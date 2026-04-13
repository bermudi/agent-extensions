/**
 * Session Reference — lets the agent search and read other Pi sessions as context.
 *
 * Usage: mention a past session in your prompt and the agent will use these tools:
 *   - session_search: find sessions by keyword, UUID, date, or cwd
 *   - session_read:   read a session's conversation (user/assistant messages)
 *   - session_list:   list recent sessions
 *
 * Also provides /sessions command for interactive browsing.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const SESSIONS_DIR = join(homedir(), ".pi/agent/sessions");

// ── helpers ───────────────────────────────────────────────────────────

interface SessionHit {
  file: string;
  id: string;
  timestamp: string;
  cwd: string;
  firstUserMessage: string;
  name: string | null;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
  }
  return "";
}

function parseHeader(line: string): { id: string; timestamp: string; cwd: string } | null {
  try {
    const obj = JSON.parse(line);
    if (obj.type === "session") return { id: obj.id, timestamp: obj.timestamp, cwd: obj.cwd };
  } catch {}
  return null;
}

function parseEntry(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function scanSession(filePath: string): Promise<SessionHit | null> {
  let data: string;
  try {
    data = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const lines = data.trim().split("\n");
  if (lines.length === 0) return null;

  const header = parseHeader(lines[0]);
  if (!header) return null;

  let firstUserMessage = "";
  let name: string | null = null;

  for (const line of lines.slice(1)) {
    const entry = parseEntry(line);
    if (!entry) continue;

    // session name
    if (entry.type === "session_info" && entry.name) {
      name = entry.name;
    }

    // first user message
    if (!firstUserMessage && entry.type === "message" && entry.message?.role === "user") {
      const text = extractText(entry.message.content);
      if (text) {
        firstUserMessage = text.length > 200 ? text.slice(0, 200) + "…" : text;
      }
    }
  }

  return {
    file: filePath,
    id: header.id,
    timestamp: header.timestamp,
    cwd: header.cwd || "",
    firstUserMessage,
    name,
  };
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
    } catch {}
  }
  // sort newest first
  files.sort().reverse();
  return files;
}

function formatConversation(lines: string[], options: { includeTools?: boolean; maxTurns?: number }): string {
  const entries = lines.map(parseEntry).filter(Boolean);
  let turnCount = 0;
  const out: string[] = [];

  for (const entry of entries) {
    if (!entry || entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg?.role) continue;

    if (msg.role === "user") {
      turnCount++;
      if (options.maxTurns && turnCount > options.maxTurns) break;
      const text = extractText(msg.content);
      if (text) out.push(`\n### User\n${text}`);
    } else if (msg.role === "assistant") {
      const text = extractText(msg.content);
      const toolCalls = Array.isArray(msg.content)
        ? (msg.content as any[]).filter((b: any) => b.type === "toolCall")
        : [];

      if (text) out.push(`\n### Assistant\n${text}`);
      if (options.includeTools && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          out.push(`\n[Tool: ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 300)})]`);
        }
      }
    } else if (msg.role === "toolResult" && options.includeTools) {
      const text = extractText(msg.content);
      if (text) {
        const preview = text.length > 500 ? text.slice(0, 500) + "…" : text;
        out.push(`\n[Result (${msg.toolName}): ${preview}]`);
      }
    }
  }

  return out.join("\n");
}

// ── extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── /sessions command ─────────────────────────────────────────────

  pi.registerCommand("sessions", {
    description: "Browse and list past sessions",
    handler: async (args, ctx) => {
      const files = await getAllSessionFiles();
      if (files.length === 0) {
        ctx.ui.notify("No sessions found.", "info");
        return;
      }

      const limit = args ? parseInt(args, 10) || 20 : 20;
      const cwd = ctx.cwd;
      const hits: SessionHit[] = [];

      for (const f of files.slice(0, limit * 3)) {
        if (hits.length >= limit) break;
        const hit = await scanSession(f);
        if (hit && hit.cwd === cwd) hits.push(hit);
      }

      const items = hits.map((h) => {
        const date = new Date(h.timestamp).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        const label = h.name || h.firstUserMessage || "(empty)";
        return `${date}  ${label.slice(0, 80)}`;
      });

      const choice = await ctx.ui.select("Sessions:", items);
      if (choice) {
        const idx = items.indexOf(choice);
        const hit = idx >= 0 ? hits[idx] : undefined;
        const file = hit?.file;
        if (file) {
          await ctx.switchSession(file);
        }
      }
    },
  });

  // ── session_search tool ───────────────────────────────────────────

  pi.registerTool({
    name: "session_search",
    label: "Search Sessions",
    description:
      "Search past Pi sessions by keyword, partial UUID, or cwd path. Returns a list of matching sessions with their first user message, name, date, and file path. Use session_read to read the full conversation of a matching session.",
    promptSnippet: "Search past Pi sessions by keyword or UUID with session_search",
    promptGuidelines: [
      "When the user mentions a past session, conversation, or topic they discussed before, use session_search to find it.",
      "You can search by keywords from the conversation topic, partial session UUID, or the project path.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description:
          "Search query: keyword from the conversation, partial session UUID, or project path substring.",
      }),
      limit: Type.Optional(
        Type.Number({
          description: "Max results to return (default 10)",
          default: 10,
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const files = await getAllSessionFiles();
      const limit = params.limit ?? 10;
      const q = params.query.toLowerCase();
      const hits: SessionHit[] = [];

      for (const f of files) {
        if (hits.length >= limit * 3) break; // over-scan to allow filtering
        const hit = await scanSession(f);
        if (!hit) continue;

        const searchable = [
          hit.firstUserMessage,
          hit.name,
          hit.id,
          hit.cwd,
          hit.file,
          hit.timestamp,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        if (searchable.includes(q)) {
          hits.push(hit);
          if (hits.length >= limit) break;
        }
      }

      if (hits.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No sessions found matching "${params.query}". Try different keywords or a partial UUID.`,
            },
          ],
        };
      }

      const text = hits
        .map((h, i) => {
          const date = new Date(h.timestamp).toLocaleString();
          const label = h.name || "(unnamed)";
          return [
            `## ${i + 1}. ${label}`,
            `- **Date:** ${date}`,
            `- **CWD:** ${h.cwd}`,
            `- **UUID:** ${h.id}`,
            `- **File:** ${h.file}`,
            `- **First message:** ${h.firstUserMessage || "(empty)"}`,
          ].join("\n");
        })
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `Found ${hits.length} session(s):\n\n${text}\n\nUse session_read with the file path to read the full conversation.`,
          },
        ],
      };
    },
  });

  // ── session_read tool ─────────────────────────────────────────────

  pi.registerTool({
    name: "session_read",
    label: "Read Session",
    description:
      "Read the conversation from a past Pi session file. Provide the session file path (from session_search results). Returns the user/assistant conversation, optionally including tool calls.",
    promptSnippet: "Read a past session's full conversation with session_read",
    promptGuidelines: [
      "After finding a session with session_search, use session_read to read its conversation.",
      "Prefer max_turns to limit output size — only request the full conversation when needed.",
    ],
    parameters: Type.Object({
      file: Type.String({
        description: "Absolute path to the session .jsonl file (from session_search results)",
      }),
      max_turns: Type.Optional(
        Type.Number({
          description: "Max user/assistant turns to include (default 50). Use smaller values to get just the beginning or a summary.",
          default: 50,
        })
      ),
      include_tools: Type.Optional(
        Type.Boolean({
          description: "Include tool calls and results in the output (default false for cleaner reading)",
          default: false,
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      let data: string;
      try {
        data = await readFile(params.file, "utf8");
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to read session file: ${err.message}`,
            },
          ],
          isError: true,
        };
      }

      const lines = data.trim().split("\n");
      if (lines.length === 0) {
        return { content: [{ type: "text", text: "Empty session file." }] };
      }

      const header = parseHeader(lines[0]);
      const headerInfo = header
        ? `Session ${header.id} | CWD: ${header.cwd} | Created: ${new Date(header.timestamp).toLocaleString()}`
        : "Unknown session";

      const conversation = formatConversation(lines, {
        includeTools: params.include_tools ?? false,
        maxTurns: params.max_turns ?? 50,
      });

      if (!conversation.trim()) {
        return {
          content: [{ type: "text", text: `${headerInfo}\n\n(No conversation messages found.)` }],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `${headerInfo}\n\n---\n${conversation}`,
          },
        ],
      };
    },
  });

  // ── session_list tool ─────────────────────────────────────────────

  pi.registerTool({
    name: "session_list",
    label: "List Recent Sessions",
    description:
      "List recent Pi sessions, optionally filtered by project path. Returns session metadata (name, date, first message, file path). Use session_read to read the full conversation.",
    promptSnippet: "List recent Pi sessions with session_list",
    promptGuidelines: [
      "Use session_list when the user wants to see their recent sessions or find a session by project.",
    ],
    parameters: Type.Object({
      cwd_filter: Type.Optional(
        Type.String({
          description: "Filter by project directory path substring (e.g. 'agent-extensions')",
        })
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Max results (default 20)",
          default: 20,
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const files = await getAllSessionFiles();
      const limit = params.limit ?? 20;
      const cwdFilter = params.cwd_filter?.toLowerCase();
      const hits: SessionHit[] = [];

      for (const f of files) {
        if (hits.length >= limit) break;
        const hit = await scanSession(f);
        if (!hit) continue;
        if (cwdFilter && !hit.cwd.toLowerCase().includes(cwdFilter)) continue;
        hits.push(hit);
      }

      if (hits.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: cwdFilter
                ? `No sessions found for project matching "${cwdFilter}".`
                : "No sessions found.",
            },
          ],
        };
      }

      const text = hits
        .map((h, i) => {
          const date = new Date(h.timestamp).toLocaleString();
          const label = h.name || h.firstUserMessage?.slice(0, 80) || "(empty)";
          return `${i + 1}. **${label}** — ${date}\n   CWD: ${h.cwd} | File: ${h.file}`;
        })
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `**${hits.length} session(s):**\n\n${text}\n\nUse session_read with the file path to read a session's conversation.`,
          },
        ],
      };
    },
  });
}
