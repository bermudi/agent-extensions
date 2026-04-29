/**
 * delegate — In-process subagent delegation for pi.
 *
 * Borrows apple-pi's architecture (pi-agent-core Agent class, Promise.all
 * parallelism) with per-task overrides for model, skills, tools, thinking
 * level, system prompt, and working directory.
 *
 * Agent definitions live in .pi/agents/*.md (project) and ~/.pi/agent/agents/*.md (user).
 * Each task can reference a named agent and/or supply inline overrides.
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
  type ModelRegistry,
  type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ── Types ────────────────────────────────────────────────────────────────

interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  thinking: ThinkingLevel;
  tools: string[];
  skills: string[];
  systemPrompt: string;
}

interface TaskDef {
  prompt: string;
  agent?: string;
  model?: string;
  skills?: string[];
  tools?: string[];
  thinking?: string;
  systemPrompt?: string;
  cwd?: string;
  context?: "fresh" | "inherit";
}

interface TaskProgress {
  index: number;
  agent: string;
  status: "pending" | "running" | "done" | "failed";
  durationMs: number;
  tokens: number;
  error?: string;
}

interface DelegateDetails {
  tasks: TaskDef[];
  results: (TaskResult | { error: string })[];
  progress: TaskProgress[];
}

interface TaskResult {
  agent: string;
  output: string;
  error?: string;
  durationMs: number;
  tokens: number;
}

// ── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];

const TOOL_FACTORIES: Record<string, (cwd: string) => AgentTool<unknown>> = {
  read: createReadTool,
  bash: createBashTool,
  edit: createEditTool,
  write: createWriteTool,
  grep: createGrepTool,
  find: createFindTool,
  ls: createLsTool,
};

const VALID_THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

// ── Frontmatter ───────────────────────────────────────────────────────────

function parseFrontmatter(content: string): { data: Record<string, string>; body: string } {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: content.trim() };
  const data: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    data[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { data, body: m[2]!.trim() };
}

// ── Agent Discovery ───────────────────────────────────────────────────────

function findProjectRoot(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    if (fs.existsSync(path.join(dir, ".pi", "agents"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadAgentFile(filePath: string): AgentConfig | null {
  let content: string;
  try { content = fs.readFileSync(filePath, "utf-8"); } catch { return null; }
  const { data, body } = parseFrontmatter(content);
  if (!data.name || !data.description) return null;
  return {
    name: data.name,
    description: data.description,
    model: data.model,
    thinking: VALID_THINKING.has(data.thinking ?? "") ? (data.thinking as ThinkingLevel) : "off",
    tools: data.tools ? data.tools.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_TOOLS,
    skills: data.skills ? data.skills.split(",").map((s) => s.trim()).filter(Boolean) : [],
    systemPrompt: body,
  };
}

function discoverAgents(cwd: string): Map<string, AgentConfig> {
  const dirs: string[] = [];
  const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
  const projectRoot = findProjectRoot(cwd);
  if (projectRoot) dirs.push(path.join(projectRoot, ".pi", "agents"));
  dirs.push(userDir);

  const agents = new Map<string, AgentConfig>();
  for (const dir of dirs) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.name.endsWith(".md") || e.name.endsWith(".chain.md")) continue;
      const cfg = loadAgentFile(path.join(dir, e.name));
      if (cfg && !agents.has(cfg.name)) agents.set(cfg.name, cfg);
    }
  }
  return agents;
}

// ── Parent Context ────────────────────────────────────────────────────────

function buildParentTranscript(entries: SessionEntry[], leafId: string | null): string | null {
  try {
    const ctx = buildSessionContext(entries, leafId);
    const lines: string[] = [];
    for (const msg of ctx.messages) {
      if (msg.role === "user") {
        const text = extractTextContent(msg.content);
        if (text) lines.push(`**User:** ${text.trim()}`);
      } else if (msg.role === "assistant") {
        const text = extractTextContent(msg.content);
        if (text) lines.push(`**Assistant:** ${text.trim()}`);
      }
    }
    return lines.join("\n\n") || null;
  } catch {
    return null;
  }
}

function extractTextContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

// ── Skill Loading ─────────────────────────────────────────────────────────

function loadSkill(name: string, cwd: string): string | null {
  const candidates = [
    // Project (standard → pi-specific)
    path.join(cwd, ".agents", "skills", name, "SKILL.md"),
    path.join(cwd, ".pi", "skills", name, "SKILL.md"),
    // User (standard → pi-specific)
    path.join(os.homedir(), ".agents", "skills", name, "SKILL.md"),
    path.join(os.homedir(), ".pi", "agent", "skills", name, "SKILL.md"),
  ];
  for (const p of candidates) {
    try { return fs.readFileSync(p, "utf-8"); } catch { /* skip */ }
  }
  return null;
}

