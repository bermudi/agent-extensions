import { isAbsolute, relative } from "node:path";

export interface SessionHeader {
  id: string;
  timestamp: string;
  cwd: string;
}

export interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  arguments?: unknown;
}

export interface SessionMessage {
  role: string;
  content?: unknown;
  toolName?: string;
}

export interface MessageEntry {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: SessionMessage;
}

export interface SessionInfoEntry {
  type: "session_info";
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  name: string | null;
}

export interface GenericEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export type SessionEntry = MessageEntry | SessionInfoEntry | GenericEntry;

export interface ParsedSession {
  header: SessionHeader;
  entries: SessionEntry[];
  name: string | null;
}

export type SearchField =
  | "id"
  | "cwd"
  | "file"
  | "timestamp"
  | "name"
  | "first_user_message"
  | "user_message"
  | "assistant_message"
  | "tool_result";

export interface SearchSegment {
  field: SearchField;
  text: string;
  entryId?: string;
}

export interface SessionSummary {
  file: string;
  id: string;
  timestamp: string;
  cwd: string;
  firstUserMessage: string;
  name: string | null;
  latestLeafId: string | null;
  segments: SearchSegment[];
}

export interface SessionMatch {
  field: SearchField;
  score: number;
  snippet: string;
  entryId?: string;
}

export interface FormatConversationOptions {
  includeTools?: boolean;
  maxTurns?: number;
  entryId?: string;
}

export interface FormattedConversation {
  text: string;
  leafEntryId: string | null;
  messageCount: number;
}

export interface SearchHit {
  summary: SessionSummary;
  match: SessionMatch;
}

const MAX_FIRST_USER_MESSAGE_CHARS = 200;
const MAX_SEARCH_TEXT_CHARS = 4_000;
const MAX_SNIPPET_CHARS = 180;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asParentId(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function timestampValue(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function compareTimestampDesc(left: { timestamp: string }, right: { timestamp: string }): number {
  return timestampValue(right.timestamp) - timestampValue(left.timestamp);
}

export function clampPositiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.trunc(value ?? fallback);
  if (normalized < 1) return fallback;
  return Math.min(normalized, max);
}

export function isPathWithinDir(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function isSameProjectPath(left: string, right: string): boolean {
  const normalizedLeft = left.replace(/\/+$/, "");
  const normalizedRight = right.replace(/\/+$/, "");
  if (!normalizedLeft || !normalizedRight) return false;
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
  );
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const texts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  return texts.join("\n");
}

/**
 * Extract text from content blocks, joining with spaces.
 * Suitable for FTS5 indexing where newlines would break token boundaries.
 */
export function extractTextFlat(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const texts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  return texts.join(" ");
}

export function extractToolCalls(content: unknown): Array<{ name: string; arguments: string }> {
  if (!Array.isArray(content)) return [];

  const toolCalls: Array<{ name: string; arguments: string }> = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "toolCall") continue;
    const name = asString(block.name);
    if (!name) continue;
    const serializedArguments = JSON.stringify(block.arguments ?? {});
    toolCalls.push({ name, arguments: serializedArguments });
  }
  return toolCalls;
}

export function parseHeader(line: string): SessionHeader | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || parsed.type !== "session") return null;

    const id = asString(parsed.id);
    const timestamp = asString(parsed.timestamp);
    const cwd = asString(parsed.cwd) ?? "";
    if (!id || !timestamp) return null;

    return { id, timestamp, cwd };
  } catch {
    return null;
  }
}

export function parseEntry(line: string): SessionEntry | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) return null;

    const type = asString(parsed.type);
    if (!type) return null;

    if (type === "session_info") {
      return {
        type,
        id: asString(parsed.id),
        parentId: asParentId(parsed.parentId),
        timestamp: asString(parsed.timestamp),
        name: asString(parsed.name) ?? null,
      };
    }

    const id = asString(parsed.id);
    const parentId = asParentId(parsed.parentId);
    const timestamp = asString(parsed.timestamp);
    if (!id || parentId === undefined || !timestamp) return null;

    if (type === "message") {
      const messageRecord = parsed.message;
      if (!isRecord(messageRecord)) return null;
      const role = asString(messageRecord.role);
      if (!role) return null;

      return {
        type,
        id,
        parentId,
        timestamp,
        message: {
          role,
          content: messageRecord.content,
          toolName: asString(messageRecord.toolName),
        },
      };
    }

    return {
      type,
      id,
      parentId,
      timestamp,
    };
  } catch {
    return null;
  }
}

export function parseSessionText(data: string): ParsedSession | null {
  const lines = data.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;

  const header = parseHeader(lines[0]);
  if (!header) return null;

  const entries: SessionEntry[] = [];
  let name: string | null = null;

  for (const line of lines.slice(1)) {
    const entry = parseEntry(line);
    if (!entry) continue;
    entries.push(entry);

    if (entry.type === "session_info" && (entry as SessionInfoEntry).name) {
      name = (entry as SessionInfoEntry).name;
    }
  }

  return { header, entries, name };
}

function getTreeEntries(entries: readonly SessionEntry[]): GenericEntry[] {
  return entries.filter((entry) => entry.type !== "session_info") as GenericEntry[];
}

