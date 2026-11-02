// Contract every sidekick connector implements. The extension (index.ts) owns
// the single sidekick and its handoff bookkeeping; a connector only knows how to
// talk to one harness.

/** Hardcoded harness + model choices (operator decision 2026-11-01: no config file). */
export type HarnessId = "piz" | "devin";

export interface ModelChoice {
  harness: HarnessId;
  /** Model id as the harness names it. */
  model: string;
  /** Picker label. */
  label: string;
}

export const MODEL_CHOICES: readonly ModelChoice[] = [
  { harness: "piz", model: "GLM-5.3", label: "GLM-5.3" },
  { harness: "piz", model: "GLM-5.3-Flash", label: "GLM-5.3-Flash" },
  // The ranked Devin Fusion pairing uses SWE-2 Medium; it is free on the Devin plan.
  { harness: "devin", model: "swe-2-medium", label: "SWE-2 Medium" },
];

export const HARNESS_LABELS: Record<HarnessId, string> = {
  piz: "piz (GLM coding plan)",
  devin: "Devin (SWE-2)",
};

/**
 * Sidekick context limit. SWE-2's window is 262K; GLM reports 1M but is capped
 * to the same value through the piz core's per-session compactContextWindow.
 */
export const SIDEKICK_CONTEXT_WINDOW = 262_000;

/** One line of sidekick activity, for progress display and the report's evidence trail. */
export interface SidekickActivity {
  kind: "tool" | "text" | "status";
  text: string;
}

export interface TurnOutcome {
  /** The sidekick's final message for this handoff. */
  report: string;
  stopReason: string;
  /** Context tokens in use after the turn, when the harness reports it. */
  contextUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  /** Delivery problems the lead must know about (e.g. a rejected mid-turn update). */
  warnings?: string[];
}

export interface TurnCallbacks {
  onActivity(activity: SidekickActivity): void;
}

export interface SidekickConnector {
  readonly harness: HarnessId;
  readonly model: string;
  /** Harness-side session id (persisted so a resumed pi session can reattach). */
  readonly sessionId: string;
  /** Run one handoff to completion. Rejects on transport/turn failure. */
  prompt(
    text: string,
    callbacks: TurnCallbacks,
    signal: AbortSignal,
  ): Promise<TurnOutcome>;
  /**
   * Deliver a message into the turn that is currently running (steering).
   * Returns false when the message was NOT delivered into a running turn:
   * no running turn, or the harness rejected / did not queue the steer
   * (e.g. the turn had just ended). The caller never queues it as the next
   * handoff: a non-blocking (`block: false`) call throws so the lead
   * retries the call, and a blocking call waits for the running handoff's
   * report and returns it flagged as undelivered, instructing the lead to
   * re-send the update as a new handoff.
   */
  inject(text: string): Promise<boolean>;
  /** Stop the running turn, keeping the session. */
  cancel(): Promise<void>;
  /** Tear down the process/socket. Idempotent. */
  dispose(): Promise<void>;
}

export interface ConnectOptions {
  cwd: string;
  model: string;
  /** Reattach to this harness session instead of creating a new one. */
  resumeSessionId?: string;
  log: Logger;
  /**
   * Called once when the harness process/transport dies on its own (not via
   * dispose). The owner should drop the connector so the next use reattaches.
   */
  onClosed?: (error: Error) => void;
}

export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}
