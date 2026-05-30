/**
 * roundtable — Multi-project roundtable discussion.
 *
 * Spawns N participants, each rooted in their own project directory with their
 * own AGENTS.md loaded as context. Participants take turns in round-robin order.
 * An optional moderator synthesizes at the end.
 *
 * This is not adversarial (like debate) — it's collaborative. Each participant
 * brings their own domain expertise, project conventions, and codebase access.
 *
 * Agent instances are cached across rounds so the conversation prefix stays warm
 * in the provider's prompt cache. Only the delta (new messages since last turn)
 * is sent per turn — O(N) token scaling, not O(N²).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import { type Api, type Model, streamSimple } from "@mariozechner/pi-ai";
import {
  convertToLlm,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type ExtensionAPI,
  getMarkdownTheme,
  keyHint,
  type ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ── Types ────────────────────────────────────────────────────────────────

export interface Participant {
  name: string;
  cwd: string;
  role?: string;
  model?: string;
  systemPrompt?: string;
}

export interface RoundtableArgs {
  topic: string;
  rounds?: number;
  participants: Participant[];
  moderator?: { model?: string; prompt?: string };
  tools?: string[];
  thinking?: string;
}

export interface RoundtableProgress {
  phase: "setup" | "turn" | "moderator" | "done";
  round: number;
  totalRounds: number;
  speaker: string;
  tokens: number;
  durationMs: number;
}

export interface RoundtableEntry {
  round: number;
  speaker: string;
  model: string;
  output: string;
  durationMs: number;
  tokens: number;
  error?: string;
}

export interface RoundtableDetails {
  topic: string;
  rounds: number;
  participantCount: number;
  transcript: RoundtableEntry[];
  moderatorSummary?: string;
  progress: RoundtableProgress[];
}

/** Tracks a live agent and what it's seen so far. */
interface LiveParticipant {
  agent: Agent;
  lastSeenIndex: number; // index into the global transcript
  model: Model<Api>;
}

// ── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_TOOLS = ["read", "grep", "find", "ls", "bash"];
const MAX_ROUNDS = 10;
const DEFAULT_ROUNDS = 2;
const MAX_PARTICIPANTS = 6;

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

