/**
 * Xonsh Shell Extension
 *
 * Adds a xonsh tool alongside the built-in bash tool. Uses `uv run` for
 * on-demand dependency resolution — the agent declares what it needs via the
 * `deps` parameter and uv caches the result.
 *
 * Usage:
 *   pi -e pi-packages/experiments/xonsh/xonsh.ts
 *   # or symlink to .pi/extensions/ for auto-discovery
 */

import { createWriteStream, type WriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const XONSH_PACKAGE = "xonsh==0.24.1";
const MAX_ROLLING_BYTES = DEFAULT_MAX_BYTES * 2;
const MAX_DEPENDENCIES = 32;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
const UPDATE_THROTTLE_MS = 100;
const EXIT_STDIO_GRACE_MS = 100;

type LogValue = string | number | boolean;

function logXonsh(event: string, fields: Record<string, LogValue>): void {
  const suffix = Object.entries(fields)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  console.error(`[xonsh] ${event}${suffix ? ` ${suffix}` : ""}`);
}

type OutputStream = "stdout" | "stderr";

interface ExecuteOptions {
  signal?: AbortSignal;
  timeout?: number;
  onOutput?: (output: string) => void;
}

interface OutputSnapshot {
  text: string;
  truncation: TruncationResult;
}

interface XonshExecutionResult extends OutputSnapshot {
  exitCode: number | null;
  timedOut: boolean;
  fullOutputPath?: string;
}

interface XonshDetails {
  truncated: boolean;
  exitCode: number | null;
  timedOut: boolean;
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

interface OutputFile {
  directory: string;
  path: string;
  stream: WriteStream;
}

/**
 * Accumulates only a bounded tail in memory while tracking full-output totals.
 * The complete raw output is written to a temporary file by the caller.
 *
 * This intentionally mirrors Pi's internal OutputAccumulator
 * (`core/tools/output-accumulator.ts`), which is not part of the public API.
 * Keep the two implementations aligned when that upstream logic changes.
 */
class OutputCapture {
  private readonly decoders: Record<OutputStream, TextDecoder> = {
    stdout: new TextDecoder(),
    stderr: new TextDecoder(),
  };
  private rollingText = "";
  private totalBytes = 0;
  private newlineCount = 0;
  private hasOpenLine = false;
  private tailStartsAtLineBoundary = true;

  append(stream: OutputStream, data: Buffer): void {
    this.totalBytes += data.byteLength;
    this.appendText(this.decoders[stream].decode(data, { stream: true }));
  }

  finish(): void {
    this.appendText(this.decoders.stdout.decode());
    this.appendText(this.decoders.stderr.decode());
  }

  snapshot(): OutputSnapshot {
    const totalLines = this.newlineCount + (this.hasOpenLine ? 1 : 0);
    const truncation = truncateTail(this.getSnapshotText(), {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    });
    const truncated =
      this.totalBytes > DEFAULT_MAX_BYTES || totalLines > DEFAULT_MAX_LINES;
    const truncatedBy =
      truncation.truncatedBy ??
      (totalLines > DEFAULT_MAX_LINES ? "lines" : "bytes");

    return {
      text: truncated ? truncation.content : this.rollingText,
      truncation: {
        ...truncation,
        truncated,
        truncatedBy: truncated ? truncatedBy : null,
        totalBytes: this.totalBytes,
        totalLines,
      },
    };
  }

  private appendText(text: string): void {
    if (!text) return;

    for (const character of text) {
      if (character === "\n") {
        this.newlineCount++;
        this.hasOpenLine = false;
      } else {
        this.hasOpenLine = true;
      }
    }

    const combined = Buffer.from(this.rollingText + text, "utf8");
    if (combined.byteLength <= MAX_ROLLING_BYTES) {
      this.rollingText = combined.toString("utf8");
      return;
    }

    let start = combined.byteLength - MAX_ROLLING_BYTES;
    while (start < combined.byteLength && (combined[start]! & 0xc0) === 0x80) {
      start++;
    }
    this.tailStartsAtLineBoundary =
      start === 0
        ? this.tailStartsAtLineBoundary
        : combined[start - 1] === 0x0a;
    this.rollingText = combined.subarray(start).toString("utf8");
  }

  private getSnapshotText(): string {
    if (this.tailStartsAtLineBoundary) return this.rollingText;

    const firstNewline = this.rollingText.indexOf("\n");
    return firstNewline === -1
      ? this.rollingText
      : this.rollingText.slice(firstNewline + 1);
  }
}

function validateTimeout(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(
      "Invalid timeout: must be a finite number greater than zero",
    );
  }

  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(
      `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`,
    );
  }
  return timeoutMs;
}

function validateDependencies(deps: string[]): void {
  if (deps.length > MAX_DEPENDENCIES) {
    throw new Error(`Too many dependencies; maximum is ${MAX_DEPENDENCIES}`);
  }

  for (const dep of deps) {
    if (!dep.trim()) throw new Error("Dependency names cannot be empty");
    if (dep.startsWith("-")) {
      throw new Error(`Invalid dependency specifier: ${dep}`);
    }
  }
}

