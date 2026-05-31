/**
 * oracle — Deep reasoning from Qwen via qwen2api.
 *
 * A tool-only oracle: no tools, no agency, just raw thinking power.
 * Sends a question (with optional file attachments) to Qwen's deep-thinking
 * models and streams back reasoning + answer.
 *
 * Handles flaky/free-tier endpoints gracefully: if the connection drops
 * mid-stream, returns whatever reasoning was collected instead of throwing.
 *
 * Config (env vars):
 *   ORACLE_URL    — qwen2api base URL (default: auto — tries http://localhost:8765, falls back to https://qwen2api-n.smanx.xx.kg)
 *   ORACLE_TOKEN  — API bearer token (default: none, public endpoint needs none)
 *   ORACLE_MODEL  — model id (default: qwen3.7-max)
 *   ORACLE_TIMEOUT — request timeout in ms (default: 300000)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ── Config ────────────────────────────────────────────────────────────────

const PUBLIC_FALLBACK = "https://qwen2api-n.smanx.xx.kg";
const LOCAL_PROXY = "http://localhost:8765";

async function probeBaseUrl(): Promise<string> {
  if (process.env.ORACLE_URL) return process.env.ORACLE_URL.replace(/\/+$/, "");
  // Prefer local proxy if available; fall back to public serverless endpoint.
  try {
    const resp = await fetch(`${LOCAL_PROXY}/`, { method: "GET", signal: AbortSignal.timeout(1500) });
    if (resp.ok) return LOCAL_PROXY;
  } catch { /* not running */ }
  return PUBLIC_FALLBACK;
}

const BASE_URL = await probeBaseUrl();
const API_TOKEN = process.env.ORACLE_TOKEN ?? "";
const DEFAULT_MODEL = process.env.ORACLE_MODEL ?? "qwen3.7-max";
const REQUEST_TIMEOUT_MS = parseInt(process.env.ORACLE_TIMEOUT ?? "300000", 10);

/** Max individual attachment size: 10 MB */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Max total attachment payload: 20 MB */
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Max final response text returned to the LLM: 64 KB */
const MAX_RESPONSE_BYTES = 64 * 1024;

// ── Types ─────────────────────────────────────────────────────────────────

interface StreamDelta {
  content?: string;
  reasoning_content?: string;
}

interface StreamChunk {
  choices?: Array<{ delta?: StreamDelta; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface OracleDetails {
  model: string;
  reasoningChars: number;
  contentChars: number;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  attachedFiles: string[];
  wallMs: number;
  truncated: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function truncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text;
  let cut = text.slice(0, maxBytes);
  while (Buffer.byteLength(cut, "utf-8") > maxBytes) cut = cut.slice(0, -1);
  return cut + `\n\n[Output truncated at ${maxBytes / 1024}KB]`;
}

function shortenPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtK(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

// ── File Attachment ───────────────────────────────────────────────────────

function buildContentParts(
  question: string,
  files: string[],
  cwd: string,
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [{ type: "text", text: question }];
  let totalBytes = 0;

  for (const raw of files) {
    const resolved = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
    if (!fs.existsSync(resolved)) {
      parts.push({ type: "text", text: `[File not found: ${raw}]` });
      continue;
    }
    const stat = fs.statSync(resolved);
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      parts.push({ type: "text", text: `[File too large: ${raw} (${(stat.size / 1024 / 1024).toFixed(1)} MB)]` });
      continue;
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      parts.push({ type: "text", text: `[Remaining attachments skipped: total size limit exceeded]` });
      break;
    }

    const ext = path.extname(resolved).toLowerCase();
    const b64 = fs.readFileSync(resolved).toString("base64");

    // Text-ish files → inline as text. Binary → file attachment.
    const textExts = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".yaml", ".yml", ".md", ".txt", ".py", ".rs", ".go", ".zig", ".toml", ".css", ".html", ".sh", ".bash", ".zsh", ".env", ".ini", ".cfg", ".conf", ".sql", ".graphql", ".proto", ".tf", ".dockerfile"]);
    if (textExts.has(ext) || ext === "") {
      const content = fs.readFileSync(resolved, "utf-8");
      parts.push({ type: "text", text: `--- ${shortenPath(resolved)} ---\n${content}\n--- end ${shortenPath(resolved)} ---` });
    } else {
      const mime = ext === ".pdf" ? "application/pdf"
        : ext === ".png" ? "image/png"
        : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
        : ext === ".gif" ? "image/gif"
        : ext === ".webp" ? "image/webp"
        : "application/octet-stream";
      parts.push({ type: "file", file_data: `data:${mime};base64,${b64}`, filename: path.basename(resolved) });
    }
  }

