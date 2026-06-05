import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
// ── Per-server timeout defaults (ms) ────────────────────────────────────

const SERVER_TIMEOUTS: Record<string, number> = {
  tavily: 30_000,
  grep: 15_000,
  deepwiki: 60_000,
  context7: 30_000,
  "poe-research": 120_000,
  "zai-vision": 120_000,
  "next-devtools": 30_000,
};
const DEFAULT_TIMEOUT = 60_000;
const TIMEOUT_BUFFER = 10_000;

// ── Types ──────────────────────────────────────────────────────────────

interface ServerInfo {
  name: string;
  tools: { name: string; description: string }[];
}

// ── Schema discovery ───────────────────────────────────────────────────

async function discoverServers(): Promise<ServerInfo[]> {
  const result = await runRaw(["list", "--json"], 30_000);
  if (result.exitCode !== 0) return [];

  try {
    const data = JSON.parse(result.stdout);
    // Full list format: { mode: "list", servers: [...] }
    if (data.servers) return data.servers as ServerInfo[];
    // Single server format: { name, tools: [...] }
    if (data.name) return [data as ServerInfo];
  } catch {
    // Not JSON — mcporter may not be installed
  }
  return [];
}

function buildDirectory(servers: ServerInfo[]): string {
  const lines: string[] = ["## MCP Tools", ""];
  lines.push("Use the `mcp` tool to call these external services.");
  lines.push("Pass arguments as a JSON object in the `args` parameter.");
  lines.push("");

  for (const server of servers) {
    for (const tool of server.tools) {
      const desc = tool.description.split("\n")[0].slice(0, 120);
      lines.push(`- **${server.name}.${tool.name}** — ${desc}`);
    }
  }

  return lines.join("\n");
}

// ── Spawn helper ───────────────────────────────────────────────────────

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  killed: boolean;
}

function runRaw(
  args: string[],
  timeout: number,
  signal?: AbortSignal,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn("mcporter", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: code,
        stdout,
        stderr,
        killed: timedOut || signal?.aborted === true,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: null,
        stdout: "",
        stderr: err.message,
        killed: false,
      });
    });
  });
}

// ── Output truncation ──────────────────────────────────────────────────

async function truncateOutput(
  text: string,
): Promise<{ text: string; truncated: boolean; fullPath?: string }> {
  const result = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!result.truncated) return { text: result.content, truncated: false };

  const tempDir = await mkdtemp(join(tmpdir(), "pi-mcp-"));
  const tempFile = join(tempDir, "output.txt");
  await withFileMutationQueue(tempFile, async () => {
    await writeFile(tempFile, text, "utf8");
  });

  const omittedLines = result.totalLines - result.outputLines;
  const omittedBytes = result.totalBytes - result.outputBytes;

  const out =
    result.content +
    `\n\n[Output truncated: showing ${result.outputLines} of ${result.totalLines} lines ` +
    `(${formatSize(result.outputBytes)} of ${formatSize(result.totalBytes)}). ` +
    `${omittedLines} lines (${formatSize(omittedBytes)}) omitted. ` +
    `Full output saved to: ${tempFile}]`;

  return { text: out, truncated: true, fullPath: tempFile };
}

// ── Extension ──────────────────────────────────────────────────────────

