// Devin connector: `devin acp` (Agent Client Protocol, JSON-RPC 2.0 over stdio).
//
// Observed 2026-11-01 against Devin CLI 3000.11.234:
// - `--model` pins the default model for new sessions; we also set it on the
//   session via session/set_config_option and verify the reported value.
// - Mode "bypass" ("Bypass Permissions") runs tools without asking (yolo).
// - A second session/prompt while one is running is merged into the running
//   turn (advertised as cognition.ai/midTurnPrompts); both requests resolve
//   when the merged turn ends. That is the steering surface.
// - session/load reattaches to a persisted session (loadSession capability).
// - ACP collapses a model family into one `model` value plus a `thought_level`
//   option: SWE-2 is model "swe-2-high" (label "SWE-2"); "SWE-2 Medium" is
//   that plus thought_level "medium" (observed 2026-11-02). The CLI name
//   "swe-2-medium" is rejected by session/set_config_option.
import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import { RpcError, RpcPeer } from "./rpc.ts";
import type {
  ConnectOptions,
  SidekickConnector,
  TurnCallbacks,
  TurnOutcome,
} from "./types.ts";

/** CLI model name -> ACP (model value, thought level). */
const ACP_MODEL: Record<string, { model: string; thoughtLevel: string }> = {
  "swe-2-medium": { model: "swe-2-high", thoughtLevel: "medium" },
};

const configOptionsSchema = z.array(
  z
    .object({ id: z.string(), currentValue: z.unknown().optional() })
    .passthrough(),
);

const newSessionSchema = z
  .object({
    sessionId: z.string(),
    configOptions: configOptionsSchema.optional(),
  })
  .passthrough();

