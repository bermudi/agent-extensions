# Session Search Merge Plan

**Base:** `session-reference` (better types, branch-aware parsing, path security, 3 agent tools, `/sessions` command)
**Fork:** `pi-session-search` (SQLite FTS5 indexer, TUI overlay `/search`, summarizer, resume)
**Goal:** Merge into `pi-session-search` extension, using `session-reference` code quality as the base and layering FTS5 on top.

---

## Architecture Overview

```
pi-session-search/extensions/
  pi-session-search.ts   ← main entry (merged extension registration)
  session-utils.ts       ← pure functions + types from session-reference-utils
  session-utils.test.ts  ← tests from session-reference-utils.test
  indexer.ts             ← FTS5 SQLite engine (mostly unchanged)
  types.ts               ← TUI types + re-export agent types
  component.ts           ← TUI component (unchanged)
  screens/               ← TUI screens (unchanged)
  lib/render-helpers.ts  ← TUI helpers (unchanged)
  summarizer.ts          ← LLM summarization (unchanged)
  jsonl-parser.ts        ← JSONL parser for compaction engine (unchanged)
  resume.ts              ← /search resume arg parser (unchanged)
```

**Design principle:** Agent tools (`session_search`, `session_read`, `session_list`) always produce richly typed `SessionSummary` + `SessionMatch` output. FTS5 is used as a **fast pre-filter** for `session_search` and `session_list` when the index is ready; when the index is not ready they fall back to a full file scan. `session_read` never touches FTS5 — it uses secure path resolution and branch-aware parsing directly.

---

## File-by-File Plan

---

### 1. `extensions/session-utils.ts` (NEW)

**Replaces:** `session-reference/session-reference-utils.ts`

**What to keep:**
- Every type definition: `SessionHeader`, `ContentBlock`, `SessionMessage`, `MessageEntry`, `SessionInfoEntry`, `GenericEntry`, `SessionEntry`, `ParsedSession`, `SearchField`, `SearchSegment`, `SessionSummary`, `SessionMatch`, `FormatConversationOptions`, `FormattedConversation`.
- Every pure function: `compareTimestampDesc`, `clampPositiveInteger`, `isPathWithinDir`, `isSameProjectPath`, `extractText`, `extractToolCalls`, `parseHeader`, `parseEntry`, `parseSessionText`, `hasEntryId`, `selectLeafEntryId`, `selectBranchMessages`, `findSessionMatch`, `buildSessionSummary`, `formatConversation`.
- Move **from** `session-reference.ts` into this file: `matchFieldLabel`, `formatSessionDate`, `formatSessionChoiceLabel`, `filterByCwd`, `searchSessions`.

**What to adapt:**
- Update module-level constants to match the ones in `session-reference.ts`:
  - `MAX_FIRST_USER_MESSAGE_CHARS = 200`
  - `MAX_SEARCH_TEXT_CHARS = 4_000`
  - `MAX_SNIPPET_CHARS = 180`
- Add `filterByCwd` and `searchSessions` as **exported** functions (they were private in `session-reference.ts`).
- `searchSessions` signature:
  ```ts
  export interface SearchHit {
    summary: SessionSummary;
    match: SessionMatch;
  }

  export function filterByCwd(
    summaries: readonly SessionSummary[],
    cwdFilter?: string,
  ): SessionSummary[];

  export function searchSessions(
    summaries: readonly SessionSummary[],
    query: string,
    options: { cwdFilter?: string; limit: number; searchTools?: boolean },
  ): SearchHit[];
  ```

**Import dependencies:**
```ts
import { isAbsolute, relative } from "node:path";
```

**Key code snippets:**

