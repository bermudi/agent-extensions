import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ScopedModel,
} from "@earendil-works/pi-coding-agent";
import {
  assertModelsAvailable,
  loadConfig,
  type CouncilConfig,
} from "./config.ts";
import { runCouncil, type UserChair } from "./council.ts";
import { CouncilOutput } from "./output.ts";
import type { Ballot, DecisionSet } from "./types.ts";
import { CouncilDashboard, pickCouncilMembers } from "./ui.ts";

function serializeMessage(message: AgentMessage): string {
  const content =
    "content" in message
      ? typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content, null, 2)
      : JSON.stringify(message, null, 2);
  return [`### ${message.role}`, content].join("\n");
}

export function snapshotConversation(ctx: ExtensionCommandContext): string {
  const entries = ctx.sessionManager.buildContextEntries();
  const messages = entries.flatMap(sessionEntryToContextMessages);
  return messages.map(serializeMessage).join("\n\n");
}

function makeUserChair(
  ctx: ExtensionCommandContext,
  signal: AbortSignal,
): UserChair {
  return {
    async decide(
      decisions: DecisionSet,
      ballots: Array<{ voter: string; ballot: Ballot }>,
    ): Promise<Record<string, string>> {
      const selections: Record<string, string> = {};
      for (const decision of decisions.decisions) {
        signal.throwIfAborted();
        const counts = new Map<string, number>();
        for (const { ballot } of ballots) {
          const vote = ballot.decisions.find(
            (candidate) => candidate.decision === decision.id,
          );
          if (vote) counts.set(vote.choice, (counts.get(vote.choice) ?? 0) + 1);
        }
        const choices = decision.options.map((option) => {
          const votes = counts.get(option.id) ?? 0;
          return `${option.id} (${votes} vote${votes === 1 ? "" : "s"}) — ${option.description}`;
        });
        let selected: string | undefined;
        while (!selected) {
          const answer = await ctx.ui.select(
            `${decision.id}: ${decision.question}`,
            [...choices, "Inspect vote reasoning"],
          );
          signal.throwIfAborted();
          if (!answer)
            throw new CouncilCanceled("User canceled council chairing");
          if (answer !== "Inspect vote reasoning") {
            selected = answer;
            break;
          }
          const report = [
            `# ${decision.id} — ${decision.question}`,
            ...decision.options.flatMap((option) => [
              "",
              `## ${option.id} — ${option.description}`,
              `Proposed by: ${option.proposedBy.join(", ")}`,
              `Evidence: ${option.evidence.join(", ") || "none cited"}`,
              ...ballots.flatMap(({ voter, ballot }) => {
                const vote = ballot.decisions.find(
                  (candidate) => candidate.decision === decision.id,
                );
                return vote?.choice === option.id
                  ? [
                      `${voter} (${vote.confidence} confidence; evidence ${vote.evidence.join(", ") || "none"}): ${vote.reasoning}`,
                    ]
                  : [];
              }),
            ]),
          ].join("\n");
          await ctx.ui.editor(`Inspect ${decision.id}`, report);
          signal.throwIfAborted();
        }
        const optionId = selected.slice(0, selected.indexOf(" "));
        selections[decision.id] = optionId;
      }
      return selections;
    },
  };
}

function modelId(scoped: ScopedModel): string {
  return `${scoped.model.provider}/${scoped.model.id}`;
}

/** Distinguishes an intentional user cancellation from a real failure. */
class CouncilCanceled extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CouncilCanceled";
  }
}

/** Records a terminal event without letting a logging failure mask the
 *  outcome that triggered it. Returns a human-readable note when the
 *  event could not be persisted. */
async function recordOutcome(
  output: CouncilOutput | undefined,
  type: string,
  data: unknown,
): Promise<string> {
  if (!output) return "";
  try {
    await output.record(type, data);
    return "";
  } catch (logError) {
    const message =
      logError instanceof Error ? logError.message : String(logError);
    return ` (failed to record ${type} in ${output.logPath}: ${message})`;
  }
}

async function pickConfig(
  ctx: ExtensionCommandContext,
): Promise<CouncilConfig> {
  const scoped: ScopedModel[] =
    ctx.scopedModels.length > 0
      ? [...ctx.scopedModels]
      : ctx.modelRegistry.getAvailable().map((model) => ({ model }));
  const available = [
    ...new Map(scoped.map((entry) => [modelId(entry), entry])).values(),
  ];
  if (available.length < 2) {
    throw new Error("Council needs at least two distinct available models");
  }

  const picked = await pickCouncilMembers(ctx, available.map(modelId));
  if (!picked) throw new CouncilCanceled("Council setup canceled");
  const selected = new Set(picked);

  const chairMode = await ctx.ui.select("Who chairs the council?", [
    "A model",
    "I will chair",
  ]);
  if (!chairMode) throw new CouncilCanceled("Council setup canceled");

  const members = [...selected].map((id) => {
    const entry = available.find((candidate) => modelId(candidate) === id);
    return {
      model: id,
      ...(entry?.thinkingLevel ? { thinking: entry.thinkingLevel } : {}),
    };
  });
  const modelSpecFor = (id: string) => {
    const entry = available.find((candidate) => modelId(candidate) === id);
    return {
      model: id,
      ...(entry?.thinkingLevel ? { thinking: entry.thinkingLevel } : {}),
    };
  };
  if (chairMode === "I will chair") {
    const secretaryId = await ctx.ui.select(
      "Which model should act as secretary?",
      [...selected],
    );
    if (!secretaryId) throw new CouncilCanceled("Council setup canceled");
    return {
      version: 1,
      members,
      chair: {
        mode: "user",
        secretary: modelSpecFor(secretaryId),
      },
    };
  }

  const chairId = await ctx.ui.select(
    "Which model should chair?",
    available.map(modelId),
  );
  if (!chairId) throw new CouncilCanceled("Council setup canceled");
  return {
    version: 1,
    members,
    chair: { mode: "model", ...modelSpecFor(chairId) },
  };
}