  return parts;
}

// ── Streaming Fetch ───────────────────────────────────────────────────────

interface StreamResult {
  reasoning: string;
  content: string;
  usage?: OracleDetails["usage"];
  /** True if the stream was cut short (timeout, disconnect, etc.) */
  truncated: boolean;
}

async function streamOracle(
  messages: Array<Record<string, unknown>>,
  model: string,
  signal: AbortSignal | undefined,
  onChunk: (reasoning: string, content: string) => void,
): Promise<StreamResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (API_TOKEN) headers["Authorization"] = `Bearer ${API_TOKEN}`;

  // Create a per-request AbortController so we can set our own timeout
  // independent of the parent turn's signal.
  const timeoutCtrl = new AbortController();
  const timeoutId = setTimeout(() => timeoutCtrl.abort(), REQUEST_TIMEOUT_MS);

  // Also abort if the parent signal fires.
  const onParentAbort = () => timeoutCtrl.abort();
  signal?.addEventListener("abort", onParentAbort, { once: true });

  let reasoning = "";
  let content = "";
  let usage: OracleDetails["usage"] | undefined;
  let truncated = false;

  try {
    const body = JSON.stringify({ model, messages, stream: true });

    const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers,
      body,
      signal: timeoutCtrl.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Oracle API error ${response.status}: ${text.slice(0, 500)}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);
          if (payload === "[DONE]") continue;

          let chunk: StreamChunk;
          try { chunk = JSON.parse(payload); } catch { continue; }

          if (chunk.usage) {
            usage = {
              prompt_tokens: chunk.usage.prompt_tokens ?? 0,
              completion_tokens: chunk.usage.completion_tokens ?? 0,
              total_tokens: chunk.usage.total_tokens ?? 0,
            };
          }

          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.reasoning_content) reasoning += delta.reasoning_content;
          if (delta.content) content += delta.content;

          if (delta.reasoning_content || delta.content) onChunk(reasoning, content);
        }
      }
    } catch (readErr) {
      // Stream cut short — return whatever we collected.
      truncated = true;
      // If we got nothing at all, this is a real failure — rethrow.
      if (!reasoning && !content) throw readErr;
    }
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onParentAbort);
  }

  return { reasoning, content, usage, truncated };
}

// ── Spinner ───────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ── Extension ─────────────────────────────────────────────────────────────