// ── Model Resolution ──────────────────────────────────────────────────────

function resolveModel(spec: string | undefined, registry: ModelRegistry, parentModel: Model<Api>): Model<Api> | undefined {
  if (!spec) return parentModel;
  const idx = spec.indexOf("/");
  if (idx === -1) {
    // Bare id — match against available models
    const match = registry.getAvailable().find((m) => m.id === spec);
    return match ?? undefined;
  }
  return registry.find(spec.slice(0, idx), spec.slice(idx + 1)) ?? undefined;
}

// ── Agent Runner ──────────────────────────────────────────────────────────

async function runAgent(
  config: {
    systemPrompt: string;
    model: Model<Api>;
    thinking: ThinkingLevel;
    tools: string[];
    cwd: string;
  },
  prompt: string,
  modelRegistry: ModelRegistry,
  signal?: AbortSignal,
): Promise<{ output: string; error?: string; durationMs: number; tokens: number }> {
  const start = Date.now();

  const tools = config.tools
    .map((name) => TOOL_FACTORIES[name]?.(config.cwd))
    .filter(Boolean) as AgentTool<unknown>[];

  let tokens = 0;
  const agent = new Agent({
    initialState: {
      systemPrompt: config.systemPrompt,
      model: config.model,
      thinkingLevel: config.thinking,
      tools,
    },
    convertToLlm,
    streamFn: async (m, context, options) => {
      const auth = await modelRegistry.getApiKeyAndHeaders(m);
      if (!auth.ok) throw new Error(`Auth failed: ${auth.error}`);
      return streamSimple(m, context, { ...options, apiKey: auth.apiKey, headers: auth.headers ?? undefined });
    },
  });

  if (signal) {
    const onAbort = () => { try { agent.abort(); } catch { /* */ } };
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    await agent.prompt(prompt);
    await agent.waitForIdle();

    const messages = (agent as unknown as { state: { messages: AgentMessage[]; errorMessage?: string } }).state.messages;
    const errorMessage = (agent as unknown as { state: { errorMessage?: string } }).state.errorMessage;

    let output = "";
    for (const msg of messages) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type === "text" && block.text) output += block.text;
      }
      if (msg.usage) {
        const u = msg.usage as Record<string, number>;
        tokens += (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0);
      }
    }

    return {
      output: output || "(no output)",
      error: errorMessage,
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

// ── Formatting ────────────────────────────────────────────────────────────

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const mins = Math.floor(s / 60);
  const secs = Math.floor(s % 60);
  return `${mins}m${secs}s`;
}

