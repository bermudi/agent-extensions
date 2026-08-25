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
  timestamp: number;
  turnId: number;
  /** Position in `entries`; stable because entries are append-only. */
  index: number;
  result?: {
    content: Array<{ type: string; text?: string; data?: string }>;
    details?: any;
  };
  isError?: boolean;
  hasImage?: boolean;
};

const BURST_WINDOW_MS = 1500;
let turnId = 0;
// True while pi is replaying persisted history (startup with -c/--continue,
// /resume, /fork). During replay there are no turn_start events and wall-clock
// timestamps are meaningless (every upsert lands within the burst window), so
// each replayed entry gets a unique replayTurnId to force solo rendering.
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
      timestamp: Date.now(),
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
  if (a.turnId !== b.turnId) return false;
  if (a.toolName !== b.toolName) return false;
  if (a.hasImage || b.hasImage) return false;
  if (Math.abs(b.timestamp - a.timestamp) > BURST_WINDOW_MS) return false;
  // Also don't group if either is an image path hint (e.g. .png) before result known?
  // We keep pending image reads grouped optimistically; they'll split once hasImage is known.
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
  // burst; pending/error flags change the leader's box). Rerender those runs —
  // bounded, unlike scanning the whole history per result.
  const idx = changed.index;
  const ranges: Array<[number, number]> = [[idx, idx]];
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
  const box = new Box(1, 1, bgFor(pending, isError, theme));
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

function formatBashHeader(args: any, theme: any): string {
  const cmd = args.command || "...";
  const truncated = cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
  return theme.fg("accent", truncated);
}

function formatBashBullet(entry: Entry, theme: any): string {
  const cmd = entry.args.command || "...";
  const truncated = cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
  return `  ${theme.fg("muted", "•")} ${theme.fg("accent", truncated)}`;
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

  pi.on("turn_start", () => {
    turnId++;
    // First live turn after startup/resume: tool calls from here on may group.
    replaying = false;
  });
  pi.on("session_start", () => {
    turnId++;
    replaying = true;
    entries.length = 0;
    entryById.clear();
    invalidateById.clear();
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
        // follower hidden — but if it later becomes an image, revalidation will make it visible
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
    renderResult(result: any, { expanded }: any, theme: any, ctx: any) {
      const entry = entryById.get(ctx.toolCallId);
      if (entry) {
        entry.result = result;
        entry.isError = !!ctx.isError || !!result.isError;
        entry.hasImage = hasImageContent(result);
      }
      // Revalidate to split image bursts or update grouped details
      revalidateBurstsAround(ctx.toolCallId);
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

      if (isGrouped && !isLeader) return new Container();

      if (isGrouped && isLeader) {
        const count = burst.entries.length;
        let header = `${theme.fg("toolTitle", theme.bold("bash"))} ${theme.fg("muted", `×${count}`)}`;
        header += `\n${burst.entries.map((e) => formatBashBullet(e, theme)).join("\n")}`;
        if (ctx.expanded) {
          const details: string[] = [];
          for (const e of burst.entries) {
            if (!e.result) {
              details.push(
                theme.fg("warning", `— $ ${e.args.command}: pending`),
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
              `\n${theme.fg("muted", `— $ ${e.args.command.slice(0, 40)}`)}:\n${preview}`,
            );
          }
          if (details.length) header += `\n${details.join("\n")}`;
        }
        return makeBox(theme, pending, isError, header);
      }

      const suffix = args.timeout
        ? theme.fg("muted", ` (timeout ${args.timeout}s)`)
        : "";
      let line = `${theme.fg("toolTitle", theme.bold(`$ ${args.command || "..."}`))}${suffix}`;
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
      const entry = entryById.get(ctx.toolCallId);
      if (entry) {
        entry.result = result;
        entry.isError = !!ctx.isError || !!result.isError;
      }
      revalidateBurstsAround(ctx.toolCallId);
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
      if (isGrouped && !isLeader) return new Container();
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
      const entry = entryById.get(ctx.toolCallId);
      if (entry) {
        entry.result = result;
        entry.isError = !!ctx.isError || !!result.isError;
      }
      revalidateBurstsAround(ctx.toolCallId);
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
      if (isGrouped && !isLeader) return new Container();
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
      const entry = entryById.get(ctx.toolCallId);
      if (entry) {
        entry.result = result;
        entry.isError = !!ctx.isError || !!result.isError;
      }
      revalidateBurstsAround(ctx.toolCallId);
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
      if (isGrouped && !isLeader) return new Container();
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
      const entry = entryById.get(ctx.toolCallId);
      if (entry) {
        entry.result = result;
        entry.isError = !!ctx.isError || !!result.isError;
      }
      revalidateBurstsAround(ctx.toolCallId);
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
      if (isGrouped && !isLeader) return new Container();
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
      const entry = entryById.get(ctx.toolCallId);
      if (entry) {
        entry.result = result;
        entry.isError = !!ctx.isError || !!result.isError;
      }
      revalidateBurstsAround(ctx.toolCallId);
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
      if (isGrouped && !isLeader) return new Container();
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
      const entry = entryById.get(ctx.toolCallId);
      if (entry) {
        entry.result = result;
        entry.isError = !!ctx.isError || !!result.isError;
      }
      revalidateBurstsAround(ctx.toolCallId);
      return new Container();
    },
  });
}