function getLeafCandidates(entries: readonly GenericEntry[]): GenericEntry[] {
  const parentIds = new Set(
    entries
      .map((entry) => entry.parentId)
      .filter((parentId): parentId is string => typeof parentId === "string" && parentId.length > 0),
  );

  return entries.filter((entry) => !parentIds.has(entry.id));
}

function sortEntriesByTimestampDesc(entries: readonly GenericEntry[]): GenericEntry[] {
  return [...entries].sort((left, right) => {
    const timestampCompare = compareTimestampDesc(left, right);
    if (timestampCompare !== 0) return timestampCompare;
    return right.id.localeCompare(left.id);
  });
}

function buildChildrenMap(entries: readonly GenericEntry[]): Map<string, GenericEntry[]> {
  const children = new Map<string, GenericEntry[]>();
  for (const entry of entries) {
    if (entry.parentId === null) continue;
    const siblings = children.get(entry.parentId) ?? [];
    siblings.push(entry);
    children.set(entry.parentId, siblings);
  }
  return children;
}

function collectDescendantLeaves(startId: string, children: ReadonlyMap<string, GenericEntry[]>): GenericEntry[] {
  const leaves: GenericEntry[] = [];
  const stack = [startId];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const currentId = stack.pop();
    if (!currentId || visited.has(currentId)) continue;
    visited.add(currentId);

    const currentChildren = children.get(currentId) ?? [];
    if (currentChildren.length === 0) continue;

    let pushedChild = false;
    for (const child of currentChildren) {
      stack.push(child.id);
      pushedChild = true;
    }

    if (!pushedChild) {
      continue;
    }
  }

  for (const childList of children.values()) {
    for (const child of childList) {
      if (!visited.has(child.id)) continue;
      const grandChildren = children.get(child.id) ?? [];
      if (grandChildren.length === 0) {
        leaves.push(child);
      }
    }
  }

  return sortEntriesByTimestampDesc(leaves);
}

export function hasEntryId(session: ParsedSession, entryId: string): boolean {
  return getTreeEntries(session.entries).some((entry) => entry.id === entryId);
}

export function selectLeafEntryId(session: ParsedSession, preferredEntryId?: string): string | null {
  const treeEntries = getTreeEntries(session.entries);
  if (treeEntries.length === 0) return null;

  const byId = new Map(treeEntries.map((entry) => [entry.id, entry]));
  const children = buildChildrenMap(treeEntries);

  if (preferredEntryId) {
    const preferred = byId.get(preferredEntryId);
    if (preferred) {
      const descendantLeaves = collectDescendantLeaves(preferred.id, children);
      if (descendantLeaves.length > 0) return descendantLeaves[0].id;
      return preferred.id;
    }
  }

  const leafCandidates = getLeafCandidates(treeEntries);
  if (leafCandidates.length > 0) return sortEntriesByTimestampDesc(leafCandidates)[0].id;
  return sortEntriesByTimestampDesc(treeEntries)[0].id;
}

export function selectBranchMessages(session: ParsedSession, preferredEntryId?: string): MessageEntry[] {
  const leafEntryId = selectLeafEntryId(session, preferredEntryId);
  if (!leafEntryId) return [];

  const treeEntries = getTreeEntries(session.entries);
  const byId = new Map(treeEntries.map((entry) => [entry.id, entry]));
  const branchIds = new Set<string>();
  const visited = new Set<string>();

  let currentId: string | null = leafEntryId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    branchIds.add(currentId);
    const currentEntry = byId.get(currentId);
    currentId = currentEntry?.parentId ?? null;
  }

  return session.entries.filter((entry): entry is MessageEntry => entry.type === "message" && branchIds.has(entry.id));
}

function snippetForMatch(text: string, query: string): string {
  const normalizedText = collapseWhitespace(text);
  const lowerText = normalizedText.toLowerCase();
  const lowerQuery = collapseWhitespace(query).toLowerCase();
  const terms = lowerQuery.split(" ").filter(Boolean);

  let index = lowerText.indexOf(lowerQuery);
  if (index < 0) {
    index = terms.reduce<number>((best, term) => {
      const nextIndex = lowerText.indexOf(term);
      if (nextIndex < 0) return best;
      if (best < 0) return nextIndex;
      return Math.min(best, nextIndex);
    }, -1);
  }

  if (index < 0) return limitText(normalizedText, MAX_SNIPPET_CHARS);

  const start = Math.max(0, index - 40);
  const end = Math.min(normalizedText.length, index + Math.max(lowerQuery.length, 40) + 80);
  const snippet = normalizedText.slice(start, end);
  return `${start > 0 ? "…" : ""}${snippet}${end < normalizedText.length ? "…" : ""}`;
}

