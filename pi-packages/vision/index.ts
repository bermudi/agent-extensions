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
 * or env:     VISION_MODEL=<provider>/<model>   (~/.pi/vision.json wins)
 * Show/reset: /vision show | /vision reset
 */
import { existsSync, rmSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import {
  configPath,
  loadConfig,
  parseVisionArgs,
  readRawImage,
  resetConfigCache,
  resolveVisionTransport,
  runVisionTool,
  saveConfig,
  type ContentBlockLike,
} from "./vision-core.ts";

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
          "vision: config cleared — VISION_MODEL env still applies if set",
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
        ? `~/.pi/vision.json`
        : process.env.VISION_MODEL
          ? "VISION_MODEL env"
          : "not configured";
      ctx.ui.notify(
        `vision: model=${cfg.model || "(none)"} maxTokens=${cfg.maxTokens} (from ${src})`,
        "info",
      );
    },
  });

  pi.registerTool({
    name: "vision",
    label: "vision",
    description:
      "Ask a vision-capable model a specific question about an image file (jpg, png, gif, webp, bmp) and get a text answer. " +
      "Works even when the active model cannot see images. Each call is independent — ask targeted questions " +
      "('what error does the dialog show?', 'which element is highlighted?', 'read the chart axis labels') " +
      "rather than 'describe this image'; follow-up questions are new calls.",
    promptSnippet: "Ask a vision model targeted questions about image files",
    promptGuidelines: [
      "Use the vision tool to ask targeted questions about images (screenshots, diagrams, charts) when you need visual details — it answers even when the active model cannot see images.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the image file (relative or absolute)",
      }),
      prompt: Type.String({
        description: "The specific question to answer about the image",
      }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Delegate image loading to pi's own read tool: photon resize,
      // magic-byte mime detection, size caps — battle-tested behavior.
      const reader = createReadToolDefinition(ctx.cwd);
      return runVisionTool(
        { path: params.path, prompt: params.prompt },
        {
          cwd: ctx.cwd,
          registry: ctx.modelRegistry,
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
                signal,
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