function sendSignalToProcessTree(pid: number, signal: NodeJS.Signals): void {
  try {
    // Detached Unix children are process-group leaders. This reaches xonsh,
    // Python, and any subprocesses that xonsh started.
    process.kill(-pid, signal);
  } catch {
    // The process may have exited between the group and direct kill attempts.
    try {
      process.kill(pid, signal);
    } catch {
      // Nothing remains to kill.
    }
  }
}

/** Terminate a child tree immediately. */
function terminateProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill("SIGKILL");
    return;
  }

  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may already be gone.
      }
    });
    return;
  }

  sendSignalToProcessTree(child.pid, "SIGKILL");
}

async function openOutputFile(): Promise<OutputFile> {
  const directory = await mkdtemp(join(tmpdir(), "pi-xonsh-"));
  const path = join(directory, "output.log");
  const stream = createWriteStream(path);

  try {
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        stream.removeListener("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        stream.removeListener("open", onOpen);
        reject(error);
      };
      stream.once("open", onOpen);
      stream.once("error", onError);
    });
  } catch (error) {
    stream.destroy();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  return { directory, path, stream };
}

async function closeOutputFile(outputFile: OutputFile): Promise<void> {
  const { stream } = outputFile;
  if (stream.destroyed || stream.writableFinished) return;

  await new Promise<void>((resolve, reject) => {
    const onFinish = () => {
      stream.removeListener("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      stream.removeListener("finish", onFinish);
      reject(error);
    };

    stream.once("finish", onFinish);
    stream.once("error", onError);
    if (!stream.writableEnded) stream.end();
  });
}

function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };
    const maybeFinish = () => {
      if (exited && stdoutEnded && stderrEnded) finish(exitCode);
    };
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(exitCode), EXIT_STDIO_GRACE_MS);
    };
    const onData = () => {
      // A descendant can inherit stdout/stderr after the direct child exits.
      // Keep collecting while it is active, but do not wait forever when it
      // becomes quiet.
      if (exited) armIdleTimer();
    };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinish();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinish();
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinish();
      if (!settled) armIdleTimer();
    };
    const onClose = (code: number | null) => finish(code);

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

function makeUpdateEmitter(
  capture: OutputCapture,
  onOutput: ((output: string) => void) | undefined,
): { schedule(): void; flush(): void; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const emit = () => onOutput?.(capture.snapshot().text);
  const schedule = () => {
    if (!onOutput || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      emit();
    }, UPDATE_THROTTLE_MS);
  };
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    emit();
  };
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  return { schedule, flush, stop };
}

/**
 * Execute a command via
 * `uv run --with xonsh==... [--with deps...] -- xonsh -c ...`.
 *
 * Output is streamed to a temporary file and only a bounded tail is retained
 * in memory. The file is kept only when Pi's output limits are exceeded.
 */