```ts
export function matchFieldLabel(field: SearchField): string {
  switch (field) {
    case "id": return "UUID";
    case "cwd": return "CWD";
    case "file": return "file path";
    case "timestamp": return "timestamp";
    case "name": return "session name";
    case "first_user_message": return "first user message";
    case "user_message": return "user message";
    case "assistant_message": return "assistant message";
    case "tool_result": return "tool result";
  }
}

export function formatSessionDate(timestamp: string): string {
  return new Date(timestamp).toLocaleString();
}

export function formatSessionChoiceLabel(summary: SessionSummary): string {
  const date = new Date(summary.timestamp).toLocaleDateString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const label = summary.name || summary.firstUserMessage || "(empty)";
  return `${date}  ${label.slice(0, 80)} · ${summary.id.slice(0, 8)}`;
}

export function filterByCwd(summaries: readonly SessionSummary[], cwdFilter?: string): SessionSummary[] {
  const normalizedFilter = cwdFilter?.trim().toLowerCase();
  if (!normalizedFilter) return [...summaries];
  return summaries.filter((summary) => summary.cwd.toLowerCase().includes(normalizedFilter));
}

export function searchSessions(
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
```

---

### 2. `extensions/session-utils.test.ts` (NEW)

**Replaces:** `session-reference/session-reference-utils.test.ts`

**What to keep:** All existing tests.

**What to adapt:** Only the import path:
```ts
import {
  buildSessionSummary,
  clampPositiveInteger,
  findSessionMatch,
  formatConversation,
  isPathWithinDir,
  isSameProjectPath,
  parseSessionText,
} from "./session-utils.js";
```

Everything else identical.

---

### 3. `extensions/types.ts` (MODIFY)

**Replaces:** `pi-session-search/extensions/types.ts`

**What to keep:** Everything already in the file (`SearchResult` re-export, `Theme`, `PaletteAction`, `PreviewActionType`, `PREVIEW_ACTIONS`, `ACTION_LABELS`, `SearchAction`, `PreviewAction`, `PromptAction`, screen states, `formatDate`, `shortenProject`, `cleanSnippet`).

**What to add:** Re-export the richly-typed agent types from `session-utils.ts` so consumers can import them from the central types module:
```ts
export type {
  SearchField,
  SessionSummary,
  SessionMatch,
  SearchSegment,
  FormatConversationOptions,
  FormattedConversation,
} from "./session-utils.js";
```

This satisfies the requirement to surface `session-reference`'s union types without breaking the TUI's existing `SearchResult` dependency.

---

### 4. `extensions/indexer.ts` (KEEP — no structural changes)

**Replaces:** `pi-session-search/extensions/indexer.ts`

**What to keep:** The entire file as-is. All of the following are preserved:
- `SearchResult` interface
- `IndexStats` interface
- `getDb()`, `closeDb()`
- `projectFromDir()`, `timestampFromFilename()`
- `extractContent()`, `extractContentAsync()`, `extractText()`, `extractAssistantText()`, `extractToolResultText()`
- `findSessionFiles()`, `yieldTick()`
- `updateIndex()`, `rebuildIndex()`, `sanitizeTokens()`, `buildFtsQuery()`
- `search()`, `getSessionSnippets()`, `getSessionTitle()`, `listRecent()`, `getStats()`
- WAL mode, cooperative yielding, batching, `BATCH_SIZE = 20`, `CHUNK_SIZE = 4000`

**What to adapt:** Nothing. The agent tools will call `search(query, limit).map(r => r.sessionPath)` and `listRecent(limit).map(r => r.sessionPath)` to use FTS5 as a pre-filter. The indexer does not need to know about `SessionSummary`.

**Import dependencies:** `better-sqlite3`, `node:fs`, `node:fs/promises`, `node:path`, `node:os`.

---

### 5. `extensions/pi-session-search.ts` (COMPLETE REWRITE)

**Replaces:** BOTH `session-reference/session-reference.ts` AND `pi-session-search/extensions/pi-session-search.ts`

