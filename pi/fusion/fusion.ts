/**
 * fusion — Run multiple models side-by-side, analyze their responses,
 * and fuse into the best result.
 *
 * Command: /fusion [prompt]
 *   Opens a model picker (multi-select overlay), then a fuse-model selector.
 *   Runs all selected models in parallel with the full session context,
 *   then passes their responses to a fusion model for analysis + synthesis.
 */

import { Agent, type AgentEvent, type AgentMessage, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import { type Api, type Model, streamSimple } from "@mariozechner/pi-ai";
import {
  buildSessionContext,
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  getMarkdownTheme,
  keyHint,
  type ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, matchesKey, Spacer, Text, truncateToWidth } from "@mariozechner/pi-tui";

// ── Types ────────────────────────────────────────────────────────────────

interface SourceResult {
  model: Model<Api>;
  output: string;
  error?: string;
  durationMs: number;
  tokens: number;
}

interface FusionDetails {
  prompt: string;
  sources: SourceResult[];
  analysis: string;
  fused: string;
  fuseModel: string;
  totalDurationMs: number;
  totalTokens: number;
}

interface ModelSelectionResult {
  models: Model<Api>[];
  cancelled: boolean;
}

interface SourceProgress {
  key: string;
  status: "pending" | "running" | "done" | "error";
  output: string;
  error?: string;
  durationMs: number;
  tokens: number;
}

// ── Progress Overlay ──────────────────────────────────────────────────────

function showFusionProgress(
  models: Model<Api>[],
  abortController: AbortController,
  ctx: ExtensionContext,
): {
  promise: Promise<void>;
  state: Map<string, SourceProgress>;
  requestRender: () => void;
  close: () => void;
} {
  const state = new Map<string, SourceProgress>();
  for (const m of models) {
    const key = `${m.provider}/${m.id}`;
    state.set(key, { key, status: "pending", output: "", durationMs: 0, tokens: 0 });
  }

  let tuiRef: { requestRender(): void } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closeOverlay: (() => void) | undefined;

  const promise = ctx.ui.custom<void>((tui, theme, _kb, done) => {
    tuiRef = tui;
    closeOverlay = () => done();
    let frame = 0;
    const spinnerFrames = ["◜", "◝", "◞", "◟"];

    // Keep spinner animate even without input
    timer = setInterval(() => tui.requestRender(), 120);

    return {
      render(width: number): string[] {
        frame++;
        const entries = [...state.values()];
        const doneCount = entries.filter((e) => e.status === "done" || e.status === "error").length;
        const spinner = spinnerFrames[frame % spinnerFrames.length]!;

        const lines: string[] = [];
        lines.push(theme.fg("accent", theme.bold(` Fusion  ${doneCount}/${entries.length} sources `)));
        lines.push("");

        for (const entry of entries) {
          let icon: string;
          if (entry.status === "done") icon = theme.fg("success", "●");
          else if (entry.status === "error") icon = theme.fg("error", "✗");
          else if (entry.status === "running") icon = theme.fg("accent", spinner);
          else icon = theme.fg("dim", "○");

          const status = entry.error
            ? theme.fg("error", `failed · ${entry.error}`)
            : entry.status === "done"
              ? theme.fg("success", fmtDuration(entry.durationMs))
              : entry.status === "running"
                ? theme.fg("accent", "streaming…")
                : theme.fg("dim", "waiting…");

          lines.push(`${icon} ${theme.bold(entry.key)}  ${status}`);

          // Show last 2 lines of streaming output
          if (entry.output && (entry.status === "running" || entry.status === "done")) {
            const outLines = entry.output.split("\n");
            const preview = outLines.slice(-2);
            for (const pl of preview) {
              if (pl.trim()) {
                const trimmed = truncateToWidth(pl.trim(), width - 6);
                lines.push(theme.fg("dim", `  │ ${trimmed}`));
              }
            }
          } else if (entry.status === "error" && entry.error) {
            const trimmed = truncateToWidth(entry.error, width - 6);
            lines.push(theme.fg("error", `  │ ${trimmed}`));
          }
        }

        lines.push("");
        if (doneCount >= entries.length) {
          lines.push(theme.fg("muted", "All sources complete · closing…"));
        } else {
          lines.push(theme.fg("dim", "Esc to abort · models streaming in parallel"));
        }
        return lines.map((l) => truncateToWidth(l, width));
      },

      handleInput(data: string) {
        if (matchesKey(data, "escape")) {
          abortController.abort();
          done();
        }
      },

      invalidate() {
        if (timer) { clearInterval(timer); timer = undefined; }
      },
    };
  }, {
    overlay: true,
    overlayOptions: { anchor: "center", width: "75%", minWidth: 60, maxHeight: "80%" },
  });

  // Clean up timer when promise settles
  promise.finally(() => { if (timer) { clearInterval(timer); timer = undefined; } });

  return {
    promise,
    state,
    requestRender: () => tuiRef?.requestRender(),
    close: () => { if (timer) { clearInterval(timer); timer = undefined; } closeOverlay?.(); },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function resolveModel(
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

function extractOutput(messages: AgentMessage[], fromIndex = 0): string {
  const parts: string[] = [];
  for (let i = fromIndex; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string") {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && block.text) parts.push(block.text);
      }
    }
  }
  return parts.join("\n\n");
}

interface UsageSnapshot {
  input?: number;
  output?: number;
  cacheRead?: number;
  total?: number;
}

function extractUsage(messages: AgentMessage[]) {
  const usage = { input: 0, output: 0, cacheRead: 0, total: 0 };
  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.usage) continue;
    const u = msg.usage as UsageSnapshot | undefined;
    if (!u) continue;
    usage.input += u.input ?? 0;
    usage.output += u.output ?? 0;
    usage.cacheRead += u.cacheRead ?? 0;
    usage.total += u.total ?? (u.input ?? 0) + (u.output ?? 0);
  }
  return usage;
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

// ── Model Selection UI ───────────────────────────────────────────────────

async function showModelPicker(
  available: Model<Api>[],
  preselected: Set<string>,
  ctx: ExtensionContext,
): Promise<ModelSelectionResult> {
  if (!ctx.hasUI || available.length === 0) {
    return { models: [], cancelled: true };
  }

  return ctx.ui.custom<ModelSelectionResult>(
    (tui, theme, _kb, done) => {
      let selectedIndex = 0;
      const checked = new Set<number>();

      for (let i = 0; i < available.length; i++) {
        const key = `${available[i]!.provider}/${available[i]!.id}`;
        if (preselected.has(key)) checked.add(i);
      }
      if (checked.size === 0 && available.length > 0) checked.add(0);

      return {
        render(width: number): string[] {
          const lines: string[] = [];
          lines.push(theme.fg("accent", theme.bold(" Model Fusion ")));
          lines.push(theme.fg("muted", ` Select 2+ models (${checked.size} selected) `));
          lines.push("");

          const maxVisible = Math.min(available.length, 20);
          const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), available.length - maxVisible));
          const end = Math.min(available.length, start + maxVisible);

          for (let i = start; i < end; i++) {
            const model = available[i]!;
            const isCursor = i === selectedIndex;
            const isChecked = checked.has(i);
            const prefix = isChecked ? theme.fg("success", "[x]") : "[ ]";
            const label = `${model.provider}/${model.id}`;
            const cursor = isCursor ? theme.fg("accent", "> ") : "  ";
            const color = isCursor ? "accent" : "text";
            lines.push(`${cursor}${theme.fg(color, `${prefix} ${label}`)}`);
          }

          if (available.length > maxVisible) {
            lines.push(theme.fg("dim", `  … ${available.length - maxVisible} more`));
          }

          lines.push("");
          lines.push(theme.fg("dim", "↑↓ navigate • Space toggle • Enter confirm • Esc cancel"));
          return lines.map((l) => truncateToWidth(l, width));
        },

        handleInput(data: string) {
          if (matchesKey(data, "up")) {
            selectedIndex = Math.max(0, selectedIndex - 1);
            tui.requestRender();
          } else if (matchesKey(data, "down")) {
            selectedIndex = Math.min(available.length - 1, selectedIndex + 1);
            tui.requestRender();
          } else if (matchesKey(data, "space")) {
            if (checked.has(selectedIndex)) {
              if (checked.size > 1) checked.delete(selectedIndex);
            } else {
              checked.add(selectedIndex);
            }
            tui.requestRender();
          } else if (matchesKey(data, "enter")) {
            if (checked.size >= 2) {
              done({
                models: Array.from(checked).map((i) => available[i]!),
                cancelled: false,
              });
            }
          } else if (matchesKey(data, "escape")) {
            done({ models: [], cancelled: true });
          }
        },

        invalidate() {},
      };
    },
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "60%", minWidth: 50, maxHeight: "70%" },
    },
  );
}