export default function mcpExtension(pi: ExtensionAPI) {
  let servers: ServerInfo[] = [];
  let serverNames: Set<string> = new Set();
  let directoryCache = "";

  // ── Lifecycle ──────────────────────────────────────────────────────

  let discoveryDone = false;

  pi.on("session_start", () => {
    // Kick off discovery in background — doesn't block startup
    discoverServers().then((discovered) => {
      servers = discovered;
      serverNames = new Set(servers.map((s) => s.name));
      directoryCache = buildDirectory(servers);
      discoveryDone = true;
    });
  });

  async function ensureDiscovered(): Promise<void> {
    if (discoveryDone) return;
    servers = await discoverServers();
    serverNames = new Set(servers.map((s) => s.name));
    directoryCache = buildDirectory(servers);
    discoveryDone = true;
  }

  // ── System prompt injection ────────────────────────────────────────

  pi.on("before_agent_start", async (event) => {
    if (!discoveryDone || !directoryCache) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + directoryCache };
  });

  // ── Main tool: mcp ─────────────────────────────────────────────────

  pi.registerTool({
    name: "mcp",
    label: "MCP",
    description:
      "Call any configured MCP server tool via mcporter. " +
      "Pass tool arguments as a JSON object in the 'args' parameter. " +
      "Use mcp_list to discover available servers and their tools, or check the MCP Tools section in the system prompt.",
    promptSnippet: "Call external MCP tools (web search, code search, vision, research, docs)",
    promptGuidelines: [
      "Use mcp for web search (tavily), code search (grep), image analysis (zai-vision), " +
        "research (poe-research), library docs (context7), repo understanding (deepwiki).",
      "For content from a known URL: try curl first (free, instant). If that fails, use " +
        "mcp with tavily.tavily_extract.",
      "For web search: tavily.tavily_search (quick facts) or poe-research.research (synthesized analysis).",
      "For deep research: poe-research.deep_research. This is slow — use higher timeout.",
      "For code examples: grep.searchGitHub searches literal code patterns, not natural language.",
      "For library docs: context7 requires two calls — resolve-library-id first, then query-docs.",
      "For images: when read returns 'model does not support images', use zai-vision tools.",
      "If a call times out, increase the timeout parameter or simplify the query.",
    ],
    parameters: Type.Object({
      server: Type.String({ description: "MCP server name (e.g. 'tavily', 'grep', 'zai-vision')" }),
      tool: Type.String({ description: "Tool name on the server (e.g. 'tavily_search', 'searchGitHub')" }),
      args: Type.Record(Type.String(), Type.Any(), {
        description: "Tool arguments as a JSON object. Key names must match the tool's expected parameters.",
      }),
      timeout: Type.Optional(
        Type.Number({
          description:
            "Override timeout in milliseconds. Default varies by server (15s–120s). " +
            "Increase for slow operations like deep_research or video analysis.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      // Ensure discovery completed before validating server names
      await ensureDiscovered();

      // Validate server name
      if (!serverNames.has(params.server)) {
        const available = [...serverNames].join(", ") || "(none discovered)";
        return {
          content: [
            {
              type: "text",
              text: `Unknown MCP server '${params.server}'. Available: ${available}`,
            },
          ],
          isError: true,
        };
      }

      const innerTimeout = params.timeout ?? SERVER_TIMEOUTS[params.server] ?? DEFAULT_TIMEOUT;
      const outerTimeout = innerTimeout + TIMEOUT_BUFFER;

      const args = [
        "call",
        `${params.server}.${params.tool}`,
        "--args",
        JSON.stringify(params.args),
        "--timeout",
        String(innerTimeout),
      ];

      const result = await runRaw(args, outerTimeout, signal);

      // Handle process killed (timeout or abort)
      if (result.killed) {
        const secs = Math.round(innerTimeout / 1000);
        return {
          content: [
            {
              type: "text",
              text: signal?.aborted
                ? `Call to ${params.server}.${params.tool} was aborted.`
                : `Call to ${params.server}.${params.tool} timed out after ${secs}s. ` +
                  `Try increasing the timeout parameter or simplifying the query.`,
            },
          ],
          isError: true,
        };
      }

      // Handle spawn failure
      if (result.exitCode === null) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to spawn mcporter: ${result.stderr}`,
            },
          ],
          isError: true,
        };
      }

      // Handle mcporter errors (exit ≠ 0)
      if (result.exitCode !== 0) {
        const parts = [result.stdout, result.stderr].filter(Boolean);
        return {
          content: [
            {
              type: "text",
              text: parts.join("\n") || `mcporter exited with code ${result.exitCode}`,
            },
          ],
          isError: true,
        };
      }

      // Success — truncate if needed
      const output = await truncateOutput(result.stdout);
      return {
        content: [{ type: "text", text: output.text }],
        details: {
          server: params.server,
          tool: params.tool,
          truncated: output.truncated,
          fullPath: output.fullPath,
        },
      };
    },

    // ── TUI rendering ──────────────────────────────────────────────

    renderCall(args, theme, ctx) {
      const text = (ctx?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const selector = `${args.server}.${args.tool}`;
      const argKeys = args.args ? Object.keys(args.args).join(", ") : "";
      let label = theme.bold(theme.fg("toolTitle", "mcp "));
      label += theme.fg("accent", selector);
      if (argKeys) label += theme.fg("muted", ` (${argKeys})`);
      text.setText(label);
      return text;
    },

    renderResult(result, { expanded }, theme, ctx) {
      const text = (ctx?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const details = result.details as {
        server?: string;
        tool?: string;
        truncated?: boolean;
        fullPath?: string;
      } | void;

      if (result.isError) {
        text.setText(theme.fg("error", "✗ error"));
        return text;
      }

      let label = theme.fg("success", "✓");
      if (details?.truncated) {
        label += theme.fg("warning", " (truncated)");
      }

      if (expanded) {
        const content = result.content[0];
        if (content?.type === "text") {
          const lines = content.text.split("\n").slice(0, 12);
          for (const line of lines) {
            label += `\n` + theme.fg("dim", line);
          }
          if (content.text.split("\n").length > 12) {
            label += `\n` + theme.fg("muted", "...");
          }
        }
      }

      text.setText(label);
      return text;
    },
  });

  // ── Discovery tool: mcp_list ───────────────────────────────────────

  pi.registerTool({
    name: "mcp_list",
    label: "MCP List",
    description:
      "List available MCP servers and their tools with full parameter schemas. " +
      "Use when you need exact parameter names, types, or defaults for an mcp call.",
    parameters: Type.Object({
      server: Type.Optional(
        Type.String({
          description:
            "Specific server to inspect. Omit to list all servers (no schemas).",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      await ensureDiscovered();

      const args = params.server
        ? ["list", params.server, "--schema", "--json"]
        : ["list", "--json"];

      const result = await runRaw(args, 30_000, signal);

      if (result.exitCode !== 0) {
        return {
          content: [
            {
              type: "text",
              text: result.stderr || result.stdout || "Failed to list MCP servers.",
            },
          ],
          isError: true,
        };
      }

      const output = await truncateOutput(result.stdout);
      return {
        content: [{ type: "text", text: output.text }],
      };
    },

    renderCall(args, theme, ctx) {
      const text = (ctx?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const target = args.server ?? "all";
      text.setText(theme.bold(theme.fg("toolTitle", "mcp_list ")) + theme.fg("accent", target));
      return text;
    },

    renderResult(result, _opts, theme, ctx) {
      const text = (ctx?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if (result.isError) {
        text.setText(theme.fg("error", "✗ error"));
      } else {
        text.setText(theme.fg("success", "✓ listed"));
      }
      return text;
    },
  });
}
