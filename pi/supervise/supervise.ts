/**
 * supervise — Event-driven subagent supervision for pi.
 *
 * Spawns an agent and returns turn-by-turn: you start it, it runs until
 * the agent stops (no more tool calls = waiting for input), you get the
 * full output (text + tool calls) for THAT TURN, you decide what to do next.
 * No polling. No screen-scraping.
 *
 * Usage:
 *   1. First call:  supervise({ task: "ingest this source...", cwd: "/project" })
 *      → returns { turn, text, toolCalls, status: "waiting" }
 *   2. Next call:   supervise({ session: "...", command: "go to Phase 2" })
 *      → returns { turn, text, toolCalls, status: "waiting" }
 *   3. Inspect:     supervise({ session: "...", inspect: true })
 *      → returns full message tree
 *   4. Done:        supervise({ session: "...", done: true })
 *      → disposes agent
 */

import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import { type Api, type Model, streamSimple } from "@mariozechner/pi-ai";
import {
  convertToLlm,
  type ExtensionAPI,
  type ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ── Reused from delegate ─────────────────────────────────────────────────

import {
  DEFAULT_TOOLS,
  VALID_THINKING,
  TOOL_FACTORIES,
  RETRYABLE_PATTERN,
  fmtDuration,
  fmtTokens,
  trunc,
  discoverAgents,
  loadSkill,
  resolveModel,
} from "../delegate/delegate.ts";

// ── Types ─────────────────────────────────────────────────────────────────

export interface SessionState {
  id: string;
  agent: Agent;
  cwd: string;
  model: Model<Api>;
  startedAt: number;
  turn: number;
  /** Number of messages at end of last turn — used to slice per-turn output. */
  messageCount: number;
  /** If true, the agent errored and the session is dead. */
  failed: boolean;
}

export interface ToolCallSummary {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  resultPreview: string;
  isError: boolean;
}

class AbortError extends Error {
  override name = "AbortError";
  constructor() { super("Aborted"); }
}

// ── Session Store ─────────────────────────────────────────────────────────

const MAX_SESSIONS = 10;
const sessions = new Map<string, SessionState>();
let nextId = 0;

function generateId(): string {
  return `supervise-${++nextId}-${Date.now()}`;
}

/** Evict oldest session if we're at the limit. */
function ensureCapacity(): void {
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest) {
      const state = sessions.get(oldest);
      if (state) { try { state.agent.abort(); } catch { /* */ } }
      sessions.delete(oldest);
    }
  }
}

// ── Agent Config Resolution ───────────────────────────────────────────────

interface ResolvedConfig {
  systemPrompt: string;
  model: Model<Api>;
  thinking: ThinkingLevel;
  tools: AgentTool[];
  warnings: string[];
}

function resolveConfig(
  params: {
    agent?: string;
    systemPrompt?: string;
    model?: string;
    thinking?: string;
    tools?: string[];
    skills?: string[];
  },
  cwd: string,
  parentModel: Model<Api> | undefined,
  registry: ModelRegistry,
): ResolvedConfig {
  const warnings: string[] = [];

  // Discover agent file if specified
  let agentSystemPrompt: string | undefined;
  let agentModel: string | undefined;
  let agentThinking: string | undefined;
  let agentTools: string[] | undefined;
  let agentSkills: string[] | undefined;

  if (params.agent) {
    const agents = discoverAgents(cwd);
    const cfg = agents.get(params.agent);
    if (!cfg) {
      const available = [...agents.keys()].join(", ") || "(none found)";
      throw new Error(`Agent "${params.agent}" not found. Available: ${available}`);
    }
    agentSystemPrompt = cfg.systemPrompt;
    agentModel = cfg.model;
    agentThinking = cfg.thinking as string;
    agentTools = cfg.tools;
    agentSkills = cfg.skills;
  }

  // Model: inline > agent file > parent
  const model = resolveModel(params.model ?? agentModel, registry, parentModel);
  if (!model) throw new Error("No model available.");

  // Thinking: inline > agent file > default
  const thinkingRaw = params.thinking ?? agentThinking ?? "off";
  const thinking: ThinkingLevel = VALID_THINKING.has(thinkingRaw)
    ? (thinkingRaw as ThinkingLevel)
    : "off";

  // Tools: inline > agent file > default
  const toolNames = params.tools ?? agentTools ?? DEFAULT_TOOLS;
  const unknownTools = toolNames.filter(name => !(name in TOOL_FACTORIES));
  if (unknownTools.length) {
    warnings.push(
      `Unknown tool(s) ignored: ${unknownTools.join(", ")}. Available: ${Object.keys(TOOL_FACTORIES).join(", ")}`,
    );
  }
  const tools = toolNames
    .filter(name => name in TOOL_FACTORIES)
    .map(name => TOOL_FACTORIES[name]!(cwd));

  // System prompt: inline > agent file
  let systemPrompt = params.systemPrompt ?? agentSystemPrompt ?? "";
  if (!systemPrompt.trim()) {
    throw new Error("systemPrompt or agent required.");
  }

  // Skills: merge agent file + inline (deduped)
  const skillNames = [...new Set([...(agentSkills ?? []), ...(params.skills ?? [])])];
  for (const name of skillNames) {
    const content = loadSkill(name, cwd);
    if (content) {
      systemPrompt += `\n\n<skill name="${name}">\n${content}\n</skill>`;
    } else {
      warnings.push(`Skill "${name}" not found.`);
    }
  }

  return { systemPrompt, model, thinking, tools, warnings };
}

