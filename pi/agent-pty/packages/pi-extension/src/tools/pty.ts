import { Type } from "@sinclair/typebox";
import type {
  AgentToolResult,
  ExtensionAPI,
  Theme,
  ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { sendCommand, ensureDaemon } from "@agent-pty/core";
import {
  deriveStatus,
  deriveStatusFromResult,
  formatRuntime,
  formatSessionStatus,
  statusColor,
  statusIcon,
  statusLabel,
  truncate,
  type SessionListEntry,
} from "../utils/format.js";

const PTY_ACTIONS = [
  "spawn",
  "type",
  "key",
  "snapshot",
  "scroll",
  "wait_for",
  "await_change",
  "wait_for_exit",
  "kill",
  "remove",
  "list_sessions",
] as const;

const PtyParams = Type.Object({
  action: Type.String({
    description:
      "PTY action to perform: spawn, type, key, snapshot, scroll, wait_for, await_change, wait_for_exit, kill, list_sessions",
  }),
  name: Type.Optional(Type.String({ description: "Session name" })),
  command: Type.Optional(
    Type.String({ description: "Command to spawn (for spawn action)" }),
  ),
  args: Type.Optional(
    Type.Array(Type.String(), {
      description: "Arguments for spawned command (for spawn action)",
    }),
  ),
  cwd: Type.Optional(
    Type.String({ description: "Working directory (for spawn action)" }),
  ),
  cols: Type.Optional(
    Type.Number({ description: "Terminal columns (for spawn action, default 80)" }),
  ),
  rows: Type.Optional(
    Type.Number({ description: "Terminal rows (for spawn action, default 24)" }),
  ),
  text: Type.Optional(
    Type.String({ description: "Text to type (for type action)" }),
  ),
  key: Type.Optional(
    Type.String({ description: "Key to send (for key action)" }),
  ),
  format: Type.Optional(
    Type.String({
      description: "Snapshot format: 'text' or 'full' (for snapshot action, default 'text')",
    }),
  ),
  lines: Type.Optional(
    Type.Number({
      description: "Number of scrollback lines to return (for scroll action, 0 = all)",
    }),
  ),
  pattern: Type.Optional(
    Type.String({ description: "Pattern to wait for (for wait_for action)" }),
  ),
  regex: Type.Optional(
    Type.Boolean({ description: "Treat pattern as regex (for wait_for action, default false)" }),
  ),
  since: Type.Optional(
    Type.Number({ description: "Snapshot ID to skip immediate check; only match on data after this snapshot (for wait_for action)" }),
  ),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in milliseconds (default 30000)" }),
  ),
  settle: Type.Optional(
    Type.Number({ description: "Settle time in ms (for await_change action, default 200)" }),
  ),
  signal: Type.Optional(
    Type.String({ description: "Signal to send (for kill action)" }),
  ),
});

interface PtyDetails {
  action: string;
  success: boolean;
  message: string;
  result?: unknown;
}

function actionToCmd(action: string): string {
  switch (action) {
    case "wait_for":
      return "wait-for";
    case "await_change":
      return "await-change";
    case "wait_for_exit":
      return "wait-for-exit";
    case "list_sessions":
      return "list-sessions";
    default:
      return action;
  }
}

