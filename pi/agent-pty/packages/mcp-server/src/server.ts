#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { sendCommand, ensureDaemon } from "@agent-pty/core";

async function rpc(
  payload: { id: string; cmd: string; [key: string]: unknown },
  timeout?: number,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  try {
    const res = await sendCommand(payload, timeout);
    return { content: [{ type: "text", text: JSON.stringify(res) }] };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: false, error: err }),
        },
      ],
    };
  }
}

async function main() {
  await ensureDaemon();

  const server = new McpServer(
    {
      name: "agent-pty-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        "Headless PTY orchestration for AI agents. Spawn interactive terminal programs, " +
        "send input, capture screen snapshots, and wait for on-screen changes. " +
        "All sessions are named and persist until killed or removed.",
    },
  );

  // ── spawn ───────────────────────────────────────────────────────────────
  server.registerTool(
    "agent_pty_spawn",
    {
      description:
        "Spawn a named PTY session running a command. Returns {ok, name, pid}.",
      inputSchema: z.object({
        name: z.string().describe("Unique session name"),
        command: z.string().describe("Command to execute"),
        args: z.array(z.string()).optional().describe("Command arguments"),
        cwd: z.string().optional().describe("Working directory"),
        cols: z.number().int().min(1).optional().describe("Terminal columns (default 80)"),
        rows: z.number().int().min(1).optional().describe("Terminal rows (default 24)"),
      }),
    },
    async (args) =>
      rpc({
        id: crypto.randomUUID(),
        cmd: "spawn",
        name: args.name,
        command: args.command,
        args: args.args ?? [],
        cwd: args.cwd ?? process.cwd(),
        cols: args.cols ?? 80,
        rows: args.rows ?? 24,
      }),
  );

  // ── type ────────────────────────────────────────────────────────────────
  server.registerTool(
    "agent_pty_type",
    {
      description: "Send literal text to a PTY session.",
      inputSchema: z.object({
        name: z.string().describe("Session name"),
        text: z.string().describe("Text to type"),
      }),
    },
    async (args) =>
      rpc({
        id: crypto.randomUUID(),
        cmd: "type",
        name: args.name,
        text: args.text,
      }),
  );

  // ── key ─────────────────────────────────────────────────────────────────
  server.registerTool(
    "agent_pty_key",
    {
      description:
        "Send a named key or control sequence to a PTY session. Keys: enter, tab, escape, backspace, delete, up, down, left, right, home, end, pageup, pagedown, ctrl-c, ctrl-d, alt-x, or caret notation like ^C.",
      inputSchema: z.object({
        name: z.string().describe("Session name"),
        key: z.string().describe("Key name to send"),
      }),
    },
    async (args) =>
      rpc({
        id: crypto.randomUUID(),
        cmd: "key",
        name: args.name,
        key: args.key,
      }),
  );

  // ── snapshot ────────────────────────────────────────────────────────────
  server.registerTool(
    "agent_pty_snapshot",
    {
      description:
        "Capture the current visible screen of a PTY session. Returns {snapshotId, at, size, cursor, text, contentHash}.",
      inputSchema: z.object({
        name: z.string().describe("Session name"),
        format: z.enum(["text", "full"]).optional().describe("'full' includes grid array"),
      }),
    },
    async (args) =>
      rpc({
        id: crypto.randomUUID(),
        cmd: "snapshot",
        name: args.name,
        format: args.format ?? "text",
      }),
  );

  // ── scroll ──────────────────────────────────────────────────────────────
  server.registerTool(
    "agent_pty_scroll",
    {
      description:
        "Retrieve scrollback history (lines that scrolled off the visible screen). Returns {lines, text}.",
      inputSchema: z.object({
        name: z.string().describe("Session name"),
        lines: z.number().int().optional().describe("Max lines to return (default: all)"),
      }),
    },
    async (args) =>
      rpc({
        id: crypto.randomUUID(),
        cmd: "scroll",
        name: args.name,
        lines: args.lines ?? 0,
      }),
  );

  // ── wait_for ────────────────────────────────────────────────────────────
  server.registerTool(
    "agent_pty_wait_for",
    {
      description:
        "Block until screen text matches a pattern. Use --since snapshotId to skip immediate matches and only react to new data.",
      inputSchema: z.object({
        name: z.string().describe("Session name"),
        pattern: z.string().describe("Pattern to wait for"),
        regex: z.boolean().optional().describe("Treat pattern as regex (default false)"),
        since: z.number().int().optional().describe("Snapshot ID to skip immediate check"),
        timeout: z.number().int().min(0).optional().describe("Timeout in ms (default 30000)"),
      }),
    },
    async (args) => {
      const t = args.timeout ?? 30000;
      return rpc(
        {
          id: crypto.randomUUID(),
          cmd: "wait-for",
          name: args.name,
          pattern: args.pattern,
          regex: args.regex ?? false,
          timeout: t,
          ...(args.since !== undefined ? { since: args.since } : {}),
        },
        t + 5000,
      );
    },
  );

  // ── await_change ────────────────────────────────────────────────────────
  server.registerTool(
    "agent_pty_await_change",
    {
      description:
        "Block until the screen changes from its current state. Start this BEFORE triggering the action.",
      inputSchema: z.object({
        name: z.string().describe("Session name"),
        timeout: z.number().int().min(0).optional().describe("Timeout in ms (default 30000)"),
        settle: z.number().int().min(0).optional().describe("Settle time in ms (default 200)"),
      }),
    },
    async (args) => {
      const t = args.timeout ?? 30000;
      return rpc(
        {
          id: crypto.randomUUID(),
          cmd: "await-change",
          name: args.name,
          timeout: t,
          settle: args.settle ?? 200,
        },
        t + 5000,
      );
    },
  );

  // ── wait_for_exit ─────────────────────────────────────────────────────
  server.registerTool(
    "agent_pty_wait_for_exit",
    {
      description: "Block until the PTY process exits. Returns {exited, exitCode, signal?, elapsed}.",
      inputSchema: z.object({
        name: z.string().describe("Session name"),
        timeout: z.number().int().min(0).optional().describe("Timeout in ms (default 30000)"),
      }),
    },
    async (args) => {
      const t = args.timeout ?? 30000;
      return rpc(
        {
          id: crypto.randomUUID(),
          cmd: "wait-for-exit",
          name: args.name,
          timeout: t,
        },
        t + 5000,
      );
    },
  );

  // ── kill ────────────────────────────────────────────────────────────────
  server.registerTool(
    "agent_pty_kill",
    {
      description:
        "Terminate a PTY session but keep its record for forensic inspection. Use remove to clean up afterwards.",
      inputSchema: z.object({
        name: z.string().describe("Session name"),
        signal: z.string().optional().describe("Signal to send (default: SIGHUP)"),
      }),
    },
    async (args) =>
      rpc({
        id: crypto.randomUUID(),
        cmd: "kill",
        name: args.name,
        ...(args.signal ? { signal: args.signal } : {}),
      }),
  );

  // ── remove ──────────────────────────────────────────────────────────────
  server.registerTool(
    "agent_pty_remove",
    {
      description: "Permanently remove a session record from the daemon.",
      inputSchema: z.object({
        name: z.string().describe("Session name"),
      }),
    },
    async (args) =>
      rpc({
        id: crypto.randomUUID(),
        cmd: "remove",
        name: args.name,
      }),
  );

  // ── list_sessions ───────────────────────────────────────────────────────
  server.registerTool(
    "agent_pty_list_sessions",
    {
      description: "List all sessions including killed ones.",
      inputSchema: z.object({}),
    },
    async () =>
      rpc({
        id: crypto.randomUUID(),
        cmd: "list-sessions",
      }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // StdioServerTransport keeps the event loop alive via stdin reading.
  // When the parent process closes the pipe or sends SIGTERM, we exit.
  await new Promise(() => {});
}

main().catch((e) => {
  console.error("MCP server failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