export default function oracleExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "oracle",
    label: "Oracle",
    description: [
      "Consult a deep-thinking oracle (Qwen) for analysis, reasoning, or second opinions.",
      "The oracle is a bare reasoning engine — it has no tools, no search, no access to documentation or external information, and no knowledge of your project.",
      "It only knows what you explicitly give it. Attach files for context.",
      "Use for: architecture decisions, debugging hypotheses, code review, security analysis, algorithmic puzzles, anything requiring deep thought.",
      "Always attach relevant source files so the oracle can reason over the actual code, not just a description of it.",
    ].join(" "),
    promptSnippet: "Ask the oracle for deep analysis or a second opinion",
    promptGuidelines: [
      "Use oracle when you need deep reasoning from a different model — architecture decisions, security analysis, complex debugging, algorithmic questions, second opinions.",
      "Attach relevant files so the oracle has full context.",
      "The oracle has no tools and cannot execute code — it only reasons about what you give it.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "The question or problem to analyze" }),
      files: Type.Optional(
        Type.Array(Type.String(), {
          description: "File paths to attach for the oracle to reason over (relative to cwd or absolute). Text files are inlined, binary files sent as base64.",
        }),
      ),
      model: Type.Optional(Type.String({
        description: `Qwen model id. Default: ${DEFAULT_MODEL}. Options: qwen3.7-max, qwen3.6-plus, qwen3.6-max-preview, qwen3.5-turbo.`,
        default: DEFAULT_MODEL,
      })),
    }),

    async execute(_id, params, signal, onUpdate, ctx) {
      const model = params.model || DEFAULT_MODEL;
      const files = params.files ?? [];
      const start = Date.now();

      // Build messages with file attachments
      const contentParts = buildContentParts(params.question, files, ctx.cwd);
      const messages = [
        {
          role: "system",
          content: [
            "You are a reasoning engine. You have no tools, no search, no internet access, and no knowledge of any specific project, framework, or codebase.",
            "Only reason about what is explicitly provided in the user message. Never fabricate APIs, function names, documentation references, or external sources.",
            "If you don't have enough information, say so instead of guessing.",
          ].join(" "),
        },
        { role: "user", content: contentParts },
      ];

      const attachedNames = files.map((f) => shortenPath(path.isAbsolute(f) ? f : path.resolve(ctx.cwd, f)));

      // Track streaming state for progress updates
      let lastReasoningLen = 0;
      let lastContentLen = 0;

      try {
        const result = await streamOracle(messages, model, signal, (reasoning, content) => {
          const newReasoning = reasoning.length - lastReasoningLen;
          const newContent = content.length - lastContentLen;
          if (newReasoning > 200 || newContent > 200) {
            lastReasoningLen = reasoning.length;
            lastContentLen = content.length;
            const phase = reasoning.length > 0 && content.length === 0 ? "thinking" : "responding";
            onUpdate?.({
              content: [{ type: "text", text: `Oracle is ${phase}… (${fmtMs(Date.now() - start)} elapsed)` }],
              details: {
                model,
                reasoningChars: reasoning.length,
                contentChars: content.length,
                attachedFiles: attachedNames,
                wallMs: Date.now() - start,
                truncated: false,
              } satisfies OracleDetails,
            });
          }
        });

        const wallMs = Date.now() - start;
        const details: OracleDetails = {
          model,
          reasoningChars: result.reasoning.length,
          contentChars: result.content.length,
          usage: result.usage,
          attachedFiles: attachedNames,
          wallMs,
          truncated: result.truncated,
        };

        // Format response for the LLM
        const parts: string[] = [];

        if (result.reasoning.trim()) {
          parts.push(`<oracle-reasoning>\n${truncate(result.reasoning.trim(), 30 * 1024)}\n</oracle-reasoning>`);
        }
        if (result.content.trim()) {
          parts.push(truncate(result.content.trim(), MAX_RESPONSE_BYTES));
        }

        if (parts.length === 0) {
          parts.push("(Oracle returned no output — the endpoint may have timed out before generating a response. Try a shorter question or a different model.)");
        }

        // Truncation notice goes AFTER content so the LLM can parse reasoning/answer cleanly.
        if (result.truncated) {
          parts.push(`[Note: Oracle response was cut short after ${fmtMs(wallMs)} due to endpoint timeout. The reasoning above is partial.]`);
        }

        return {
          content: [{ type: "text" as const, text: parts.join("\n\n") }],
          details,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("aborted") || signal?.aborted) {
          return {
            content: [{ type: "text" as const, text: "Oracle query aborted." }],
            details: { model, reasoningChars: 0, contentChars: 0, attachedFiles: attachedNames, wallMs: Date.now() - start, truncated: false },
          };
        }
        return {
          content: [{ type: "text" as const, text: `Oracle error: ${msg}` }],
          details: { model, reasoningChars: 0, contentChars: 0, attachedFiles: attachedNames, wallMs: Date.now() - start, truncated: false },
          isError: true,
        };
      }
    },

    renderCall(args, theme, ctx) {
      const text = (ctx.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const model = (args as { model?: string }).model || DEFAULT_MODEL;
      const files = (args as { files?: string[] }).files ?? [];
      const question = (args as { question?: string }).question || "";
      const preview = question.length > 60 ? `${question.slice(0, 60)}…` : question;

      let label = theme.fg("toolTitle", theme.bold("oracle ")) + theme.fg("accent", model);
      if (files.length > 0) label += theme.fg("muted", ` +${files.length} file${files.length > 1 ? "s" : ""}`);
      label += `\n  ${theme.fg("dim", preview)}`;
      text.setText(label);
      return text;
    },

    renderResult(result, options, theme, ctx) {
      const state = ctx.state as { startedAt?: number; interval?: ReturnType<typeof setInterval>; spinnerIdx?: number };
      const tickMs = 120;
      if (options.isPartial && !state.interval) {
        state.startedAt = state.startedAt ?? Date.now();
        state.spinnerIdx = state.spinnerIdx ?? 0;
        state.interval = setInterval(() => ctx.invalidate(), tickMs);
      }
      if (!options.isPartial && state.interval) {
        clearInterval(state.interval);
        state.interval = undefined;
      }

      const text = (ctx.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const details = result.details as OracleDetails | undefined;

      if (options.isPartial && details) {
        state.spinnerIdx = (state.spinnerIdx ?? 0) + 1;
        const elapsed = fmtMs(Date.now() - (state.startedAt ?? Date.now()));
        const phase = details.contentChars === 0 && details.reasoningChars > 0
          ? theme.fg("warning", "thinking")
          : theme.fg("success", "responding");
        const glyph = theme.fg("warning", SPINNER_FRAMES[state.spinnerIdx % SPINNER_FRAMES.length]!);
        let label = `${glyph} ${theme.fg("toolTitle", theme.bold("oracle "))}${theme.fg("accent", details.model)} · ${phase}${theme.fg("muted", ` · ${elapsed}`)}`;
        if (details.attachedFiles.length) {
          label += theme.fg("muted", ` · ${details.attachedFiles.length} file${details.attachedFiles.length > 1 ? "s" : ""}`);
        }
        if (details.reasoningChars > 0) {
          label += theme.fg("muted", ` · ${fmtK(details.reasoningChars)} chars reasoning`);
        }
        text.setText(label);
        return text;
      }

      // Final result
      const lines: string[] = [""];
      if (details) {
        const isError = result.content?.[0]?.type === "text" && result.content[0].text.startsWith("Oracle error:");
        const icon = isError ? theme.fg("error", "✗") : details.truncated ? theme.fg("warning", "⚠") : theme.fg("success", "✓");
        const meta: string[] = [fmtMs(details.wallMs)];
        if (details.usage) meta.push(`${fmtK(details.usage.total_tokens)} tokens`);
        if (details.reasoningChars > 0) meta.push(`${fmtK(details.reasoningChars)} chars thought`);
        if (details.attachedFiles.length) meta.push(`${details.attachedFiles.length} file${details.attachedFiles.length > 1 ? "s" : ""}`);
        if (details.truncated) meta.push("cut short");

        let header = `${icon} ${theme.fg("toolTitle", theme.bold("oracle "))}${theme.fg("accent", details.model)}`;
        header += theme.fg("muted", ` · ${meta.join(" · ")}`);
        lines.push(header);

        if (details.attachedFiles.length > 0 && options.expanded) {
          lines.push(theme.fg("muted", `  attached: ${details.attachedFiles.join(", ")}`));
        }
        lines.push("");
      }

      // Render content
      const content = result.content?.[0];
      if (content?.type === "text" && content.text) {
        // Split reasoning from answer for nicer rendering
        const reasoningMatch = content.text.match(/^<oracle-reasoning>\n([\s\S]*?)\n<\/oracle-reasoning>(?:\n\n([\s\S]*))?$/);

        if (reasoningMatch) {
          const [, reasoning, answer] = reasoningMatch;
          if (reasoning && options.expanded) {
            lines.push(theme.fg("muted", "─── Reasoning ───"));
            const rLines = reasoning!.split("\n");
            const shown = rLines.length > 30 ? [...rLines.slice(0, 15), theme.fg("muted", `  ... ${rLines.length - 30} lines omitted ...`), ...rLines.slice(-15)] : rLines;
            for (const l of shown!) lines.push(`  ${theme.fg("dim", l)}`);
            lines.push("");
          }
          if (answer?.trim()) {
            lines.push(theme.fg("muted", "─── Answer ───"));
            const aLines = answer.trim().split("\n");
            const limit = options.expanded ? aLines.length : Math.min(aLines.length, 20);
            for (const l of aLines.slice(0, limit)) lines.push(`  ${l}`);
            if (!options.expanded && aLines.length > 20) {
              lines.push(theme.fg("muted", `  ... ${aLines.length - 20} more lines (Ctrl+O to expand)`));
            }
          }
        } else {
          // No reasoning block — just render the text
          const tLines = content.text.split("\n");
          const limit = options.expanded ? tLines.length : Math.min(tLines.length, 20);
          for (const l of tLines.slice(0, limit)) lines.push(`  ${l}`);
          if (!options.expanded && tLines.length > 20) {
            lines.push(theme.fg("muted", `  ... ${tLines.length - 20} more lines (Ctrl+O to expand)`));
          }
        }
      }

      text.setText(lines.join("\n"));
      return text;
    },
  });
}
