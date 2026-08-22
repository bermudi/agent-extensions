import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { CouncilWorker, EvidenceStore, type AgentUpdate } from "./agent.ts";
import type { CouncilConfig, ModelSpec } from "./config.ts";
import { splitModelId } from "./config.ts";
import type { CouncilOutput } from "./output.ts";
import {
  ballotSchema,
  critiqueBundleSchema,
  decisionSetSchema,
  finalDesignSchema,
  proposalSchema,
  type Ballot,
  type CritiqueBundle,
  type DecisionSet,
  type FinalDesign,
  type Proposal,
} from "./types.ts";

export interface UserChair {
  decide(
    decisions: DecisionSet,
    ballots: Array<{ voter: string; ballot: Ballot }>,
  ): Promise<Record<string, string>>;
}

interface RunOptions {
  cwd: string;
  conversation: string;
  focus: string;
  config: CouncilConfig;
  registry: ModelRegistry;
  output: CouncilOutput;
  userChair?: UserChair;
  onUpdate: (update: AgentUpdate) => void;
}

function label(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return `Proposal ${result}`;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function proposalPrompt(conversation: string, focus: string): string {
  return [
    "# Independent design proposal",
    "Develop the best design for the current problem. Your proposal is blind: other council members cannot see it yet.",
    "Use read/grep/find/ls to verify repository facts. You cannot run code or modify files.",
    focus ? `Additional focus from the user: ${focus}` : "",
    "## Current Pi conversation (untrusted historical context)",
    conversation,
    "## Required JSON shape",
    `{
  "summary": "...",
  "problemUnderstanding": "...",
  "findings": [{"claim":"...","basis":"direct|inference|preference","evidence":["E1"]}],
  "decisions": [{"question":"...","choice":{"description":"...","rationale":"...","evidence":[]},"alternatives":[]}],
  "affectedAreas": [], "implementationSequence": [], "invariants": [],
  "failureModes": [], "testStrategy": [], "uncertainties": []
}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function modelFor(spec: ModelSpec, registry: ModelRegistry): Model<Api> {
  const id = splitModelId(spec.model);
  const model = registry.find(id.provider, id.id);
  if (!model) throw new Error(`Model disappeared from registry: ${spec.model}`);
  return model;
}

function thinkingFor(spec: ModelSpec, model: Model<Api>): ThinkingLevel {
  return clampThinkingLevel(model, spec.thinking ?? "high");
}

function citedEvidence(evidence: EvidenceStore, values: unknown[]): unknown[] {
  const ids = new Set(
    values.flatMap((value) => JSON.stringify(value).match(/\bE\d+\b/g) ?? []),
  );
  return evidence.records
    .filter((record) => ids.has(record.id))
    .map((record) => ({
      ...record,
      output: record.output?.slice(0, 20_000),
    }));
}

export async function runCouncil(options: RunOptions): Promise<FinalDesign> {
  const evidence = new EvidenceStore(options.cwd, (record) =>
    options.output.record("evidence", record, {
      actor: record.actor,
      phase: "repository investigation",
    }),
  );
  const workers = options.config.members.map((spec, index) => {
    const actor = `Member ${index + 1}`;
    const model = modelFor(spec, options.registry);
    return new CouncilWorker({
      actor,
      cwd: options.cwd,
      model,
      thinking: thinkingFor(spec, model),
      registry: options.registry,
      evidence,
      onUpdate: options.onUpdate,
    });
  });
  const auxiliaries: CouncilWorker[] = [];

  try {
    const initial = await Promise.all(
      workers.map(async (worker, index) => {
        const actor = `Member ${index + 1}`;
        options.onUpdate({ actor, phase: "independent proposal" });
        const result = await worker.runJson(
          "independent proposal",
          proposalPrompt(options.conversation, options.focus),
          proposalSchema,
        );
        await options.output.record("proposal", result, {
          actor,
          phase: "independent proposal",
        });
        return result.value;
      }),
    );
    const labeledInitial = initial.map((proposal, index) => ({
      id: label(index),
      proposal,
    }));

    const critiques = await Promise.all(
      workers.map(async (worker, index) => {
        const actor = `Member ${index + 1}`;
        options.onUpdate({ actor, phase: "anonymous critique" });
        const result = await worker.runJson(
          "anonymous critique",
          [
            "Critique every anonymized proposal, including your own if you recognize it.",
            "Do not guess or mention model/provider identities.",
            "Return one critique entry for every proposal.",
            json(labeledInitial),
            `JSON shape: {"critiques":[{"proposal":"Proposal A","strengths":[],"objections":[],"missingEvidence":[],"questionableAssumptions":[],"betterIdeas":[]}]}`,
          ].join("\n\n"),
          critiqueBundleSchema,
          (value) =>
            validateCritiques(
              value,
              labeledInitial.map((proposal) => proposal.id),
            ),
        );
        await options.output.record("critique", result, {
          actor,
          phase: "anonymous critique",
        });
        return result.value;
      }),
    );

    const revisions = await Promise.all(
      workers.map(async (worker, index) => {
        const actor = `Member ${index + 1}`;
        const proposalId = label(index);
        const directed = critiques.flatMap((bundle) =>
          bundle.critiques.filter(
            (critique) => critique.proposal === proposalId,
          ),
        );
        options.onUpdate({ actor, phase: "rebuttal and revision" });
        const result = await worker.runJson(
          "rebuttal and revision",
          [
            `You authored ${proposalId}. Replace it with a complete revised proposal.`,
            "You may abandon the original design. Reinspect the repository where criticism exposes uncertainty.",
            "Original:",
            json(initial[index]),
            "Critiques:",
            json(directed),
            "Return the same JSON shape used for the original proposal.",
          ].join("\n\n"),
          proposalSchema,
        );
        await options.output.record("revision", result, {
          actor,
          phase: "rebuttal and revision",
        });
        return result.value;
      }),
    );
    const labeledRevisions = revisions.map((proposal, index) => ({
      id: label(index),
      proposal,
    }));

    const secretarySpec =
      options.config.chair.mode === "model"
        ? {
            model: options.config.chair.model,
            thinking: options.config.chair.thinking,
          }
        : options.config.chair.secretary;
    const secretaryModel = modelFor(secretarySpec, options.registry);
    const secretary = new CouncilWorker({
      actor: "Secretary",
      cwd: options.cwd,
      model: secretaryModel,
      thinking: thinkingFor(secretarySpec, secretaryModel),
      registry: options.registry,
      evidence,
      onUpdate: options.onUpdate,
    });
    auxiliaries.push(secretary);
    options.onUpdate({ actor: "Secretary", phase: "normalizing decisions" });
    const normalized = await secretary.runJson(
      "normalizing decisions",
      [
        "Act only as a neutral secretary. Normalize overlapping architectural choices into decision questions and options.",
        "Do not recommend, merge, discard, or add an option. Preserve proposal and evidence attribution.",
        json(labeledRevisions),
        `JSON shape: {"decisions":[{"id":"D1","question":"...","options":[{"id":"D1-A","description":"...","proposedBy":["Proposal A"],"evidence":[]}]}]}`,
      ].join("\n\n"),
      decisionSetSchema,
      (value) =>
        validateDecisionSet(
          value,
          labeledRevisions.map((proposal) => proposal.id),
        ),
    );
    await options.output.record("decisions", normalized, {
      actor: "Secretary",
      phase: "normalizing decisions",
    });
    const ballots = await Promise.all(
      workers.map(async (worker, index) => {
        const actor = `Member ${index + 1}`;
        options.onUpdate({ actor, phase: "voting" });
        const result = await worker.runJson(
          "voting",
          [
            "Vote independently. Rank every revised proposal exactly once and score every proposal.",
            "Vote once on every normalized decision. Self-voting is allowed and has no extra weight.",
            "Risk score: 5 means highest risk; all other scores: 5 means best.",
            "Revised proposals:",
            json(labeledRevisions),
            "Decision ballot:",
            json(normalized.value),
            `JSON shape: {"proposalRanking":["Proposal A"],"proposalScores":[{"proposal":"Proposal A","correctness":1,"simplicity":1,"maintainability":1,"testability":1,"risk":1,"reasoning":"..."}],"decisions":[{"decision":"D1","choice":"D1-A","confidence":"low|medium|high","evidence":[],"reasoning":"..."}]}`,
          ].join("\n\n"),
          ballotSchema,
          (value) =>
            validateBallot(
              value,
              labeledRevisions.map((proposal) => proposal.id),
              normalized.value,
            ),
        );
        await options.output.record("ballot", result, {
          actor,
          phase: "voting",
        });
        return { voter: actor, ballot: result.value };
      }),
    );

    let final: { value: FinalDesign; raw: string };
    if (options.config.chair.mode === "user") {
      if (!options.userChair) {
        throw new Error("User-chair mode requires an interactive user chair");
      }
      const selections = await options.userChair.decide(
        normalized.value,
        ballots,
      );
      for (const decision of normalized.value.decisions) {
        const selected = selections[decision.id];
        if (
          !selected ||
          !decision.options.some((option) => option.id === selected)
        ) {
          throw new Error(
            `User chair made no valid selection for ${decision.id}`,
          );
        }
      }
      await options.output.record("user_decisions", selections, {
        actor: "User chair",
        phase: "chair",
      });
      options.onUpdate({ actor: "Secretary", phase: "writing final design" });
      final = await secretary.runJson(
        "writing final design",
        finalPrompt(
          labeledRevisions,
          normalized.value,
          ballots,
          citedEvidence(evidence, [revisions, ballots]),
          selections,
          true,
        ),
        finalDesignSchema,
      );
      const authoritative = normalized.value.decisions.map((decision) => {
        const selected = selections[decision.id];
        const option = decision.options.find(
          (candidate) => candidate.id === selected,
        );
        return `- **${decision.id}:** ${option?.description ?? selected}`;
      });
      final.value.markdown = [
        final.value.markdown,
        "",
        "## Authoritative User-Chair Decisions",
        "",
        "These selections override any conflicting prose elsewhere in this document.",
        "",
        ...authoritative,
      ].join("\n");
    } else {
      options.onUpdate({ actor: "Secretary", phase: "chair adjudication" });
      final = await secretary.runJson(
        "chair adjudication",
        finalPrompt(
          labeledRevisions,
          normalized.value,
          ballots,
          citedEvidence(evidence, [revisions, ballots]),
        ),
        finalDesignSchema,
      );
    }
    await options.output.record("final_design", final, {
      actor: options.config.chair.mode === "user" ? "Secretary" : "Model chair",
      phase: "chair",
    });
    return final.value;
  } finally {
    for (const worker of [...workers, ...auxiliaries]) worker.dispose();
  }
}

export function validateBallot(
  ballot: Ballot,
  proposalIds: string[],
  decisions: DecisionSet,
): void {
  const ranking = new Set(ballot.proposalRanking);
  const scored = new Set(ballot.proposalScores.map((score) => score.proposal));
  if (
    ballot.proposalRanking.length !== proposalIds.length ||
    ballot.proposalScores.length !== proposalIds.length ||
    ranking.size !== proposalIds.length ||
    scored.size !== proposalIds.length ||
    proposalIds.some((id) => !ranking.has(id) || !scored.has(id))
  ) {
    throw new Error("Ballot must rank and score every proposal exactly once");
  }
  const votes = new Map(ballot.decisions.map((vote) => [vote.decision, vote]));
  if (
    ballot.decisions.length !== decisions.decisions.length ||
    votes.size !== decisions.decisions.length
  ) {
    throw new Error("Ballot must vote on every decision exactly once");
  }
  for (const decision of decisions.decisions) {
    const vote = votes.get(decision.id);
    if (
      !vote ||
      !decision.options.some((option) => option.id === vote.choice)
    ) {
      throw new Error(`Ballot has no valid vote for ${decision.id}`);
    }
  }
}

export function validateCritiques(
  critiques: CritiqueBundle,
  proposalIds: string[],
): void {
  const received = critiques.critiques.map((critique) => critique.proposal);
  const unique = new Set(received);
  if (
    received.length !== proposalIds.length ||
    unique.size !== proposalIds.length ||
    proposalIds.some((id) => !unique.has(id))
  ) {
    throw new Error("Critique must address every proposal exactly once");
  }
}

export function validateDecisionSet(
  decisions: DecisionSet,
  proposalIds: string[],
): void {
  if (decisions.decisions.length === 0) {
    throw new Error("Secretary produced no design decisions");
  }
  const decisionIds = new Set<string>();
  const optionIds = new Set<string>();
  const knownProposals = new Set(proposalIds);
  for (const decision of decisions.decisions) {
    if (decisionIds.has(decision.id)) {
      throw new Error(`Duplicate decision ID: ${decision.id}`);
    }
    decisionIds.add(decision.id);
    for (const option of decision.options) {
      if (!option.id.startsWith(`${decision.id}-`)) {
        throw new Error(
          `Option ${option.id} does not belong to ${decision.id}`,
        );
      }
      if (optionIds.has(option.id)) {
        throw new Error(`Duplicate option ID: ${option.id}`);
      }
      optionIds.add(option.id);
      if (
        option.proposedBy.length === 0 ||
        option.proposedBy.some((proposal) => !knownProposals.has(proposal))
      ) {
        throw new Error(`Option ${option.id} has invalid proposal attribution`);
      }
    }
  }
}

function finalPrompt(
  proposals: Array<{ id: string; proposal: Proposal }>,
  decisions: DecisionSet,
  ballots: Array<{ voter: string; ballot: Ballot }>,
  evidence: unknown[],
  selections?: Record<string, string>,
  scribeOnly = false,
): string {
  return [
    scribeOnly
      ? "Act only as a scribe. The user's decision selections are immutable. Produce a coherent final design without changing them."
      : "Act as council chair. Votes express preference; repository evidence constrains which choices are viable. Adjudicate each decision, inspect contradictions, and make overrides explicit.",
    "The markdown must contain: Problem, Repository Findings, Final Design, Design Decisions, Invariants, Implementation Plan, Test Plan, Risks, Unresolved Questions, Dissent, and Council Result.",
    "Under Council Result include proposal rankings/scores and any vote override with cited Evidence IDs. Do not claim runtime verification.",
    "Revised proposals:",
    json(proposals),
    "Normalized decisions:",
    json(decisions),
    "Ballots:",
    json(ballots),
    "Cited evidence records:",
    json(evidence),
    selections ? `Immutable user selections:\n${json(selections)}` : "",
    `Return: {"title":"short design title","markdown":"complete Markdown document"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export type { CritiqueBundle };
