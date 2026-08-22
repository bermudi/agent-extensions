import { z } from "zod";

export const thinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const evidenceIdSchema = z.string().regex(/^E\d+$/);

const findingSchema = z.object({
  claim: z.string().min(1),
  basis: z.enum(["direct", "inference", "preference"]),
  evidence: z.array(evidenceIdSchema).default([]),
});

const decisionOptionSchema = z.object({
  description: z.string().min(1),
  rationale: z.string().min(1),
  evidence: z.array(evidenceIdSchema).default([]),
});

export const proposalSchema = z.object({
  summary: z.string().min(1),
  problemUnderstanding: z.string().min(1),
  findings: z.array(findingSchema),
  decisions: z.array(
    z.object({
      question: z.string().min(1),
      choice: decisionOptionSchema,
      alternatives: z.array(decisionOptionSchema).default([]),
    }),
  ),
  affectedAreas: z.array(z.string()),
  implementationSequence: z.array(z.string()),
  invariants: z.array(z.string()),
  failureModes: z.array(z.string()),
  testStrategy: z.array(z.string()),
  uncertainties: z.array(z.string()),
});

export const critiqueBundleSchema = z.object({
  critiques: z.array(
    z.object({
      proposal: z.string().regex(/^Proposal [A-Z]+$/),
      strengths: z.array(z.string()),
      objections: z.array(z.string()),
      missingEvidence: z.array(z.string()),
      questionableAssumptions: z.array(z.string()),
      betterIdeas: z.array(z.string()),
    }),
  ),
});

export const decisionSetSchema = z.object({
  decisions: z.array(
    z.object({
      id: z.string().regex(/^D\d+$/),
      question: z.string().min(1),
      options: z
        .array(
          z.object({
            id: z.string().regex(/^D\d+-[A-Z]+$/),
            description: z.string().min(1),
            proposedBy: z.array(z.string().regex(/^Proposal [A-Z]+$/)),
            evidence: z.array(evidenceIdSchema).default([]),
          }),
        )
        .min(2),
    }),
  ),
});

export const ballotSchema = z.object({
  proposalRanking: z.array(z.string().regex(/^Proposal [A-Z]+$/)),
  proposalScores: z.array(
    z.object({
      proposal: z.string().regex(/^Proposal [A-Z]+$/),
      correctness: z.number().int().min(1).max(5),
      simplicity: z.number().int().min(1).max(5),
      maintainability: z.number().int().min(1).max(5),
      testability: z.number().int().min(1).max(5),
      risk: z.number().int().min(1).max(5),
      reasoning: z.string().min(1),
    }),
  ),
  decisions: z.array(
    z.object({
      decision: z.string().regex(/^D\d+$/),
      choice: z.string().regex(/^D\d+-[A-Z]+$/),
      confidence: z.enum(["low", "medium", "high"]),
      evidence: z.array(evidenceIdSchema).default([]),
      reasoning: z.string().min(1),
    }),
  ),
});

export const finalDesignSchema = z.object({
  title: z.string().min(1),
  markdown: z.string().min(1),
});

export type Proposal = z.infer<typeof proposalSchema>;
export type CritiqueBundle = z.infer<typeof critiqueBundleSchema>;
export type DecisionSet = z.infer<typeof decisionSetSchema>;
export type Ballot = z.infer<typeof ballotSchema>;
export type FinalDesign = z.infer<typeof finalDesignSchema>;

export interface Evidence {
  id: string;
  actor: string;
  operation: "read" | "grep" | "find" | "ls";
  input: unknown;
  output?: string;
  error?: string;
  createdAt: string;
}

export interface CouncilEvent {
  sequence: number;
  at: string;
  type: string;
  actor?: string;
  phase?: string;
  data: unknown;
}
