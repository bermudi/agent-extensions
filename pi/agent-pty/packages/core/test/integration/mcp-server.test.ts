import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { DaemonHarness } from "../helpers.js";
import { spawn } from "bun";
import { resolve } from "path";

async function mcpRpc(
  sockPath: string,
  msg: unknown,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const proc = spawn({
    cmd: ["bun", resolve(import.meta.dir, "../../../mcp-server/src/server.ts")],
    env: { ...process.env, AGENT_PTY_SOCK: sockPath },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(JSON.stringify(msg) + "\n");
  proc.stdin.end();

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  // Give it a moment to process then kill
  await new Promise((r) => setTimeout(r, 500));
  try { proc.kill(); } catch {}
  const exitCode = await Promise.race([
    proc.exited,
    new Promise<null>((r) => setTimeout(() => r(null), 1000)),
  ]);

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

describe("MCP server", () => {
  const harness = new DaemonHarness();

  beforeAll(async () => {
    await harness.start();
  });

  afterAll(async () => {
    await harness.stop();
  });

  test("lists agent_pty tools", async () => {
    const initReq = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.1" },
      },
    };

    const { stdout } = await mcpRpc(harness.sockPath, initReq);
    const lines = stdout.split("\n").filter((l) => l.trim());
    expect(lines.length).toBeGreaterThan(0);

    const initRes = JSON.parse(lines[0]!);
    expect(initRes.result).toBeDefined();
    expect(initRes.result.protocolVersion).toBeDefined();

    // Tools/list request
    const toolsReq = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    };
    const { stdout: toolsStdout } = await mcpRpc(harness.sockPath, toolsReq);
    const toolsLines = toolsStdout.split("\n").filter((l) => l.trim());
    expect(toolsLines.length).toBeGreaterThan(0);

    const toolsRes = JSON.parse(toolsLines[0]!);
    expect(toolsRes.result).toBeDefined();
    const names = (toolsRes.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("agent_pty_spawn");
    expect(names).toContain("agent_pty_snapshot");
    expect(names).toContain("agent_pty_wait_for");
    expect(names).toContain("agent_pty_kill");
    expect(names).toContain("agent_pty_list_sessions");
  });

  test("agent_pty_spawn via MCP", async () => {
    const req = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "agent_pty_spawn",
        arguments: {
          name: "mcp-test",
          command: "sleep",
          args: ["1000"],
        },
      },
    };

    const { stdout } = await mcpRpc(harness.sockPath, req);
    const lines = stdout.split("\n").filter((l) => l.trim());
    expect(lines.length).toBeGreaterThan(0);

    const res = JSON.parse(lines[0]!);
    expect(res.result).toBeDefined();
    const content = (res.result.content as Array<{ type: string; text: string }>)[0]!;
    expect(content.type).toBe("text");
    const parsed = JSON.parse(content.text);
    expect(parsed.ok).toBe(true);
    expect(parsed.name).toBe("mcp-test");

    // Clean up
    await harness.cmd("kill", { name: "mcp-test" });
    await harness.cmd("remove", { name: "mcp-test" });
  });
});