async function executeXonsh(
  command: string,
  cwd: string,
  deps: string[],
  options: ExecuteOptions = {},
): Promise<XonshExecutionResult> {
  const timeoutMs = validateTimeout(options.timeout);
  validateDependencies(deps);

  if (options.signal?.aborted) throw new Error("aborted");

  const startedAt = Date.now();
  logXonsh("start", {
    dependencies: deps.length,
    timeoutSeconds: options.timeout ?? "none",
  });

  const args = ["run", "--with", XONSH_PACKAGE];
  for (const dep of deps) args.push("--with", dep);
  args.push("--", "xonsh", "-c", command);

  const outputFile = await openOutputFile();
  const capture = new OutputCapture();
  const updates = makeUpdateEmitter(capture, options.onOutput);
  let keepOutputFile = false;
  let timedOut = false;
  let aborted = false;
  let terminationRequested = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let fileError: Error | undefined;
  let streamError: Error | undefined;
  let child: ChildProcess | undefined;

  const requestTermination = () => {
    if (terminationRequested || !child) return;
    terminationRequested = true;
    terminateProcessTree(child);
  };

  const onFileError = (error: Error) => {
    fileError ??= error;
    requestTermination();
  };
  const onOutputStreamError = (error: Error) => {
    streamError ??= error;
    requestTermination();
  };
  outputFile.stream.on("error", onFileError);

  try {
    child = spawn("uv", args, {
      cwd,
      detached: process.platform !== "win32",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    // Keep the complete raw output on disk without growing the JS heap.
    child.stdout?.pipe(outputFile.stream, { end: false });
    child.stderr?.pipe(outputFile.stream, { end: false });
    child.stdout?.on("error", onOutputStreamError);
    child.stderr?.on("error", onOutputStreamError);
    child.stdout?.on("data", (data: Buffer) => {
      capture.append("stdout", data);
      updates.schedule();
    });
    child.stderr?.on("data", (data: Buffer) => {
      capture.append("stderr", data);
      updates.schedule();
    });

    const onAbort = () => {
      aborted = true;
      requestTermination();
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    if (timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        requestTermination();
      }, timeoutMs);
    }

    if (fileError) requestTermination();

    let exitCode: number | null;
    try {
      exitCode = await waitForChildProcess(child);
    } finally {
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
    }

    child.stdout?.unpipe(outputFile.stream);
    child.stderr?.unpipe(outputFile.stream);
    await closeOutputFile(outputFile);

    if (fileError) throw fileError;
    if (streamError) throw streamError;

    capture.finish();
    updates.flush();
    const snapshot = capture.snapshot();
    keepOutputFile = snapshot.truncation.truncated;

    const result = {
      ...snapshot,
      exitCode,
      timedOut,
      fullOutputPath: keepOutputFile ? outputFile.path : undefined,
    };
    if (aborted || options.signal?.aborted) {
      throw new Error(`${formatOutput(result)}\n\nCommand aborted`);
    }
    if (timedOut) {
      throw new Error(
        `${formatOutput(result)}\n\nCommand timed out after ${options.timeout} seconds`,
      );
    }

    logXonsh("complete", {
      durationMs: Date.now() - startedAt,
      exitCode: result.exitCode ?? "signal",
      outputBytes: result.truncation.totalBytes,
      truncated: result.truncation.truncated,
    });
    return result;
  } catch (error) {
    logXonsh("failed", {
      aborted,
      durationMs: Date.now() - startedAt,
      reason: error instanceof Error ? error.name : "unknown",
      timedOut,
    });
    throw error;
  } finally {
    updates.stop();
    if (timeoutHandle) clearTimeout(timeoutHandle);
    child?.stdout?.unpipe(outputFile.stream);
    child?.stderr?.unpipe(outputFile.stream);
    child?.stdout?.removeListener("error", onOutputStreamError);
    child?.stderr?.removeListener("error", onOutputStreamError);
    await closeOutputFile(outputFile);
    outputFile.stream.removeListener("error", onFileError);

    if (!keepOutputFile) {
      await rm(outputFile.directory, { recursive: true, force: true });
    }
  }
}

function formatOutput(result: XonshExecutionResult): string {
  const { truncation } = result;
  let text = result.text || "(no output)";
  if (!truncation.truncated) return text;

  if (truncation.lastLinePartial) {
    text +=
      `\n\n[Showing the last ${formatSize(truncation.outputBytes)} of ` +
      `a line that exceeds the ${formatSize(DEFAULT_MAX_BYTES)} limit. ` +
      `Full output saved to: ${result.fullOutputPath}]`;
  } else if (truncation.truncatedBy === "lines") {
    const firstLine = truncation.totalLines - truncation.outputLines + 1;
    text +=
      `\n\n[Showing lines ${firstLine}-${truncation.totalLines} of ` +
      `${truncation.totalLines}. Full output saved to: ${result.fullOutputPath}]`;
  } else {
    text +=
      `\n\n[Showing the last ${formatSize(truncation.outputBytes)} of ` +
      `${formatSize(truncation.totalBytes)}. Full output saved to: ` +
      `${result.fullOutputPath}]`;
  }
  return text;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "xonsh",
    label: "xonsh",
    description: [
      "Execute a command in a xonsh shell (Python-powered shell).",
      "Supports Python expressions, subprocess mode, and mixed syntax.",
      "Use $(...) to capture subprocess output; use @(expression) in a subprocess command to expand a Python expression.",
      "Example: files = $(ls).split(); print(len(files)) or x = 'hi'; echo @(x)",
      "Dependencies are resolved on-demand via uv — specify them in the deps parameter.",
      `Output is streamed and truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; full output is saved to a temporary file when truncated.`,
    ].join(" "),
    promptSnippet: "Execute xonsh commands (Python + shell hybrid)",
    parameters: Type.Object({
      command: Type.String({ description: "The xonsh command to execute" }),
      deps: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          maxItems: MAX_DEPENDENCIES,
          description:
            "Python packages to make available (e.g. ['openpyxl', 'pandas']). Resolved via uv — cached after first use.",
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          exclusiveMinimum: 0,
          maximum: MAX_TIMEOUT_SECONDS,
          description: "Timeout in seconds (optional, no default timeout)",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const { command, timeout } = params;
      const deps = params.deps ?? [];

      const result = await executeXonsh(command, ctx.cwd, deps, {
        signal,
        timeout,
        onOutput: (output) => {
          onUpdate?.({
            content: [{ type: "text", text: output || "(no output)" }],
            details: undefined,
          });
        },
      });

      const text = formatOutput(result);
      const details: XonshDetails = {
        truncated: result.truncation.truncated,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        truncation: result.truncation.truncated ? result.truncation : undefined,
        fullOutputPath: result.fullOutputPath,
      };

      if (result.exitCode !== 0) {
        throw new Error(
          `${text}\n\nCommand exited with code ${result.exitCode}`,
        );
      }

      return {
        content: [{ type: "text" as const, text }],
        details,
      };
    },
  });
}