function buildCommand(
  action: string,
  params: Record<string, unknown>,
): { id: string; cmd: string; [key: string]: unknown } {
  const cmd = actionToCmd(action);
  const id = crypto.randomUUID();

  const payload: Record<string, unknown> = { id, cmd };

  switch (action) {
    case "spawn": {
      payload.name = params.name;
      payload.command = params.command;
      if (params.args !== undefined) payload.args = params.args;
      if (params.cwd !== undefined) payload.cwd = params.cwd;
      payload.cols = params.cols ?? 80;
      payload.rows = params.rows ?? 24;
      break;
    }
    case "type": {
      payload.name = params.name;
      payload.text = params.text;
      break;
    }
    case "key": {
      payload.name = params.name;
      payload.key = params.key;
      break;
    }
    case "snapshot": {
      payload.name = params.name;
      payload.format = params.format ?? "text";
      break;
    }
    case "scroll": {
      payload.name = params.name;
      payload.lines = params.lines ?? 0;
      break;
    }
    case "wait_for": {
      payload.name = params.name;
      payload.pattern = params.pattern;
      payload.regex = params.regex ?? false;
      if (params.since !== undefined) payload.since = params.since;
      payload.timeout = params.timeout ?? 30000;
      break;
    }
    case "await_change": {
      payload.name = params.name;
      payload.timeout = params.timeout ?? 30000;
      payload.settle = params.settle ?? 200;
      break;
    }
    case "wait_for_exit": {
      payload.name = params.name;
      payload.timeout = params.timeout ?? 30000;
      break;
    }
    case "kill": {
      payload.name = params.name;
      if (params.signal !== undefined) payload.signal = params.signal;
      break;
    }
    case "remove": {
      payload.name = params.name;
      break;
    }
    case "list_sessions": {
      break;
    }
  }

  return payload as { id: string; cmd: string; [key: string]: unknown };
}

function getTimeout(action: string, params: Record<string, unknown>): number {
  const defaultTimeout = 30000;
  switch (action) {
    case "wait_for":
    case "await_change":
    case "wait_for_exit": {
      const t = typeof params.timeout === "number" ? params.timeout : defaultTimeout;
      return t + 5000;
    }
    default:
      return defaultTimeout;
  }
}

// ── Tool registration ────────────────────────────────────────────────────

export function setupPtyTools(pi: ExtensionAPI) {
  pi.registerTool<typeof PtyParams, PtyDetails>({
    name: "pty",
    label: "PTY",
    description:
      "Spawn and control pseudo-terminal sessions. " +
      "Actions: spawn (start a session), type (send text), key (send special key), " +
      "snapshot (capture screen), scroll (retrieve scrollback), wait_for (wait for text/pattern), " +
      "await_change (wait for screen to change), wait_for_exit (wait for process exit), " +
      "kill (terminate session), list_sessions (list active sessions).",
    parameters: PtyParams,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      await ensureDaemon();

      const command = buildCommand(params.action, params as Record<string, unknown>);
      const timeout = getTimeout(params.action, params as Record<string, unknown>);

      const res = (await sendCommand(command, timeout)) as {
        ok: boolean;
        error?: string;
        [key: string]: unknown;
      };

      const success = res.ok === true;
      const message = success ? "OK" : (res.error ?? "unknown error");

      const details: PtyDetails = {
        action: params.action,
        success,
        message,
        result: res,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(res) }],
        details,
      };
    },

    renderCall(args, theme, _context) {
      return renderPtyCall(args as Record<string, unknown>, theme);
    },

    renderResult(result, options, theme, _context) {
      return renderPtyResult(result, options, theme);
    },
  });
}

// ── renderCall dispatch ──────────────────────────────────────────────────

function renderPtyCall(args: Record<string, unknown>, theme: Theme): Text {
  const action = String(args.action ?? "unknown");
  const name = args.name ? String(args.name) : undefined;

  const boldPty = theme.bold(theme.fg("toolTitle", "pty"));
  const actionStr = theme.fg("accent", action);

  switch (action) {
    case "spawn": {
      const cmd = args.command ? String(args.command) : "?";
      const main = name ? `"${name}" ${cmd}` : cmd;
      return new Text(`${boldPty} ${actionStr} ${main}`, 0, 0);
    }
    case "type": {
      const text = args.text ? String(args.text) : "";
      const preview = text.length > 30 ? `${text.slice(0, 30)}…` : text;
      return new Text(`${boldPty} ${actionStr} ${name ? `"${name}"` : ""} "${preview}"`, 0, 0);
    }
    case "key": {
      const key = args.key ? String(args.key) : "?";
      return new Text(`${boldPty} ${actionStr} ${name ? `"${name}"` : ""} ${key}`, 0, 0);
    }
    case "snapshot":
    case "scroll":
    case "wait_for":
    case "await_change":
    case "wait_for_exit":
    case "kill":
    case "remove": {
      return new Text(`${boldPty} ${actionStr} ${name ? `"${name}"` : ""}`, 0, 0);
    }
    case "list_sessions": {
      return new Text(`${boldPty} ${actionStr}`, 0, 0);
    }
    default: {
      return new Text(`${boldPty} ${actionStr} ${name ? `"${name}"` : ""}`, 0, 0);
    }
  }
}

