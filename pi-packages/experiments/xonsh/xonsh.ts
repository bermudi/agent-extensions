/**
 * Xonsh Shell Extension
 *
 * Adds a xonsh tool alongside the built-in bash tool.
 * Uses `uv run` to provide on-demand dependency resolution — the agent
 * declares what it needs via the `deps` parameter and uv caches the result.
 *
 * Usage:
 *   pi -e pi/xonsh/xonsh.ts
 *   # or symlink to .pi/extensions/ for auto-discovery
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";

/**
 * Execute a command via `uv run --with xonsh [--with deps...] -- python -m xonsh -c '...'`
 * Handles streaming output, abort, timeout, and truncation.
 */
function executeXonsh(
  command: string,
  cwd: string,
  deps: string[],
  options?: { signal?: AbortSignal; timeout?: number },
): Promise<{ output: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const args = ["run", "--with", "xonsh"];
    for (const dep of deps) args.push("--with", dep);
    args.push("--", "python", "-m", "xonsh", "-c", command);

    const child = spawn("uv", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    const timer = options?.timeout
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, options.timeout * 1000)
      : undefined;

    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => chunks.push(d));

    const onAbort = () => child.kill();
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);

      if (options?.signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }

      const output = Buffer.concat(chunks).toString("utf-8");
      if (timedOut) {
        resolve({
          output: `${output}\n[Timed out after ${options!.timeout}s]`,
          exitCode: null,
        });
      } else {
        resolve({ output, exitCode: code });
      }
    });
  });
}

/** Basic truncation at 50KB to match pi's built-in bash behavior */
const MAX_OUTPUT_BYTES = 50 * 1024;
function truncate(output: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(output, "utf-8") > MAX_OUTPUT_BYTES) {
    return {
      text:
        output.slice(0, MAX_OUTPUT_BYTES) + "\n\n[Output truncated at 50KB]",
      truncated: true,
    };
  }
  return { text: output, truncated: false };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "xonsh",
    label: "xonsh",
    description: [
      "Execute a command in a xonsh shell (Python-powered shell).",
      "Supports Python expressions, subprocess mode, and mixed syntax.",
      "Use $(...) for captured subprocess output, ${...} for Python expressions.",
      "Example: files = $(ls).split(); print(len(files))",
      "Dependencies are resolved on-demand via uv — specify them in the deps parameter.",
    ].join(" "),
    promptSnippet: "Execute xonsh commands (Python + shell hybrid)",
    parameters: Type.Object({
      command: Type.String({ description: "The xonsh command to execute" }),
      deps: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Python packages to make available (e.g. ['openpyxl', 'pandas']). Resolved via uv — cached after first use.",
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (optional, no default timeout)",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { command, timeout } = params;
      const deps = params.deps ?? [];

      const { output, exitCode } = await executeXonsh(command, ctx.cwd, deps, {
        signal,
        timeout,
      });

      const { text, truncated } = truncate(output);

      return {
        content: [{ type: "text" as const, text }],
        details: { truncated, exitCode },
        isError: exitCode !== 0,
      };
    },
  });
}
