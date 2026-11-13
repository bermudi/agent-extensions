/**
 * Monty-backed execution for the `run_code` tool: one lazily created pool+session per pi session,
 * nested tool calls dispatched through `ctx.executeTool` (so validation, `tool_call`/`tool_result`
 * hooks, and permission checks apply exactly as for direct calls), and pydantic-ai CodeMode-style
 * semantics: REPL state across calls, print capture, trailing-expression result, hard limits.
 *
 * Monty facts this relies on (probed against @pydantic/monty 1.6.0 under Bun):
 * - `externalLookup` async host functions must be awaited in the sandbox; a host throw surfaces
 *   there as RuntimeError carrying the thrown message.
 * - Sandbox call `f(1, a=2)` reaches the host as `[1, {a: 2}]` — kwargs arrive as a trailing
 *   object; `f(a=1)` as `[{a: 1}]`.
 * - `feedRun` resolves to the trailing expression's value, `null` for an assignment or `None`.
 * - Syntax/runtime errors keep the session; timeouts raise TimeoutError and also keep it. Only
 *   crash/disconnect-class errors poison it.
 * - `session.close()` during a pending feed waits for that feed to settle, so aborts work by
 *   rejecting the host call (and backstops: feed-duration timeout for pure compute, sleep cap).
 */
