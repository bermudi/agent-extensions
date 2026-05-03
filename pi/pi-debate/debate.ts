/**
 * debate — Two models argue against each other to explore a topic.
 *
 * Spawns two subagents with different models (or the same model with opposing
 * prompts), runs sequential turn-based debate rounds, and optionally passes the
 * full transcript to a judge for a final verdict.
 *
 * Separate from delegate because the debate workflow is sequential with shared
 * history, not parallel fire-and-forget.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import { type Api, type Model, streamSimple } from "@mariozechner/pi-ai";
import {
  buildSessionContext,
  convertToLlm,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type ExtensionAPI,
  type ExtensionContext,
  getMarkdownTheme,
  keyHint,
  type ModelRegistry,
  type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ── Types ────────────────────────────────────────────────────────────────

export interface DebateArgs {
  topic: string;
  rounds?: number;
  modelA?: string;
  modelB?: string;
  positionA?: string;
  positionB?: string;
  systemPromptA?: string;
  systemPromptB?: string;
  judge?: { model?: string; prompt?: string };
  cwd?: string;
  tools?: string[];
  thinking?: string;
}

export interface DebateProgress {
  phase: "setup" | "round" | "judge" | "done";
  round: number;
  totalRounds: number;
  speaker: "A" | "B" | "judge";
  tokens: number;
  durationMs: number;
}

export interface DebateDetails {
  topic: string;
  rounds: number;
  transcript: DebateEntry[];
  judgeVerdict?: string;
  progress: DebateProgress[];
}

export interface DebateEntry {
  round: number;
  speaker: "A" | "B";
  model: string;
  output: string;
  durationMs: number;
  tokens: number;
  error?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TOOL_FACTORIES: Record<string, (cwd: string) => AgentTool<any>> = {
  read: createReadTool,
  bash: createBashTool,
  edit: createEditTool,
  write: createWriteTool,
  grep: createGrepTool,
  find: createFindTool,
  ls: createLsTool,
};

const VALID_THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

const DEFAULT_ROUNDS = 3;
const MAX_ROUNDS = 10;

// ── Helpers ──────────────────────────────────────────────────────────────

export function resolveModel(
  spec: string | undefined,
  registry: ModelRegistry,
  parentModel: Model<Api> | undefined,
): Model<Api> | undefined {
  if (!spec) return parentModel;
  const idx = spec.indexOf("/");
  if (idx === -1) {
    const match = registry.getAvailable().find((m) => m.id === spec);
    return match ?? undefined;
  }
  return registry.find(spec.slice(0, idx), spec.slice(idx + 1)) ?? undefined;
}

export function extractOutput(messages: AgentMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "text" && block.text) parts.push(block.text);
    }
  }
  return parts.join("\n\n");
}

function extractTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.usage) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const u = msg.usage as any;
    total += u.total ?? (u.input ?? 0) + (u.output ?? 0);
  }
  return total;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const mins = Math.floor(s / 60);
  const secs = Math.floor(s % 60);
  return `${mins}m${secs}s`;
}

export function fmtTokens(n: number): string {
  return n < 1000 ? `${n}` : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

export function trunc(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// ── Prompt Building ──────────────────────────────────────────────────────

function buildDebateSystemPrompt(args: {
  role: "A" | "B";
  topic: string;
  position: string;
  opponentPosition: string;
  customPrompt?: string;
  round: number;
  totalRounds: number;
}): string {
  if (args.customPrompt) return args.customPrompt;

  const roundLabels: Record<number, string> = {
    1: "Opening statement — set the foundation for your case",
    2: "Rebuttal — directly engage with your opponent's points",
  };

  const roundHint = roundLabels[args.round] ?? `Rebuttal — sharpen your arguments and address weaknesses`;

  return [
    "You are participating in a structured debate.",
    "",
    `Topic: ${args.topic}`,
    `Your position: ${args.position}`,
    `Your opponent's position: ${args.opponentPosition}`,
    "",
    "Guidelines:",
    `- This is round ${args.round} of ${args.totalRounds}. ${roundHint}.`,
    "- Be concise but persuasive. Aim for 2-4 paragraphs.",
    "- Directly quote or reference your opponent's specific claims when rebutting.",
    "- Prioritize the strongest points over kitchen-sink arguments.",
    "- You may use tools to gather evidence, but cite what you find.",
    "",
    "The debate transcript so far is below. Respond with your next argument.",
    "Do NOT speak for your opponent — only present your own case.",
  ].join("\n");
}

function buildJudgeSystemPrompt(args: {
  topic: string;
  transcript: string;
  customPrompt?: string;
}): string {
  if (args.customPrompt) return args.customPrompt;

  return [
    "You are judging a structured debate between two AI models.",
    "",
    `Topic: ${args.topic}`,
    "",
    "Evaluate both participants and declare a winner. Consider:",
    "- Logical reasoning, evidence, and factual accuracy",
    "- Direct engagement with the opponent's arguments",
    "- Persuasiveness, clarity, and rhetorical quality",
    "- Consistency across rounds (did they shift goalposts?)",
    "",
    "Provide your verdict in this format:",
    "**Winner: [A or B or Draw]**",
    "**Analysis:** (2-3 sentences on why)",
    "**Key moments:** (bullet points of decisive exchanges)",
    "",
    "## Debate Transcript",
    args.transcript,
  ].join("\n");
}

function buildTurnPrompt(args: {
  speakerName: string;
  round: number;
  totalRounds: number;
  transcript: string;
}): string {
  const lines = [
    `# Debate — Round ${args.round} of ${args.totalRounds}`,
    `Your turn, ${args.speakerName}.`,
    "",
  ];
  if (args.transcript) {
    lines.push("## Transcript so far", args.transcript, "", "## Your response");
  } else {
    lines.push("Make your opening statement.");
  }
  return lines.join("\n");
}

// ── Agent Runner ─────────────────────────────────────────────────────────

async function runDebateTurn(args: {
  systemPrompt: string;
  model: Model<Api>;
  thinking: ThinkingLevel;
  tools: string[];
  cwd: string;
  prompt: string;
  modelRegistry: ModelRegistry;
  signal?: AbortSignal;
}): Promise<{ output: string; error?: string; durationMs: number; tokens: number }> {
  const start = Date.now();

  const tools = args.tools
    .map((name) => TOOL_FACTORIES[name]?.(args.cwd))
    .filter(Boolean) as AgentTool[];

  const agent = new Agent({
    initialState: {
      systemPrompt: args.systemPrompt,
      model: args.model,
      thinkingLevel: args.thinking,
      tools,
    },
    convertToLlm,
    streamFn: async (m, context, options) => {
      const auth = await args.modelRegistry.getApiKeyAndHeaders(m);
      if (!auth.ok) throw new Error(`Auth failed: ${auth.error}`);
      return streamSimple(m, context, { ...options, apiKey: auth.apiKey, headers: auth.headers ?? undefined });
    },
  });

  if (args.signal) {
    const onAbort = () => { try { agent.abort(); } catch { /* */ } };
    args.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    await agent.prompt(args.prompt);
    await agent.waitForIdle();

    const state = agent.state;
    const output = extractOutput(state.messages);
    const tokens = extractTokens(state.messages);

    return {
      output: output || "(no output)",
      error: (state as { errorMessage?: string }).errorMessage,
      durationMs: Date.now() - start,
      tokens,
    };
  } catch (err) {
    return {
      output: "",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
      tokens: 0,
    };
  }
}

