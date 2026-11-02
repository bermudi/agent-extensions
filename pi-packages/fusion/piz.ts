// piz connector: drives a PRIVATE piz core (ZCode Protocol over a Unix socket).
//
// Why a private core and not the shared one piz uses: the sidekick must not
// appear in, or interfere with, the operator's own piz sessions, and killing it
// with the pi session must never take a shared core down with it.
//
// Facts this file depends on (observed 2026-11-01/02 against the promoted core):
// - Only socket mode (`app-server --socket`) loads the standalone Z.AI account,
//   i.e. the signed coding-plan provider. stdio mode has zero models.
// - session/create defaults to permission mode "yolo"; we still set it.
// - session/create's `model` field is rejected for GLM without a reasoning
//   level at turn time, so we set the model with session/setModel afterwards.
// - session/send with delivery:"steer" injects into the running turn.
// - The core asks the client session/requestRuntimePreferences; answer it.
// - compactContextWindow (piz fork, 158a31d2) caps the auto-compact window.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { RpcError, RpcPeer, stopChild, withDeadline } from "./rpc.ts";
import {
  SIDEKICK_CONTEXT_WINDOW,
  type ConnectOptions,
  type SidekickConnector,
  type TurnCallbacks,
  type TurnOutcome,
} from "./types.ts";

const PIZ_PROVIDER_ID = "account:zai-individual-coding-plan";
const START_TIMEOUT_MS = 60_000;
const CORE_START_TIMEOUT_MS = 60_000;

export function pizCoreBinary(): string {
  return (
    process.env.FUSION_PIZ_CORE ??
    join(
      homedir(),
      "build/piz/apps/zcode-cli/packages/cli/dist-runtime/zcode.cjs",
    )
  );
}

