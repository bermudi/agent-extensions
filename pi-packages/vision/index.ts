/**
 * vision — query-driven image Q&A through any vision model in pi's catalogue.
 *
 * A separate `vision` tool (pi's built-in read is untouched): the agent asks a
 * SPECIFIC question about an image file, the configured vision model answers
 * it, and the answer comes back as text. Same interaction model as
 * gemini-media-mcp's analyze_image — targeted questions, not one frozen
 * generic description.
 *
 * The vision model is resolved through pi's own registry (models.json, /login,
 * provider env keys, OAuth) — this extension never handles credentials.
 *
 * Configure:  /vision set model=<provider>/<vision-model-id>   e.g.
 *             /vision set model=google/gemini-2.5-flash
 * or env:     VISION_MODEL=<provider>/<model>   (~/.pi/agent/vision.json wins)
 * Show/reset: /vision show | /vision reset
 */
import { existsSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import {
  applyVisionToolVisibility,
  configPath,
  createConversationStore,
  loadConfig,
  modelSupportsImages,
  parseVisionArgs,
  readRawImage,
  resetConfigCache,
  resolveVisionTransport,
  runVisionTool,
  saveConfig,
  type ContentBlockLike,
  type ModelLike,
} from "./vision-core.ts";

/** Follow-up threads live per pi process: capped, in-memory, never persisted. */
const conversations = createConversationStore();

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("vision", {
    description:
      "Configure the vision tool (set/show/reset the vision model used for image Q&A)",
    handler: async (args, ctx) => {
      let parsed: ReturnType<typeof parseVisionArgs>;
      try {
        parsed = parseVisionArgs(args ?? "");
      } catch (e) {
        ctx.ui.notify(`vision: ${(e as Error).message}`, "warning");
        return;
      }

      if (parsed.action === "reset") {
        try {
          rmSync(configPath);
        } catch {
          // already absent
        }
        resetConfigCache();
        ctx.ui.notify(
          `vision: config cleared — VISION_MODEL env still applies if set`,
          "info",
        );
        return;
      }

      if (parsed.action === "set") {
        if (!parsed.values.model && !parsed.values.maxTokens) {
          ctx.ui.notify(
            "vision: nothing to set. Usage: /vision set model=<provider>/<model> [maxTokens=N]",
            "warning",
          );
          return;
        }
        const cfg = saveConfig(parsed.values);
        // Live-validate against the registry when a model was just set:
        // fail fast on typos, text-only models, and missing auth.
        if (parsed.values.model !== undefined && ctx.modelRegistry) {
          const resolved = await resolveVisionTransport(ctx.modelRegistry, cfg);
          ctx.ui.notify(
            resolved.ok
              ? `vision: model=${resolved.transport.label} (auth ok, maxTokens=${cfg.maxTokens})`
              : `vision: saved model=${cfg.model}, but resolution failed — ${resolved.error}`,
            resolved.ok ? "info" : "warning",
          );
          return;
        }
        ctx.ui.notify(`vision: saved (maxTokens=${cfg.maxTokens})`, "info");
        return;
      }

      const cfg = loadConfig();
      const src = existsSync(configPath)
        ? configPath.replace(homedir(), "~")
        : process.env.VISION_MODEL
          ? "VISION_MODEL env"
          : "not configured";
      ctx.ui.notify(
        `vision: model=${cfg.model || "(none)"} maxTokens=${cfg.maxTokens} (from ${src})`,
        "info",
      );
    },
  });

  // Self-hide: the tool only earns its place when the ACTIVE model cannot
  // see images. Hide it from vision models (removes the tool schema AND its
  // prompt-guideline bullet); restore it on a switch to a visionless model.
  function syncVisionToolVisibility(model: ModelLike | undefined): void {
    const visible = !modelSupportsImages(model);
    const next = applyVisionToolVisibility(pi.getActiveTools(), visible);
    if (next) pi.setActiveTools(next);
  }
  pi.on("session_start", (_event, ctx) => {
    syncVisionToolVisibility(ctx.model);
  });
  pi.on("model_select", (event) => {
    syncVisionToolVisibility(event.model);
  });

  pi.registerTool({
    name: "vision",
    label: "vision",
    description:
      "Ask a vision model a specific question about an image file (jpg, png, gif, webp, bmp) and get a text answer. " +
      "The active model cannot view images itself — this is how it looks at one. Ask targeted questions " +
      "('what error does the dialog show?', 'which element is highlighted?'). Set followUp=true to build on the " +
      "previous Q&A about the same image — the vision model remembers its earlier answers, so relative references " +
      "('the smaller button below it') work.",
    promptSnippet: "Ask a vision model targeted questions about image files",
    promptGuidelines: [
      "Use the vision tool to ask targeted questions about images (screenshots, diagrams, charts) — the active model cannot view images directly. Pass followUp=true to continue the previous thread about the same image.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the image file (relative or absolute)",
      }),
      prompt: Type.String({
        description: "The specific question to answer about the image",
      }),
      followUp: Type.Optional(
        Type.Boolean({
          description:
            "Continue the previous thread about this image (the vision model sees its earlier answers). Omit for a clean slate.",
        }),
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Delegate image loading to pi's own read tool: photon resize,
      // magic-byte mime detection, size caps — battle-tested behavior.
      const reader = createReadToolDefinition(ctx.cwd);
      return runVisionTool(
        { path: params.path, prompt: params.prompt, followUp: params.followUp },
        {
          cwd: ctx.cwd,
          cfg: loadConfig(),
          signal,
          registry: ctx.modelRegistry,
          conversations,
          statFile: (path) =>
            stat(path)
              .then((s) => ({ size: s.size, mtimeMs: s.mtimeMs }))
              .catch(() => null),
          readImage: (path) =>
            reader.execute(
              toolCallId,
              { path } as never,
              signal,
              undefined,
              ctx,
            ) as Promise<{ content: ContentBlockLike[]; isError?: boolean }>,
          readRaw: readRawImage,
          complete: (model, context, options) =>
            completeSimple(
              model as never,
              context as never,
              {
                apiKey: options.apiKey,
                headers: options.headers,
                maxTokens: options.maxTokens,
                signal: options.signal,
                timeoutMs: 120_000,
                maxRetries: 1,
              } as never,
            ) as Promise<never>,
        },
        (text) =>
          onUpdate?.({ content: [{ type: "text", text }], details: undefined }),
      );
    },
  });
}