// ── renderResult dispatch ─────────────────────────────────────────────────

function renderPtyResult(
  result: AgentToolResult<PtyDetails>,
  _options: ToolRenderResultOptions,
  theme: Theme,
): Text {
  const details = result.details;

  if (!details) {
    return new Text(theme.fg("dim", "No details"), 0, 0);
  }

  if (!details.success) {
    return new Text(theme.fg("error", details.message), 0, 0);
  }

  const res = (details.result ?? {}) as Record<string, unknown>;

  switch (details.action) {
    case "spawn":
      return renderSpawnResult(res, theme);
    case "list_sessions":
      return renderListResult(res, theme);
    case "snapshot":
      return renderSnapshotResult(res, theme);
    case "scroll":
      return renderScrollResult(res, theme);
    case "wait_for":
      return renderWaitForResult(res, theme);
    case "await_change":
      return renderAwaitChangeResult(res, theme);
    case "wait_for_exit":
      return renderWaitForExitResult(res, theme);
    case "type":
      return renderTypeResult(res, theme);
    case "key":
      return renderKeyResult(res, theme);
    case "kill":
      return renderKillResult(res, theme);
    case "remove":
      return renderRemoveResult(res, theme);
    default:
      return new Text(theme.fg("success", "OK"), 0, 0);
  }
}

// ── Per-action renderResult implementations ────────────────────────────────

function renderSpawnResult(res: Record<string, unknown>, theme: Theme): Text {
  const name = String(res.name ?? "?");
  const pid = typeof res.pid === "number" ? res.pid : "?";
  const lines: string[] = [
    theme.fg("success", "Started PTY session"),
    `  name: ${theme.fg("accent", name)}`,
    `  pid: ${String(pid)}`,
  ];
  return new Text(lines.join("\n"), 0, 0);
}