function fmtTokens(n: number): string {
  return n < 1000 ? `${n}` : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

function trunc(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// ── Extension ─────────────────────────────────────────────────────────────

export default function delegateExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description:
      "Delegate tasks to subagents running in-process with their own system prompt, skills, and tool restrictions. " +
      "Each task runs independently with a clean context window. " +
      "Only pi core tools are available: read, write, edit, bash. " +
      "Reference a named agent from .pi/agents/*.md (project) or ~/.pi/agent/agents/*.md (user), or supply systemPrompt/tools/skills inline. " +
      "All fields except prompt are optional — missing values fall back to the agent definition or parent defaults.",
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          prompt: Type.String({ description: "The task for this subagent to perform." }),
          agent: Type.Optional(Type.String({
            description: "Named agent to load from .pi/agents/*.md (project) or ~/.pi/agent/agents/*.md (user). All other fields override the agent definition.",
          })),
          model: Type.Optional(Type.String({
            description: "Model override (e.g. 'anthropic/claude-sonnet-4'). Falls back to agent default, then parent model.",
          })),
          skills: Type.Optional(Type.Array(Type.String(), {
            description: "Skill names to inject into the subagent's system prompt. Searched in .agents/skills/, .pi/skills/ (project), ~/.agents/skills/, ~/.pi/agent/skills/ (user).",
          })),
          tools: Type.Optional(Type.Array(Type.String(), {
            description: "Tools the subagent can use. Defaults to agent definition or all standard tools.",
          })),
          thinking: Type.Optional(Type.String({
            description: "Thinking level: off, minimal, low, medium, high, xhigh. Defaults to agent definition or off.",
          })),
          systemPrompt: Type.Optional(Type.String({
            description: "System prompt override. Replaces the agent definition's prompt entirely.",
          })),
          cwd: Type.Optional(Type.String({
            description: "Working directory override. Defaults to parent session cwd.",
          })),
          context: Type.Optional(Type.String({
            enum: ["fresh", "inherit"],
            description: "'fresh' (default) gives the subagent a clean context. 'inherit' injects the full parent session transcript so the subagent can reference prior conversation for deeper investigation.",
          })),
        }),
        { minItems: 1, description: "Tasks to run in parallel. Each gets an independent subagent instance." },
      ),
    }),

    async execute(_id, params: { tasks: TaskDef[] }, signal, onUpdate, ctx) {
      const agents = discoverAgents(ctx.cwd);

      // ── Validate ──────────────────────────────────────────────────
      const unknown: string[] = [];
      for (const t of params.tasks) {
        if (t.agent && !agents.has(t.agent)) unknown.push(t.agent);
      }
      if (unknown.length) {
        const names = [...agents.keys()];
        return {
          content: [{ type: "text", text: `Unknown agent(s): ${unknown.join(", ")}. Available: ${names.join(", ") || "(none)"}` }],
          details: { tasks: params.tasks, results: [], progress: [] },
        };
      }

      // ── Resolve tasks ─────────────────────────────────────────────
      // Build parent transcript lazily — only computed once if any task uses inherit
      let parentTranscript: string | null = null;
      const hasInherit = params.tasks.some((t) => t.context === "inherit");
      if (hasInherit) {
        parentTranscript = buildParentTranscript(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
      }

      const resolved = params.tasks.map((t, i) => {
        const agent = t.agent ? agents.get(t.agent) : undefined;
        const cwd = t.cwd ?? ctx.cwd;

        // Build system prompt
        let systemPrompt = t.systemPrompt ?? agent?.systemPrompt ?? "";
        if (!systemPrompt.trim()) {
          throw new Error(`Task ${i}: no system prompt — specify agent, systemPrompt, or both.`);
        }

        // Inject skills
        const skillNames = t.skills ?? agent?.skills ?? [];
        const skillBodies: string[] = [];
        for (const name of skillNames) {
          const content = loadSkill(name, cwd);
          if (content) skillBodies.push(content);
        }
        if (skillBodies.length) {
          systemPrompt = systemPrompt.trimEnd() + "\n\n" + skillBodies.join("\n\n");
        }

        // Build prompt — wrap with parent context if inheriting
        let prompt = t.prompt;
        const inheritCtx = t.context === "inherit" && parentTranscript ? parentTranscript : null;
        if (inheritCtx) {
          prompt = [
            "<parent-session>",
            "The following is the conversation from the parent session.",
            "Read this for context, then execute the task below.",
            "Do not continue the parent conversation or respond to prior messages.",
            "",
            inheritCtx,
            "</parent-session>",
            "",
            "## Task",
            prompt,
          ].join("\n");
        }

        // Resolve model (falls back to parent model if specification fails to resolve)
        const modelSpec = t.model ?? agent?.model;
        const model = resolveModel(modelSpec, ctx.modelRegistry, ctx.model) ?? ctx.model;

        // Resolve tools — warn about unknown tool names
        const tools = t.tools ?? agent?.tools ?? DEFAULT_TOOLS;
        const unknownTools = tools.filter((name) => !(name in TOOL_FACTORIES));

        // Resolve thinking
        const thinkingRaw = t.thinking ?? agent?.thinking ?? "off";
        const thinking = VALID_THINKING.has(thinkingRaw) ? (thinkingRaw as ThinkingLevel) : "off";

        const warnings: string[] = [];
        if (unknownTools.length) {
          warnings.push(`Unknown tool(s) ignored: ${unknownTools.join(", ")}. Available: ${Object.keys(TOOL_FACTORIES).join(", ")}`);
        }
        return { ...t, cwd, systemPrompt, model, tools, thinking, prompt, agentName: agent?.name ?? "inline", warnings };
      });

      // ── Progress tracking ─────────────────────────────────────────
      const progress: TaskProgress[] = resolved.map((t, i) => ({
        index: i,
        agent: t.agentName,
        status: "pending" as const,
        durationMs: 0,
        tokens: 0,
      }));
      const fire = () => onUpdate?.({
        content: [{ type: "text", text: `Running ${resolved.length} subagent${resolved.length > 1 ? "s" : ""}…` }],
        details: { tasks: params.tasks, results: [], progress: [...progress] },
      });
      fire();

      // ── Run parallel ──────────────────────────────────────────────
      const results = await Promise.allSettled(resolved.map(async (t, i) => {
        const p = progress[i]!;
        p.status = "running"; fire();
        try {
          const r = await runAgent(
            { systemPrompt: t.systemPrompt, model: t.model, thinking: t.thinking, tools: t.tools, cwd: t.cwd },
            t.prompt,
            ctx.modelRegistry,
            signal,
          );
          p.status = r.error ? "failed" : "done";
          p.durationMs = r.durationMs;
          p.tokens = r.tokens;
          p.error = r.error;
          fire();
          return { agent: t.agentName, output: r.output, error: r.error, durationMs: r.durationMs, tokens: r.tokens };
        } catch (err) {
          p.status = "failed";
          p.error = err instanceof Error ? err.message : String(err);
          fire();
          throw err;
        }
      }));

      // ── Format for LLM ────────────────────────────────────────────
      const finalResults = results.map((r, i) =>
        r.status === "fulfilled" ? r.value : { agent: resolved[i]!.agentName, output: "", error: String(r.reason), durationMs: 0, tokens: 0 },
      );

      const parts: string[] = [];
      const succeeded = finalResults.filter((r) => !r.error).length;
      parts.push(`${succeeded}/${finalResults.length} tasks completed successfully\n`);
      for (let i = 0; i < finalResults.length; i++) {
        const r = finalResults[i]!;
        const t = resolved[i]!;
        parts.push(`=== ${r.agent}: ${trunc(t.prompt, 80)} ===`);
        if (t.warnings?.length) {
          for (const w of t.warnings) parts.push(`[WARNING: ${w}]`);
        }
        if (r.error) {
          parts.push(`[FAILED: ${r.error}]`);
        } else {
          parts.push(`[OK | ${fmtDuration(r.durationMs)} | ${fmtTokens(r.tokens)} tokens]\n\n${r.output}`);
        }
      }

      return {
        content: [{ type: "text", text: parts.join("\n\n") }],
        details: { tasks: params.tasks, results: finalResults, progress },
      };
    },

    renderCall(args, theme) {
      const tasks = (args as { tasks?: TaskDef[] }).tasks ?? [];
      if (!tasks.length) return new Text(theme.fg("toolTitle", theme.bold("delegate")), 0, 0);
      const lines = [theme.fg("toolTitle", theme.bold(`delegate ${tasks.length} task${tasks.length > 1 ? "s" : ""}`))];
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i]!;
        const tree = i === tasks.length - 1 ? "└─" : "├─";
        const label = t.agent ? theme.bold(t.agent) : "inline";
        lines.push(`${tree} ${label} ${theme.fg("muted", trunc(t.prompt, 60))}`);
      }
      return new Text(lines.join("\n"), 0, 0);
    },

    renderResult(result, options, theme) {
      const details = result.details as DelegateDetails | undefined;
      if (!details?.progress?.length) {
        const text = (result.content as Array<{ type: string; text: string }>)
          ?.filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n") ?? "";
        return new Text(text ? `\n${text}` : "", 0, 0);
      }

      const { progress, results: taskResults } = details;
      const total = progress.length;
      const lines: string[] = [""];

      if (options.isPartial) {
        const done = progress.filter((p) => p.status === "done" || p.status === "failed").length;
        lines.push(theme.fg("muted", `Running ${total} subagent${total > 1 ? "s" : ""}… (${done}/${total})`), "");
        for (let i = 0; i < total; i++) {
          const p = progress[i]!;
          const tree = i === total - 1 ? "└─" : "├─";
          const icon = p.status === "done" ? theme.fg("success", "✓") : p.status === "failed" ? theme.fg("error", "✗") : p.status === "running" ? theme.fg("warning", "●") : theme.fg("muted", "○");
          const stats = p.tokens > 0 ? theme.fg("muted", ` · ${fmtTokens(p.tokens)} tokens`) : "";
          lines.push(`${tree} ${icon} ${theme.bold(p.agent)}${stats}`);
        }
      } else {
        const succeeded = progress.filter((p) => p.status === "done").length;
        const totalTokens = progress.reduce((sum, p) => sum + p.tokens, 0);
        const totalMs = progress.reduce((sum, p) => sum + p.durationMs, 0);
        lines.push(theme.fg("muted", `${succeeded}/${total} completed · ${fmtDuration(totalMs)} · ${fmtTokens(totalTokens)} tokens`), "");

        for (let i = 0; i < total; i++) {
          const p = progress[i]!;
          const r = taskResults[i];
          const tree = i === total - 1 ? "└─" : "├─";
          const indent = i === total - 1 ? "   " : "│  ";
          const icon = p.status === "done" ? theme.fg("success", "✓") : theme.fg("error", "✗");
          const stats = theme.fg("muted", ` · ${fmtDuration(p.durationMs)} · ${fmtTokens(p.tokens)} tokens`);
          lines.push(`${tree} ${icon} ${theme.bold(p.agent)}${stats}`);

          if (r && "output" in r && r.output?.trim() && r.output !== "(no output)") {
            const outputLines = r.output.trim().split("\n");
            const maxLines = options.expanded ? outputLines.length : 3;
            for (const line of outputLines.slice(0, maxLines)) {
              lines.push(`${indent}${theme.fg("toolOutput", line)}`);
            }
            const remaining = outputLines.length - maxLines;
            if (remaining > 0) lines.push(`${indent}${theme.fg("muted", `… ${remaining} more lines`)}`);
          } else if (r && "error" in r && r.error) {
            lines.push(`${indent}${theme.fg("error", r.error)}`);
          }
        }
      }

      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
