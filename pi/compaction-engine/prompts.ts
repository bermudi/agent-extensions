export const INITIAL_PROMPT = `You are compacting an AI coding session for future continuation.

Your highest priority is preserving the assistant's working mind:
- how it understood the codebase
- what issues it identified
- what approaches it tried
- what dead ends or false starts happened
- why it changed direction
- what mental model it built

User messages may contain crucial details — requirements, constraints, preferences, or corrections buried in casual conversation. You SHOULD attempt to preserve as much of that content as possible without sacrificing the compression of other low-value material.

Low-value information to aggressively compress or omit unless essential:
- raw file contents from read tool calls
- repetitive tool call lists
- boilerplate assistant chatter ("let me check", "I'll inspect", etc.)
- unimportant command output

Convert the transcript into a small number of coherent units of work. Each unit should preserve the reasoning trail, not just the final result.

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

export const UPDATE_PROMPT = `You are updating an existing compaction summary for an AI coding session.

The previous summary is in <previous-summary>. The new transcript is in <new-work>.

Your highest priority is preserving the assistant's reasoning trail and mental model. Merge the previous summary with the new work while keeping the result concise and high-signal.

Rules:
- Preserve important prior context unless superseded.
- Add new units of work as needed, or update existing ones if they naturally continue the same effort.
- Keep the focus on understanding, issues found, attempts, course corrections, and outcomes.
- Remove stale "Next Steps" items if they are already done.
- Preserve exact file paths, function names, identifiers, branch names, and important error messages.
- Do not bloat the summary with raw tool output or repetitive tool listings.
- User messages often contain the most important context (requirements, constraints, corrections). Never sacrifice user-stated details for the sake of brevity.

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

## Current Mental Model
- [How the assistant currently understands the system / problem]

## Open Questions / Risks
- [Outstanding uncertainty, risk, or unresolved point]
- [Or "(none)"]

## Next Steps
1. [What should happen next]`;