**What to keep from `session-reference.ts`:**
- `SESSIONS_DIR` constant
- In-memory `sessionCache` with mtime/size invalidation
- `getAllSessionFiles()`, `loadSession()`, `loadSessionSummaries()`, `resolveSessionFilePath()`
- `/sessions` command (interactive browsing with `ctx.ui.select`)
- `session_search` tool schema and formatting logic
- `session_read` tool schema and formatting logic (including path security and branch parsing)
- `session_list` tool schema and formatting logic
- Constants: `MAX_SEARCH_RESULTS = 50`, `MAX_LIST_RESULTS = 50`, `MAX_READ_TURNS = 200`

**What to keep from `pi-session-search.ts`:**
- `ensureIndex()`, `indexReady`, `indexing` state
- `session_start` hook (background index build + pending-summary injection)
- `session_shutdown` hook (`closeDb()`)
- `openSearch()` and `/search` command (overlay, reindex, stats, resume)
- `PENDING_DIR` / `PENDING_FILE` logic for "New + Context"
- `registerMessageRenderer("session-search-context", ...)`
- Stale-context safety guards in `resume` and `summarize` handlers

**What to adapt / merge:**

#### A. Imports
```ts
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import * as fs from "node:fs/promises";
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
} from "./session-utils.js";

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
```

#### B. Caching & file loading (unchanged from session-reference)
```ts
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

const sessionCache = new Map<string, CachedSession>();

async function getAllSessionFiles(): Promise<string[]> { /* same as session-reference */ }
async function loadSession(filePath: string): Promise<CachedSession | null> { /* same as session-reference */ }
async function loadSessionSummaries(): Promise<SessionSummary[]> { /* same as session-reference */ }
async function resolveSessionFilePath(requestedFile: string): Promise<string> { /* same as session-reference */ }
```

#### C. `session_search` tool — hybrid FTS5 + rich scoring
```ts
pi.registerTool({
  name: "session_search",
  label: "Search Sessions",
  description: "Search past Pi sessions by keyword, partial UUID, cwd path, date, or transcript content. Returns ranked matches with snippets and file paths. Uses a fast full-text index when available.",
  promptSnippet: "Search past Pi sessions by keyword or UUID with session_search",
  promptGuidelines: [
    "When the user mentions a past session, conversation, or topic they discussed before, use session_search to find it.",
    "Search includes transcript content, not just the first user message.",
    "If the user is referring to a session in a project, pass cwd_filter to narrow the search.",
  ],
  parameters: Type.Object({
    query: Type.String({ description: "Search query: keyword, partial UUID, date, cwd path substring, or transcript text." }),
    limit: Type.Optional(Type.Number({ description: `Max results (default 10, max ${MAX_SEARCH_RESULTS})`, default: 10 })),
    cwd_filter: Type.Optional(Type.String({ description: "Optional cwd path substring filter." })),
    search_tools: Type.Optional(Type.Boolean({ description: "Also search tool-result text (default false).", default: false })),
  }),
  async execute(_toolCallId, params) {
    const query = params.query.trim();
    if (!query) {
      return { content: [{ type: "text", text: "Query cannot be empty." }], isError: true };
    }

    const limit = clampPositiveInteger(params.limit, 10, MAX_SEARCH_RESULTS);
    let candidatePaths: string[];

    if (indexReady) {
      // Fast path: FTS5 pre-filter. Ask for extra candidates because some may
      // drop out during rich scoring (e.g. tool-only matches when search_tools=false).
      const ftsResults = ftsSearch(query, limit * 5);
      candidatePaths = ftsResults.map((r) => r.sessionPath);
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
        content: [{
          type: "text",
          text: `No sessions found matching "${query}"${scopeText}. Try a different keyword, a partial UUID, or enable search_tools for tool output.`,
        }],
      };
    }

    const text = hits.map(({ summary, match }, index) => {
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
      if (match.entryId) lines.push(`- **Entry ID:** ${match.entryId}`);
      return lines.join("\n");
    }).join("\n\n");

    return {
      content: [{
        type: "text",
        text: `Found ${hits.length} session(s):\n\n${text}\n\nUse session_read with the file path to read the matching session. If a result includes Entry ID, pass it as entry_id to read the matching branch.`,
      }],
    };
  },
});
```

