/**
 * Collapse built-in tool output for a cleaner TUI focused on agent prose.
 *
 * Consecutive tool calls of the same type collapse into a single block to
 * save vertical space. A burst like `read ×3` shares one background box
 * instead of three separate striped rows. Followers in a burst render nothing
 * and are hidden, so N calls cost ~1 row when collapsed.
 *
 * Images are respected: a read that returns an image is never grouped, stays
 * solo, and its image is rendered by Pi's native image layer (outside our
 * Box) even when collapsed. Expanding a burst header (ctrl+e / click)
 * reveals the concatenated outputs of all calls in that burst.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

type BuiltInTools = {
  read: ReturnType<typeof createReadTool>;
  bash: ReturnType<typeof createBashTool>;
  edit: ReturnType<typeof createEditTool>;
  write: ReturnType<typeof createWriteTool>;
  find: ReturnType<typeof createFindTool>;
  grep: ReturnType<typeof createGrepTool>;
  ls: ReturnType<typeof createLsTool>;
};

const toolCache = new Map<string, BuiltInTools>();

function createBuiltInTools(cwd: string): BuiltInTools {
  return {
    read: createReadTool(cwd),
    bash: createBashTool(cwd),
    edit: createEditTool(cwd),
    write: createWriteTool(cwd),
    find: createFindTool(cwd),
    grep: createGrepTool(cwd),
    ls: createLsTool(cwd),
  };
}

function getBuiltInTools(cwd: string): BuiltInTools {
  let tools = toolCache.get(cwd);
  if (!tools) {
    tools = createBuiltInTools(cwd);
    toolCache.set(cwd, tools);
  }
  return tools;
}

function shortenPath(path: string): string {
  const home = homedir();
  if (path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

function resultText(result: {
  content: Array<{ type: string; text?: string }>;
}): string | undefined {
  const textContent = result.content.find((c) => c.type === "text");
  return textContent?.type === "text" ? textContent.text : undefined;
}

function hasImageContent(result: {
  content: Array<{ type: string; data?: string }>;
}): boolean {
  return result.content.some((c) => c.type === "image" && !!c.data);
}

// ── Burst tracking ──────────────────────────────────────────────
type Entry = {
  toolCallId: string;
  toolName: string;
  args: any;
  /** Agent-run boundary: bumped on agent_start; negative while replaying. */
  turnId: number;
  /** Position in `entries`; stable because entries are append-only. */
  index: number;
  result?: {
    content: Array<{ type: string; text?: string; data?: string }>;
    details?: any;
  };
  isError?: boolean;
  hasImage?: boolean;
  /** Content array of the last result seen; detects real mutations vs re-renders. */
  contentRef?: unknown;
};

let turnId = 0;
// True while pi is replaying persisted history (startup with -c/--continue,
// /resume, /fork). During replay no agent events fire and wall-clock
// timestamps are meaningless (every upsert lands "now"), so replayed entries
// get negative turnIds: they group by adjacency + same tool instead of the
// live same-run rule (see shouldGroup).
let replaying = true;
let replayTurnId = -1;
const entries: Entry[] = [];
const entryById = new Map<string, Entry>();
const invalidateById = new Map<string, () => void>();

function upsertEntry(
  toolCallId: string,
  toolName: string,
  args: any,
  invalidate: () => void,
): Entry {
  let e = entryById.get(toolCallId);
  if (!e) {
    e = {
      toolCallId,
      toolName,
      args,
      turnId: replaying ? replayTurnId-- : turnId,
      index: entries.length,
    };
    entries.push(e);
    entryById.set(toolCallId, e);
  } else {
    e.args = args;
  }
  if (invalidate) invalidateById.set(toolCallId, invalidate);
  return e;
}

function shouldGroup(a: Entry, b: Entry): boolean {
  // Grouping is by adjacency + same tool within one agent run. pi fires
  // turn_start per model round-trip (every tool-call cycle), so turn boundaries
  // are useless here; agent_start marks a real run. A time window is also
  // useless: model latency between sequential calls routinely exceeds seconds.
  // Replay entries (negative turnId) have no run boundaries at all, so they
  // group purely by adjacency + same tool — consecutive same-tool calls in
  // the replay stream were consecutive in the original transcript.
  const aReplay = a.turnId < 0;
  const bReplay = b.turnId < 0;
  if (aReplay !== bReplay) return false;
  if (!aReplay && a.turnId !== b.turnId) return false;
  if (a.toolName !== b.toolName) return false;
  if (a.hasImage || b.hasImage) return false;
  return true;
}