// ── Extension ─────────────────────────────────────────────────────────────

// ── Core Debate Runner ───────────────────────────────────────────────────

type DebateState = { transcript: DebateEntry[]; progress: DebateProgress[] };

async function runDebate(
  params: DebateArgs,
  ctx: { modelRegistry: ModelRegistry; model?: Model<Api>; cwd: string; signal?: AbortSignal },
  onProgress?: (state: DebateState) => void,
) {
  const startedAt = Date.now();
  const rounds = Math.min(params.rounds ?? DEFAULT_ROUNDS, MAX_ROUNDS);
  const cwd = params.cwd ?? ctx.cwd;

  // ── Resolve models ───────────────────────────────────────────────
  const modelA = resolveModel(params.modelA, ctx.modelRegistry, ctx.model);
  if (!modelA) {
    return {
      content: [{ type: "text" as const, text: "❌ Could not resolve model for participant A. Provide modelA or ensure the parent session has a model set." }],
      details: { topic: params.topic, rounds, transcript: [] as DebateEntry[], progress: [] as DebateProgress[] },
    };
  }
  const modelB = resolveModel(params.modelB, ctx.modelRegistry, modelA) ?? modelA;
  const judgeModel = params.judge?.model
    ? (resolveModel(params.judge.model, ctx.modelRegistry, ctx.model) ?? modelA)
    : modelA;

  // ── Resolve tools & thinking ─────────────────────────────────────
  const tools = params.tools ?? DEFAULT_TOOLS;
  const unknownTools = tools.filter((name) => !(name in TOOL_FACTORIES));
  const thinkingRaw = params.thinking ?? "off";
  const thinking: ThinkingLevel = VALID_THINKING.has(thinkingRaw) ? (thinkingRaw as ThinkingLevel) : "off";

  // ── Build positions ──────────────────────────────────────────────
  const positionA = params.positionA ?? "pro (in favor of the proposition)";
  const positionB = params.positionB ?? "con (opposed to the proposition)";

  // ── Progress tracking ────────────────────────────────────────────
  const transcript: DebateEntry[] = [];
  const progress: DebateProgress[] = [];

  const fire = (p?: DebateProgress) => {
    if (p) progress.push(p);
    onProgress?.({ transcript: [...transcript], progress: [...progress] });
  };

  if (unknownTools.length) {
    fire({ phase: "setup", round: 0, totalRounds: rounds, speaker: "A", tokens: 0, durationMs: 0 });
  }

  // ── Debate rounds ────────────────────────────────────────────────
  for (let round = 1; round <= rounds; round++) {
    let transcriptText = "";
    for (const entry of transcript) {
      transcriptText += `\n### Round ${entry.round} — ${entry.speaker === "A" ? "Participant A" : "Participant B"}\n\n${entry.output}\n`;
    }

    // ── Turn A ────────────────────────────────────────────────────
    const systemPromptA = buildDebateSystemPrompt({
      role: "A", topic: params.topic, position: positionA, opponentPosition: positionB,
      customPrompt: params.systemPromptA, round, totalRounds: rounds,
    });

    fire({ phase: "round", round, totalRounds: rounds, speaker: "A", tokens: 0, durationMs: 0 });

    const resultA = await runDebateTurn({
      systemPrompt: systemPromptA, model: modelA, thinking, tools, cwd,
      prompt: buildTurnPrompt({ speakerName: "Participant A", round, totalRounds: rounds, transcript: transcriptText }),
      modelRegistry: ctx.modelRegistry, signal: ctx.signal,
    });

    const entryA: DebateEntry = {
      round, speaker: "A", model: `${modelA.provider}/${modelA.id}`,
      output: resultA.output, durationMs: resultA.durationMs, tokens: resultA.tokens, error: resultA.error,
    };
    transcript.push(entryA);

    const lastA = progress[progress.length - 1]!;
    lastA.durationMs = resultA.durationMs;
    lastA.tokens = resultA.tokens;
    fire();

    if (resultA.error) entryA.output = `[ERROR: ${resultA.error}]`;
    if (ctx.signal?.aborted) break;

    // ── Turn B ────────────────────────────────────────────────────
    transcriptText += `\n### Round ${round} — Participant A\n\n${entryA.output}\n`;

    const systemPromptB = buildDebateSystemPrompt({
      role: "B", topic: params.topic, position: positionB, opponentPosition: positionA,
      customPrompt: params.systemPromptB, round, totalRounds: rounds,
    });

    fire({ phase: "round", round, totalRounds: rounds, speaker: "B", tokens: 0, durationMs: 0 });

    const resultB = await runDebateTurn({
      systemPrompt: systemPromptB, model: modelB, thinking, tools, cwd,
      prompt: buildTurnPrompt({ speakerName: "Participant B", round, totalRounds: rounds, transcript: transcriptText }),
      modelRegistry: ctx.modelRegistry, signal: ctx.signal,
    });

    const entryB: DebateEntry = {
      round, speaker: "B", model: `${modelB.provider}/${modelB.id}`,
      output: resultB.output, durationMs: resultB.durationMs, tokens: resultB.tokens, error: resultB.error,
    };
    transcript.push(entryB);

    const lastB = progress[progress.length - 1]!;
    lastB.durationMs = resultB.durationMs;
    lastB.tokens = resultB.tokens;
    fire();

    if (resultB.error) entryB.output = `[ERROR: ${resultB.error}]`;
    if (ctx.signal?.aborted) break;
  }

  // ── Optional judge ──────────────────────────────────────────────
  let judgeVerdict: string | undefined;
  if (params.judge && !ctx.signal?.aborted) {
    fire({ phase: "judge", round: rounds, totalRounds: rounds, speaker: "judge", tokens: 0, durationMs: 0 });

    const fullTranscript = transcript
      .map((e) => `### Round ${e.round} — Participant ${e.speaker} (${e.model})\n\n${e.output}`)
      .join("\n\n");

    const judgeResult = await runDebateTurn({
      systemPrompt: buildJudgeSystemPrompt({ topic: params.topic, transcript: fullTranscript, customPrompt: params.judge?.prompt }),
      model: judgeModel, thinking, tools: [], cwd,
      prompt: "Review the debate and deliver your verdict.",
      modelRegistry: ctx.modelRegistry, signal: ctx.signal,
    });

    judgeVerdict = judgeResult.error ? `[JUDGE ERROR: ${judgeResult.error}]` : judgeResult.output;

    const lastP = progress[progress.length - 1]!;
    lastP.durationMs = judgeResult.durationMs;
    lastP.tokens = judgeResult.tokens;
    lastP.phase = "done";
    fire();
  } else {
    fire({ phase: "done", round: rounds, totalRounds: rounds, speaker: "A", tokens: 0, durationMs: 0 });
  }

  // ── Format output ────────────────────────────────────────────────
  const elapsedTotal = Date.now() - startedAt;
  const totalTokens = transcript.reduce((sum, e) => sum + e.tokens, 0);
  const parts: string[] = [];

  parts.push(`# Debate: ${params.topic}`);
  parts.push(`Rounds: ${rounds} · Wall time: ${fmtDuration(elapsedTotal)} · Total tokens: ${fmtTokens(totalTokens)}`);
  if (unknownTools.length) parts.push(`⚠ Unknown tools ignored: ${unknownTools.join(", ")}`);
  parts.push("");

  for (const entry of transcript) {
    const name = entry.speaker === "A" ? "A" : "B";
    const label = entry.error ? "⚠ FAILED" : "OK";
    parts.push(
      `## Round ${entry.round} — Participant ${name} (${entry.model})\n` +
      `[${label} | ${fmtDuration(entry.durationMs)} | ${fmtTokens(entry.tokens)} tokens]\n\n${entry.output}\n`,
    );
  }

  if (judgeVerdict) {
    parts.push("---\n");
    parts.push(`## Judge Verdict (${judgeModel.provider}/${judgeModel.id})`);
    parts.push(judgeVerdict);
  }

  return {
    content: [{ type: "text" as const, text: parts.join("\n") }],
    details: { topic: params.topic, rounds, transcript, judgeVerdict, progress },
  };
}