#### D. `session_read` tool — unchanged logic, secure paths
```ts
pi.registerTool({
  name: "session_read",
  label: "Read Session",
  description: "Read the conversation from a past Pi session file. Provide the session file path from session_search or session_list. Optionally pass entry_id to read the branch containing a specific matched entry.",
  promptSnippet: "Read a past session's full conversation with session_read",
  promptGuidelines: [
    "After finding a session with session_search, use session_read to read its conversation.",
    "Prefer max_turns to limit output size.",
    "If session_search returned an Entry ID, pass it as entry_id so you read the matching branch instead of a different fork.",
  ],
  parameters: Type.Object({
    file: Type.String({ description: "Absolute path to the session .jsonl file" }),
    entry_id: Type.Optional(Type.String({ description: "Optional entry ID from session_search. Reads the branch anchored at that matching entry." })),
    max_turns: Type.Optional(Type.Number({ description: `Max user turns (default 50, max ${MAX_READ_TURNS})`, default: 50 })),
    include_tools: Type.Optional(Type.Boolean({ description: "Include tool calls and results (default false)", default: false })),
  }),
  async execute(_toolCallId, params) {
    let filePath: string;
    try {
      filePath = await resolveSessionFilePath(params.file);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return { content: [{ type: "text", text: `Failed to resolve session file: ${message}` }], isError: true };
    }

    const loaded = await loadSession(filePath);
    if (!loaded) {
      return { content: [{ type: "text", text: "Failed to parse session file." }], isError: true };
    }

    if (params.entry_id && !hasEntryId(loaded.parsed, params.entry_id)) {
      return { content: [{ type: "text", text: `Entry ID ${params.entry_id} was not found in that session.` }], isError: true };
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
    ].filter((part): part is string => typeof part === "string" && part.length > 0).join(" | ");

    if (!conversation.text.trim()) {
      return { content: [{ type: "text", text: `${headerInfo}\n\n(No conversation messages found on that branch.)` }] };
    }
    return { content: [{ type: "text", text: `${headerInfo}\n\n---\n${conversation.text}` }] };
  },
});
```