function getBurstForId(
  toolCallId: string,
): { entries: Entry[]; index: number } | null {
  const entry = entryById.get(toolCallId);
  if (!entry) return null;
  const idx = entry.index;
  let start = idx;
  while (start > 0 && shouldGroup(entries[start - 1], entries[start])) start--;
  let end = idx;
  while (
    end + 1 < entries.length &&
    shouldGroup(entries[end], entries[end + 1])
  )
    end++;
  const slice = entries.slice(start, end + 1);
  // slice is uniform toolName due to shouldGroup, but verify: if grouping broke due to name mismatch, slice would be size 1.
  return { entries: slice, index: idx - start };
}

// Maximal groupable run containing entries[i] (pairwise adjacency, same as
// getBurstForId).
function runAround(i: number): [number, number] {
  let start = i;
  while (start > 0 && shouldGroup(entries[start - 1], entries[start])) start--;
  let end = i;
  while (
    end + 1 < entries.length &&
    shouldGroup(entries[end], entries[end + 1])
  )
    end++;
  return [start, end];
}

function revalidateBurstsAround(changedId: string) {
  const changed = entryById.get(changedId);
  if (!changed) return;
  // Grouping is decided purely by adjacency, so a result arriving can only
  // affect the runs touching the changed entry (its image flag may split a
  // burst; pending/error flags surface on the leader). Rerender those runs —
  // bounded, unlike scanning the whole history per result.
  //
  // The changed row itself is NOT invalidated here: pi is already re-rendering
  // it (we are inside its render slot), and invalidating it would synchronously
  // re-enter this code path via updateDisplay -> renderResult -> invalidate.
  const idx = changed.index;
  const ranges: Array<[number, number]> = [];
  if (idx > 0) ranges.push(runAround(idx - 1));
  if (idx + 1 < entries.length) ranges.push(runAround(idx + 1));
  const seen = new Set<number>();
  for (const [s, e] of ranges) {
    for (let i = s; i <= e; i++) {
      if (seen.has(i)) continue;
      seen.add(i);
      const fn = invalidateById.get(entries[i].toolCallId);
      if (fn) fn();
    }
  }
}

/**
 * Record a tool result. pi calls renderResult on EVERY rerender of a row
 * (expand toggles, neighbor invalidations, resizes), not only when a result
 * arrives — its wrapper object is fresh each time but the content array ref is
 * stable. Only a genuinely new result mutates state and triggers revalidation;
 * treating plain re-renders as mutations caused infinite render churn
 * (invalidate -> updateDisplay -> renderResult -> invalidate -> ...).
 */
function recordResult(entry: Entry | undefined, result: any, ctx: any) {
  if (!entry || entry.contentRef === result?.content) return;
  entry.contentRef = result?.content;
  entry.result = result;
  entry.isError = !!ctx.isError || !!result.isError;
  entry.hasImage = hasImageContent(result);
  revalidateBurstsAround(entry.toolCallId);
}

// ── AI summary for massive bash commands (qwen3.7-flash via 1min proxy) ──
const SUMMARY_MODEL = "qwen3.7-flash";
const SUMMARY_URL = "https://1min-proxy.bermudi.deno.net/v1/chat/completions";
const SUMMARY_THRESHOLD_CHARS = 120;
const SUMMARY_THRESHOLD_LINES = 3;
const summaryCache = new Map<string, string>();
const pendingSummaries = new Set<string>();
let summaryEnabled = true;

export function __setSummaryEnabled(v: boolean): void {
  summaryEnabled = v;
}
export function __clearSummaryCache(): void {
  summaryCache.clear();
  pendingSummaries.clear();
  summaryFailuresLogged.clear();
}

function isSummarizable(cmd: string): boolean {
  return (
    cmd.length > SUMMARY_THRESHOLD_CHARS ||
    cmd.split("\n").length > SUMMARY_THRESHOLD_LINES
  );
}

