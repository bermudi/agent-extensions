// Public API — re-export everything from the compaction engine modules.

export { INITIAL_PROMPT, UPDATE_PROMPT } from "./prompts";

export type { Turn, ToolCallInfo } from "./turn-grouper";
export {
  groupIntoTurns,
  createTurn,
  finalizeTurn,
  hasUsefulTurnContent,
  isTurnStartRole,
  labelForRole,
  describeTurnRequest,
  ingestAssistantMessage,
  ingestToolResult,
  summarizeBashEvidence,
  pickInterestingLines,
  looksLikeFiller,
} from "./turn-grouper";

export { CHARS_PER_TOKEN, computeCharBudget, buildTranscript, formatTurn, indentBullet } from "./transcript-builder";

export {
  SUMMARY_MAX_TOKENS,
  buildPrompt,
  stripFileTags,
  computeFileLists,
  toStringArray,
  formatFileTags,
} from "./prompt-builder";
