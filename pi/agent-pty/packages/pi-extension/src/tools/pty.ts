import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { sendCommand, ensureDaemon } from "@agent-pty/core";

const PTY_ACTIONS = [
  "spawn",
  "type",
  "key",
  "snapshot",
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
      "PTY action to perform: spawn, type, key, snapshot, wait_for, await_change, wait_for_exit, kill, list_sessions",
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
  pattern: Type.Optional(
    Type.String({ description: "Pattern to wait for (for wait_for action)" }),
  ),
  regex: Type.Optional(
    Type.Boolean({ description: "Treat pattern as regex (for wait_for action, default false)" }),
  ),
  skip_existing: Type.Optional(
    Type.Boolean({ description: "Skip immediate match, only match new data (for wait_for action, default false)" }),
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
    case "wait_for": {
      payload.name = params.name;
      payload.pattern = params.pattern;
      payload.regex = params.regex ?? false;
      payload.skipExisting = params.skip_existing ?? false;
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

export function setupPtyTools(pi: ExtensionAPI) {
  pi.registerTool<typeof PtyParams, PtyDetails>({
    name: "pty",
    label: "PTY",
    description:
      "Spawn and control pseudo-terminal sessions. " +
      "Actions: spawn (start a session), type (send text), key (send special key), " +
      "snapshot (capture screen), wait_for (wait for text/pattern), " +
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
      let text = theme.bold(theme.fg("toolTitle", "pty "));
      text += theme.fg("accent", args.action);
      if (args.name) {
        text += ` ${theme.fg("muted", String(args.name))}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as PtyDetails | undefined;
      if (!details) {
        return new Text(theme.fg("dim", "No details"), 0, 0);
      }
      if (details.success) {
        return new Text(theme.fg("success", "OK"), 0, 0);
      }
      return new Text(theme.fg("error", details.message), 0, 0);
    },
  });
}
