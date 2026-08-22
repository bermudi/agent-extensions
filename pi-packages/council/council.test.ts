import { describe, expect, test } from "bun:test";
import {
  validateBallot,
  validateCritiques,
  validateDecisionSet,
} from "./council.ts";
import type { Ballot, CritiqueBundle, DecisionSet } from "./types.ts";

const decisions: DecisionSet = {
  decisions: [
    {
      id: "D1",
      question: "Who owns state?",
      options: [
        {
          id: "D1-A",
          description: "Repository",
          proposedBy: ["Proposal A"],
          evidence: [],
        },
        {
          id: "D1-B",
          description: "Request",
          proposedBy: ["Proposal B"],
          evidence: [],
        },
      ],
    },
  ],
};

const ballot: Ballot = {
  proposalRanking: ["Proposal A", "Proposal B"],
  proposalScores: ["Proposal A", "Proposal B"].map((proposal) => ({
    proposal,
    correctness: 4,
    simplicity: 4,
    maintainability: 4,
    testability: 4,
    risk: 2,
    reasoning: "Sound",
  })),
  decisions: [
    {
      decision: "D1",
      choice: "D1-A",
      confidence: "high",
      evidence: [],
      reasoning: "Clear owner",
    },
  ],
};

function critique(proposal: string) {
  return {
    proposal,
    strengths: [],
    objections: [],
    missingEvidence: [],
    questionableAssumptions: [],
    betterIdeas: [],
  };
}

describe("protocol validation", () => {
  test("accepts a complete decision set and ballot", () => {
    expect(() =>
      validateDecisionSet(decisions, ["Proposal A", "Proposal B"]),
    ).not.toThrow();
    expect(() =>
      validateBallot(ballot, ["Proposal A", "Proposal B"], decisions),
    ).not.toThrow();
  });

  test("rejects duplicate rankings and decision votes", () => {
    expect(() =>
      validateBallot(
        {
          ...ballot,
          proposalRanking: ["Proposal A", "Proposal B", "Proposal A"],
        },
        ["Proposal A", "Proposal B"],
        decisions,
      ),
    ).toThrow("exactly once");
    expect(() =>
      validateBallot(
        { ...ballot, decisions: [...ballot.decisions, ...ballot.decisions] },
        ["Proposal A", "Proposal B"],
        decisions,
      ),
    ).toThrow("every decision exactly once");
  });

  test("rejects malformed normalization", () => {
    expect(() =>
      validateDecisionSet({ decisions: [] }, ["Proposal A"]),
    ).toThrow("no design decisions");
    expect(() =>
      validateDecisionSet(
        {
          decisions: [
            {
              ...decisions.decisions[0]!,
              options: [
                {
                  id: "D2-A",
                  description: "Wrong parent",
                  proposedBy: ["Proposal Z"],
                  evidence: [],
                },
                decisions.decisions[0]!.options[1]!,
              ],
            },
          ],
        },
        ["Proposal A", "Proposal B"],
      ),
    ).toThrow("does not belong");
  });

  test("requires exactly one critique per proposal", () => {
    const valid: CritiqueBundle = {
      critiques: [critique("Proposal A"), critique("Proposal B")],
    };
    expect(() =>
      validateCritiques(valid, ["Proposal A", "Proposal B"]),
    ).not.toThrow();
    expect(() =>
      validateCritiques(
        {
          critiques: [critique("Proposal A"), critique("Proposal A")],
        },
        ["Proposal A", "Proposal B"],
      ),
    ).toThrow("exactly once");
  });
});
