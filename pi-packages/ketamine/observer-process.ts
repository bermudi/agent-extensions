import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

export interface ObserverModel {
  provider: string;
  id: string;
}

export interface ObserverRunOptions {
  cwd: string;
  runDir: string;
  snapshotPath: string;
  observerSessionDir: string;
  model: ObserverModel;
  thinkingLevel?: ThinkingLevel;
  signal: AbortSignal;
}

export interface ObserverRunResult {
  plan: unknown;
  stderrPath: string;
  usage?: Usage;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addUsage(total: Usage | undefined, value: unknown): Usage | undefined {
  if (!value || typeof value !== "object") return total;
  const usage = value as Record<string, unknown>;
  const costValue = usage.cost;
  if (!costValue || typeof costValue !== "object") return total;
  const cost = costValue as Record<string, unknown>;
  const base: Usage = total ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const reasoning = usage.reasoning;
  const cacheWrite1h = usage.cacheWrite1h;
  return {
    input: base.input + numberField(usage, "input"),
    output: base.output + numberField(usage, "output"),
    cacheRead: base.cacheRead + numberField(usage, "cacheRead"),
    cacheWrite: base.cacheWrite + numberField(usage, "cacheWrite"),
    totalTokens: base.totalTokens + numberField(usage, "totalTokens"),
    ...(base.reasoning !== undefined || typeof reasoning === "number"
      ? {
          reasoning:
            (base.reasoning ?? 0) +
            (typeof reasoning === "number" ? reasoning : 0),
        }
      : {}),
    ...(base.cacheWrite1h !== undefined || typeof cacheWrite1h === "number"
      ? {
          cacheWrite1h:
            (base.cacheWrite1h ?? 0) +
            (typeof cacheWrite1h === "number" ? cacheWrite1h : 0),
        }
      : {}),
    cost: {
      input: base.cost.input + numberField(cost, "input"),
      output: base.cost.output + numberField(cost, "output"),
      cacheRead: base.cost.cacheRead + numberField(cost, "cacheRead"),
      cacheWrite: base.cost.cacheWrite + numberField(cost, "cacheWrite"),
      total: base.cost.total + numberField(cost, "total"),
    },
  };
}

export class ObserverEventCollector {
  plan: unknown;
  successfulSubmissions = 0;
  usage: Usage | undefined;

  consume(event: unknown): void {
    if (!event || typeof event !== "object") return;
    const record = event as Record<string, unknown>;
    if (
      record.type === "message_end" &&
      record.message &&
      typeof record.message === "object"
    ) {
      const message = record.message as Record<string, unknown>;
      if (message.role === "assistant") {
        this.usage = addUsage(this.usage, message.usage);
      }
    }
    if (
      record.type === "tool_execution_end" &&
      record.toolName === "ketamine_submit" &&
      record.isError === false &&
      record.result &&
      typeof record.result === "object"
    ) {
      const result = record.result as Record<string, unknown>;
      this.successfulSubmissions += 1;
      this.plan = result.details;
    }
  }
}

const OBSERVER_PROMPT = `You are Ketamine: a dissociated context curator for another coding-agent session.

Use ketamine_trajectory to inspect EVERY compact trajectory page. Start with progressive disclosure: the page already shows user intent, assistant responses, exposed reasoning, tool calls, errors, and output sizes.

Do NOT read successful tool-output bodies by default. Use ketamine_unit when full reasoning or assistant text is needed. Use ketamine_tool_result only when an error, the assistant's reasoning, or a later conclusion indicates that one exact result contains decisive evidence.

Then decide what the working model actually needs next:
- keep: preserve important turns verbatim
- summarize: replace one or more consecutive turns with a precise summary
- drop: remove repetition, obsolete exploration, noise, and superseded failures

Treat exposed assistant reasoning as a salience signal, not infallible truth. Preserve user intent, constraints, current repository state, unresolved work, important evidence, exact paths/symbols/errors, and decisions with rationale. Do not preserve material merely because it is recent. Do not discard unresolved requirements merely because they are old.

Finish by calling ketamine_submit exactly once. Cover every unit exactly once, in chronological order. Group only consecutive units. The submitted context must be substantially smaller than the source while remaining sufficient to continue the work.`;

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const configuredCommand = process.env.KETAMINE_PI_COMMAND?.trim();
  if (configuredCommand) return { command: configuredCommand, args };

  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const executable = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

export async function runObserver(
  options: ObserverRunOptions,
): Promise<ObserverRunResult> {
  const observerPath = fileURLToPath(new URL("./observer.ts", import.meta.url));
  const args = [
    "--mode",
    "json",
    "--print",
    "--session-dir",
    options.observerSessionDir,
    "--name",
    `Ketamine observer ${basename(options.runDir)}`,
    "--model",
    `${options.model.provider}/${options.model.id}`,
    "--no-approve",
    "--no-extensions",
    "--extension",
    observerPath,
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-themes",
    "--no-builtin-tools",
    "--tools",
    "ketamine_trajectory,ketamine_unit,ketamine_tool_result,ketamine_submit",
    "--system-prompt",
    OBSERVER_PROMPT,
    "Inspect the frozen trajectory and submit its replacement context.",
  ];
  if (options.thinkingLevel) {
    args.splice(args.length - 1, 0, "--thinking", options.thinkingLevel);
  }
  const invocation = getPiInvocation(args);
  const stderrPath = `${options.runDir}/observer.stderr.log`;

  return await new Promise<ObserverRunResult>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        KETAMINE_OBSERVER: "1",
        KETAMINE_SNAPSHOT_PATH: options.snapshotPath,
      },
    });

    let stdoutBuffer = "";
    let stderr = "";
    const events = new ObserverEventCollector();
    let aborted = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const processLine = (line: string): void => {
      if (!line.trim()) return;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      events.consume(event);
    };

    const abortChild = (): void => {
      aborted = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    };

    if (options.signal.aborted) abortChild();
    else options.signal.addEventListener("abort", abortChild, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      while (true) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        processLine(line);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.once("error", (error) => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal.removeEventListener("abort", abortChild);
      reject(
        new Error(`Could not launch the Ketamine observer: ${error.message}`),
      );
    });

    child.once("close", (code) => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal.removeEventListener("abort", abortChild);
      if (stdoutBuffer.trim()) processLine(stdoutBuffer);

      void writeFile(stderrPath, stderr, { mode: 0o600 }).then(
        () => {
          if (aborted) {
            reject(new Error("Ketamine observer was cancelled"));
          } else if (code !== 0) {
            reject(
              new Error(
                `Ketamine observer exited with code ${code}; diagnostics: ${stderrPath}`,
              ),
            );
          } else if (
            events.successfulSubmissions !== 1 ||
            events.plan === undefined
          ) {
            reject(
              new Error(
                `Ketamine observer produced ${events.successfulSubmissions} successful submissions; expected exactly one; diagnostics: ${stderrPath}`,
              ),
            );
          } else {
            resolve({ plan: events.plan, stderrPath, usage: events.usage });
          }
        },
        (error: unknown) => {
          reject(
            new Error(
              `Ketamine observer finished, but diagnostics could not be saved: ${String(error)}`,
            ),
          );
        },
      );
    });
  });
}