// ── Source Runner ────────────────────────────────────────────────────────

async function runSource(
  model: Model<Api>,
  systemPrompt: string,
  messages: AgentMessage[],
  prompt: string,
  thinking: ThinkingLevel,
  modelRegistry: ModelRegistry,
  signal?: AbortSignal,
  onOutput?: (text: string) => void,
): Promise<SourceResult> {
  const start = Date.now();
  const initialCount = messages.length;
  const modelKey = `${model.provider}/${model.id}`;

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: thinking,
      messages: [...messages],
    },
    convertToLlm,
    streamFn: async (m, context, options) => {
      const auth = await modelRegistry.getApiKeyAndHeaders(m);
      if (!auth.ok) throw new Error(`Auth failed: ${(auth as { error: string }).error}`);
      return streamSimple(m, context, { ...options, apiKey: auth.apiKey, headers: auth.headers ?? undefined });
    },
  });

  // Subscribe to streaming updates for live progress
  let unsubscribe: (() => void) | undefined;
  if (onOutput) {
    unsubscribe = agent.subscribe((event: AgentEvent) => {
      if (event.type === "message_update" && event.message.role === "assistant") {
        const parts: string[] = [];
        const content = event.message.content;
        if (typeof content === "string") {
          parts.push(content);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) parts.push(block.text);
          }
        }
        onOutput(parts.join("\n"));
      }
    });
  }

  if (signal?.aborted) {
    return { model, output: "", error: "Aborted", durationMs: 0, tokens: 0 };
  }

  let abortHandler: (() => void) | undefined;
  if (signal) {
    abortHandler = () => {
      try {
        agent.abort();
      } catch {
        /* ignore */
      }
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    await agent.prompt(prompt);
    await agent.waitForIdle();

    const state = agent.state;
    const output = extractOutput(state.messages, initialCount);
    const tokens = extractUsage(state.messages).total;

    return {
      model,
      output: output || "",
      error: output ? undefined : "(no output produced)",
      durationMs: Date.now() - start,
      tokens,
    };
  } catch (err) {
    return {
      model,
      output: "",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
      tokens: 0,
    };
  } finally {
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
    if (unsubscribe) unsubscribe();
  }
}