const snapshotSchema = z
  .object({
    session: z.object({ sessionId: z.string() }).passthrough(),
    settings: z
      .object({
        model: z
          .object({
            available: z.array(
              z
                .object({
                  ref: z.object({
                    providerId: z.string(),
                    modelId: z.string(),
                  }),
                  reasoning: z
                    .object({ defaultLevel: z.string().optional() })
                    .passthrough()
                    .optional(),
                })
                .passthrough(),
            ),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

const rawEventSchema = z
  .object({
    sessionId: z.string(),
    type: z.string(),
    turnId: z.string().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

type RawEvent = z.infer<typeof rawEventSchema>;

interface ActiveTurn {
  inputId: string;
  callbacks: TurnCallbacks;
  resolve: (outcome: TurnOutcome) => void;
  reject: (error: Error) => void;
  lastText: string;
  contextUsed?: number;
}

export async function connectPiz(
  options: ConnectOptions,
): Promise<SidekickConnector> {
  const binary = pizCoreBinary();
  if (!existsSync(binary)) {
    throw new Error(
      `piz core not found at ${binary} (set FUSION_PIZ_CORE to override)`,
    );
  }
  const socketDir = mkdtempSync(join(tmpdir(), "pi-fusion-"));
  const socketPath = join(socketDir, "core.sock");

  // ZCODE_ATTACH_CORE makes ~/.zcode/herdr-hook.sh a no-op: the core's env would
  // otherwise carry THIS pane's HERDR_* and report the sidekick as the pane's agent.
  const env: NodeJS.ProcessEnv = { ...process.env, ZCODE_ATTACH_CORE: "1" };
  for (const key of Object.keys(env))
    if (key.startsWith("HERDR_")) delete env[key];
  delete env.ZCODE_WORKSPACE_IDENTITY;

  let child: ChildProcess;
  try {
    child = spawn(
      "node",
      [binary, "app-server", "--socket", socketPath, "--no-plugins"],
      {
        cwd: options.cwd,
        env,
        stdio: ["ignore", "ignore", "pipe"],
        detached: false,
      },
    );
  } catch (error) {
    rmSync(socketDir, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`piz sidekick failed to start: ${message}`);
  }
  // A spawn that fails asynchronously (bad cwd, missing node) surfaces through
  // the child's 'error' event — which would otherwise be an unhandled EventEmitter
  // error — until the connector installs its own listener. Record it so
  // waitForSocket fails fast instead of polling 60s.
  let startupError: Error | undefined;
  const onStartupError = (error: Error) => {
    startupError = error;
  };
  child.on("error", onStartupError);
  let stderrTail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
  });
  options.log.info("piz.core.spawned", { pid: child.pid, socketPath, binary });

  let connector: PizConnector | undefined;
  try {
    await waitForSocket(socketPath, child, () => startupError);
    const socket = await openSocket(socketPath);
    connector = new PizConnector(child, socket, options, socketDir);
    // The connector has its own 'error' listener now.
    child.removeListener("error", onStartupError);
    // A spawn error in the window between socket connect and the connector's
    // listener going up is still fatal.
    if (startupError) throw startupError;
    // A core that accepts the connection but never answers must not wedge /fusion.
    await withDeadline(
      connector.start(options.resumeSessionId),
      START_TIMEOUT_MS,
      "piz session start",
    );
    return connector;
  } catch (error) {
    if (connector) await connector.dispose();
    else {
      child.removeListener("error", onStartupError);
      await stopChild(child);
      rmSync(socketDir, { recursive: true, force: true });
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `piz sidekick failed to start: ${message}${stderrTail ? `\ncore stderr: ${stderrTail.slice(-800)}` : ""}`,
    );
  }
}

async function waitForSocket(
  path: string,
  child: ChildProcess,
  spawnError: () => Error | undefined,
): Promise<void> {
  const deadline = Date.now() + CORE_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const error = spawnError();
    if (error) throw error;
    if (child.exitCode !== null)
      throw new Error(`core exited with code ${child.exitCode}`);
    if (child.signalCode !== null)
      throw new Error(`core killed by signal ${child.signalCode}`);
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `core socket did not appear within ${CORE_START_TIMEOUT_MS / 1000}s`,
  );
}

function openSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path, () => {
      socket.removeListener("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

export class PizConnector implements SidekickConnector {
  readonly harness = "piz" as const;
  readonly model: string;
  sessionId = "";
  private readonly peer: RpcPeer;
  private active: ActiveTurn | undefined;
  private inputCounter = 0;
  private disposed = false;
  /** One-shot guard: onClosed necessarily sees an already-closed peer. */
  private transportClosed = false;

  constructor(
    private readonly child: ChildProcess,
    private readonly socket: Socket,
    private readonly options: ConnectOptions,
    private readonly socketDir: string,
  ) {
    this.model = options.model;
    this.peer = new RpcPeer({
      jsonrpc: false,
      idPrefix: "fusion",
      write: (line) => socket.write(line),
      onDiagnostic: (message, data) =>
        options.log.warn(`piz.rpc.${message}`, data),
      onClose: (reason) => this.onTransportClosed(reason),
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.peer.feed(chunk));
    socket.on("close", () =>
      this.onTransportClosed(new Error("piz core socket closed")),
    );
    socket.on("error", (error) => this.onTransportClosed(error));
    child.on("exit", (code) =>
      this.onTransportClosed(new Error(`piz core exited (${code})`)),
    );
    child.on("error", (error) => this.onTransportClosed(error));
    this.peer.setRequestHandler(async (method) => {
      if (method === "session/requestRuntimePreferences") {
        // Same local defaults the desktop host answers with; no memory, no extras.
        return {
          nativeSearchEnhancementsEnabled: false,
          memoryEnabled: false,
          askUserQuestionAutoResolutionEnabled: true,
        };
      }
      // Yolo mode means no permission prompts; anything else is unexpected.
      options.log.warn("piz.reverse_request.unhandled", { method });
      throw new RpcError(-32601, `fusion does not handle ${method}`);
    });
    this.peer.onNotification((method, params) =>
      this.onNotification(method, params),
    );
  }

  async start(resumeSessionId: string | undefined): Promise<void> {
    const workspace = {
      workspacePath: this.options.cwd,
      workspaceKey: this.options.cwd,
    };
    const common = { workspace, compactContextWindow: SIDEKICK_CONTEXT_WINDOW };
    const raw = resumeSessionId
      ? await this.peer.request("session/resume", {
          ...common,
          sessionId: resumeSessionId,
        })
      : await this.peer.request("session/create", {
          ...common,
          mode: "yolo",
          titleGenerationEnabled: false,
        });
    const snapshot = snapshotSchema.parse(raw);
    this.sessionId = snapshot.session.sessionId;

    const choice = snapshot.settings.model.available.find(
      (m) =>
        m.ref.providerId === PIZ_PROVIDER_ID && m.ref.modelId === this.model,
    );
    if (!choice) {
      const offered = snapshot.settings.model.available
        .map((m) => m.ref.modelId)
        .join(", ");
      throw new Error(
        `piz does not offer ${this.model} (offered: ${offered || "none — is the Z.AI login present?"})`,
      );
    }
    await this.peer.request("session/setModel", {
      sessionId: this.sessionId,
      persistAsWorkspaceLastUsed: false,
      model: {
        providerId: PIZ_PROVIDER_ID,
        modelId: this.model,
        options: { reasoningLevel: choice.reasoning?.defaultLevel ?? "max" },
      },
    });
    if (resumeSessionId) {
      await this.peer.request("session/setMode", {
        sessionId: this.sessionId,
        mode: "yolo",
      });
    }
    await this.peer.request("session/subscribe", {
      sessionId: this.sessionId,
      deliveryKind: "desktop-continuous",
      eventFormat: "raw",
      includeSnapshot: false,
    });
    this.options.log.info("piz.session.ready", {
      sessionId: this.sessionId,
      model: this.model,
      resumed: Boolean(resumeSessionId),
    });
  }

  prompt(
    text: string,
    callbacks: TurnCallbacks,
    signal: AbortSignal,
  ): Promise<TurnOutcome> {
    if (this.active)
      return Promise.reject(
        new Error("piz sidekick already has a running turn"),
      );
    if (signal.aborted)
      return Promise.reject(new Error("handoff aborted before it started"));
    const inputId = `fusion-${Date.now()}-${++this.inputCounter}`;
    return new Promise<TurnOutcome>((resolve, reject) => {
      const turn: ActiveTurn = {
        inputId,
        callbacks,
        resolve,
        reject,
        lastText: "",
      };
      this.active = turn;
      const onAbort = () => {
        void this.cancel();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const settle = () => signal.removeEventListener("abort", onAbort);
      turn.resolve = (outcome) => {
        settle();
        resolve(outcome);
      };
      turn.reject = (error) => {
        settle();
        reject(error);
      };
      this.peer
        .request("session/send", {
          sessionId: this.sessionId,
          inputId,
          content: text,
        })
        .catch((error: unknown) => {
          if (this.active === turn) this.active = undefined;
          turn.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
    });
  }

  async inject(text: string): Promise<boolean> {
    if (!this.active) return false;
    try {
      const result = z
        .object({ steerQueued: z.object({}).passthrough().optional() })
        .passthrough()
        .parse(
          await this.peer.request("session/send", {
            sessionId: this.sessionId,
            inputId: `fusion-steer-${Date.now()}-${++this.inputCounter}`,
            content: text,
            delivery: "steer",
          }),
        );
      if (result.steerQueued) return true;
      // Without steerQueued the core treated the text as a fresh prompt (the
      // turn had just ended). That orphan turn would run unattended and its
      // events would be misattributed to the next handoff, so stop it before
      // reporting failure (see the inject() contract in types.ts: the caller
      // throws for block:false / flags the report undelivered for blocking
      // calls, and the lead re-sends the update).
      this.options.log.warn("piz.steer.not_queued_stopping_orphan", {});
      await this.peer
        .request("session/stop", { sessionId: this.sessionId })
        .catch(() => undefined);
      return false;
    } catch (error) {
      this.options.log.warn("piz.steer.rejected", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async cancel(): Promise<void> {
    if (!this.active) return;
    await this.peer
      .request("session/stop", { sessionId: this.sessionId })
      .catch(() => undefined);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.active?.reject(new Error("sidekick shut down"));
    this.active = undefined;
    this.peer.close();
    this.socket.destroy();
    await stopChild(this.child);
    rmSync(this.socketDir, { recursive: true, force: true });
    this.options.log.info("piz.core.stopped", { sessionId: this.sessionId });
  }

  private onTransportClosed(error: Error): void {
    // Marked before peer.close: close() fires onClose, which lands back here.
    if (this.disposed || this.transportClosed) return;
    this.transportClosed = true;
    this.peer.close(error);
    const turn = this.active;
    this.active = undefined;
    turn?.reject(error);
    this.options.log.error("piz.transport.closed", { error: error.message });
    this.options.onClosed?.(error);
  }

  private onNotification(method: string, params: unknown): void {
    if (method === "state.updated") {
      const parsed = z
        .object({
          patch: z.object({ contextUsed: z.number().optional() }).passthrough(),
        })
        .passthrough()
        .safeParse(params);
      if (
        parsed.success &&
        this.active &&
        parsed.data.patch.contextUsed !== undefined
      ) {
        this.active.contextUsed = parsed.data.patch.contextUsed;
      }
      return;
    }
    if (method !== "session/rawEvent") return;
    const parsed = rawEventSchema.safeParse(params);
    if (!parsed.success || parsed.data.sessionId !== this.sessionId) return;
    this.onEvent(parsed.data);
  }

  private onEvent(event: RawEvent): void {
    const turn = this.active;
    if (!turn) return;
    const payload = event.payload ?? {};
    switch (event.type) {
      case "tool_call_started": {
        const name =
          typeof payload.toolName === "string" ? payload.toolName : "tool";
        turn.callbacks.onActivity({ kind: "tool", text: name });
        return;
      }
      case "tool_call_scheduled": {
        const name =
          typeof payload.toolName === "string" ? payload.toolName : "tool";
        turn.callbacks.onActivity({
          kind: "tool",
          text: describeToolInput(name, payload.input),
        });
        return;
      }
      case "model_complete": {
        // The last request's input size is the context in use (state.updated
        // carries no contextUsed for legacy subscribers; observed 2026-11-02).
        const usage = payload.usage as { inputTokens?: unknown } | undefined;
        if (typeof usage?.inputTokens === "number")
          turn.contextUsed = usage.inputTokens;
        if (typeof payload.content === "string" && payload.content.trim()) {
          turn.lastText = payload.content;
          turn.callbacks.onActivity({ kind: "text", text: payload.content });
        }
        return;
      }
      case "turn_steer_queued":
        turn.callbacks.onActivity({
          kind: "status",
          text: "lead update queued into the turn",
        });
        return;
      case "turn_complete": {
        this.active = undefined;
        const usage = z
          .object({
            inputTokens: z.number().optional(),
            outputTokens: z.number().optional(),
            cacheReadTokens: z.number().optional(),
          })
          .passthrough()
          .safeParse(payload.usage);
        const response =
          typeof payload.response === "string"
            ? payload.response
            : turn.lastText;
        turn.resolve({
          report: response,
          stopReason:
            typeof payload.resultType === "string"
              ? payload.resultType
              : "complete",
          contextUsed: turn.contextUsed,
          ...(usage.success
            ? {
                inputTokens: usage.data.inputTokens,
                outputTokens: usage.data.outputTokens,
                cacheReadTokens: usage.data.cacheReadTokens,
              }
            : {}),
        });
        return;
      }
      case "turn_error": {
        this.active = undefined;
        const err = z
          .object({
            message: z.string().optional(),
            code: z.string().optional(),
            type: z.string().optional(),
          })
          .passthrough()
          .safeParse(payload.error);
        const message = err.success
          ? (err.data.message ?? err.data.code)
          : undefined;
        // CoreErrorType.TurnCancelled = "turn_cancelled" (contracts/src/errors).
        if (
          err.success &&
          (err.data.type === "turn_cancelled" ||
            err.data.code === "turn_cancelled")
        ) {
          turn.resolve({ report: turn.lastText, stopReason: "cancelled" });
          return;
        }
        turn.reject(
          new Error(`piz turn failed: ${message ?? "unknown error"}`),
        );
        return;
      }
      default:
        return;
    }
  }
}

function describeToolInput(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of [
      "command",
      "file_path",
      "path",
      "pattern",
      "description",
    ]) {
      const value = record[key];
      if (typeof value === "string" && value.trim())
        return `${name}: ${value.trim()}`;
    }
  }
  return name;
}