#### E. `session_list` tool — hybrid FTS5 + rich metadata
```ts
pi.registerTool({
  name: "session_list",
  label: "List Recent Sessions",
  description: "List recent Pi sessions, optionally filtered by project path. Returns session metadata sorted by timestamp. Uses the full-text index when available.",
  promptSnippet: "List recent sessions with session_list",
  promptGuidelines: [
    "Use session_list when the user wants to see their recent sessions or find a session by project.",
    "cwd_filter matches a substring of the session cwd.",
  ],
  parameters: Type.Object({
    cwd_filter: Type.Optional(Type.String({ description: "Filter by project path substring" })),
    limit: Type.Optional(Type.Number({ description: `Max results (default 20, max ${MAX_LIST_RESULTS})`, default: 20 })),
  }),
  async execute(_toolCallId, params) {
    const limit = clampPositiveInteger(params.limit, 20, MAX_LIST_RESULTS);
    let summaries: SessionSummary[];

    if (indexReady) {
      const recent = ftsListRecent(limit * 2);
      const loaded = await Promise.all(recent.map((r) => loadSession(r.sessionPath)));
      summaries = loaded
        .filter((c): c is CachedSession => c !== null)
        .map((c) => c.summary)
        .sort(compareTimestampDesc)
        .slice(0, limit);
    } else {
      summaries = await loadSessionSummaries();
    }

    summaries = filterByCwd(summaries, params.cwd_filter).slice(0, limit);

    if (summaries.length === 0) {
      return {
        content: [{
          type: "text",
          text: params.cwd_filter
            ? `No sessions found for project matching "${params.cwd_filter}".`
            : "No sessions found.",
        }],
      };
    }

    const text = summaries.map((summary, index) => {
      const label = summary.name || summary.firstUserMessage.slice(0, 80) || "(empty)";
      return [
        `${index + 1}. **${label}** — ${formatSessionDate(summary.timestamp)}`,
        `   CWD: ${summary.cwd}`,
        `   UUID: ${summary.id}`,
        `   File: ${summary.file}`,
      ].join("\n");
    }).join("\n\n");

    return {
      content: [{
        type: "text",
        text: `**${summaries.length} session(s):**\n\n${text}\n\nUse session_read with the file path to read a session's conversation.`,
      }],
    };
  },
});
```

#### F. `/sessions` command — unchanged from session-reference
```ts
pi.registerCommand("sessions", {
  description: "Browse and list past sessions",
  handler: async (args, ctx) => {
    const summaries = await loadSessionSummaries();
    if (summaries.length === 0) { ctx.ui.notify("No sessions found.", "info"); return; }

    const limit = clampPositiveInteger(args ? Number.parseInt(args, 10) : undefined, 20, MAX_LIST_RESULTS);
    const sameProject = summaries.filter((summary) => isSameProjectPath(summary.cwd, ctx.cwd));
    const hits = (sameProject.length > 0 ? sameProject : summaries).slice(0, limit);

    if (hits.length === 0) { ctx.ui.notify("No sessions found for this project.", "info"); return; }

    const labelToFile = new Map<string, string>();
    const items = hits.map((summary) => {
      const label = formatSessionChoiceLabel(summary);
      labelToFile.set(label, summary.file);
      return label;
    });

    const choice = await ctx.ui.select("Sessions:", items);
    const file = choice ? labelToFile.get(choice) : undefined;
    if (file) await ctx.switchSession(file);
  },
});
```

#### G. `/search` command, overlay, hooks, renderer — keep pi-session-search implementation verbatim
- `ensureIndex()` with `indexReady` / `indexing` guards
- `session_start` hook with 100ms `setTimeout(() => ensureIndex(), 100)` (stale-context safe — do NOT pass `ctx` to the timer closure)
- Pending-summary injection on `reason === "new"`
- `session_shutdown` → `closeDb()`
- `/search` handler with `resume`, `reindex`, `stats`, and `openSearch`
- `openSearch` with `SessionSearchComponent`
- `registerMessageRenderer("session-search-context", ...)`
- Stale-context guards in `resume` (return after `switchSession` without touching `ctx`) and `summarize` (catch stale errors)

#### H. `export default function (pi: ExtensionAPI)`
Wraps all registrations above.

---

### 6. `extensions/component.ts` (UNCHANGED)

Keep exactly as-is. It imports from `./indexer`, `./types`, `./screens/*`. None of these change.

---

### 7. `extensions/screens/search.ts` (UNCHANGED)

Keep exactly as-is. Imports `../types`, `../lib/render-helpers`, `@mariozechner/pi-tui`.

---

### 8. `extensions/screens/preview.ts` (UNCHANGED)

Keep exactly as-is.

---

### 9. `extensions/screens/prompt-input.ts` (UNCHANGED)

Keep exactly as-is.

---

### 10. `extensions/lib/render-helpers.ts` (UNCHANGED)

Keep exactly as-is.

---

### 11. `extensions/summarizer.ts` (UNCHANGED)

Keep exactly as-is. Imports `./indexer`, `./types`, `./jsonl-parser`, `../../compaction-engine`, `@mariozechner/pi-ai`.

---

### 12. `extensions/jsonl-parser.ts` (UNCHANGED)

Keep exactly as-is.

---

### 13. `extensions/resume.ts` (UNCHANGED)

Keep exactly as-is.

---

### 14. `package.json` (MODIFY)

**File:** `pi/pi-session-search/package.json`

**Changes:**
1. Add `@sinclair/typebox` to `dependencies` (needed for tool parameter schemas).
2. Update description to reflect the merged capabilities.
3. Keep `better-sqlite3`, peer deps, scripts, and `pi.extensions` array as-is.

```json
{
  "name": "pi-session-search",
  "version": "1.2.0",
  "description": "Full-text search across pi sessions with FTS5 index, agent tools, and overlay UI",
  "keywords": ["pi-package", "pi-coding-agent", "search", "sessions", "fts5", "sqlite"],
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/bermudi/agent-extensions" },
  "publishConfig": { "access": "public" },
  "files": ["extensions", "!extensions/__tests__", "README.md", "LICENSE"],
  "pi": {
    "extensions": ["./extensions/pi-session-search.ts"]
  },
  "dependencies": {
    "better-sqlite3": "^11.10.0",
    "@sinclair/typebox": "^0.34.0"
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*"
  },
  "scripts": {
    "bundle": "esbuild extensions/pi-session-search.ts --bundle --platform=node --format=esm --target=esnext --outfile=extensions/pi-session-search.bundle.mjs --external:@mariozechner/pi-coding-agent --external:@mariozechner/pi-tui --alias:better-sqlite3=./node_modules/better-sqlite3/lib/index.js",
    "publish:pi": "bash ./scripts/publish.sh"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "tsx": "^4.21.0",
    "typescript": "^5.9.3"
  }
}
```

**Note:** Update the `bundle` script `outfile` to match the entry filename if desired (e.g. `pi-session-search.bundle.mjs`).

---

## Type Merge Matrix

| Concept | session-reference | pi-session-search | Merged Location |
|---|---|---|---|
| `SearchField` union | ✅ Better | ❌ Missing | `session-utils.ts` |
| `SessionSummary` | ✅ Rich | ❌ Missing | `session-utils.ts` |
| `SessionMatch` | ✅ Rich | ❌ Missing | `session-utils.ts` |
| `SearchResult` | ❌ Missing | ✅ (loose, TUI) | `indexer.ts` (unchanged) |
| `SearchSegment` | ✅ Rich | ❌ Missing | `session-utils.ts` |
| `ParsedSession` / tree parsing | ✅ | ❌ | `session-utils.ts` |
| Branch-aware `formatConversation` | ✅ | ❌ | `session-utils.ts` |
| `PaletteAction` / TUI states | ❌ | ✅ | `types.ts` (unchanged) |

The TUI continues using `SearchResult` from `indexer.ts`. Agent tools use `SessionSummary` + `SessionMatch` from `session-utils.ts`. No type is lost.

---

## Behavioral Changes Summary

1. **session_search** now uses FTS5 as a fast pre-filter when the index is ready. It still loads the actual session file and runs `findSessionMatch` to produce the same richly typed, scored, snippeted output as before. If the index is stale or unavailable, it falls back to a full scan.
2. **session_list** now uses FTS5 `listRecent` as a fast pre-filter when ready, then enriches with `SessionSummary` metadata. Falls back to full scan.
3. **session_read** is unchanged in behavior — still resolves paths securely via `realpath` and reads the correct branch using `selectBranchMessages`.
4. **FTS5 indexer** is unchanged in behavior — still incrementally indexes on `session_start`, uses WAL mode, yields cooperatively.
5. **TUI overlay** (`/search`) is unchanged in behavior.
6. **Summarizer** (`/search` → summarize / new + context) is unchanged.

---

## Testing Checklist for Worker

- [ ] `session-utils.test.ts` passes (all session-reference unit tests).
- [ ] `bun test extensions/session-utils.test.ts` (or `uv run` if using node:test) passes.
- [ ] `/sessions` command lists sessions and allows switching.
- [ ] `/search` command opens overlay, searches, previews, resumes.
- [ ] `/search reindex` rebuilds the index.
- [ ] `/search stats` shows session/chunk counts.
- [ ] `/search resume <path>` resumes a session.
- [ ] `session_search` tool returns structured results with `SearchField` labels, snippets, and `entryId` when indexed.
- [ ] `session_search` tool falls back correctly when index is not ready.
- [ ] `session_read` tool respects `entry_id` branch anchoring and path security.
- [ ] `session_list` tool returns recent sessions sorted by timestamp.
- [ ] `session_list` with `cwd_filter` works in both indexed and fallback modes.
