import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEBUG_LOG_PATH = process.env.THINKING_COMPACTION_DEBUG_PATH || join(homedir(), ".config", "opencode", "thinking-compaction-debug.log");
const DEBUG_PROMPT_PATH =
  process.env.THINKING_COMPACTION_PROMPT_PATH || join(homedir(), ".config", "opencode", "thinking-compaction-last-prompt.txt");

const THINKING_COMPACTION_PROMPT = `You are generating a continuation summary for an AI coding session.

Your highest priority is preserving the assistant's working mind:
- how it understood the codebase
- what issues it identified
- what approaches it tried
- what dead ends or false starts happened
- why it changed direction
- what mental model it built

When there is already an existing summary or prior compaction context, update it rather than starting over. Preserve important prior context unless it has clearly been superseded.

Low-value information to aggressively compress or omit unless essential:
- raw file contents from read tool calls
- repetitive tool call lists
- boilerplate assistant chatter ("let me check", "I'll inspect", etc.)
- unimportant command output

Convert the session into a small number of coherent units of work. Each unit should preserve the reasoning trail, not just the final result.

Use this EXACT format:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements, constraints, or preferences]
- [Or "(none)"]

## Units of Work
### Unit 1: [short title]
- **Understanding**: [What the assistant learned / how it interpreted the code]
- **Issues found**: [Problems, risks, or mismatches it identified]
- **Attempts**: [What it tried, including wrong turns if important]
- **Outcome**: [Where that unit ended up]

### Unit 2: [short title]
- **Understanding**: ...
- **Issues found**: ...
- **Attempts**: ...
- **Outcome**: ...

## Current Mental Model
- [How the assistant currently understands the system / problem]

## Open Questions / Risks
- [Outstanding uncertainty, risk, or unresolved point]
- [Or "(none)"]

## Next Steps
1. [What should happen next]

Rules:
- Preserve exact file paths, function names, identifiers, branch names, and important error messages.
- Prefer reasoning and problem-solving over chronology.
- If the assistant corrected itself, preserve the correction.
- Mention file modifications only when they matter to the reasoning or current state.
- Be concise but high-signal.`;

async function appendDebug(event: string, extra: Record<string, unknown> = {}) {
  try {
    await mkdir(dirname(DEBUG_LOG_PATH), { recursive: true });
    await appendFile(
      DEBUG_LOG_PATH,
      `${JSON.stringify({ ts: new Date().toISOString(), event, ...extra })}\n`,
      "utf8",
    );
  } catch {
    // Never let debug logging break compaction.
  }
}

function summarizeInput(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { inputType: Array.isArray(input) ? "array" : typeof input };
  }

  const record = input as Record<string, unknown>;
  return {
    inputType: "object",
    inputKeys: Object.keys(record).sort(),
  };
}

export const ThinkingCompactionPlugin = async () => {
  await appendDebug("plugin.init", {
    pid: process.pid,
    cwd: process.cwd(),
  });

  return {
    "experimental.session.compacting": async (input: unknown, output: { prompt?: string }) => {
      output.prompt = THINKING_COMPACTION_PROMPT;

      try {
        await mkdir(dirname(DEBUG_PROMPT_PATH), { recursive: true });
        await writeFile(DEBUG_PROMPT_PATH, output.prompt, "utf8");
      } catch {
        // Never let debug logging break compaction.
      }

      await appendDebug("experimental.session.compacting", {
        ...summarizeInput(input),
        promptLength: output.prompt.length,
        promptPath: DEBUG_PROMPT_PATH,
      });
    },
  };
};

export default ThinkingCompactionPlugin;
