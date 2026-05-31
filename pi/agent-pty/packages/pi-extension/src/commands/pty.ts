import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { sendCommand, ensureDaemon } from "@agent-pty/core";

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
        sessions?: Array<{ name: string; command: string; cwd: string; pid: number; createdAt: string }>;
      };

      if (!res.ok) {
        ctx.ui.notify(`List failed: ${res.error ?? "unknown error"}`, "error");
        return;
      }

      const sessions = res.sessions ?? [];
      if (sessions.length === 0) {
        ctx.ui.notify("No active PTY sessions.", "info");
        return;
      }

      const text = sessions
        .map((s) => `- ${s.name}: ${s.command} in ${s.cwd} (PID ${s.pid})`)
        .join("\n");

      ctx.ui.notify(`Active PTY sessions:\n${text}`, "info");
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
        size?: unknown;
        cursor?: unknown;
        contentHash?: string;
      };

      if (!res.ok) {
        ctx.ui.notify(`Snapshot failed: ${res.error ?? "unknown error"}`, "error");
        return;
      }

      const lines = [
        `Snapshot #${res.snapshotId} of "${name}"`,
        `Size: ${JSON.stringify(res.size)} | Cursor: ${JSON.stringify(res.cursor)} | Hash: ${res.contentHash}`,
        "---",
        res.text ?? "",
      ];

      ctx.ui.notify(lines.join("\n"), "info");
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
