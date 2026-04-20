import type { Turn } from "./turn-grouper";

// Rough heuristic: 1 token ≈ 3.5 characters. Conservative to avoid overshooting.
export const CHARS_PER_TOKEN = 3.5;

export function computeCharBudget(contextWindow: number | undefined, maxOutputTokens: number, systemPrompt: string) {
  // Fallback to 128k tokens if contextWindow is unknown — conservative default.
  const cw = contextWindow ?? 128_000;
  const systemPromptTokens = Math.ceil(systemPrompt.length / CHARS_PER_TOKEN);
  const availableTokens = cw - maxOutputTokens - systemPromptTokens;
  return Math.floor(availableTokens * CHARS_PER_TOKEN);
}

export function buildTranscript(turns: Turn[], maxChars: number): string {
  const formatted = turns.map(formatTurn);
  // If the full transcript fits, send it all — the model decides what matters.
  const full = formatted.join("\n\n");
  if (full.length <= maxChars) return full;

  // Otherwise drop middle turns — keep the first (context) and last (recent).
  const charBudget = maxChars;
  const firstTurn = formatted[0];
  const firstLen = firstTurn?.length ?? 0;

  // Walk backwards from the end, including recent turns until budget is spent.
  // Budget accounts for all content: first turn + gap marker + recent turns.
  let used = firstLen;
  const keptRecent: string[] = [];

  for (let i = formatted.length - 1; i > 0; i--) {
    if (used + formatted[i].length + 4 > charBudget) break;
    keptRecent.push(formatted[i]);
    used += formatted[i].length + 4;
  }

  // Assemble: first turn, gap marker, then recent turns in chronological order.
  const recentInOrder = keptRecent.reverse();
  const droppedCount = turns.length - 1 - recentInOrder.length;
  const parts: string[] = [];
  if (firstTurn) parts.push(firstTurn);
  if (droppedCount > 0) parts.push(`[… ${droppedCount} earlier turns omitted …]`);
  parts.push(...recentInOrder);
  return parts.join("\n\n");
}

export function formatTurn(turn: Turn): string {
  const section: string[] = [];
  section.push(`### ${turn.label}`);
  section.push(`Request: ${turn.request}`);

  if (turn.reasoning.length > 0) {
    section.push(`Reasoning:\n${turn.reasoning.map((item) => `- ${indentBullet(item)}`).join("\n")}`);
  }

  if (turn.responses.length > 0) {
    section.push(`Stated conclusions:\n${turn.responses.map((item) => `- ${indentBullet(item)}`).join("\n")}`);
  }

  if (turn.evidence.length > 0) {
    section.push(`Relevant evidence:\n${turn.evidence.map((item) => `- ${indentBullet(item)}`).join("\n")}`);
  }

  return section.join("\n\n");
}

export function indentBullet(text: string) {
  return text.replace(/\n/g, "\n  ");
}