async function fetchSummary(cmd: string): Promise<string> {
  const apiKey = process.env.ONEMINAI_API_KEY?.trim();
  if (!apiKey) throw new Error("ONEMINAI_API_KEY not set in pi's environment");
  const prompt =
    "Summarize this shell command in 5-8 words, plain English, no quotes, no formatting. " +
    'Examples: "cat >> file << \'EOF\' with 20 lines of log" -> "Appends reboot log to migration file". ' +
    `Command:\n${cmd.slice(0, 2000)}`;
  const res = await fetch(SUMMARY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: SUMMARY_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 30,
    }),
  });
  if (!res.ok) throw new Error(`summary request failed: HTTP ${res.status}`);
  const json: any = await res.json();
  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("empty summary");
  return content
    .replace(/^["']|["']$/g, "")
    .trim()
    .slice(0, 80);
}

// Summaries are best-effort polish over the heuristic hint, but failures must
// not be silent: log once per distinct cause so a broken proxy/key is
// debuggable instead of a black box.
const summaryFailuresLogged = new Set<string>();
function logSummaryFailure(cmd: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  if (summaryFailuresLogged.has(msg)) return;
  summaryFailuresLogged.add(msg);
  console.error(
    `[clean-tui] command summary failed (${msg}); keeping heuristic hint. ` +
      `Command starts: ${JSON.stringify(cmd.slice(0, 60))}`,
  );
}

function requestSummary(cmd: string): void {
  if (
    !summaryEnabled ||
    replaying ||
    !isSummarizable(cmd) ||
    summaryCache.has(cmd) ||
    pendingSummaries.has(cmd)
  )
    return;
  pendingSummaries.add(cmd);
  fetchSummary(cmd)
    .then((summary) => {
      summaryCache.set(cmd, summary);
      pendingSummaries.delete(cmd);
      for (const e of entries) {
        if (e.args?.command === cmd) {
          const fn = invalidateById.get(e.toolCallId);
          if (fn) fn();
        }
      }
    })
    .catch((err) => {
      pendingSummaries.delete(cmd);
      logSummaryFailure(cmd, err);
    });
}

function bgFor(
  pending: boolean,
  isError: boolean,
  theme: any,
): (s: string) => string {
  if (pending) return (s: string) => theme.bg("toolPendingBg", s);
  if (isError) return (s: string) => theme.bg("toolErrorBg", s);
  return (s: string) => theme.bg("toolSuccessBg", s);
}

function makeBox(
  theme: any,
  pending: boolean,
  isError: boolean,
  text: string,
): Box {
  const box = new Box(1, 0, bgFor(pending, isError, theme));
  box.addChild(new Text(text, 0, 0));
  return box;
}

// ── Per-tool helpers ────────────────────────────────────────────
function formatReadHeader(args: any, theme: any): string {
  const path = shortenPath(args.path || "");
  let display = path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
  if (args.offset !== undefined || args.limit !== undefined) {
    const start = args.offset ?? 1;
    const end = args.limit !== undefined ? start + args.limit - 1 : "";
    display += theme.fg("warning", `:${start}${end ? `-${end}` : ""}`);
  }
  return display;
}

function formatReadBullet(entry: Entry, theme: any): string {
  const args = entry.args;
  const path = shortenPath(args.path || "...");
  let line = `  ${theme.fg("muted", "•")} ${theme.fg("accent", path)}`;
  if (args.offset !== undefined || args.limit !== undefined) {
    const start = args.offset ?? 1;
    const end = args.limit !== undefined ? start + args.limit - 1 : "";
    line += theme.fg("warning", `:${start}${end ? `-${end}` : ""}`);
  }
  if (entry.hasImage) line += theme.fg("success", " [image]");
  return line;
}

/**
 * Command display: first line only, hard-capped, plus a muted "(+N lines)"
 * hint for heredocs/multi-line commands. Full command stays available via
 * expand — a 30-line heredoc must not cost 30 rows of transcript.
 */
function formatBashCommand(cmd: string, theme: any, cap: number): string {
  const nl = cmd.indexOf("\n");
  let head = nl === -1 ? cmd : cmd.slice(0, nl);
  if (head.length > cap) head = head.slice(0, cap - 1) + "…";
  let out = theme.fg("accent", head);
  if (nl !== -1) {
    const extra = cmd.split("\n").length - 1;
    out += theme.fg("muted", ` (+${extra} line${extra === 1 ? "" : "s"})`);
  }
  return out;
}

function formatBashHeader(args: any, theme: any): string {
  const cmd = args.command || "...";
  if (isSummarizable(cmd) && summaryCache.has(cmd)) {
    const summary = summaryCache.get(cmd)!;
    let out = theme.fg("accent", summary);
    const nl = cmd.indexOf("\n");
    if (nl !== -1) {
      const extra = cmd.split("\n").length - 1;
      out += theme.fg("muted", ` (+${extra} lines)`);
    }
    return out;
  }
  return formatBashCommand(cmd, theme, 120);
}

function formatBashBullet(entry: Entry, theme: any): string {
  const cmd = entry.args.command || "...";
  if (isSummarizable(cmd) && summaryCache.has(cmd)) {
    const summary = summaryCache.get(cmd)!;
    let out = `  ${theme.fg("muted", "•")} ${theme.fg("accent", summary)}`;
    const nl = cmd.indexOf("\n");
    if (nl !== -1) {
      const extra = cmd.split("\n").length - 1;
      out += theme.fg("muted", ` (+${extra} lines)`);
    }
    return out;
  }
  return `  ${theme.fg("muted", "•")} ${formatBashCommand(cmd, theme, 60)}`;
}

function formatWriteBullet(entry: Entry, theme: any): string {
  const path = shortenPath(entry.args.path || "...");
  const lines = entry.args.content ? entry.args.content.split("\n").length : 0;
  const info = lines ? theme.fg("muted", ` (${lines} lines)`) : "";
  return `  ${theme.fg("muted", "•")} ${theme.fg("accent", path)}${info}`;
}

function formatEditBullet(entry: Entry, theme: any): string {
  const path = shortenPath(entry.args.path || "...");
  return `  ${theme.fg("muted", "•")} ${theme.fg("accent", path)}`;
}

function formatFindBullet(entry: Entry, theme: any): string {
  const pat = entry.args.pattern || "";
  const path = shortenPath(entry.args.path || ".");
  return `  ${theme.fg("muted", "•")} ${theme.fg("accent", pat)}${theme.fg("toolOutput", ` in ${path}`)}`;
}

function formatGrepBullet(entry: Entry, theme: any): string {
  const pat = entry.args.pattern || "";
  const path = shortenPath(entry.args.path || ".");
  const glob = entry.args.glob ? ` (${entry.args.glob})` : "";
  return `  ${theme.fg("muted", "•")} ${theme.fg("accent", `/${pat}/`)}${theme.fg("toolOutput", ` in ${path}${glob}`)}`;
}

function formatLsBullet(entry: Entry, theme: any): string {
  const path = shortenPath(entry.args.path || ".");
  return `  ${theme.fg("muted", "•")} ${theme.fg("accent", path)}`;
}

export default function cleanTui(pi: ExtensionAPI): void {
  const schemaTools = getBuiltInTools(process.cwd());

  // agent_start = one agent run (one user message). pi's turn_start fires per
  // model round-trip, which would give every sequential tool call its own
  // boundary and kill grouping — so runs, not turns, are the burst boundary.
  pi.on("agent_start", () => {
    turnId++;
    // First live run after startup/resume: tool calls from here on may group.
    replaying = false;
  });
  pi.on("session_start", () => {
    turnId++;
    replaying = true;
    entries.length = 0;
    entryById.clear();
    invalidateById.clear();
    pendingSummaries.clear();
  });

  // ── read ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "read",
    label: "read",
    description: schemaTools.read.description,
    parameters: schemaTools.read.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).read.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme, ctx: any) {
      const entry = upsertEntry(ctx.toolCallId, "read", args, ctx.invalidate);
      const burst = getBurstForId(ctx.toolCallId);
      const isGrouped = burst && burst.entries.length > 1;
      const isLeader =
        isGrouped && burst.entries[0].toolCallId === ctx.toolCallId;
      const pending = isGrouped
        ? burst.entries.some((e) => !e.result)
        : !entry.result;
      const isError = isGrouped
        ? burst.entries.some((e) => e.isError)
        : !!entry.isError;

      if (isGrouped && !isLeader) {
        // Refresh the leader's header/count. Single hop: a leader's renderCall
        // never invalidates anything, so this cannot loop.
        const lead = invalidateById.get(burst.entries[0].toolCallId);
        if (lead) lead();
        return new Container();
      }

      if (isGrouped && isLeader) {
        const count = burst.entries.length;
        let header = `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("muted", `×${count}`)}`;
        const bullets = burst.entries
          .map((e) => formatReadBullet(e, theme))
          .join("\n");
        header += `\n${bullets}`;
        if (ctx.expanded) {
          const details: string[] = [];
          for (const e of burst.entries) {
            if (!e.result) {
              details.push(
                theme.fg("warning", `— ${shortenPath(e.args.path)}: pending`),
              );
              continue;
            }
            const txt = resultText(e.result as any);
            if (!txt) continue;
            const preview = txt
              .split("\n")
              .slice(0, 12)
              .map((l) => theme.fg("toolOutput", l))
              .join("\n");
            const remaining = txt.split("\n").length - 12;
            let block = `\n${theme.fg("muted", `— ${shortenPath(e.args.path)}`)}:\n${preview}`;
            if (remaining > 0)
              block += `\n${theme.fg("muted", `... ${remaining} more lines`)}`;
            details.push(block);
          }
          if (details.length) header += `\n${details.join("\n")}`;
        }
        return makeBox(theme, pending, isError, header);
      }

      // solo
      let line = `${theme.fg("toolTitle", theme.bold("read"))} ${formatReadHeader(args, theme)}`;
      if (ctx.expanded && entry.result) {
        const txt = resultText(entry.result as any);
        if (txt) {
          const preview = txt
            .split("\n")
            .map((l) => theme.fg("toolOutput", l))
            .join("\n");
          line += `\n${preview}`;
        }
      }
      return makeBox(theme, pending, isError, line);
    },
    renderResult(result: any, _opts: any, _theme: any, ctx: any) {
      recordResult(entryById.get(ctx.toolCallId), result, ctx);
      // All visual work is done in renderCall (unified box); keep result slot empty
      // Images are rendered by Pi's ToolExecutionComponent image layer even when we return empty here
      return new Container();
    },
  });

  // ── bash ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "bash",
    label: "bash",
    description: schemaTools.bash.description,
    parameters: schemaTools.bash.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).bash.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme, ctx: any) {
      if (args.command) requestSummary(args.command);
      const entry = upsertEntry(ctx.toolCallId, "bash", args, ctx.invalidate);
      const burst = getBurstForId(ctx.toolCallId);
      const isGrouped = burst && burst.entries.length > 1;
      const isLeader =
        isGrouped && burst.entries[0].toolCallId === ctx.toolCallId;
      const pending = isGrouped
        ? burst.entries.some((e) => !e.result)
        : !entry.result;
      const isError = isGrouped
        ? burst.entries.some((e) => e.isError)
        : !!entry.isError;

      if (isGrouped && !isLeader) {
        // Refresh the leader's header/count. Single hop: a leader's renderCall
        // never invalidates anything, so this cannot loop.
        const lead = invalidateById.get(burst.entries[0].toolCallId);
        if (lead) lead();
        return new Container();
      }

      if (isGrouped && isLeader) {
        const count = burst.entries.length;
        let header = `${theme.fg("toolTitle", theme.bold("bash"))} ${theme.fg("muted", `×${count}`)}`;
        header += `\n${burst.entries.map((e) => formatBashBullet(e, theme)).join("\n")}`;
        if (ctx.expanded) {
          const details: string[] = [];
          for (const e of burst.entries) {
            if (!e.result) {
              details.push(
                theme.fg(
                  "warning",
                  `— $ ${formatBashCommand(e.args.command || "...", theme, 40)}: pending`,
                ),
              );
              continue;
            }
            const txt = resultText(e.result as any)?.trim();
            if (!txt) continue;
            const preview = txt
              .split("\n")
              .slice(0, 12)
              .map((l) => theme.fg("toolOutput", l))
              .join("\n");
            details.push(
              `\n${theme.fg("muted", `— $ ${formatBashCommand(e.args.command || "...", theme, 40)}`)}:\n${preview}`,
            );
          }
          if (details.length) header += `\n${details.join("\n")}`;
        }
        return makeBox(theme, pending, isError, header);
      }

      const suffix = args.timeout
        ? theme.fg("muted", ` (timeout ${args.timeout}s)`)
        : "";
      let line = `${theme.fg("toolTitle", theme.bold("$"))} ${formatBashHeader(args, theme)}${suffix}`;
      if (ctx.expanded && args.command && args.command.includes("\n")) {
        // Header only showed the first line — reveal the full command.
        line += `\n${theme.fg("toolOutput", args.command)}`;
      }
      if (ctx.expanded && entry.result) {
        const txt = resultText(entry.result as any)?.trim();
        if (txt)
          line += `\n${txt
            .split("\n")
            .map((l: string) => theme.fg("toolOutput", l))
            .join("\n")}`;
      }
      return makeBox(theme, pending, isError, line);
    },
    renderResult(result: any, _opts: any, _theme: any, ctx: any) {
      recordResult(entryById.get(ctx.toolCallId), result, ctx);
      return new Container();
    },
  });

  // ── write ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "write",
    label: "write",
    description: schemaTools.write.description,
    parameters: schemaTools.write.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).write.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme, ctx: any) {
      const entry = upsertEntry(ctx.toolCallId, "write", args, ctx.invalidate);
      const burst = getBurstForId(ctx.toolCallId);
      const isGrouped = burst && burst.entries.length > 1;
      const isLeader =
        isGrouped && burst.entries[0].toolCallId === ctx.toolCallId;
      const pending = isGrouped
        ? burst.entries.some((e) => !e.result)
        : !entry.result;
      const isError = isGrouped
        ? burst.entries.some((e) => e.isError)
        : !!entry.isError;
      if (isGrouped && !isLeader) {
        // Refresh the leader's header/count. Single hop: a leader's renderCall
        // never invalidates anything, so this cannot loop.
        const lead = invalidateById.get(burst.entries[0].toolCallId);
        if (lead) lead();
        return new Container();
      }
      if (isGrouped && isLeader) {
        let header = `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("muted", `×${burst.entries.length}`)}`;
        header += `\n${burst.entries.map((e) => formatWriteBullet(e, theme)).join("\n")}`;
        if (ctx.expanded) {
          const details = burst.entries
            .filter((e) => e.result && resultText(e.result as any))
            .map(
              (e) =>
                `\n${theme.fg("muted", `— ${shortenPath(e.args.path)}`)}: ${theme.fg("error", resultText(e.result as any)!)}`,
            )
            .join("");
          if (details) header += details;
        }
        return makeBox(theme, pending, isError, header);
      }
      const path = shortenPath(args.path || "");
      const display = path
        ? theme.fg("accent", path)
        : theme.fg("toolOutput", "...");
      const lines = args.content ? args.content.split("\n").length : 0;
      const info = lines > 0 ? theme.fg("muted", ` (${lines} lines)`) : "";
      let line = `${theme.fg("toolTitle", theme.bold("write"))} ${display}${info}`;
      if (ctx.expanded && entry.result) {
        const txt = resultText(entry.result as any);
        if (txt) line += `\n${theme.fg("error", txt)}`;
      }
      return makeBox(theme, pending, isError, line);
    },
    renderResult(result: any, _opts: any, _theme: any, ctx: any) {
      recordResult(entryById.get(ctx.toolCallId), result, ctx);
      return new Container();
    },
  });

  // ── edit ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "edit",
    label: "edit",
    description: schemaTools.edit.description,
    parameters: schemaTools.edit.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).edit.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme, ctx: any) {
      const entry = upsertEntry(ctx.toolCallId, "edit", args, ctx.invalidate);
      const burst = getBurstForId(ctx.toolCallId);
      const isGrouped = burst && burst.entries.length > 1;
      const isLeader =
        isGrouped && burst.entries[0].toolCallId === ctx.toolCallId;
      const pending = isGrouped
        ? burst.entries.some((e) => !e.result)
        : !entry.result;
      const isError = isGrouped
        ? burst.entries.some((e) => e.isError)
        : !!entry.isError;
      if (isGrouped && !isLeader) {
        // Refresh the leader's header/count. Single hop: a leader's renderCall
        // never invalidates anything, so this cannot loop.
        const lead = invalidateById.get(burst.entries[0].toolCallId);
        if (lead) lead();
        return new Container();
      }
      if (isGrouped && isLeader) {
        let header = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("muted", `×${burst.entries.length}`)}`;
        header += `\n${burst.entries.map((e) => formatEditBullet(e, theme)).join("\n")}`;
        if (ctx.expanded) {
          const details = burst.entries
            .map((e) => {
              const txt = e.result ? resultText(e.result as any) : undefined;
              return txt
                ? `\n${theme.fg("muted", `— ${shortenPath(e.args.path)}`)}:\n${theme.fg("toolOutput", txt.slice(0, 600))}`
                : "";
            })
            .join("");
          if (details) header += details;
        }
        return makeBox(theme, pending, isError, header);
      }
      let line = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", shortenPath(args.path || "..."))}`;
      if (ctx.expanded && entry.result) {
        const txt = resultText(entry.result as any);
        if (txt) line += `\n${theme.fg("toolOutput", txt)}`;
      }
      return makeBox(theme, pending, isError, line);
    },
    renderResult(result: any, _opts: any, _theme: any, ctx: any) {
      recordResult(entryById.get(ctx.toolCallId), result, ctx);
      return new Container();
    },
  });

  // ── find ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "find",
    label: "find",
    description: schemaTools.find.description,
    parameters: schemaTools.find.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).find.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme, ctx: any) {
      const entry = upsertEntry(ctx.toolCallId, "find", args, ctx.invalidate);
      const burst = getBurstForId(ctx.toolCallId);
      const isGrouped = burst && burst.entries.length > 1;
      const isLeader =
        isGrouped && burst.entries[0].toolCallId === ctx.toolCallId;
      const pending = isGrouped
        ? burst.entries.some((e) => !e.result)
        : !entry.result;
      const isError = isGrouped
        ? burst.entries.some((e) => e.isError)
        : !!entry.isError;
      if (isGrouped && !isLeader) {
        // Refresh the leader's header/count. Single hop: a leader's renderCall
        // never invalidates anything, so this cannot loop.
        const lead = invalidateById.get(burst.entries[0].toolCallId);
        if (lead) lead();
        return new Container();
      }
      if (isGrouped && isLeader) {
        let header = `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("muted", `×${burst.entries.length}`)}`;
        header += `\n${burst.entries.map((e) => formatFindBullet(e, theme)).join("\n")}`;
        if (ctx.expanded) {
          const details = burst.entries
            .map((e) => {
              const txt = e.result
                ? resultText(e.result as any)?.trim()
                : undefined;
              return txt
                ? `\n${theme.fg("muted", `— ${e.args.pattern}`)}:\n${txt
                    .split("\n")
                    .slice(0, 10)
                    .map((l) => theme.fg("toolOutput", l))
                    .join("\n")}`
                : "";
            })
            .join("");
          if (details) header += details;
        }
        return makeBox(theme, pending, isError, header);
      }
      let line = `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", args.pattern || "")}${theme.fg("toolOutput", ` in ${shortenPath(args.path || ".")}`)}`;
      if (ctx.expanded && entry.result) {
        const txt = resultText(entry.result as any)?.trim();
        if (txt)
          line += `\n${txt
            .split("\n")
            .map((l) => theme.fg("toolOutput", l))
            .join("\n")}`;
      }
      return makeBox(theme, pending, isError, line);
    },
    renderResult(result: any, _opts: any, _theme: any, ctx: any) {
      recordResult(entryById.get(ctx.toolCallId), result, ctx);
      return new Container();
    },
  });

  // ── grep ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "grep",
    label: "grep",
    description: schemaTools.grep.description,
    parameters: schemaTools.grep.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).grep.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme, ctx: any) {
      const entry = upsertEntry(ctx.toolCallId, "grep", args, ctx.invalidate);
      const burst = getBurstForId(ctx.toolCallId);
      const isGrouped = burst && burst.entries.length > 1;
      const isLeader =
        isGrouped && burst.entries[0].toolCallId === ctx.toolCallId;
      const pending = isGrouped
        ? burst.entries.some((e) => !e.result)
        : !entry.result;
      const isError = isGrouped
        ? burst.entries.some((e) => e.isError)
        : !!entry.isError;
      if (isGrouped && !isLeader) {
        // Refresh the leader's header/count. Single hop: a leader's renderCall
        // never invalidates anything, so this cannot loop.
        const lead = invalidateById.get(burst.entries[0].toolCallId);
        if (lead) lead();
        return new Container();
      }
      if (isGrouped && isLeader) {
        let header = `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("muted", `×${burst.entries.length}`)}`;
        header += `\n${burst.entries.map((e) => formatGrepBullet(e, theme)).join("\n")}`;
        if (ctx.expanded) {
          const details = burst.entries
            .map((e) => {
              const txt = e.result
                ? resultText(e.result as any)?.trim()
                : undefined;
              return txt
                ? `\n${theme.fg("muted", `— /${e.args.pattern}/`)}:\n${txt
                    .split("\n")
                    .slice(0, 10)
                    .map((l) => theme.fg("toolOutput", l))
                    .join("\n")}`
                : "";
            })
            .join("");
          if (details) header += details;
        }
        return makeBox(theme, pending, isError, header);
      }
      let line = `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", `/${args.pattern || ""}/`)}${theme.fg("toolOutput", ` in ${shortenPath(args.path || ".")}`)}`;
      if (args.glob) line += theme.fg("toolOutput", ` (${args.glob})`);
      if (ctx.expanded && entry.result) {
        const txt = resultText(entry.result as any)?.trim();
        if (txt)
          line += `\n${txt
            .split("\n")
            .map((l) => theme.fg("toolOutput", l))
            .join("\n")}`;
      }
      return makeBox(theme, pending, isError, line);
    },
    renderResult(result: any, _opts: any, _theme: any, ctx: any) {
      recordResult(entryById.get(ctx.toolCallId), result, ctx);
      return new Container();
    },
  });

  // ── ls ────────────────────────────────────────────────────────
  pi.registerTool({
    name: "ls",
    label: "ls",
    description: schemaTools.ls.description,
    parameters: schemaTools.ls.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).ls.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme, ctx: any) {
      const entry = upsertEntry(ctx.toolCallId, "ls", args, ctx.invalidate);
      const burst = getBurstForId(ctx.toolCallId);
      const isGrouped = burst && burst.entries.length > 1;
      const isLeader =
        isGrouped && burst.entries[0].toolCallId === ctx.toolCallId;
      const pending = isGrouped
        ? burst.entries.some((e) => !e.result)
        : !entry.result;
      const isError = isGrouped
        ? burst.entries.some((e) => e.isError)
        : !!entry.isError;
      if (isGrouped && !isLeader) {
        // Refresh the leader's header/count. Single hop: a leader's renderCall
        // never invalidates anything, so this cannot loop.
        const lead = invalidateById.get(burst.entries[0].toolCallId);
        if (lead) lead();
        return new Container();
      }
      if (isGrouped && isLeader) {
        let header = `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("muted", `×${burst.entries.length}`)}`;
        header += `\n${burst.entries.map((e) => formatLsBullet(e, theme)).join("\n")}`;
        if (ctx.expanded) {
          const details = burst.entries
            .map((e) => {
              const txt = e.result
                ? resultText(e.result as any)?.trim()
                : undefined;
              return txt
                ? `\n${theme.fg("muted", `— ${shortenPath(e.args.path || ".")}`)}:\n${txt
                    .split("\n")
                    .slice(0, 10)
                    .map((l) => theme.fg("toolOutput", l))
                    .join("\n")}`
                : "";
            })
            .join("");
          if (details) header += details;
        }
        return makeBox(theme, pending, isError, header);
      }
      let line = `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", shortenPath(args.path || "."))}`;
      if (ctx.expanded && entry.result) {
        const txt = resultText(entry.result as any)?.trim();
        if (txt)
          line += `\n${txt
            .split("\n")
            .map((l) => theme.fg("toolOutput", l))
            .join("\n")}`;
      }
      return makeBox(theme, pending, isError, line);
    },
    renderResult(result: any, _opts: any, _theme: any, ctx: any) {
      recordResult(entryById.get(ctx.toolCallId), result, ctx);
      return new Container();
    },
  });
}