function searchScore(field: SearchField, text: string, query: string): number {
  const normalizedText = collapseWhitespace(text).toLowerCase();
  const normalizedQuery = collapseWhitespace(query).toLowerCase();
  if (!normalizedQuery) return 0;

  const exact = normalizedText === normalizedQuery;
  const prefix = normalizedText.startsWith(normalizedQuery);
  const substring = normalizedText.includes(normalizedQuery);
  const terms = normalizedQuery.split(" ").filter(Boolean);
  const allTerms = terms.length > 1 && terms.every((term) => normalizedText.includes(term));

  if (!substring && !allTerms) return 0;

  const baseScores: Record<SearchField, number> = {
    id: 1_000,
    name: 850,
    first_user_message: 800,
    user_message: 775,
    assistant_message: 750,
    cwd: 650,
    file: 625,
    timestamp: 600,
    tool_result: 300,
  };

  let score = baseScores[field];
  if (exact) score += 220;
  else if (prefix) score += 160;
  else if (substring) score += 100;
  else if (allTerms) score += 40;

  if (field === "id" && normalizedText.startsWith(normalizedQuery)) {
    score += 120;
  }

  return score;
}

export function findSessionMatch(
  summary: SessionSummary,
  query: string,
  options: { searchTools?: boolean } = {},
): SessionMatch | null {
  const normalizedQuery = collapseWhitespace(query);
  if (!normalizedQuery) return null;

  let best: SessionMatch | null = null;

  for (const segment of summary.segments) {
    if (segment.field === "tool_result" && !options.searchTools) continue;

    const score = searchScore(segment.field, segment.text, normalizedQuery);
    if (score === 0) continue;

    const match: SessionMatch = {
      field: segment.field,
      score,
      snippet: snippetForMatch(segment.text, normalizedQuery),
      entryId: segment.entryId,
    };

    if (!best || match.score > best.score) {
      best = match;
      continue;
    }

    if (match.score === best.score && match.field < best.field) {
      best = match;
    }
  }

  return best;
}

export function buildSessionSummary(file: string, session: ParsedSession): SessionSummary {
  const firstUserMessageEntry = session.entries.find((entry): entry is MessageEntry => {
    if (entry.type !== "message") return false;
    const messageEntry = entry as MessageEntry;
    return messageEntry.message.role === "user" && extractText(messageEntry.message.content).length > 0;
  });
  const firstUserMessage = firstUserMessageEntry
    ? limitText(extractText(firstUserMessageEntry.message.content), MAX_FIRST_USER_MESSAGE_CHARS)
    : "";

  const segments: SearchSegment[] = [
    { field: "id", text: session.header.id },
    { field: "cwd", text: session.header.cwd },
    { field: "file", text: file },
    { field: "timestamp", text: session.header.timestamp },
  ];

  if (session.name) {
    segments.push({ field: "name", text: session.name });
  }
  if (firstUserMessage) {
    segments.push({ field: "first_user_message", text: firstUserMessage, entryId: firstUserMessageEntry?.id });
  }

  for (const entry of session.entries) {
    if (entry.type !== "message") continue;
    const messageEntry = entry as MessageEntry;

    const text = collapseWhitespace(extractText(messageEntry.message.content));
    if (!text) continue;

    if (messageEntry.message.role === "user") {
      segments.push({ field: "user_message", text: limitText(text, MAX_SEARCH_TEXT_CHARS), entryId: messageEntry.id });
      continue;
    }
    if (messageEntry.message.role === "assistant") {
      segments.push({ field: "assistant_message", text: limitText(text, MAX_SEARCH_TEXT_CHARS), entryId: messageEntry.id });
      continue;
    }
    if (messageEntry.message.role === "toolResult") {
      segments.push({ field: "tool_result", text: limitText(text, MAX_SEARCH_TEXT_CHARS), entryId: messageEntry.id });
    }
  }

  return {
    file,
    id: session.header.id,
    timestamp: session.header.timestamp,
    cwd: session.header.cwd,
    firstUserMessage,
    name: session.name,
    latestLeafId: selectLeafEntryId(session),
    segments,
  };
}

export function formatConversation(session: ParsedSession, options: FormatConversationOptions = {}): FormattedConversation {
  const maxTurns = options.maxTurns ?? 50;
  const branchMessages = selectBranchMessages(session, options.entryId);
  const leafEntryId = selectLeafEntryId(session, options.entryId);
  let turnCount = 0;
  const out: string[] = [];

  for (const entry of branchMessages) {
    const msg = entry.message;
    if (msg.role === "user") {
      turnCount += 1;
      if (turnCount > maxTurns) break;
      const text = extractText(msg.content);
      if (text) out.push(`\n### User\n${text}`);
      continue;
    }

    if (msg.role === "assistant") {
      const text = extractText(msg.content);
      if (text) out.push(`\n### Assistant\n${text}`);
      if (options.includeTools) {
        for (const toolCall of extractToolCalls(msg.content)) {
          out.push(`\n[Tool: ${toolCall.name}(${toolCall.arguments.slice(0, 300)})]`);
        }
      }
      continue;
    }

    if (msg.role === "toolResult" && options.includeTools) {
      const text = extractText(msg.content);
      if (text) {
        out.push(`\n[Result (${msg.toolName ?? "tool"}): ${limitText(text, 500)}]`);
      }
    }
  }

  return {
    text: out.join("\n"),
    leafEntryId,
    messageCount: branchMessages.length,
  };
}

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
