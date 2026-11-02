// Newline-delimited JSON-RPC peer, shared by both sidekick connectors.
// Devin speaks ACP (JSON-RPC 2.0 over stdio); the piz core speaks ZCode Protocol
// (same envelope minus the "jsonrpc" field, over a Unix socket). Both carry
// server→client requests (id + method) that we must answer.
import type { ChildProcess } from "node:child_process";
import { z } from "zod";

const messageSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number(),
        message: z.string(),
        data: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export type RequestHandler = (
  method: string,
  params: unknown,
) => Promise<unknown>;
export type NotificationHandler = (method: string, params: unknown) => void;

export interface RpcPeerOptions {
  /** Emit `"jsonrpc": "2.0"` on outgoing frames (ACP needs it; ZCode Protocol does not). */
  jsonrpc: boolean;
  /** Prefix for outgoing request ids (keeps ids distinguishable in logs). */
  idPrefix: string;
  write: (line: string) => void;
  onDiagnostic?: (message: string, data?: Record<string, unknown>) => void;
}

/** One line can be large (piz snapshots) but must not grow without bound on a broken stream. */
const MAX_LINE_CHARS = 8 * 1024 * 1024;

export class RpcPeer {
  private counter = 0;
  private buffer = "";
  private closed = false;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private requestHandler: RequestHandler | undefined;
  private readonly notificationHandlers = new Set<NotificationHandler>();

  constructor(private readonly options: RpcPeerOptions) {}

  setRequestHandler(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`rpc closed (${method})`));
    const id = `${this.options.idPrefix}-${++this.counter}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject });
      this.send({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.send({ method, ...(params === undefined ? {} : { params }) });
  }

  /** Feed raw transport bytes (already decoded to text). */
  feed(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_CHARS && !this.buffer.includes("\n")) {
      this.close(new Error("rpc stream sent an oversized line"));
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.dispatch(line);
    }
  }

  close(reason?: Error): void {
    if (this.closed) return;
    this.closed = true;
    const error = reason ?? new Error("rpc closed");
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private send(frame: Record<string, unknown>): void {
    const payload = this.options.jsonrpc ? { jsonrpc: "2.0", ...frame } : frame;
    this.options.write(`${JSON.stringify(payload)}\n`);
  }

  private dispatch(line: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      this.options.onDiagnostic?.("dropped non-JSON line", {
        preview: line.slice(0, 160),
      });
      return;
    }
    const parsed = messageSchema.safeParse(decoded);
    if (!parsed.success) {
      this.options.onDiagnostic?.("dropped malformed frame", {
        preview: line.slice(0, 160),
      });
      return;
    }
    const message = parsed.data;
    if (message.method !== undefined && message.id !== undefined) {
      void this.answer(message.id, message.method, message.params);
      return;
    }
    if (message.method !== undefined) {
      for (const handler of this.notificationHandlers) {
        try {
          handler(message.method, message.params);
        } catch (error) {
          this.options.onDiagnostic?.("notification handler threw", {
            method: message.method,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return;
    }
    if (message.id === undefined) return;
    const key = String(message.id);
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    if (message.error) {
      entry.reject(
        new RpcError(
          message.error.code,
          message.error.message,
          message.error.data,
        ),
      );
    } else {
      entry.resolve(message.result);
    }
  }

  private async answer(
    id: string | number,
    method: string,
    params: unknown,
  ): Promise<void> {
    try {
      if (!this.requestHandler)
        throw new RpcError(-32601, `method not found: ${method}`);
      const result = await this.requestHandler(method, params);
      if (!this.closed) this.send({ id, result: result ?? {} });
    } catch (error) {
      if (this.closed) return;
      const code = error instanceof RpcError ? error.code : -32000;
      const message = error instanceof Error ? error.message : String(error);
      this.send({ id, error: { code, message } });
    }
  }
}

/** Reject if `promise` has not settled within `ms` (startup handshakes only). */
export function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${ms / 1000}s`)),
      ms,
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * SIGTERM then SIGKILL after 3s. A child that already died (including by
 * signal: exitCode is null then, and 'exit' will not fire again) returns at once.
 */
export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