const promptResultSchema = z
  .object({
    stopReason: z.string(),
    usage: z
      .object({
        inputTokens: z.number().optional(),
        outputTokens: z.number().optional(),
        cachedReadTokens: z.number().optional(),
        totalTokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const sessionUpdateSchema = z
  .object({
    sessionId: z.string(),
    update: z.object({ sessionUpdate: z.string() }).passthrough(),
  })
  .passthrough();

interface ActiveTurn {
  callbacks: TurnCallbacks;
  text: string;
  contextUsed?: number;
}

export async function connectDevin(
  options: ConnectOptions,
): Promise<SidekickConnector> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("HERDR_")) delete env[key];
  const child = spawn("devin", ["acp", "--model", options.model], {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderrTail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
  });
  options.log.info("devin.acp.spawned", {
    pid: child.pid,
    model: options.model,
  });
  const connector = new DevinConnector(child, options);
  try {
    await connector.start(options.resumeSessionId);
    return connector;
  } catch (error) {
    await connector.dispose();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `devin sidekick failed to start: ${message}${stderrTail ? `\nstderr: ${stderrTail.slice(-800)}` : ""}`,
    );
  }
}

class DevinConnector implements SidekickConnector {
  readonly harness = "devin" as const;
  readonly model: string;
  sessionId = "";
  private readonly peer: RpcPeer;
  private active: ActiveTurn | undefined;
  private disposed = false;

  constructor(
    private readonly child: ChildProcess,
    private readonly options: ConnectOptions,
  ) {
    this.model = options.model;
    this.peer = new RpcPeer({
      jsonrpc: true,
      idPrefix: "fusion",
      write: (line) => {
        child.stdin?.write(line);
      },
      onDiagnostic: (message, data) =>
        options.log.warn(`devin.rpc.${message}`, data),
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.peer.feed(chunk));
    child.on("exit", (code) => this.onExit(code));
    child.on("error", (error) => this.onExit(null, error));
    this.peer.setRequestHandler(async (method, params) =>
      this.onRequest(method, params),
    );
    this.peer.onNotification((method, params) =>
      this.onNotification(method, params),
    );
  }

  async start(resumeSessionId: string | undefined): Promise<void> {
    await this.peer.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
    const cwd = this.options.cwd;
    if (resumeSessionId) {
      await this.peer.request("session/load", {
        sessionId: resumeSessionId,
        cwd,
        mcpServers: [],
      });
      this.sessionId = resumeSessionId;
    } else {
      const created = newSessionSchema.parse(
        await this.peer.request("session/new", { cwd, mcpServers: [] }),
      );
      this.sessionId = created.sessionId;
    }
    const target = ACP_MODEL[this.model];
    if (!target)
      throw new Error(`no ACP mapping for devin model ${this.model}`);
    await this.peer.request("session/set_mode", {
      sessionId: this.sessionId,
      modeId: "bypass",
    });
    const setOption = async (configId: string, value: string) =>
      z
        .object({ configOptions: configOptionsSchema })
        .passthrough()
        .parse(
          await this.peer.request("session/set_config_option", {
            sessionId: this.sessionId,
            configId,
            value,
          }),
        ).configOptions;
    await setOption("model", target.model);
    const options = await setOption("thought_level", target.thoughtLevel);
    // The hardcoded model must actually be in force: Devin's own default is a
    // paid frontier model, and a silent fallback would bill it.
    const current = (id: string) =>
      options.find((o) => o.id === id)?.currentValue;
    if (
      current("model") !== target.model ||
      current("thought_level") !== target.thoughtLevel
    ) {
      throw new Error(
        `devin reports ${String(current("model"))}/${String(current("thought_level"))} instead of ${target.model}/${target.thoughtLevel}`,
      );
    }
    if (current("mode") !== "bypass") {
      throw new Error(
        `devin reports mode ${String(current("mode"))} instead of bypass`,
      );
    }
    this.options.log.info("devin.session.ready", {
      sessionId: this.sessionId,
      model: this.model,
      resumed: Boolean(resumeSessionId),
    });
  }

  async prompt(
    text: string,
    callbacks: TurnCallbacks,
    signal: AbortSignal,
  ): Promise<TurnOutcome> {
    if (this.active)
      throw new Error("devin sidekick already has a running turn");
    const turn: ActiveTurn = { callbacks, text: "" };
    this.active = turn;
    const onAbort = () => {
      void this.cancel();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = promptResultSchema.parse(
        await this.peer.request("session/prompt", {
          sessionId: this.sessionId,
          prompt: [{ type: "text", text }],
        }),
      );
      return {
        report: turn.text.trim(),
        stopReason: result.stopReason,
        contextUsed: turn.contextUsed,
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
        cacheReadTokens: result.usage?.cachedReadTokens,
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (this.active === turn) this.active = undefined;
    }
  }

  async inject(text: string): Promise<boolean> {
    if (!this.active) return false;
    // Devin merges a mid-turn prompt into the running turn; this request
    // resolves when that merged turn ends, which the main prompt() also awaits.
    this.peer
      .request("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      })
      .catch((error: unknown) => {
        this.options.log.warn("devin.inject.failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  async cancel(): Promise<void> {
    if (!this.active) return;
    this.peer.notify("session/cancel", { sessionId: this.sessionId });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.peer.close(new Error("sidekick shut down"));
    this.child.stdin?.end();
    if (this.child.exitCode === null) {
      this.child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.child.kill("SIGKILL");
          resolve();
        }, 3000);
        this.child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.options.log.info("devin.acp.stopped", { sessionId: this.sessionId });
  }

  private onExit(code: number | null, error?: Error): void {
    if (this.disposed) return;
    const reason = error ?? new Error(`devin acp exited (${code})`);
    this.peer.close(reason);
    this.active = undefined;
    this.options.log.error("devin.transport.closed", { error: reason.message });
  }

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    if (method === "session/request_permission") {
      // Bypass mode should never ask; if it does, allow once (operator chose yolo)
      // and log it so a mode regression is visible.
      const parsed = z
        .object({
          options: z.array(
            z.object({ optionId: z.string(), kind: z.string() }).passthrough(),
          ),
          toolCall: z.unknown().optional(),
        })
        .passthrough()
        .parse(params);
      const allow =
        parsed.options.find((o) => o.kind === "allow_once") ??
        parsed.options.find((o) => o.kind.startsWith("allow"));
      this.options.log.warn("devin.permission.auto_allowed", {
        kinds: parsed.options.map((o) => o.kind),
      });
      if (!allow) return { outcome: { outcome: "cancelled" } };
      return { outcome: { outcome: "selected", optionId: allow.optionId } };
    }
    throw new RpcError(-32601, `fusion does not handle ${method}`);
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== "session/update") return;
    const parsed = sessionUpdateSchema.safeParse(params);
    if (!parsed.success || parsed.data.sessionId !== this.sessionId) return;
    const turn = this.active;
    if (!turn) return;
    const update = parsed.data.update as Record<string, unknown> & {
      sessionUpdate: string;
    };
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = update.content as { text?: unknown } | undefined;
        if (typeof content?.text === "string") turn.text += content.text;
        return;
      }
      case "tool_call": {
        const title = typeof update.title === "string" ? update.title : "tool";
        // A new tool call starts a new assistant step; keep only the final step's text.
        if (turn.text.trim())
          turn.callbacks.onActivity({ kind: "text", text: turn.text.trim() });
        turn.text = "";
        turn.callbacks.onActivity({ kind: "tool", text: title });
        return;
      }
      case "usage_update": {
        if (typeof update.used === "number") turn.contextUsed = update.used;
        return;
      }
      default:
        return;
    }
  }
}