// ── Extension ─────────────────────────────────────────────────────────────

export default function debateExtension(pi: ExtensionAPI): void {
  // ── /debate command (user-facing) ────────────────────────────────

  pi.registerCommand("debate", {
    description: "Run a structured debate between two AI models on a topic",
    handler: async (args, ctx) => {
      // Get topic: from args or prompt the user
      let topic = args?.trim();
      if (!topic) {
        topic = await ctx.ui.input("Debate topic:", "e.g. Is Rust better than Go for CLIs?");
        if (!topic) return;
      }

      ctx.ui.setStatus("debate", "Debate starting…");

      const result = await runDebate(
        { topic },
        { modelRegistry: ctx.modelRegistry, model: ctx.model, cwd: ctx.cwd },
        ({ progress }) => {
          const last = progress[progress.length - 1];
          if (last?.phase === "round") {
            ctx.ui.setStatus("debate", `R${last.round} — ${last.speaker}`);
          } else if (last?.phase === "judge") {
            ctx.ui.setStatus("debate", "Judge deliberating…");
          }
        },
      );

      ctx.ui.setStatus("debate", undefined);

      // Notify result
      const details = result.details as DebateDetails;
      const turnCount = details.transcript.length;
      if (turnCount > 0) {
        ctx.ui.notify(`Debate complete — ${turnCount} turns`, "info");
      } else {
        ctx.ui.notify(result.content[0]!.text, "error");
      }

      // Inject results into session
      pi.sendMessage({
        customType: "debate-results",
        content: result.content[0]!.text,
        display: true,
        details: result.details,
      });
    },
  });

  // ── debate tool (LLM-callable) ──────────────────────────────────

  pi.registerTool({
    name: "debate",
    label: "Debate",
    description:
      "Run a structured debate between two AI models on a topic. " +
      "Models argue in rounds, each seeing the full transcript. " +
      "Optionally, a judge model evaluates the debate and declares a winner. " +
      "Each participant gets independent tools, model, and thinking level.",
    parameters: Type.Object({
      topic: Type.String({ description: "The debate topic or question." }),
      rounds: Type.Optional(Type.Number({
        minimum: 1,
        maximum: MAX_ROUNDS,
        default: DEFAULT_ROUNDS,
        description: `Number of back-and-forth rounds (1-${MAX_ROUNDS}, default ${DEFAULT_ROUNDS}).`,
      })),
      modelA: Type.Optional(Type.String({
        description: "Model for participant A (pro). Falls back to parent model.",
      })),
      modelB: Type.Optional(Type.String({
        description: "Model for participant B (con). Falls back to model A, then parent model.",
      })),
      positionA: Type.Optional(Type.String({
        description: "Position/perspective for A (default: 'pro / in favor').",
      })),
      positionB: Type.Optional(Type.String({
        description: "Position/perspective for B (default: 'con / against').",
      })),
      systemPromptA: Type.Optional(Type.String({
        description: "Custom system prompt for A. Overrides the default debate framing.",
      })),
      systemPromptB: Type.Optional(Type.String({
        description: "Custom system prompt for B. Overrides the default debate framing.",
      })),
      judge: Type.Optional(Type.Object({
        model: Type.Optional(Type.String({
          description: "Model for the judge. Defaults to parent model.",
        })),
        prompt: Type.Optional(Type.String({
          description: "Custom judge prompt. Overrides the default evaluation format.",
        })),
      })),
      cwd: Type.Optional(Type.String({
        description: "Working directory for both participants. Defaults to parent session cwd.",
      })),
      tools: Type.Optional(Type.Array(Type.String(), {
        description: "Tools both participants may use: read, write, edit, bash, grep, find, ls.",
      })),
      thinking: Type.Optional(Type.String({
        description: "Thinking level for both participants: off, minimal, low, medium, high, xhigh. Defaults to off.",
      })),
    }),

    async execute(_id, params: DebateArgs, signal, onUpdate, ctx) {
      return runDebate(params, {
        modelRegistry: ctx.modelRegistry,
        model: ctx.model,
        cwd: ctx.cwd,
        signal,
      }, ({ transcript, progress }) => {
        onUpdate?.({
          content: [{ type: "text", text: `Debating: ${trunc(params.topic, 60)}` }],
          details: { topic: params.topic, rounds: params.rounds ?? DEFAULT_ROUNDS, transcript, progress },
        });
      });
    },

    // ── TUI Renderers ────────────────────────────────────────────────

    renderCall(args, theme, ctx) {
      const state = ctx.state as { startedAt?: number };
      if (ctx.executionStarted && state.startedAt === undefined) state.startedAt = Date.now();
      const a = args as DebateArgs;
      const text = (ctx.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const rd = a.rounds ?? DEFAULT_ROUNDS;
      const hasJudge = !!a.judge;
      const lines = [
        theme.fg("toolTitle", theme.bold(`debate`)),
        `  ${theme.fg("muted", trunc(a.topic, 60))}`,
        `  ${rd} round${rd > 1 ? "s" : ""}${hasJudge ? " · judge" : ""}`,
      ];
      text.setText(lines.join("\n"));
      return text;
    },

    renderResult(result, options, theme, ctx) {
      const state = ctx.state as { startedAt?: number };
      const details = result.details as DebateDetails | undefined;

      if (!details?.progress?.length) {
        const content = (result.content as Array<{ type: string; text: string }>)
          ?.filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n") ?? "";
        const text = (ctx.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(content ? `\n${content}` : "");
        return text;
      }

      const { progress, transcript } = details;
      const elapsed = state.startedAt ? ` · ${fmtDuration(Date.now() - state.startedAt)}` : "";

      // ── Partial (still running) ────────────────────────────────
      if (options.isPartial) {
        const text = (ctx.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        const lines: string[] = ["", theme.fg("muted", `Debating${elapsed}`), ""];

        for (const p of progress) {
          switch (p.phase) {
            case "setup":
              lines.push(`  ${theme.fg("warning", "⚠")} ${theme.fg("muted", "validating…")}`);
              break;
            case "round":
              lines.push(`  ${theme.fg("warning", "●")} Round ${p.round}/${p.totalRounds} — ${theme.bold(p.speaker)}${p.tokens > 0 ? theme.fg("muted", ` · ${fmtTokens(p.tokens)} tokens`) : ""}`);
              break;
            case "judge":
              lines.push(`  ${theme.fg("warning", "●")} ${theme.bold("Judge")} deliberating…`);
              break;
            case "done":
              break;
          }
        }

        const done = transcript.length;
        const total = details.rounds * 2;
        if (done > 0 && done < total) {
          lines.push("", theme.fg("muted", `${done}/${total} turns complete`));
        }
        text.setText(lines.join("\n"));
        return text;
      }

      // ── Complete — expanded (Ctrl+O) ──────────────────────────
      const totalTokens = transcript.reduce((sum, e) => sum + e.tokens, 0);
      const totalMs = transcript.reduce((sum, e) => sum + e.durationMs, 0);
      const wallTime = state.startedAt ? fmtDuration(Date.now() - state.startedAt) : fmtDuration(totalMs);

      if (options.expanded) {
        const mdTheme = getMarkdownTheme();
        const container = new Container();

        // Header
        container.addChild(new Text(
          theme.fg("muted", `${transcript.length}/${details.rounds * 2} turns · ${wallTime} wall · ${fmtTokens(totalTokens)} tokens`),
          0, 0,
        ));
        container.addChild(new Spacer(1));

        // Full transcript
        for (const entry of transcript) {
          const icon = entry.error ? theme.fg("error", "✗") : theme.fg("success", "✓");
          const label = `Round ${entry.round} — Participant ${entry.speaker}`;
          container.addChild(new Text(
            `${icon} ${theme.bold(label)} ${theme.fg("muted", `(${entry.model})`)}${theme.fg("muted", ` · ${fmtDuration(entry.durationMs)} · ${fmtTokens(entry.tokens)} tokens`)}`,
            0, 0,
          ));
          container.addChild(new Markdown(entry.output, 1, 0, mdTheme));
          container.addChild(new Spacer(1));
        }

        // Judge verdict
        if (details.judgeVerdict) {
          container.addChild(new Text(theme.bold("Judge:"), 0, 0));
          container.addChild(new Markdown(details.judgeVerdict, 1, 0, mdTheme));
        }

        return container;
      }

      // ── Complete — collapsed (default) ────────────────────────
      // Reuse lastComponent only if it's a Text; expanded path returns Container
      const last = ctx.lastComponent as Record<string, unknown> | undefined;
      const text = (last && "setText" in last ? ctx.lastComponent as Text : undefined) ?? new Text("", 0, 0);
      const lines: string[] = [
        "",
        theme.fg("muted", `${transcript.length}/${details.rounds * 2} turns · ${wallTime} wall · ${fmtTokens(totalTokens)} tokens`),
        "",
      ];

      for (const entry of transcript) {
        const icon = entry.error ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const label = `Round ${entry.round} — ${entry.speaker}`;
        lines.push(
          `${icon} ${theme.bold(label)} ${theme.fg("muted", `(${entry.model})`)}` +
          theme.fg("muted", ` · ${fmtDuration(entry.durationMs)} · ${fmtTokens(entry.tokens)} tokens`),
        );
      }

      if (details.judgeVerdict) {
        lines.push("");
        const verdictLines = details.judgeVerdict.trim().split("\n");
        lines.push(theme.bold("Judge:"));
        const maxLines = 4;
        for (const line of verdictLines.slice(0, maxLines)) {
          lines.push(`  ${theme.fg("toolOutput", line)}`);
        }
        if (verdictLines.length > maxLines) {
          lines.push(`  ${theme.fg("muted", `… ${verdictLines.length - maxLines} more lines`)}`);
        }
      }

      try {
        lines.push("", theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`));
      } catch {
        lines.push("", theme.fg("muted", "(Ctrl+O to expand)"));
      }
      text.setText(lines.join("\n"));
      return text;
    },
  });
}