export default function councilExtension(pi: ExtensionAPI): void {
  let activeAbort: AbortController | undefined;

  pi.registerShortcut("ctrl+shift+x", {
    description: "Cancel the active design council",
    handler: async (ctx) => {
      if (!activeAbort) {
        ctx.ui.notify("No design council is running", "info");
        return;
      }
      activeAbort.abort();
      ctx.ui.notify("Canceling design council…", "warning");
    },
  });

  pi.registerCommand("council-cancel", {
    description: "Cancel the active design council",
    handler: async (_args, ctx) => {
      if (!activeAbort) {
        ctx.ui.notify("No design council is running", "info");
        return;
      }
      activeAbort.abort();
      ctx.ui.notify("Canceling design council…", "warning");
    },
  });

  pi.registerCommand("council", {
    description:
      "Run a read-only, multi-model design council over the current conversation",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        throw new Error("/council requires an interactive Pi session");
      }
      await ctx.waitForIdle();

      const focus = args.trim();
      const conversation = snapshotConversation(ctx);
      if (!focus && !conversation.trim()) {
        throw new Error(
          "There is no problem to design. Discuss a task first, or run /council <design brief>.",
        );
      }
      if (activeAbort) {
        throw new Error("A design council is already running");
      }
      // Reserve the run slot before any awaited setup step so a second
      // concurrent invocation cannot slip past the guard above.
      const abort = new AbortController();
      activeAbort = abort;
      let output: CouncilOutput | undefined;
      let dashboard: CouncilDashboard | undefined;
      try {
        const config =
          (await loadConfig(ctx.cwd, ctx.isProjectTrusted())) ??
          (await pickConfig(ctx));
        assertModelsAvailable(config, ctx.modelRegistry);
        abort.signal.throwIfAborted();
        const confirmed = await ctx.ui.confirm(
          "Start design council?",
          `${config.members.length} models will inspect the repository and deliberate. This can be expensive.\n\nProblem: ${
            focus || conversation.slice(0, 500)
          }`,
        );
        if (!confirmed || abort.signal.aborted) return;

        output = await CouncilOutput.create(
          ctx.cwd,
          focus || "current-problem",
        );
        await output.record("run_started", {
          focus,
          cwd: ctx.cwd,
          conversation,
          config,
        });

        const actorNames = [
          ...config.members.map((_, index) => `Member ${index + 1}`),
          config.chair.mode === "model" ? "Chair" : "Secretary",
        ];
        const activeDashboard = new CouncilDashboard(ctx, actorNames);
        dashboard = activeDashboard;
        const finalDesign = await runCouncil({
          cwd: ctx.cwd,
          conversation,
          focus,
          config,
          registry: ctx.modelRegistry,
          output,
          userChair:
            config.chair.mode === "user"
              ? makeUserChair(ctx, abort.signal)
              : undefined,
          signal: abort.signal,
          onUpdate: (update) => {
            activeDashboard.update(update.actor, {
              phase: update.tool
                ? `${update.phase} · ${update.tool}`
                : update.phase,
              status: "running",
              delta: update.delta,
            });
          },
        });
        const markdown = finalDesign.markdown.startsWith("# ")
          ? finalDesign.markdown
          : `# ${finalDesign.title}\n\n${finalDesign.markdown}`;
        await output.writeDesign(`${markdown.trim()}\n`);
        await output.record("run_completed", {
          designPath: output.designPath,
        });
        ctx.ui.notify(`Council design: ${output.designPath}`, "info");
      } catch (error) {
        if (error instanceof CouncilCanceled || abort.signal.aborted) {
          // Intentional cancellation (shortcut, declined prompt), not a
          // system failure. Record it distinctly and report it as such.
          const logNote = await recordOutcome(output, "run_canceled", {});
          ctx.ui.notify(
            `Design council canceled${logNote}`,
            logNote ? "warning" : "info",
          );
          return;
        }
        const description =
          error instanceof Error ? error.message : String(error);
        // Log the failure defensively: if logging itself rejects (e.g. the
        // same filesystem problem that failed the run), keep the original
        // error as the primary outcome and surface the logging error too.
        const logNote = await recordOutcome(output, "run_failed", {
          error: description,
        });
        ctx.ui.notify(
          [
            `Council failed: ${description}.`,
            output ? `Log: ${output.logPath}` : "",
            logNote,
          ]
            .filter(Boolean)
            .join(" "),
          "error",
        );
        throw error;
      } finally {
        if (activeAbort === abort) activeAbort = undefined;
        dashboard?.close();
      }
    },
  });
}