// ── Turn waiting (event-driven, no polling) ───────────────────────────────

interface TurnEndResult {
  text: string;
  toolCalls: ToolCallSummary[];
  isFinished: boolean;
  error?: string;
  tokens: number;
}

function waitForTurnEnd(agent: Agent, prevMessageCount: number, signal?: AbortSignal): Promise<TurnEndResult> {
  return new Promise((resolve, reject) => {
    // Track tool calls by ID — events carry toolCallId on both start and end.
    const toolCalls = new Map<string, ToolCallSummary>();

    let unsub: (() => void) | undefined;

    const cleanup = () => {
      unsub?.();
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(new AbortError());
    };

    unsub = agent.subscribe((event: AgentEvent) => {
      switch (event.type) {
        case "tool_execution_start":
          toolCalls.set(event.toolCallId, {
            id: event.toolCallId,
            name: event.toolName,
            args: event.args ?? {},
            resultPreview: "...",
            isError: false,
          });
          break;
        case "tool_execution_end": {
          const tc = toolCalls.get(event.toolCallId);
          if (tc) {
            const resultStr = typeof event.result === "string"
              ? event.result
              : JSON.stringify(event.result);
            tc.resultPreview = trunc(resultStr, 200);
            tc.isError = event.isError;
          }
          break;
        }
        case "agent_end": {
          cleanup();
          const messages = event.messages;
          // Slice only messages since the previous turn boundary
          const newMessages = messages.slice(prevMessageCount);
          resolve({
            text: extractAssistantText(newMessages),
            toolCalls: [...toolCalls.values()],
            // At agent_end the agent has settled — no pending tool calls remain.
            isFinished: !agent.state.errorMessage,
            error: agent.state.errorMessage,
            tokens: extractUsage(newMessages).total,
          });
          break;
        }
      }
    });

    if (signal) {
      if (signal.aborted) { cleanup(); reject(new AbortError()); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// ── Retry helpers ─────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => { clearTimeout(timer); reject(new AbortError()); };
      signal.addEventListener("abort", onAbort, { once: true });
      // Close TOCTOU window: signal could have fired between our check and addEventListener.
      if (signal.aborted) {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(new AbortError());
      }
    }
  });
}

function createAgent(config: ResolvedConfig, registry: ModelRegistry): Agent {
  return new Agent({
    initialState: {
      systemPrompt: config.systemPrompt,
      model: config.model,
      thinkingLevel: config.thinking,
      tools: config.tools,
    },
    convertToLlm,
    streamFn: async (m, context, options) => {
      const auth = await registry.getApiKeyAndHeaders(m);
      if (!auth.ok) throw new Error(`Auth failed: ${auth.error}`);
      return streamSimple(m, context, { ...options, apiKey: auth.apiKey, headers: auth.headers ?? undefined });
    },
  });
}

// ── Output extraction ─────────────────────────────────────────────────────

/** Extract text from assistant messages. Works on slices (per-turn) or full transcript. */
function extractAssistantText(messages: AgentMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    if (!("content" in msg) || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if ("text" in block && typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join("\n\n");
}

function extractUsage(messages: AgentMessage[]) {
  const usage = { input: 0, output: 0, cacheRead: 0, total: 0 };
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    // usage is attached by the agent loop at runtime, not declared in the pi-ai types
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const u = (msg as any).usage;
    if (!u) continue;
    usage.input += u.input ?? 0;
    usage.output += u.output ?? 0;
    usage.cacheRead += u.cacheRead ?? 0;
    usage.total += u.total ?? (u.input ?? 0) + (u.output ?? 0);
  }
  return usage;
}

// ── Message formatting for inspect ────────────────────────────────────────

function formatMessagesForInspect(messages: AgentMessage[]) {
  return messages.map(msg => {
    const entry: {
      role: string;
      content: string;
      toolCalls?: ToolCallSummary[];
      usage?: { input: number; output: number; total: number };
    } = {
      role: msg.role ?? "unknown",
      content: "",
    };

    // Narrow by content shape — not all AgentMessage variants have .content
    if (!("content" in msg)) {
      // BranchSummaryMessage, BashExecutionMessage, etc — skip content extraction
    } else if (typeof msg.content === "string") {
      entry.content = msg.content;
    } else if (Array.isArray(msg.content)) {
      entry.content = extractAssistantText([msg]);
      const toolUses = msg.content.filter(
        (b): b is Extract<typeof b, { type: "toolCall" }> => "type" in b && b.type === "toolCall",
      );
      if (toolUses.length) {
        entry.toolCalls = toolUses.map(tc => ({
          id: tc.id,
          name: tc.name,
          args: tc.arguments,
          resultPreview: "",
          isError: false,
        }));
      }
    }

    // usage is attached by the agent loop at runtime
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const u = (msg as any).usage;
    if (u) {
      entry.usage = { input: u.input ?? 0, output: u.output ?? 0, total: u.total ?? 0 };
    }

    return entry;
  });
}

// ── Result formatting ─────────────────────────────────────────────────────

const MAX_TURN_TEXT_LENGTH = 8000;

function formatTurnText(
  sessionId: string,
  turn: number,
  result: TurnEndResult,
  durationMs: number,
  warnings?: string[],
): string {
  const status = result.error ? "error" : result.isFinished ? "finished" : "waiting";
  const lines: string[] = [
    `## Session: ${sessionId} — Turn ${turn}`,
    `Status: ${status} | Duration: ${fmtDuration(durationMs)} | Tokens: ${fmtTokens(result.tokens)}`,
  ];

  if (result.toolCalls.length) {
    lines.push(`Tools: ${result.toolCalls.map(tc => `${tc.name}${tc.isError ? " ✗" : " ✓"}`).join(", ")}`);
  }

  // Truncate text to avoid blowing up parent agent's context
  const text = result.text.length > MAX_TURN_TEXT_LENGTH
    ? result.text.slice(0, MAX_TURN_TEXT_LENGTH) + `\n\n... (truncated ${result.text.length - MAX_TURN_TEXT_LENGTH} chars)`
    : result.text;

  lines.push("", text || "(no text output)");

  if (result.toolCalls.length) {
    lines.push("", "### Tool Calls",
      ...result.toolCalls.map(tc => `- \`${tc.name}\` — ${tc.resultPreview}`),
    );
  }

  if (result.error) {
    lines.push("", "### Error", result.error);
  }

  if (warnings?.length) {
    lines.push("", "### Warnings", ...warnings.map(w => `- ${w}`));
  }

  return lines.join("\n");
}

// ── Extension ─────────────────────────────────────────────────────────────

export default function superviseExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "supervise",
    label: "Supervise",
    promptSnippet: "Spawn and supervise a subagent session turn-by-turn. No polling — the tool returns when the agent hits turn_end.",
    promptGuidelines: [
      "Use supervise to spawn an agent and interact with it turn by turn. First call provides `task`. Subsequent calls provide `session` and `command` to steer the agent. Use `inspect: true` to see the full message tree.",
      "The tool returns after each agent_end event — no manual polling needed. You get the full text output plus structured tool call summaries.",
      "Call with `done: true` to dispose the session when finished.",
    ],
    description:
      "Spawn and supervise a subagent turn-by-turn. Returns at each agent_end with full output and tool calls. Steer with `command`, inspect with `inspect: true`, dispose with `done: true`.",
    parameters: Type.Object({
      // ── Start mode ───────────────────────────────────────────────
      task: Type.Optional(Type.String({ description: "Initial prompt. Required on first call. Omit when using command/inspect." })),
      cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to parent session cwd." })),
      agent: Type.Optional(Type.String({ description: "Named agent from .pi/agents/*.md or ~/.pi/agent/agents/*.md." })),
      model: Type.Optional(Type.String({ description: "Model (e.g. 'deepseek/deepseek-v4-flash'). Falls back to agent file, then parent model." })),
      skills: Type.Optional(Type.Array(Type.String(), { description: "Skill names to inject into the system prompt." })),
      tools: Type.Optional(Type.Array(Type.String(), { description: "Tools: read, write, edit, bash, grep, find, ls. Default: all 7." })),
      thinking: Type.Optional(Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh." })),
      systemPrompt: Type.Optional(Type.String({ description: "System prompt. Overrides agent file if both given." })),

      // ── Continue mode ────────────────────────────────────────────
      session: Type.Optional(Type.String({ description: "Session ID from a previous supervise call. Required for command/inspect/done." })),
      command: Type.Optional(Type.String({ description: "Steer command to send to the supervised agent." })),
      commandType: Type.Optional(Type.String({ enum: ["steer", "followUp"], description: "How to send the command. 'steer' (default) interrupts the current turn. 'followUp' queues it." })),

      // ── Inspect mode ─────────────────────────────────────────────
      inspect: Type.Optional(Type.Boolean({ description: "Return the full message tree instead of running a turn." })),

      // ── Done mode ────────────────────────────────────────────────
      done: Type.Optional(Type.Boolean({ description: "Dispose the supervised session." })),
    }),

    async execute(_id, params, signal, onUpdate, ctx) {
      const sessionId = params.session;
      const state = sessionId ? sessions.get(sessionId) : undefined;

      // ── Done mode ────────────────────────────────────────────
      if (params.done) {
        if (!sessionId) {
          return {
            content: [{ type: "text" as const, text: "`done` requires a `session` ID." }],
            details: { error: "Missing session" },
          };
        }
        if (state) {
          try { state.agent.abort(); } catch { /* already stopped */ }
          sessions.delete(sessionId);
        }
        return {
          content: [{ type: "text" as const, text: state ? `Session ${sessionId} disposed.` : `Session ${sessionId} not found.` }],
          details: { sessionId, disposed: !!state },
        };
      }

      // ── Inspect mode ──────────────────────────────────────────
      if (params.inspect) {
        if (!state) {
          return {
            content: [{ type: "text" as const, text: sessionId
              ? `Session ${sessionId} not found. It may have been disposed or expired.`
              : "`inspect` requires a `session` ID.",
            }],
            details: { error: "Session not found" },
          };
        }
        const messages = state.agent.state.messages;
        return {
          content: [{ type: "text" as const, text: [
            `## Session: ${state.id}`,
            `Turn: ${state.turn}`,
            `Model: ${state.model.id}`,
            `Started: ${new Date(state.startedAt).toISOString()}`,
            `Messages: ${messages.length}`,
            state.failed ? "Status: **failed** (session is dead)" : "",
            "",
            "```json",
            JSON.stringify(formatMessagesForInspect(messages), null, 2),
            "```",
          ].join("\n") }],
          details: { sessionId: state.id, messages: formatMessagesForInspect(messages), turn: state.turn },
        };
      }

      // ── Start mode ────────────────────────────────────────────
      if (!state) {
        if (!params.task) {
          return {
            content: [{ type: "text" as const, text: "First call requires `task`. Use `supervise({ task: \"...\", cwd: \"/project\" })` to start a new session." }],
            details: { error: "Missing task" },
          };
        }

        const id = generateId();
        const cwd = params.cwd ?? ctx.cwd;

        let config: ResolvedConfig;
        let configWarnings: string[] = [];
        try {
          config = resolveConfig(params, cwd, ctx.model, ctx.modelRegistry);
          configWarnings = config.warnings;
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Configuration error: ${err instanceof Error ? err.message : String(err)}` }],
            details: { error: "Configuration failed", sessionId: id, warnings: configWarnings },
          };
        }

        const warnings = configWarnings;
        const startTime = Date.now();

        onUpdate?.({
          content: [{ type: "text" as const, text: `Session ${id} started. Running turn 1...` }],
          details: { sessionId: id, status: "running", turn: 1 },
        });

        // Retry loop — create fresh agent per attempt
        let lastResult: TurnEndResult | undefined;
        let lastAgent: Agent | undefined;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          if (signal?.aborted) {
            return {
              content: [{ type: "text" as const, text: `Session ${id} aborted before attempt ${attempt + 1}.` }],
              details: { sessionId: id, status: "aborted" },
            };
          }

          const agent = createAgent(config, ctx.modelRegistry);

          // Register abort handler
          let abortHandler: (() => void) | undefined;
          if (signal) {
            abortHandler = () => { try { agent.abort(); } catch { /* */ } };
            signal.addEventListener("abort", abortHandler, { once: true });
          }

          try {
            agent.prompt(params.task!).catch(() => { /* errors surface via waitForTurnEnd */ });
            const result = await waitForTurnEnd(agent, 0, signal);
            lastResult = result;
            lastAgent = agent;

            if (!result.error) {
              // Success — store session
              ensureCapacity();
              sessions.set(id, {
                id, agent, cwd, model: config.model,
                startedAt: Date.now(), turn: 1,
                messageCount: agent.state.messages.length,
                failed: false,
              });

              return {
                content: [{ type: "text" as const, text: formatTurnText(id, 1, result, Date.now() - startTime, warnings.length ? warnings : undefined) }],
                details: {
                  sessionId: id, turn: 1, text: result.text, toolCalls: result.toolCalls,
                  status: "waiting",
                  durationMs: Date.now() - startTime, tokens: result.tokens, warnings,
                },
              };
            }

            // Error — retry if transient
            if (attempt < MAX_RETRIES - 1 && RETRYABLE_PATTERN.test(result.error)) {
              const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * RETRY_BASE_DELAY_MS;
              try { await sleepWithAbort(delay, signal); } catch { /* abort during sleep */ }
              continue;
            }

            // Non-retryable or exhausted retries — do NOT store session
            return {
              content: [{ type: "text" as const, text: formatTurnText(id, 1, result, Date.now() - startTime, warnings.length ? warnings : undefined) }],
              details: {
                sessionId: id, turn: 1, text: result.text, toolCalls: result.toolCalls,
                status: "error", error: result.error,
                durationMs: Date.now() - startTime, tokens: result.tokens, warnings,
              },
            };
          } catch (err) {
            if (err instanceof AbortError) {
              return {
                content: [{ type: "text" as const, text: `Session ${id} aborted.` }],
                details: { sessionId: id, status: "aborted" },
              };
            }
            throw err;
          } finally {
            if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
          }
        }

        // All retries exhausted with retryable errors — do NOT store session
        return {
          content: [{ type: "text" as const, text: formatTurnText(id, 1, lastResult!, Date.now() - startTime, warnings) }],
          details: {
            sessionId: id, turn: 1, text: lastResult!.text, toolCalls: lastResult!.toolCalls,
            status: "error", error: lastResult!.error,
            durationMs: Date.now() - startTime, tokens: lastResult!.tokens, warnings,
          },
        };
      }

      // ── Continue mode ──────────────────────────────────────────

      // Guard: dead session can't be continued
      if (state.failed) {
        return {
          content: [{ type: "text" as const, text: `Session ${state.id} has failed and cannot accept commands. Use \`done: true\` to dispose it.` }],
          details: { sessionId: state.id, turn: state.turn, status: "error" },
        };
      }

      if (!params.command) {
        return {
          content: [{ type: "text" as const, text: `Session ${state.id} is at turn ${state.turn}. Provide \`command\` to continue, \`inspect: true\` to view messages, or \`done: true\` to dispose.` }],
          details: { sessionId: state.id, turn: state.turn, status: "waiting" },
        };
      }

      const nextTurn = state.turn + 1;
      onUpdate?.({
        content: [{ type: "text" as const, text: `Session ${state.id}: sending command for turn ${nextTurn}...` }],
        details: { sessionId: state.id, status: "running", turn: nextTurn },
      });

      const commandType = params.commandType ?? "steer";
      const userMessage = { role: "user" as const, content: params.command, timestamp: Date.now() };

      if (commandType === "followUp") {
        state.agent.followUp(userMessage);
      } else {
        state.agent.steer(userMessage);
      }

      const startTime = Date.now();
      const prevMessageCount = state.messageCount;
      try {
        const result = await waitForTurnEnd(state.agent, prevMessageCount, signal);
        state.turn = nextTurn;
        state.messageCount = state.agent.state.messages.length;

        if (result.error) {
          state.failed = true;
        }

        return {
          content: [{ type: "text" as const, text: formatTurnText(state.id, nextTurn, result, Date.now() - startTime) }],
          details: {
            sessionId: state.id, turn: nextTurn, text: result.text, toolCalls: result.toolCalls,
            status: result.isFinished ? "finished" : result.error ? "error" : "waiting",
            error: result.error,
            durationMs: Date.now() - startTime, tokens: result.tokens,
          },
        };
      } catch (err) {
        if (err instanceof AbortError) {
          return {
            content: [{ type: "text" as const, text: `Session ${state.id} aborted during turn ${nextTurn}.` }],
            details: { sessionId: state.id, turn: nextTurn, status: "aborted" },
          };
        }
        // Unexpected error — mark session as dead
        state.failed = true;
        throw err;
      }
    },

    renderCall(args, theme, ctx) {
      const renderState = ctx.state as { turnStartedAt?: number };
      if (ctx.executionStarted) renderState.turnStartedAt = Date.now();
      const text = (ctx.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const p = args as Record<string, unknown>;

      if (p.inspect) {
        text.setText(theme.fg("toolTitle", theme.bold(`supervise inspect ${p.session ?? ""}`)));
      } else if (p.done) {
        text.setText(theme.fg("toolTitle", theme.bold(`supervise done ${p.session ?? ""}`)));
      } else if (p.command) {
        text.setText(theme.fg("toolTitle", theme.bold(`supervise ${p.session ?? ""}`)) + " " + theme.fg("muted", trunc(String(p.command), 60)));
      } else {
        text.setText(theme.fg("toolTitle", theme.bold("supervise")) + " " + theme.fg("muted", trunc(String(p.task ?? ""), 60)));
      }
      return text;
    },

    renderResult(result, options, theme, ctx) {
      const renderState = ctx.state as { turnStartedAt?: number };
      const text = (ctx.lastComponent as Text | undefined) ?? new Text("", 0, 0);

      const details = result.details as Record<string, unknown> | undefined;
      const content = (result.content as Array<{ type: string; text: string }>)
        ?.filter(c => c.type === "text")
        .map(c => c.text)
        .join("\n") ?? "";

      if (!details?.sessionId) {
        text.setText(content ? `\n${content}` : "");
        return text;
      }

      if (options.isPartial) {
        const elapsed = renderState.turnStartedAt ? ` · ${fmtDuration(Date.now() - renderState.turnStartedAt)}` : "";
        text.setText(`${theme.bold(`supervise ${details.sessionId}`)} turn ${details.turn}${elapsed}\n${theme.fg("muted", "running...")}`);
      } else {
        const statusIcon = details.status === "error" ? theme.fg("error", "✗") :
          details.status === "finished" ? theme.fg("success", "✓") :
          details.status === "aborted" ? theme.fg("warning", "⏏") :
          theme.fg("warning", "⏸");
        const elapsed = fmtDuration(Number(details.durationMs ?? 0));
        const tokens = fmtTokens(Number(details.tokens ?? 0));
        const line = `${statusIcon} ${theme.bold(`supervise ${details.sessionId}`)} turn ${details.turn} · ${elapsed} · ${tokens} tokens`;

        const toolCalls = details.toolCalls as ToolCallSummary[] | undefined;
        const toolLine = toolCalls?.length
          ? `\n${theme.fg("muted", toolCalls.map(tc => `${tc.name}${tc.isError ? " ✗" : " ✓"}`).join(", "))}`
          : "";

        if (options.expanded) {
          const textContent = (details.text as string) || content;
          text.setText(`${line}${toolLine}\n\n${textContent}`);
        } else {
          text.setText(`${line}${toolLine}`);
        }
      }
      return text;
    },
  });
}
