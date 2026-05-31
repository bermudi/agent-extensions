import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { sendCommand, ensureDaemon } from "@agent-pty/core";
import {
  deriveStatus,
  formatRuntime,
  statusIcon,
  statusLabel,
} from "../utils/format.js";

function makeId(): string {
  return crypto.randomUUID();
}

export function setupPtyCommands(pi: ExtensionAPI): void {
  pi.registerCommand("pty", {
    description: "List all active PTY sessions",
    handler: async (_args, ctx) => {
      await ensureDaemon();
      const res = (await sendCommand({
        id: makeId(),
        cmd: "list-sessions",
      })) as {
        ok: boolean;
        error?: string;
        sessions?: Array<{ name: string; command: string; cwd: string; pid: number; createdAt: string; killedAt?: string }>;
      };

      if (!res.ok) {
        ctx.ui.notify(`List failed: ${res.error ?? "unknown error"}`, "error");
        return;
      }

      const sessions = res.sessions ?? [];
      if (sessions.length === 0) {
        ctx.ui.notify("No PTY sessions.", "info");
        return;
      }

      const lines: string[] = ["PTY sessions:"];
      for (const s of sessions) {
        const status = deriveStatus(s);
        const icon = statusIcon(status);
        const label = statusLabel(status);
        const runtime = formatRuntime(s.createdAt, s.killedAt);
        lines.push(
          `- ${s.name}: ${s.command} in ${s.cwd} (${icon} ${label}, ${runtime})`,
        );
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("pty:snapshot", {
    description: "Show a snapshot of a PTY session: /pty:snapshot <name>",
    handler: async (args, ctx) => {
      await ensureDaemon();
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("Usage: /pty:snapshot <session-name>", "warning");
        return;
      }

      const res = (await sendCommand({
        id: makeId(),
        cmd: "snapshot",
        name,
        format: "text",
      })) as {
        ok: boolean;
        error?: string;
        text?: string;
        snapshotId?: number;
        at?: string;
        size?: unknown;
        cursor?: unknown;
        contentHash?: string;
      };

      if (!res.ok) {
        ctx.ui.notify(`Snapshot failed: ${res.error ?? "unknown error"}`, "error");
        return;
      }

      const lines = [
        `Snapshot #${res.snapshotId} of "${name}" at ${res.at ?? "?"}`,
        `Size: ${JSON.stringify(res.size)} | Cursor: ${JSON.stringify(res.cursor)} | Hash: ${res.contentHash}`,
        "---",
        res.text ?? "",
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("pty:scroll", {
    description: "Show scrollback of a PTY session: /pty:scroll <name> [--lines N]",
    handler: async (args, ctx) => {
      await ensureDaemon();
      const parts = args.trim().split(/\s+/);
      const name = parts[0];
      const linesArg = parts.find((p) => p.startsWith("--lines="));
      const lines = linesArg ? Number(linesArg.slice(8)) : 0;
      if (!name) {
        ctx.ui.notify("Usage: /pty:scroll <session-name> [--lines=N]", "warning");
        return;
      }

      const res = (await sendCommand({
        id: makeId(),
        cmd: "scroll",
        name,
        lines,
      })) as { ok: boolean; error?: string; text?: string };

      if (!res.ok) {
        ctx.ui.notify(`Scroll failed: ${res.error ?? "unknown error"}`, "error");
        return;
      }

      ctx.ui.notify(`Scrollback of "${name}":\n${res.text ?? ""}`, "info");
    },
  });

  pi.registerCommand("pty:wait-for-exit", {
    description: "Wait for a PTY session to exit: /pty:wait-for-exit <name> [-t <ms>]",
    handler: async (args, ctx) => {
      await ensureDaemon();
      const parts = args.trim().split(/\s+/);
      const name = parts[0];
      const timeoutArg = parts.find((p) => p.startsWith("-t="));
      const timeout = timeoutArg ? Number(timeoutArg.slice(3)) : 30000;
      if (!name) {
        ctx.ui.notify("Usage: /pty:wait-for-exit <session-name> [-t=<ms>]", "warning");
        return;
      }

      const res = (await sendCommand({
        id: makeId(),
        cmd: "wait-for-exit",
        name,
        timeout,
      })) as { ok: boolean; error?: string; exited?: boolean; timedOut?: boolean; exitCode?: number; signal?: number };

      if (!res.ok) {
        ctx.ui.notify(`Wait-for-exit failed: ${res.error ?? "unknown error"}`, "error");
        return;
      }

      if (res.timedOut) {
        ctx.ui.notify(`Timed out waiting for "${name}" to exit`, "warning");
        return;
      }

      const exitText = res.signal !== undefined
        ? `exitCode=${res.exitCode} signal=${res.signal}`
        : `exitCode=${res.exitCode}`;
      ctx.ui.notify(`Session "${name}" exited (${exitText})`, "info");
    },
  });

  pi.registerCommand("pty:kill", {
    description: "Kill a PTY session: /pty:kill <name>",
    handler: async (args, ctx) => {
      await ensureDaemon();
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("Usage: /pty:kill <session-name>", "warning");
        return;
      }

      const res = (await sendCommand({
        id: makeId(),
        cmd: "kill",
        name,
      })) as { ok: boolean; error?: string };

      if (!res.ok) {
        ctx.ui.notify(`Kill failed: ${res.error ?? "unknown error"}`, "error");
        return;
      }

      ctx.ui.notify(`Killed session "${name}"`, "info");
    },
  });

  pi.registerCommand("pty:remove", {
    description: "Remove a PTY session record: /pty:remove <name>",
    handler: async (args, ctx) => {
      await ensureDaemon();
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("Usage: /pty:remove <session-name>", "warning");
        return;
      }

      const res = (await sendCommand({
        id: makeId(),
        cmd: "remove",
        name,
      })) as { ok: boolean; error?: string };

      if (!res.ok) {
        ctx.ui.notify(`Remove failed: ${res.error ?? "unknown error"}`, "error");
        return;
      }

      ctx.ui.notify(`Removed session "${name}"`, "info");
    },
  });
}
