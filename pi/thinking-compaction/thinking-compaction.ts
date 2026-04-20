import { mkdir, writeFile } from "node:fs/promises";
import { readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DEBUG_DIR = join(homedir(), ".pi", "logs", "thinking-compaction");

const EXTENSION_NAME = "thinking-compaction";
const SUMMARY_MODEL_CANDIDATES: Array<[string, string]> = [["google", "gemini-2.5-flash"]];

type AnyRecord = Record<string, any>;

// Lazy-loaded compaction engine. Resolved at first use so we don't
// block module evaluation with top-level await (pi's loader doesn't
// support it). Uses readlinkSync to chase the symlink so the engine
// resolves correctly from the real repo path.
let _engine: Promise<typeof import("../compaction-engine")> | undefined;

async function loadEngine() {
  if (!_engine) {
    _engine = (async () => {
      const filePath = fileURLToPath(import.meta.url);
      let realDir: string;
      try {
        const realPath = readlinkSync(filePath);
        realDir = dirname(realPath);
      } catch {
        realDir = dirname(filePath);
      }
      const engineDir = join(realDir, "..", "compaction-engine");
      return import(engineDir);
    })();
  }
  return _engine;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, customInstructions, signal } = event;
    const { messagesToSummarize, turnPrefixMessages, previousSummary, firstKeptEntryId, tokensBefore, fileOps } = preparation;

    const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const runDir = join(DEBUG_DIR, runId);

    if (allMessages.length === 0) return;

    const engine = await loadEngine();

    const turns = engine.groupIntoTurns(allMessages);

    const modelChoice = await resolveSummaryModel(ctx);
    if (!modelChoice) {
      ctx.ui.notify("Thinking compaction: no summary model available, falling back to default compaction", "warning");
      return;
    }

    const systemPrompt = previousSummary ? engine.UPDATE_PROMPT : engine.INITIAL_PROMPT;
    const maxPromptChars = engine.computeCharBudget(modelChoice.model.contextWindow as number | undefined, engine.SUMMARY_MAX_TOKENS, systemPrompt);
    const transcript = engine.buildTranscript(turns, maxPromptChars);
    if (!transcript.trim()) return;

    const prompt = engine.buildPrompt({
      transcript,
      previousSummary: engine.stripFileTags(previousSummary),
      customInstructions,
    });

    // ── Observability ────────────────────────────────────────────────────
    await mkdir(runDir, { recursive: true });
    await Promise.all([
      writeFile(join(runDir, "inputs.json"), JSON.stringify({
        timestamp: new Date().toISOString(),
        tokensBefore,
        messagesToSummarizeCount: messagesToSummarize.length,
        turnPrefixMessagesCount: turnPrefixMessages.length,
        firstKeptEntryId,
        hasPreviousSummary: Boolean(previousSummary),
        customInstructions,
        fileOps: {
          read: fileOps?.read ? [...fileOps.read] : [],
          written: fileOps?.written ? [...fileOps.written] : [],
          edited: fileOps?.edited ? [...fileOps.edited] : [],
        },
      }, null, 2)),
      writeFile(join(runDir, "transcript.md"), transcript),
      writeFile(join(runDir, "prompt.txt"), prompt),
    ]);

    ctx.ui.notify(
      `Thinking compaction: summarizing ${allMessages.length} messages (${tokensBefore.toLocaleString()} tokens) with ${modelChoice.model.provider}/${modelChoice.model.id}`,
      "info",
    );

    try {
      const response = await complete(
        modelChoice.model,
        {
          systemPrompt: previousSummary ? engine.UPDATE_PROMPT : engine.INITIAL_PROMPT,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: prompt }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: modelChoice.auth.apiKey,
          headers: modelChoice.auth.headers,
          maxTokens: engine.SUMMARY_MAX_TOKENS,
          signal,
        },
      );

      const summary = response.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();

      if (!summary) {
        if (!signal.aborted) {
          ctx.ui.notify("Thinking compaction produced an empty summary, falling back to default compaction", "warning");
        }
        return;
      }

      const { readFiles, modifiedFiles } = engine.computeFileLists(fileOps);
      const finalSummary = `${summary}${engine.formatFileTags(readFiles, modifiedFiles)}`;

      // ── Observability: output ─────────────────────────────────────────
      await writeFile(join(runDir, "summary.md"), finalSummary);
      await writeFile(join(runDir, "details.json"), JSON.stringify({
        version: 2,
        strategy: EXTENSION_NAME,
        readFiles,
        modifiedFiles,
        turns: turns.length,
        model: `${modelChoice.model.provider}/${modelChoice.model.id}`,
        summaryLength: finalSummary.length,
        transcriptLength: transcript.length,
        promptLength: prompt.length,
      }, null, 2));

      return {
        compaction: {
          summary: finalSummary,
          firstKeptEntryId,
          tokensBefore,
          details: {
            version: 2,
            strategy: EXTENSION_NAME,
            readFiles,
            modifiedFiles,
            turns: turns.length,
            model: `${modelChoice.model.provider}/${modelChoice.model.id}`,
          },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!signal.aborted) {
        ctx.ui.notify(`Thinking compaction failed: ${message}`, "error");
      }
      return;
    }
  });

}

// ── Model resolution ──────────────────────────────────────────────────

async function resolveSummaryModel(ctx: AnyRecord) {
  const seen = new Set<string>();
  const candidates: AnyRecord[] = [];

  for (const [provider, id] of SUMMARY_MODEL_CANDIDATES) {
    const model = ctx.modelRegistry.find(provider, id);
    if (model) candidates.push(model);
  }

  if (ctx.model) candidates.push(ctx.model);

  for (const model of candidates) {
    if (!model) continue;
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok && auth.apiKey) {
      return { model, auth };
    }
  }

  return undefined;
}