import {
  CollectString,
  Monty,
  MontyConfigurationError,
  MontyConnectError,
  MontyCrashedError,
  MontyDisconnectError,
  MontyError,
  MontyRefusedError,
  MontySession,
  MontyShutdown,
  ProtocolError,
} from "@pydantic/monty";
import type {
  AgentTool,
  AgentToolCallOutcome,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { buildIdentifierMap } from "./catalog.ts";

/** Resource limits per run_code call (pydantic-ai CodeMode defaults). */
export const DEFAULT_LIMITS = {
  /** Pure-compute execution time per feed; time paused on the host (tool calls) is excluded. */
  maxFeedDurationSecs: 30,
  maxMemory: 256 * 1024 * 1024,
  /** Cumulative sleep allowance — a sleeping snippet cannot out-wait the feed budget. */
  maxTotalSleepSecs: 30,
  maxSuspensions: 1000,
} as const;

/** Nested tool calls per run_code call. Past the cap, the call site raises inside the sandbox. */
export const MAX_TOOL_CALLS = 100;

/** Cap on the JSON the model sees as the result (pi's built-in output budget). */
const MAX_RESULT_CHARS = 50_000;
/** Cap on print output echoed to the model. */
const MAX_PRINT_CHARS = 8_000;

export interface RunCodeInput {
  code: string;
  restart?: boolean;
}

export type NestedCallStatus = "running" | "ok" | "error" | "cancelled";

export interface NestedCallRecord {
  id: string;
  name: string;
  args: string;
  status: NestedCallStatus;
  durationMs?: number;
  error?: string;
}

export interface RunCodeDetails {
  calls: NestedCallRecord[];
  printChars: number;
  /** The sandbox session was recreated before this call (restart or crash). */
  sessionReset?: boolean;
}

/** Monty errors that leave the session unusable; the next call must check out a fresh one. */
function isSessionFatal(error: unknown): boolean {
  if (
    error instanceof MontyCrashedError ||
    error instanceof MontyDisconnectError ||
    error instanceof MontyRefusedError ||
    error instanceof MontyConnectError ||
    error instanceof MontyConfigurationError ||
    error instanceof MontyShutdown ||
    error instanceof ProtocolError
  ) {
    return true;
  }
  // Non-Monty errors are bugs in this extension; dropping the session is the safe reset.
  return !(error instanceof MontyError);
}

/**
 * `[..., {kwargs}]` from the sandbox into one arguments object for executeTool. Positional
 * arguments map onto the tool's declared parameter names in order; a trailing object is the
 * kwargs dict. A positional past the declared parameters throws — a clear, retryable error
 * instead of silently dropping the argument.
 */
export function marshalToolArgs(
  args: readonly unknown[],
  paramNames: readonly string[] = [],
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  let positional = args.length > 0 ? args.slice(0, -1) : [];
  const last = args[args.length - 1];
  if (typeof last === "object" && last !== null && !Array.isArray(last)) {
    Object.assign(merged, last as Record<string, unknown>);
  } else {
    positional = args.slice();
  }
  for (const [i, arg] of positional.entries()) {
    if (i >= paramNames.length) {
      throw new Error(
        `too many positional arguments (got ${positional.length}, tool declares ${paramNames.length}); pass the rest as keyword arguments`,
      );
    }
    merged[paramNames[i]] = arg;
  }
  return merged;
}

/** Declared property names of a tool's parameter schema, in order, for positional-argument mapping. */
function paramNames(tool: AgentTool): string[] {
  const params = tool.parameters as unknown as
    { properties?: Record<string, unknown> } | undefined;
  return Object.keys(params?.properties ?? {});
}

/** What a nested call resolves to inside the sandbox: structuredContent, else text, else raise. */
export function nestedCallValue(
  outcome: AgentToolCallOutcome,
  tool: AgentTool,
): unknown {
  const blocks = outcome.result.content;
  const text = blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
  const structured =
    tool.outputSchema && outcome.result.structuredContent !== undefined
      ? outcome.result.structuredContent
      : undefined;
  if (outcome.isError && structured === undefined) {
    throw new Error(text || `tool ${outcome.toolCall.name} failed`);
  }
  if (structured === undefined && text === "" && blocks.length > 0) {
    // Non-text content (images) cannot cross into the sandbox; say so instead of an empty string.
    return "[non-text tool content omitted]";
  }
  return structured !== undefined ? structured : text;
}

function truncate(
  text: string,
  max: number,
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

function preview(value: unknown, max = 200): string {
  const json = JSON.stringify(value) ?? String(value);
  return json.length > max ? `${json.slice(0, max)}…` : json;
}

/** One nested call's status line for the result footer. */
function summarizeCalls(calls: readonly NestedCallRecord[]): string {
  const ok = calls.filter((c) => c.status === "ok").length;
  const errored = calls.filter((c) => c.status === "error").length;
  const cancelled = calls.filter((c) => c.status === "cancelled").length;
  if (calls.length === 0) return "";
  const parts = [`${calls.length} nested tool call(s): ${ok} ok`];
  if (errored) parts.push(`${errored} error`);
  if (cancelled) parts.push(`${cancelled} cancelled`);
  return parts.join(", ");
}

/** Feed the snippet, bridging nested tool calls, and build the tool result. */
export class MontyCodeRunner {
  private pool: Monty | undefined;
  private session: MontySession | undefined;
  private closed = false;

  constructor(private readonly limits: Partial<typeof DEFAULT_LIMITS> = {}) {}

  private async ensureSession(): Promise<MontySession> {
    if (this.closed) throw new Error("monty-code-mode runner is closed");
    if (this.session) return this.session;
    if (!this.pool) {
      const pool = await Monty.create({ minProcesses: 1 });
      // close() may have run while the pool was being created; do not leak it.
      if (this.closed) {
        await this.closePool(pool);
        throw new Error("monty-code-mode runner is closed");
      }
      this.pool = pool;
    }
    const session = await this.pool.checkout({
      limits: { ...DEFAULT_LIMITS, ...this.limits },
      scriptName: "run_code.py",
    });
    if (this.closed) {
      await session.close().catch(() => {});
      throw new Error("monty-code-mode runner is closed");
    }
    this.session = session;
    return session;
  }

  private async dropSession(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (session) await session.close().catch(() => {});
  }

  private async closePool(pool: Monty): Promise<void> {
    await Promise.race([
      pool.close().catch((error) => {
        console.error("[monty-code-mode] pool close failed:", error);
      }),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }

  /** Run one `run_code` call. Never rejects; failures come back as `isError` results. */
  async run(
    input: RunCodeInput,
    ctx: ExtensionToolContext,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<RunCodeDetails> | undefined,
  ): Promise<AgentToolResult<RunCodeDetails>> {
    const calls: NestedCallRecord[] = [];
    const print = new CollectString();
    const emit = (status: string): void => {
      onUpdate?.({
        content: [{ type: "text", text: status }],
        details: { calls: [...calls], printChars: 0 },
      });
    };

    let sessionReset = false;
    // Set when a tool call arrives with the signal already aborted: dispatch then raised
    // inside the sandbox, so the snippet has actually seen (and maybe swallowed) the abort.
    let abortObserved = false;
    try {
      if (input.restart) {
        await this.dropSession();
        sessionReset = true;
      }
      const session = await this.ensureSession();

      const callable = ctx.tools.filter((t) => t.name !== "run_code");
      const ids = buildIdentifierMap(callable.map((t) => t.name));
      const byId = new Map(
        callable.map((t) => [ids.get(t.name) ?? t.name, t] as const),
      );
      const externalLookup: Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      > = {};
      for (const [id, tool] of byId) {
        externalLookup[id] = async (...args: unknown[]) => {
          if (signal?.aborted) abortObserved = true;
          return this.dispatch(tool, id, args, ctx, signal, calls, emit);
        };
      }

      const value = await session.feedRun(input.code, {
        externalLookup,
        printCallback: print,
      });
      const aborted = signal?.aborted === true;
      for (const call of calls) {
        if (call.status === "running")
          call.status = aborted ? "cancelled" : "ok";
      }
      const success = this.renderSuccess(value, print.output, calls);
      return {
        content: [
          {
            type: "text",
            // A cancelled-but-completing run is labelled; only claim the snippet ignored the
            // abort when a tool call actually surfaced it there.
            text: aborted
              ? `run_code was cancelled mid-run; ${abortObserved ? "the snippet ignored the abort" : "no tool call saw the abort"}. Partial result:\n${success}`
              : success,
          },
        ],
        details: {
          calls,
          printChars: print.output.length,
          sessionReset: sessionReset || undefined,
        },
      };
    } catch (error) {
      const aborted = signal?.aborted === true;
      if (isSessionFatal(error)) {
        console.error("[monty-code-mode] sandbox session lost:", error);
        await this.dropSession();
        sessionReset = true;
      }
      for (const call of calls) {
        if (call.status === "running")
          call.status = aborted ? "cancelled" : "error";
      }
      const header = sessionReset
        ? "The Monty sandbox session was reset — re-run imports and recreate any state."
        : "Python error:";
      // Error text can be a full Monty traceback or a huge nested tool error; cap it like results.
      const message = truncate(
        error instanceof Error ? error.message : String(error),
        MAX_RESULT_CHARS,
      );
      const summary = summarizeCalls(calls);
      const parts: string[] = [];
      if (print.output) {
        const p = truncate(print.output.trimEnd(), MAX_PRINT_CHARS);
        parts.push(
          `<output>\n${p.text}${p.truncated ? "\n… (print output truncated)" : ""}\n</output>`,
        );
      }
      parts.push(
        aborted
          ? `run_code cancelled. ${summary}`
          : `${header} ${message.text}${message.truncated ? " … (error text truncated)" : ""}${summary ? `\n${summary}` : ""}`,
      );
      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: {
          calls,
          printChars: print.output.length,
          sessionReset: sessionReset || undefined,
        },
        isError: true,
      };
    }
  }

  /** One nested tool call: enforce the cap, marshal args, execute, map the outcome. */
  private async dispatch(
    tool: AgentTool,
    id: string,
    args: readonly unknown[],
    ctx: ExtensionToolContext,
    signal: AbortSignal | undefined,
    calls: NestedCallRecord[],
    emit: (status: string) => void,
  ): Promise<unknown> {
    if (calls.length >= MAX_TOOL_CALLS) {
      throw new Error(
        `run_code nested tool-call limit (${MAX_TOOL_CALLS}) exceeded; return the results you already have`,
      );
    }
    if (signal?.aborted) throw new Error("run_code aborted");
    const toolArgs = marshalToolArgs(args, paramNames(tool));
    const record: NestedCallRecord = {
      id: `${id}-${calls.length + 1}`,
      name: tool.name,
      args: preview(toolArgs),
      status: "running",
    };
    calls.push(record);
    emit(`running ${tool.name}…`);
    const startedAt = Date.now();
    const outcome = await ctx.executeTool(tool.name, toolArgs, { signal });
    record.durationMs = Date.now() - startedAt;
    try {
      const value = nestedCallValue(outcome, tool);
      record.status = "ok";
      emit(`done ${tool.name} (${record.durationMs}ms)`);
      return value;
    } catch (error) {
      record.status = "error";
      record.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private renderSuccess(
    value: unknown,
    printed: string,
    calls: readonly NestedCallRecord[],
  ): string {
    const parts: string[] = [];
    if (printed) {
      const p = truncate(printed.trimEnd(), MAX_PRINT_CHARS);
      parts.push(
        `<output>\n${p.text}${p.truncated ? "\n… (print output truncated)" : ""}\n</output>`,
      );
    }
    if (value !== null && value !== undefined) {
      const json = truncate(
        JSON.stringify(value, null, 2) ?? String(value),
        MAX_RESULT_CHARS,
      );
      parts.push(
        `<result>\n${json.text}${json.truncated ? "\n… (result truncated)" : ""}\n</result>`,
      );
    }
    const summary = summarizeCalls(calls);
    if (summary) parts.push(summary);
    if (parts.length === 0)
      return "run_code completed (no output, no result value).";
    return parts.join("\n");
  }

  /** Best-effort teardown for session_shutdown. Never rejects. */
  async close(): Promise<void> {
    // Flag first so a pool still being created by ensureSession() is closed there, not leaked.
    this.closed = true;
    // close() during a pending feed would wait for that feed; races are abandoned, not awaited.
    await Promise.race([
      this.dropSession(),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]).catch(() => {});
    const pool = this.pool;
    this.pool = undefined;
    if (pool) await this.closePool(pool);
  }
}