function renderListResult(res: Record<string, unknown>, theme: Theme): Text {
  const sessions = [...(res.sessions ?? []) as SessionListEntry[]];
  if (sessions.length === 0) {
    return new Text(theme.fg("dim", "No PTY sessions"), 0, 0);
  }

  // Sort: running first, then killed, then exited; newest first within each group
  const statusRank = (s: SessionListEntry): number => {
    const st = deriveStatus(s).status;
    return st === "running" ? 0 : st === "killed" ? 1 : 2;
  };
  sessions.sort((a, b) => {
    const rankDiff = statusRank(a) - statusRank(b);
    if (rankDiff !== 0) return rankDiff;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  const dim = (s: string) => theme.fg("dim", s);
  const lines: string[] = [
    theme.fg("success", `${sessions.length} session(s)`),
    "",
  ];

  for (const s of sessions) {
    const status = deriveStatus(s);
    const statusText = formatSessionStatus(status, theme);
    const runtime = formatRuntime(s.createdAt, s.killedAt);
    const cmd = truncate(s.command, 30);
    lines.push(
      `- ${theme.fg("accent", s.name)} ${dim(`(${s.pid})`)}  ${statusText}  ${dim(runtime)}`,
    );
    lines.push(`  ${dim(cmd)}`);
  }

  return new Text(lines.join("\n"), 0, 0);
}

function renderSnapshotResult(res: Record<string, unknown>, theme: Theme): Text {
  const snapshotId = typeof res.snapshotId === "number" ? res.snapshotId : "?";
  const size = res.size as { cols?: number; rows?: number } | undefined;
  const cursor = res.cursor as { row?: number; col?: number } | undefined;
  const contentHash = String(res.contentHash ?? "?");
  const text = String(res.text ?? "");

  const dim = (s: string) => theme.fg("dim", s);
  const lines: string[] = [
    `Snapshot #${snapshotId}  ${dim(`${size?.cols ?? "?"}×${size?.rows ?? "?"}`)}  cursor(${cursor?.row ?? "?"},${cursor?.col ?? "?"})  ${dim(contentHash)}`,
    "",
    text,
  ];

  return new Text(lines.join("\n"), 0, 0);
}

function renderScrollResult(res: Record<string, unknown>, theme: Theme): Text {
  const scrollLines = (res.lines ?? []) as string[];
  const text = String(res.text ?? "");
  const lines: string[] = [
    theme.fg("success", `Scrollback (${scrollLines.length} lines)`),
    "",
    text,
  ];
  return new Text(lines.join("\n"), 0, 0);
}

function renderWaitForResult(res: Record<string, unknown>, theme: Theme): Text {
  const matched = res.matched === true;
  const timedOut = res.timedOut === true;
  const elapsed = typeof res.elapsed === "number" ? `${res.elapsed}ms` : "";

  if (matched) {
    return new Text(theme.fg("success", `Pattern matched (${elapsed})`), 0, 0);
  }
  if (timedOut) {
    return new Text(theme.fg("warning", `Timed out (${elapsed})`), 0, 0);
  }
  return new Text(theme.fg("dim", "No match"), 0, 0);
}

function renderAwaitChangeResult(res: Record<string, unknown>, theme: Theme): Text {
  const changed = res.changed === true;
  const settled = res.settled === true;
  const timedOut = res.timedOut === true;
  const elapsed = typeof res.elapsed === "number" ? `${res.elapsed}ms` : "";

  if (changed && settled) {
    return new Text(theme.fg("success", `Screen changed and settled (${elapsed})`), 0, 0);
  }
  if (changed && !settled) {
    return new Text(theme.fg("success", `Screen changed (${elapsed})`), 0, 0);
  }
  if (timedOut) {
    return new Text(theme.fg("warning", `No change — timed out (${elapsed})`), 0, 0);
  }
  return new Text(theme.fg("dim", "No change"), 0, 0);
}

function renderWaitForExitResult(res: Record<string, unknown>, theme: Theme): Text {
  const exited = res.exited === true;
  const timedOut = res.timedOut === true;
  const elapsed = typeof res.elapsed === "number" ? `${res.elapsed}ms` : "";

  if (!exited && timedOut) {
    return new Text(theme.fg("warning", `Still running — timed out (${elapsed})`), 0, 0);
  }

  const status = deriveStatusFromResult(res);
  const icon = statusIcon(status);
  const label = statusLabel(status);
  const color = statusColor(status);
  const statusText = theme.fg(color, `${icon} ${label}`);

  return new Text(`${statusText}  ${theme.fg("dim", elapsed)}`, 0, 0);
}

function renderTypeResult(_res: Record<string, unknown>, theme: Theme): Text {
  return new Text(theme.fg("success", "Sent"), 0, 0);
}

function renderKeyResult(res: Record<string, unknown>, theme: Theme): Text {
  const sent = res.sent ? String(res.sent) : "";
  const preview = sent ? ` (${sent})` : "";
  return new Text(theme.fg("success", `Sent${preview}`), 0, 0);
}

function renderKillResult(res: Record<string, unknown>, theme: Theme): Text {
  const killedAt = res.killedAt ? String(res.killedAt) : undefined;
  const lines: string[] = [theme.fg("warning", "Session killed")];
  if (killedAt) {
    lines.push(`  ${theme.fg("dim", killedAt)}`);
  }
  return new Text(lines.join("\n"), 0, 0);
}

function renderRemoveResult(_res: Record<string, unknown>, theme: Theme): Text {
  return new Text(theme.fg("dim", "Session removed"), 0, 0);
}