function extractTokensFromAgent(agent: Agent): number {
  let total = 0;
  for (const msg of agent.state.messages) {
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

/** Read AGENTS.md from a project root, returns contents or empty string. */
async function readAgentsMd(cwd: string): Promise<string> {
  const candidates = [
    path.join(cwd, "AGENTS.md"),
    path.join(cwd, ".agents", "AGENTS.md"),
    path.join(cwd, ".pi", "AGENTS.md"),
  ];
  for (const p of candidates) {
    try {
      return await fs.readFile(p, "utf-8");
    } catch {
      // skip — file doesn't exist or not readable
    }
  }
  return "";
}

function modelId(model: Model<Api>): string {
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

// ── Prompt Building ──────────────────────────────────────────────────────

function buildParticipantSystemPrompt(args: {
  participant: Participant;
  topic: string;
  participants: Participant[];
  totalRounds: number;
  agentsMd: string;
}): string {
  if (args.participant.systemPrompt) return args.participant.systemPrompt;

  const { participant, topic, totalRounds, agentsMd } = args;
  const role = participant.role ?? `Domain expert and guardian of the ${participant.name} project`;
  const otherNames = args.participants
    .filter((p) => p.name !== participant.name)
    .map((p) => p.name)
    .join(", ");

  const lines = [
    `You are **${participant.name}**, a participant in a roundtable discussion.`,
    "",
    `## Topic`,
    topic,
    "",
    `## Your Project`,
    `Name: ${participant.name}`,
    `Root: ${participant.cwd}`,
    `Role: ${role}`,
    "",
    `## Other Participants`,
    otherNames,
    "",
    `## Your Project's Guidelines (AGENTS.md)`,
    agentsMd || "(no AGENTS.md found — use your general expertise about this project)",
    "",
    `## Instructions`,
    `- The roundtable has ${totalRounds} rounds. You speak once per round.`,
    "- For your first turn, introduce your perspective grounded in your project's domain.",
    "- For later turns, build on the discussion — engage with other participants' points.",
    "- Draw on your project's expertise, conventions, and codebase when relevant.",
    "- You may use tools to investigate your codebase if you need evidence.",
    `- Engage with the other participants (${otherNames}) — ask questions, challenge assumptions, build on ideas.`,
    "- Be concise but substantive. Aim for 2-4 paragraphs.",
    "- Stay grounded in your project's domain. You represent its perspective.",
    "- If another participant asks about your project, answer from your AGENTS.md and codebase.",
    "",
    "Each message you receive will contain the new contributions from other participants since your last turn.",
    "Respond with your own contribution. Do NOT speak for other participants.",
  ];

  return lines.join("\n");
}

function buildModeratorSystemPrompt(args: {
  topic: string;
  participants: string[];
  transcript: string;
  customPrompt?: string;
}): string {
  if (args.customPrompt) return args.customPrompt;

  return [
    "You are moderating a roundtable discussion between multiple AI participants, each representing a different project.",
    "",
    `Topic: ${args.topic}`,
    `Participants: ${args.participants.join(", ")}`,
    "",
    "Synthesize the discussion. Identify:",
    "- Key points of agreement and disagreement",
    "- Unique insights each participant brought",
    "- Actionable conclusions or next steps",
    "- Open questions that remain",
    "",
    "Format your synthesis with clear sections. Be concise but comprehensive.",
    "",
    "## Discussion Transcript",
    args.transcript,
  ].join("\n");
}

// ── Agent Factory ────────────────────────────────────────────────────────

function createParticipantAgent(args: {
  systemPrompt: string;
  model: Model<Api>;
  thinking: ThinkingLevel;
  tools: string[];
  cwd: string;
  modelRegistry: ModelRegistry;
  signal?: AbortSignal;
}): Agent {
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

  return agent;
}

// ── Core Roundtable Runner ───────────────────────────────────────────────

type RoundtableState = { transcript: RoundtableEntry[]; progress: RoundtableProgress[] };

async function runRoundtable(
  params: RoundtableArgs,
  ctx: { modelRegistry: ModelRegistry; model?: Model<Api>; cwd: string; signal?: AbortSignal },
  onProgress?: (state: RoundtableState) => void,
) {
  const startedAt = Date.now();
  const rounds = Math.min(params.rounds ?? DEFAULT_ROUNDS, MAX_ROUNDS);
  const participants = params.participants.slice(0, MAX_PARTICIPANTS);

  if (participants.length < 2) {
    return {
      content: [{ type: "text" as const, text: "❌ Need at least 2 participants for a roundtable." }],
      details: { topic: params.topic, rounds, participantCount: participants.length, transcript: [] as RoundtableEntry[], progress: [] as RoundtableProgress[] },
    };
  }

  // ── Resolve models ───────────────────────────────────────────────
  const parentModel = ctx.model;
  const participantModels = participants.map((p) =>
    resolveModel(p.model, ctx.modelRegistry, parentModel),
  );

  const firstMissing = participantModels.findIndex((m) => !m);
  if (firstMissing >= 0) {
    return {
      content: [{
        type: "text" as const,
        text: `❌ Could not resolve model for participant "${participants[firstMissing].name}".`,
      }],
      details: { topic: params.topic, rounds, participantCount: participants.length, transcript: [] as RoundtableEntry[], progress: [] as RoundtableProgress[] },
    };
  }

  const resolvedModels = participantModels as Model<Api>[];
  const moderatorModel = params.moderator?.model
    ? (resolveModel(params.moderator.model, ctx.modelRegistry, parentModel) ?? parentModel)
    : parentModel;

  // ── Resolve tools & thinking ─────────────────────────────────────
  const tools = params.tools ?? DEFAULT_TOOLS;
  const unknownTools = tools.filter((name) => !(name in TOOL_FACTORIES));
  const thinkingRaw = params.thinking ?? "off";
  const thinking: ThinkingLevel = VALID_THINKING.has(thinkingRaw) ? (thinkingRaw as ThinkingLevel) : "off";

  // ── Read AGENTS.md for each participant ──────────────────────────
  const agentsMds = await Promise.all(participants.map((p) => readAgentsMd(p.cwd)));

  // ── Progress tracking ────────────────────────────────────────────
  const transcript: RoundtableEntry[] = [];
  const progress: RoundtableProgress[] = [];

  const fire = (p?: RoundtableProgress) => {
    if (p) progress.push(p);
    onProgress?.({ transcript: [...transcript], progress: [...progress] });
  };

  if (unknownTools.length) {
    fire({ phase: "setup", round: 0, totalRounds: rounds, speaker: "", tokens: 0, durationMs: 0 });
  }

  // ── Create cached agents ─────────────────────────────────────────
  // Each participant gets one Agent that lives across all their turns.
  // The system prompt is fixed (includes AGENTS.md), and we only send
  // the delta each turn — the conversation prefix stays warm in the
  // provider's prompt cache.
  const liveParticipants: LiveParticipant[] = participants.map((participant, i) => {
    const systemPrompt = buildParticipantSystemPrompt({
      participant,
      topic: params.topic,
      participants,
      totalRounds: rounds,
      agentsMd: agentsMds[i],
    });

    const agent = createParticipantAgent({
      systemPrompt,
      model: resolvedModels[i],
      thinking,
      tools,
      cwd: participant.cwd,
      modelRegistry: ctx.modelRegistry,
      signal: ctx.signal,
    });

    return { agent, lastSeenIndex: 0, model: resolvedModels[i] };
  });

  // ── Roundtable rounds ────────────────────────────────────────────
  for (let round = 1; round <= rounds; round++) {
    for (let pi = 0; pi < participants.length; pi++) {
      if (ctx.signal?.aborted) break;

      const participant = participants[pi];
      const live = liveParticipants[pi];
      const turnStart = Date.now();
      const tokensBefore = extractTokensFromAgent(live.agent);

      // Build the delta — only new transcript entries since this participant's last turn
      const delta = transcript.slice(live.lastSeenIndex);
      let deltaText = "";
      if (delta.length > 0) {
        deltaText = "## New contributions since your last turn\n\n";
        for (const entry of delta) {
          deltaText += `**${entry.speaker}** (Round ${entry.round}):\n\n${entry.output}\n\n`;
        }
      }

      const prompt = round === 1 && delta.length === 0
        ? "The roundtable is starting. Make your opening statement."
        : `${deltaText}---\n\nRound ${round} of ${rounds}. Your turn, ${participant.name}. Respond with your contribution.`;

      fire({ phase: "turn", round, totalRounds: rounds, speaker: participant.name, tokens: 0, durationMs: 0 });

      try {
        await live.agent.prompt(prompt);
        await live.agent.waitForIdle();

        const tokensAfter = extractTokensFromAgent(live.agent);
        const turnTokens = tokensAfter - tokensBefore;
        const output = extractOutput(live.agent.state.messages) || "(no output)";
        const errorMsg = (live.agent.state as { errorMessage?: string }).errorMessage;

        const entry: RoundtableEntry = {
          round,
          speaker: participant.name,
          model: modelId(live.model),
          output: errorMsg ? `[ERROR: ${errorMsg}]` : output,
          durationMs: Date.now() - turnStart,
          tokens: turnTokens,
          error: errorMsg,
        };
        transcript.push(entry);
        live.lastSeenIndex = transcript.length;

        const lastP = progress[progress.length - 1]!;
        lastP.durationMs = entry.durationMs;
        lastP.tokens = turnTokens;
        fire();
      } catch (err) {
        const entry: RoundtableEntry = {
          round,
          speaker: participant.name,
          model: modelId(live.model),
          output: `[ERROR: ${err instanceof Error ? err.message : String(err)}]`,
          durationMs: Date.now() - turnStart,
          tokens: 0,
          error: err instanceof Error ? err.message : String(err),
        };
        transcript.push(entry);
        live.lastSeenIndex = transcript.length;

        const lastP = progress[progress.length - 1]!;
        lastP.durationMs = entry.durationMs;
        lastP.tokens = 0;
        fire();
      }
    }
    if (ctx.signal?.aborted) break;
  }

  // ── Optional moderator ──────────────────────────────────────────
  let moderatorSummary: string | undefined;
  if (params.moderator && moderatorModel && !ctx.signal?.aborted) {
    fire({ phase: "moderator", round: rounds, totalRounds: rounds, speaker: "moderator", tokens: 0, durationMs: 0 });

    // Moderator is one-shot, no caching needed
    const fullTranscript = transcript
      .map((e) => `### Round ${e.round} — ${e.speaker} (${e.model})\n\n${e.output}`)
      .join("\n\n");

    const modAgent = createParticipantAgent({
      systemPrompt: buildModeratorSystemPrompt({
        topic: params.topic,
        participants: participants.map((p) => p.name),
        transcript: fullTranscript,
        customPrompt: params.moderator?.prompt,
      }),
      model: moderatorModel,
      thinking,
      tools: [],
      cwd: ctx.cwd,
      modelRegistry: ctx.modelRegistry,
      signal: ctx.signal,
    });

    const modStart = Date.now();
    try {
      await modAgent.prompt("Synthesize the roundtable discussion.");
      await modAgent.waitForIdle();

      const modTokens = extractTokensFromAgent(modAgent);
      const modOutput = extractOutput(modAgent.state.messages);
      const modError = (modAgent.state as { errorMessage?: string }).errorMessage;

      moderatorSummary = modError ? `[MODERATOR ERROR: ${modError}]` : modOutput;

      const lastP = progress[progress.length - 1]!;
      lastP.durationMs = Date.now() - modStart;
      lastP.tokens = modTokens;
      lastP.phase = "done";
      fire();
    } catch (err) {
      moderatorSummary = `[MODERATOR ERROR: ${err instanceof Error ? err.message : String(err)}]`;
      const lastP = progress[progress.length - 1]!;
      lastP.durationMs = Date.now() - modStart;
      lastP.phase = "done";
      fire();
    }
  } else {
    fire({ phase: "done", round: rounds, totalRounds: rounds, speaker: "", tokens: 0, durationMs: 0 });
  }

  // ── Format output ────────────────────────────────────────────────
  const elapsedTotal = Date.now() - startedAt;
  const totalTokens = transcript.reduce((sum, e) => sum + e.tokens, 0);
  const parts: string[] = [];

  parts.push(`# Roundtable: ${params.topic}`);
  parts.push(`Participants: ${participants.map((p) => p.name).join(", ")} · Rounds: ${rounds} · Wall time: ${fmtDuration(elapsedTotal)} · Total tokens: ${fmtTokens(totalTokens)}`);
  if (unknownTools.length) parts.push(`⚠ Unknown tools ignored: ${unknownTools.join(", ")}`);
  parts.push("");

  for (const entry of transcript) {
    const label = entry.error ? "⚠ FAILED" : "OK";
    parts.push(
      `## Round ${entry.round} — ${entry.speaker} (${entry.model})\n` +
      `[${label} | ${fmtDuration(entry.durationMs)} | ${fmtTokens(entry.tokens)} tokens]\n\n${entry.output}\n`,
    );
  }

  if (moderatorSummary) {
    parts.push("---\n");
    parts.push(`## Moderator Synthesis (${modelId(moderatorModel!)})`);
    parts.push(moderatorSummary);
  }

  return {
    content: [{ type: "text" as const, text: parts.join("\n") }],
    details: { topic: params.topic, rounds, participantCount: participants.length, transcript, moderatorSummary, progress },
  };
}

// ── Default participants ─────────────────────────────────────────────────

const DEFAULT_PARTICIPANTS: Participant[] = [
  {
    name: "little-goblin",
    cwd: "/home/daniel/build/little-goblin",
    role: "Telegram-native personal AI agent. Expert on subagent spawning, session management, pi-coding-agent integration, and homelab automation.",
  },
  {
    name: "agent-extensions",
    cwd: "/home/daniel/build/agent-extensions",
    role: "Pi and OpenCode extension workshop. Expert on the pi extension API, tool registration, TUI rendering, subagent delegation, and agent harness patterns.",
  },
  {
    name: "AgenticWiki",
    cwd: "/home/daniel/Documents/AgenticWiki",
    role: "LLM-maintained personal wiki on AI-assisted development. Expert on agentic coding theory, context engineering, knowledge management, and AI agent patterns.",
  },
];

// ── Extension ─────────────────────────────────────────────────────────────

export default function roundtableExtension(pi: ExtensionAPI): void {

  // ── /roundtable command ──────────────────────────────────────────

  pi.registerCommand("roundtable", {
    description: "Run a multi-project roundtable discussion with agents rooted in their own codebases",
    handler: async (args, ctx) => {
      let topic = args?.trim() || undefined;
      if (!topic) {
        topic = (await ctx.ui.input("Roundtable topic:", "e.g. How should agents handle long-lived state?")) || undefined;
        if (!topic) return;
      }

      ctx.ui.setStatus("roundtable", "Roundtable starting…");

      const result = await runRoundtable(
        { topic, participants: DEFAULT_PARTICIPANTS, moderator: {} },
        { modelRegistry: ctx.modelRegistry, model: ctx.model, cwd: ctx.cwd },
        ({ progress }) => {
          const last = progress[progress.length - 1];
          if (last?.phase === "turn") {
            ctx.ui.setStatus("roundtable", `R${last.round} — ${last.speaker}`);
          } else if (last?.phase === "moderator") {
            ctx.ui.setStatus("roundtable", "Moderator synthesizing…");
          }
        },
      );

      ctx.ui.setStatus("roundtable", undefined);

      const details = result.details as RoundtableDetails;
      const turnCount = details.transcript.length;
      if (turnCount > 0) {
        ctx.ui.notify(`Roundtable complete — ${turnCount} turns across ${details.participantCount} participants`, "info");
      } else {
        ctx.ui.notify(result.content[0]!.text, "error");
      }

      pi.sendMessage({
        customType: "roundtable-results",
        content: result.content[0]!.text,
        display: true,
        details: result.details,
      });
    },
  });

  // ── roundtable tool (LLM-callable) ──────────────────────────────

  pi.registerTool({
    name: "roundtable",
    label: "Roundtable",
    description:
      "Run a multi-project roundtable discussion. Each participant is rooted in their own " +
      "project directory with their own AGENTS.md loaded. Participants take turns in " +
      "round-robin order, each seeing the growing transcript. An optional moderator " +
      "synthesizes the discussion at the end.",
    parameters: Type.Object({
      topic: Type.String({ description: "The discussion topic or question." }),
      rounds: Type.Optional(Type.Number({
        minimum: 1,
        maximum: MAX_ROUNDS,
        default: DEFAULT_ROUNDS,
        description: `Number of rounds (1-${MAX_ROUNDS}, default ${DEFAULT_ROUNDS}). Each participant speaks once per round.`,
      })),
      participants: Type.Array(Type.Object({
        name: Type.String({ description: "Participant name (used in transcript)." }),
        cwd: Type.String({ description: "Project root directory. Participant's AGENTS.md is loaded from here. Tools are scoped to this cwd." }),
        role: Type.Optional(Type.String({ description: "Role description. Default: domain expert of the project." })),
        model: Type.Optional(Type.String({ description: "Model override for this participant. Falls back to parent model." })),
        systemPrompt: Type.Optional(Type.String({ description: "Custom system prompt. Overrides the default roundtable framing + AGENTS.md injection." })),
      }), {
        minItems: 2,
        maxItems: MAX_PARTICIPANTS,
        description: "Participants in the roundtable. Each must have a name and cwd. AGENTS.md is loaded from cwd.",
      }),
      moderator: Type.Optional(Type.Object({
        model: Type.Optional(Type.String({ description: "Model for the moderator. Defaults to parent model." })),
        prompt: Type.Optional(Type.String({ description: "Custom moderator prompt. Overrides default synthesis format." })),
      })),
      tools: Type.Optional(Type.Array(Type.String(), {
        description: "Tools participants may use: read, write, edit, bash, grep, find, ls. Default: read, grep, find, ls, bash.",
      })),
      thinking: Type.Optional(Type.String({
        description: "Thinking level for all participants: off, minimal, low, medium, high, xhigh. Defaults to off.",
      })),
    }),

    async execute(_id, params: RoundtableArgs, signal, onUpdate, ctx) {
      return runRoundtable(params, {
        modelRegistry: ctx.modelRegistry,
        model: ctx.model,
        cwd: ctx.cwd,
        signal,
      }, ({ transcript, progress }) => {
        onUpdate?.({
          content: [{ type: "text", text: `Roundtable: ${trunc(params.topic, 60)}` }],
          details: { topic: params.topic, rounds: params.rounds ?? DEFAULT_ROUNDS, participantCount: params.participants.length, transcript, progress },
        });
      });
    },

    // ── TUI Renderers ────────────────────────────────────────────────

    renderCall(args, theme, ctx) {
      const state = (ctx.state ?? {}) as { startedAt?: number };
      if (ctx.executionStarted && state.startedAt === undefined) state.startedAt = Date.now();
      const a = args as RoundtableArgs;
      const text = (ctx.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const rd = a.rounds ?? DEFAULT_ROUNDS;
      const names = a.participants.map((p) => p.name).join(", ");
      const hasMod = !!a.moderator;
      const lines = [
        theme.fg("toolTitle", theme.bold(`roundtable`)),
        `  ${theme.fg("muted", trunc(a.topic, 60))}`,
        `  ${rd} round${rd > 1 ? "s" : ""} · ${a.participants.length} participants${hasMod ? " · moderator" : ""}`,
        `  ${theme.fg("muted", trunc(names, 80))}`,
      ];
      text.setText(lines.join("\n"));
      return text;
    },

    renderResult(result, options, theme, ctx) {
      const state = (ctx.state ?? {}) as { startedAt?: number };
      const details = result.details as RoundtableDetails | undefined;

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
        const lines: string[] = ["", theme.fg("muted", `Discussing${elapsed}`), ""];

        for (const p of progress) {
          switch (p.phase) {
            case "setup":
              lines.push(`  ${theme.fg("warning", "⚠")} ${theme.fg("muted", "validating…")}`);
              break;
            case "turn":
              lines.push(`  ${theme.fg("warning", "●")} Round ${p.round}/${p.totalRounds} — ${theme.bold(p.speaker)}${p.tokens > 0 ? theme.fg("muted", ` · ${fmtTokens(p.tokens)} tokens`) : ""}`);
              break;
            case "moderator":
              lines.push(`  ${theme.fg("warning", "●")} ${theme.bold("Moderator")} synthesizing…`);
              break;
            case "done":
              break;
          }
        }

        const done = transcript.length;
        const total = details.rounds * details.participantCount;
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

        container.addChild(new Text(
          theme.fg("muted", `${transcript.length}/${details.rounds * details.participantCount} turns · ${wallTime} wall · ${fmtTokens(totalTokens)} tokens`),
          0, 0,
        ));
        container.addChild(new Spacer(1));

        for (const entry of transcript) {
          const icon = entry.error ? theme.fg("error", "✗") : theme.fg("success", "✓");
          container.addChild(new Text(
            `${icon} ${theme.bold(entry.speaker)} ${theme.fg("muted", `(R${entry.round} · ${entry.model})`)}${theme.fg("muted", ` · ${fmtDuration(entry.durationMs)} · ${fmtTokens(entry.tokens)} tokens`)}`,
            0, 0,
          ));
          container.addChild(new Markdown(entry.output, 1, 0, mdTheme));
          container.addChild(new Spacer(1));
        }

        if (details.moderatorSummary) {
          container.addChild(new Text(theme.bold("Moderator Synthesis:"), 0, 0));
          container.addChild(new Markdown(details.moderatorSummary, 1, 0, mdTheme));
        }

        return container;
      }

      // ── Complete — collapsed (default) ────────────────────────
      const last = ctx.lastComponent as Record<string, unknown> | undefined;
      const text = (last && "setText" in last ? ctx.lastComponent as Text : undefined) ?? new Text("", 0, 0);
      const lines: string[] = [
        "",
        theme.fg("muted", `${transcript.length}/${details.rounds * details.participantCount} turns · ${wallTime} wall · ${fmtTokens(totalTokens)} tokens`),
        "",
      ];

      for (const entry of transcript) {
        const icon = entry.error ? theme.fg("error", "✗") : theme.fg("success", "✓");
        lines.push(
          `${icon} ${theme.bold(entry.speaker)} ${theme.fg("muted", `(R${entry.round})`)}` +
          theme.fg("muted", ` · ${fmtDuration(entry.durationMs)} · ${fmtTokens(entry.tokens)} tokens`),
        );
      }

      if (details.moderatorSummary) {
        lines.push("");
        const summaryLines = details.moderatorSummary.trim().split("\n");
        lines.push(theme.bold("Moderator:"));
        const maxLines = 4;
        for (const line of summaryLines.slice(0, maxLines)) {
          lines.push(`  ${theme.fg("toolOutput", line)}`);
        }
        if (summaryLines.length > maxLines) {
          lines.push(`  ${theme.fg("muted", `… ${summaryLines.length - maxLines} more lines`)}`);
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