// ── Fusion Runner ────────────────────────────────────────────────────────

async function runFusion(
  prompt: string,
  sources: SourceResult[],
  fuseModel: Model<Api>,
  modelRegistry: ModelRegistry,
  signal?: AbortSignal,
): Promise<{ analysis: string; fused: string; durationMs: number; tokens: number }> {
  const start = Date.now();

  const okSources = sources.filter((s) => !s.error);
  const failedSources = sources.filter((s) => s.error);

  const sourceSection = okSources
    .map((s, i) => `### Response ${i + 1} (${s.model.provider}/${s.model.id})\n\n${s.output}`)
    .join("\n\n");

  const failedSection = failedSources.length
    ? failedSources.map((s) => `- ${s.model.provider}/${s.model.id}: ${s.error}`).join("\n")
    : "";

  const delim = `===FUSION_${Math.random().toString(36).slice(2, 10)}===`;

  const fusionPrompt = [
    "# Fusion Task",
    "",
    "## Original Prompt",
    prompt,
    "",
    "## Source Responses",
    sourceSection,
    "",
    failedSection ? `## Failed Sources\n${failedSection}\n` : "",
    "## Instructions",
    "Analyze the source responses and produce two sections:",
    "1. **Analysis** — Brief analysis of agreement, key differences, unique insights, and blind spots.",
    "2. **Fused Answer** — The best possible synthesized answer, combining the strongest elements of all responses.",
    "",
    "Use this exact format (do not reproduce these markers inside your content):",
    "",
    `${delim}ANALYSIS`,
    "[Your analysis here]",
    "",
    `${delim}FUSED`,
    "[Your final fused answer here]",
  ].join("\n");

  const agent = new Agent({
    initialState: {
      systemPrompt:
        "You are a fusion engine that synthesizes multiple AI responses into the best possible answer. Be objective and thorough.",
      model: fuseModel,
      thinkingLevel: "off",
    },
    convertToLlm,
    streamFn: async (m, context, options) => {
      const auth = await modelRegistry.getApiKeyAndHeaders(m);
      if (!auth.ok) throw new Error(`Auth failed: ${(auth as { error: string }).error}`);
      return streamSimple(m, context, { ...options, apiKey: auth.apiKey, headers: auth.headers ?? undefined });
    },
  });

  if (signal?.aborted) {
    return { analysis: "", fused: "Aborted", durationMs: 0, tokens: 0 };
  }

  let abortHandler: (() => void) | undefined;
  if (signal) {
    abortHandler = () => {
      try {
        agent.abort();
      } catch {
        /* ignore */
      }
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    await agent.prompt(fusionPrompt);
    await agent.waitForIdle();

    const state = agent.state;
    const output = extractOutput(state.messages, 0);
    const tokens = extractUsage(state.messages).total;

    const analysisRe = new RegExp(`${delim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}ANALYSIS\\s*([\\s\\S]*?)(?=${delim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}FUSED|$)`);
    const fusedRe = new RegExp(`${delim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}FUSED\\s*([\\s\\S]*)`);
    const analysisMatch = output.match(analysisRe);
    const fusedMatch = output.match(fusedRe);

    return {
      analysis: analysisMatch?.[1]?.trim() || "",
      fused: fusedMatch?.[1]?.trim() || output.trim(),
      durationMs: Date.now() - start,
      tokens,
    };
  } catch (err) {
    return {
      analysis: "",
      fused: `Fusion failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
      tokens: 0,
    };
  } finally {
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}

// ── Extension ─────────────────────────────────────────────────────────────

export default function fusionExtension(pi: ExtensionAPI): void {
  // ── /fusion command ────────────────────────────────────────────

  pi.registerCommand("fusion", {
    description: "Run multiple models in parallel and fuse their responses",
    handler: async (args, ctx) => {
      let prompt = args?.trim();
      if (!prompt) {
        prompt = await ctx.ui.input("Fusion prompt:", "Ask anything...");
        if (!prompt) return;
      }

      const available = ctx.modelRegistry.getAvailable();
      if (available.length < 2) {
        if (ctx.hasUI) ctx.ui.notify("Need at least 2 available models", "error");
        return;
      }

      // Restore last selection from session
      const lastSelected = new Set<string>();
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "custom" && entry.customType === "fusion-state") {
          const data = entry.data as { selectedModels?: string[] } | undefined;
          if (data?.selectedModels) {
            for (const m of data.selectedModels) lastSelected.add(m);
          }
        }
      }
      if (ctx.model) {
        lastSelected.add(`${ctx.model.provider}/${ctx.model.id}`);
      }

      // Select source models
      const selection = await showModelPicker(available, lastSelected, ctx);
      if (selection.cancelled || selection.models.length < 2) {
        if (ctx.hasUI) ctx.ui.notify("Fusion cancelled", "warning");
        return;
      }

      // Persist selection
      pi.appendEntry("fusion-state", {
        selectedModels: selection.models.map((m) => `${m.provider}/${m.id}`),
      });

      // Select fuse model (put current model first so it's pre-selected)
      const fuseOptions = available.map((m) => `${m.provider}/${m.id}`);
      const currentSpec = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : fuseOptions[0]!;
      const orderedOptions = [currentSpec, ...fuseOptions.filter((s) => s !== currentSpec)];
      const fuseSpec = ctx.hasUI
        ? await ctx.ui.select("Fuse with:", orderedOptions)
        : currentSpec;
      if (!fuseSpec) {
        if (ctx.hasUI) ctx.ui.notify("Fusion cancelled", "warning");
        return;
      }
      const fuseModel = resolveModel(fuseSpec, ctx.modelRegistry, ctx.model) ?? selection.models[0]!;

      // Build session context
      const sessionCtx = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
      const parentMessages = sessionCtx.messages;
      const systemPrompt = ctx.getSystemPrompt() ?? "You are a helpful assistant.";
      const VALID_THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
      const thinkingRaw = sessionCtx.thinkingLevel ?? "off";
      const thinking: ThinkingLevel = VALID_THINKING.has(thinkingRaw) ? (thinkingRaw as ThinkingLevel) : "off";

      // Composite abort signal: ctx.signal (if active) + our own controller
      const abortController = new AbortController();
      const onCtxAbort = () => abortController.abort();
      if (ctx.signal) ctx.signal.addEventListener("abort", onCtxAbort, { once: true });
      const signal = abortController.signal;

      // ── Show progress overlay while sources run ───────────────
      let progress: { state: Map<string, SourceProgress>; requestRender: () => void; close: () => void } | undefined;
      let progressPromise: Promise<void> | undefined;

      if (ctx.hasUI) {
        const overlay = showFusionProgress(selection.models, abortController, ctx);
        progress = { state: overlay.state, requestRender: overlay.requestRender, close: overlay.close };
        progressPromise = overlay.promise;
      }

      let sourceResults: SourceResult[] = [];
      let fusionResult: { analysis: string; fused: string; durationMs: number; tokens: number } | undefined;

      try {
        // Run sources in parallel
        let completed = 0;
        sourceResults = await Promise.all(
          selection.models.map(async (model) => {
            const key = `${model.provider}/${model.id}`;
            const prog = progress?.state.get(key);
            if (prog) prog.status = "running";

            const onOutput = (text: string) => {
              if (prog) { prog.output = text; }
              progress?.requestRender();
            };

            const result = await runSource(
              model, systemPrompt, parentMessages, prompt, thinking, ctx.modelRegistry, signal,
              onOutput,
            );

            completed++;
            if (prog) {
              prog.status = result.error ? "error" : "done";
              prog.output = result.output;
              prog.error = result.error;
              prog.durationMs = result.durationMs;
              prog.tokens = result.tokens;
            }
            progress?.requestRender();
            return result;
          }),
        );

        if (signal.aborted) {
          if (ctx.hasUI) ctx.ui.notify("Fusion aborted", "warning");
          return;
        }

        // Close progress overlay
        if (progress) {
          progress.close();
          await progressPromise;
        }
        if (ctx.hasUI) ctx.ui.setStatus("fusion", "Fusion: analyzing…");

        // Run fusion
        fusionResult = await runFusion(prompt, sourceResults, fuseModel, ctx.modelRegistry, signal);

        const totalSourceDuration = sourceResults.reduce((s, r) => s + r.durationMs, 0);
        const totalSourceTokens = sourceResults.reduce((s, r) => s + r.tokens, 0);
        const totalDuration = totalSourceDuration + fusionResult.durationMs;
        const totalTokens = totalSourceTokens + fusionResult.tokens;

        // Content = what the LLM sees on next turn. Keep it tight: just the fused answer.
        // Details = what the renderer shows (analysis, sources, full stats).
        const content = fusionResult.fused;

        const details: FusionDetails = {
          prompt,
          sources: sourceResults,
          analysis: fusionResult.analysis,
          fused: fusionResult.fused,
          fuseModel: `${fuseModel.provider}/${fuseModel.id}`,
          totalDurationMs: totalDuration,
          totalTokens,
        };

        // Persist latest result for /fusion-continue
        pi.appendEntry("fusion-result", { details });

        pi.sendMessage(
          {
            customType: "fusion",
            content,
            display: true,
            details,
          },
          { triggerTurn: false },
        );

        if (ctx.hasUI) {
          ctx.ui.notify(
            `Fusion complete — ${selection.models.length} sources · ${fmtTokens(totalTokens)} tokens`,
            "info",
          );
        }
      } finally {
        if (ctx.signal) ctx.signal.removeEventListener("abort", onCtxAbort);
        if (ctx.hasUI) ctx.ui.setStatus("fusion", undefined);
      }
    },
  });

  // ── /fusion-continue command ───────────────────────────────────

  pi.registerCommand("fusion-continue", {
    description: "Inject the last fusion result into the conversation context",
    handler: async (_args, ctx) => {
      let lastDetails: FusionDetails | undefined;
      const entries = ctx.sessionManager.getEntries();
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]!;
        if (entry.type === "custom" && entry.customType === "fusion-result") {
          const data = entry.data as { details?: FusionDetails } | undefined;
          if (data?.details) {
            lastDetails = data.details;
            break;
          }
        }
      }

      if (!lastDetails) {
        if (ctx.hasUI) ctx.ui.notify("No fusion result found in this session", "warning");
        return;
      }

      const synopsis = [
        `[Fusion result from ${lastDetails.sources.length} models fused by ${lastDetails.fuseModel}]`,
        "",
        lastDetails.fused,
      ].join("\n");

      pi.sendUserMessage(synopsis);

      if (ctx.hasUI) {
        ctx.ui.notify("Fusion result injected into conversation context", "info");
      }
    },
  });

  // ── Message Renderer ───────────────────────────────────────────

  pi.registerMessageRenderer("fusion", (message, options, theme) => {
    const details = message.details as FusionDetails | undefined;
    if (!details) {
      const text = typeof message.content === "string" ? message.content : "";
      return new Text(text, 0, 0);
    }

    const mdTheme = getMarkdownTheme();
    const container = new Container();
    const okCount = details.sources.filter((s) => !s.error).length;

    // ── Header ──────────────────────────────────────────────────
    container.addChild(new Text(theme.fg("accent", theme.bold("🔥 Model Fusion")), 0, 0));
    container.addChild(
      new Text(
        theme.fg(
          "muted",
          `${okCount}/${details.sources.length} sources · ${details.fuseModel} · ${fmtTokens(details.totalTokens)} tok · ${fmtDuration(details.totalDurationMs)}`,
        ),
        0,
        0,
      ),
    );
    container.addChild(new Spacer(1));

    if (options.expanded) {
      // ── Analysis ─────────────────────────────────────────────
      if (details.analysis) {
        container.addChild(new Text(theme.fg("accent", theme.bold("▸ Analysis")), 0, 0));
        container.addChild(new Markdown(details.analysis, 1, 0, mdTheme));
        container.addChild(new Spacer(1));
      }

      // ── Fused Answer ─────────────────────────────────────────
      container.addChild(new Text(theme.fg("accent", theme.bold("▸ Fused Answer")), 0, 0));
      container.addChild(new Markdown(details.fused, 1, 0, mdTheme));
      container.addChild(new Spacer(1));

      // ── Sources ──────────────────────────────────────────────
      container.addChild(new Text(theme.fg("accent", theme.bold("▸ Sources")), 0, 0));
      for (const src of details.sources) {
        const icon = src.error ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const status = src.error
          ? theme.fg("error", `failed · ${src.error}`)
          : theme.fg("muted", `${fmtDuration(src.durationMs)} · ${fmtTokens(src.tokens)} tok`);
        container.addChild(
          new Text(
            `${icon} ${theme.bold(`${src.model.provider}/${src.model.id}`)}  ${status}`,
            0,
            0,
          ),
        );
        if (!src.error && src.output && src.output !== "(no output)") {
          const lines = src.output.split("\n");
          const capped = lines.slice(0, 80).join("\n");
          container.addChild(new Markdown(capped, 1, 0, mdTheme));
          if (lines.length > 80) {
            container.addChild(new Text(theme.fg("muted", `  … ${lines.length - 80} more lines`), 1, 0));
          }
        } else if (!src.error) {
          container.addChild(new Text(theme.fg("warning", "  (no output)"), 1, 0));
        }
        container.addChild(new Spacer(1));
      }

      // ── Continue hint ────────────────────────────────────────
      let continueHint: string;
      try {
        continueHint = keyHint("app.tools.expand", "to collapse");
      } catch {
        continueHint = "Ctrl+O to collapse";
      }
      container.addChild(new Text(theme.fg("dim", `(${continueHint} · /fusion-continue to discuss)`), 0, 0));
    } else {
      // ── Collapsed: compact fused preview ─────────────────────
      const fusedLines = details.fused.split("\n");
      const preview = fusedLines.slice(0, 4).join("\n");
      container.addChild(new Markdown(preview, 1, 0, mdTheme));
      if (fusedLines.length > 4) {
        container.addChild(new Text(theme.fg("muted", `… ${fusedLines.length - 4} more lines`), 1, 0));
      }
      container.addChild(new Spacer(1));

      let expandHint: string;
      try {
        expandHint = keyHint("app.tools.expand", "to expand");
      } catch {
        expandHint = "Ctrl+O to expand";
      }
      container.addChild(
        new Text(
          theme.fg("dim", `(${expandHint} · /fusion-continue to discuss result)`),
          0,
          0,
        ),
      );
    }

    return container;
  });
}
