import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
// @ts-expect-error no @opencode-ai/plugin types
import type { Plugin } from "@opencode-ai/plugin";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEBUG_DIR =
  process.env.THINKING_COMPACTION_DEBUG_DIR ||
  join(homedir(), ".config", "opencode", "thinking-compaction-debug");

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function shortId(id: string) {
  return id.slice(0, 8);
}

async function safeWrite(filePath: string, content: string) {
  try {
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, content, "utf8");
  } catch (err) {
    await appendLine(
      join(DEBUG_DIR, "errors.log"),
      `${new Date().toISOString()} write failed ${filePath}: ${err}`,
    );
  }
}

async function appendLine(filePath: string, line: string) {
  try {
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    await appendFile(filePath, `${line}\n`, "utf8");
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Message shape helpers (v1 SDK)
// v1 SessionMessagesResponses = Array<{ info: Message, parts: Array<Part> }>
// ---------------------------------------------------------------------------

function slimMessage(msg: { info: Record<string, unknown>; parts: Record<string, unknown>[] }) {
  return {
    id: msg.info.id,
    role: msg.info.role,
    summary: ("summary" in msg.info) ? msg.info.summary : undefined,
    parts: msg.parts.map((p) => {
      const slim: Record<string, unknown> = { type: p.type };
      if (typeof p.text === "string") slim.text = p.text;
      if (typeof p.auto === "boolean") slim.auto = p.auto;
      if (typeof p.overflow === "boolean") slim.overflow = p.overflow;
      if (typeof p.command === "string") slim.command = p.command;
      if (typeof p.name === "string") slim.name = p.name;
      return slim;
    }),
  };
}

function extractCompactionSummary(messages: { info: Record<string, unknown>; parts: Record<string, unknown>[] }[]): string[] {
  const summaries: string[] = [];
  for (const msg of messages) {
    const isSummary = msg.info.summary === true;
    const role = msg.info.role;

    for (const part of msg.parts) {
      if (part.type === "compaction") {
        summaries.push(`[compaction marker: auto=${part.auto}, overflow=${part.overflow ?? "unknown"}]`);
      }
      if (part.type === "text" && typeof part.text === "string" && role === "assistant" && isSummary) {
        summaries.push(part.text as string);
      }
      if (part.type === "reasoning" && typeof part.text === "string" && isSummary) {
        summaries.push(`[reasoning] ${part.text}`);
      }
    }
  }
  return summaries;
}

function computeStats(messages: { info: Record<string, unknown>; parts: Record<string, unknown>[] }[]) {
  let userCount = 0;
  let assistantCount = 0;
  let totalTextChars = 0;
  let compactionMarkers = 0;

  for (const msg of messages) {
    if (msg.info.role === "user") userCount++;
    else if (msg.info.role === "assistant") assistantCount++;

    for (const part of msg.parts) {
      if (part.type === "text" && typeof part.text === "string") totalTextChars += (part.text as string).length;
      if (part.type === "reasoning" && typeof part.text === "string") totalTextChars += (part.text as string).length;
      if (part.type === "compaction") compactionMarkers++;
    }
  }

  return { messageCount: messages.length, userCount, assistantCount, totalTextChars, compactionMarkers };
}

function generateReport(
  beforeStats: ReturnType<typeof computeStats>,
  afterStats: ReturnType<typeof computeStats>,
  summaries: string[],
  runDir: string,
) {
  const lines = [
    `# Thinking Compaction Report`,
    ``,
    `**Run directory**: \`${runDir}\``,
    ``,
    `## Before Compaction`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Messages | ${beforeStats.messageCount} |`,
    `| User messages | ${beforeStats.userCount} |`,
    `| Assistant messages | ${beforeStats.assistantCount} |`,
    `| Total text chars | ${beforeStats.totalTextChars.toLocaleString()} |`,
    `| Compaction markers | ${beforeStats.compactionMarkers} |`,
    ``,
    `## After Compaction`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Messages | ${afterStats.messageCount} |`,
    `| User messages | ${afterStats.userCount} |`,
    `| Assistant messages | ${afterStats.assistantCount} |`,
    `| Total text chars | ${afterStats.totalTextChars.toLocaleString()} |`,
    `| Compaction markers | ${afterStats.compactionMarkers} |`,
    ``,
    `## Compression`,
    ``,
    `| Metric | Before | After | Ratio |`,
    `|--------|--------|-------|-------|`,
    `| Messages | ${beforeStats.messageCount} | ${afterStats.messageCount} | ${(afterStats.messageCount / Math.max(beforeStats.messageCount, 1)).toFixed(2)} |`,
    `| Text chars | ${beforeStats.totalTextChars.toLocaleString()} | ${afterStats.totalTextChars.toLocaleString()} | ${(afterStats.totalTextChars / Math.max(beforeStats.totalTextChars, 1)).toFixed(2)} |`,
    ``,
  ];

  if (summaries.length > 0) {
    lines.push(`## Extracted Summary`);
    lines.push(``);
    for (const s of summaries) {
      lines.push(`---`);
      lines.push(s);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const ThinkingCompactionPlugin: Plugin = async ({ client }: { client: any }) => {
  await appendLine(join(DEBUG_DIR, "log"), `${new Date().toISOString()} plugin.init pid=${process.pid} cwd=${process.cwd()}`);

  return {
    "experimental.session.compacting": async (input: { sessionID: string }, output: { context: string[]; prompt?: string }) => {
      const { sessionID } = input;
      const runId = `${ts()}-${shortId(sessionID)}`;
      const runDir = join(DEBUG_DIR, runId);

      // Inject our custom prompt (replaces the default)
      output.prompt = THINKING_COMPACTION_PROMPT;

      // Save the prompt we injected
      await safeWrite(`${runDir}/prompt.txt`, output.prompt);

      // Dump pre-compaction messages
      // v1 SDK: uses { path: { id } } not { sessionID }
      try {
        const result = await client.session.messages({ path: { id: sessionID } });
        if (result.data && !result.error) {
          const messages = result.data as { info: Record<string, unknown>; parts: Record<string, unknown>[] }[];
          await safeWrite(`${runDir}/before.json`, JSON.stringify(messages, null, 2));
          await safeWrite(`${runDir}/before-slim.json`, JSON.stringify(messages.map(slimMessage), null, 2));
          await safeWrite(`${runDir}/before-stats.json`, JSON.stringify(computeStats(messages), null, 2));
        } else {
          await safeWrite(`${runDir}/before-error.json`, JSON.stringify({ error: result.error }, null, 2));
        }
      } catch (err) {
        await safeWrite(`${runDir}/before-error.json`, JSON.stringify({ error: String(err) }, null, 2));
      }

      await appendLine(
        join(DEBUG_DIR, "log"),
        `${new Date().toISOString()} compacting sessionID=${sessionID} runDir=${runDir} promptLength=${output.prompt.length}`,
      );
    },

    event: async ({ event }: { event: any }) => {
      if (event.type !== "session.compacted") return;

      const sessionID = (event as { type: "session.compacted"; properties: { sessionID: string } }).properties.sessionID;

      // Find the latest run directory for this session
      const shortSid = shortId(sessionID);
      let runDir: string | undefined;

      try {
        const entries = await readdir(DEBUG_DIR);
        const matches = entries
          .filter((e) => e.endsWith(`-${shortSid}`))
          .sort()
          .reverse(); // latest first
        if (matches.length > 0) {
          runDir = join(DEBUG_DIR, matches[0]);
        }
      } catch {
        // directory might not exist yet
      }

      // Dump post-compaction messages
      const targetDir = runDir || join(DEBUG_DIR, `after-${ts()}-${shortSid}`);
      try {
        const result = await client.session.messages({ path: { id: sessionID } });
        if (result.data && !result.error) {
          const messages = result.data as { info: Record<string, unknown>; parts: Record<string, unknown>[] }[];

          await safeWrite(`${targetDir}/after.json`, JSON.stringify(messages, null, 2));
          await safeWrite(`${targetDir}/after-slim.json`, JSON.stringify(messages.map(slimMessage), null, 2));

          const afterStats = computeStats(messages);
          await safeWrite(`${targetDir}/after-stats.json`, JSON.stringify(afterStats, null, 2));

          // Extract compaction summary
          const summaries = extractCompactionSummary(messages);
          if (summaries.length > 0) {
            await safeWrite(`${targetDir}/summary.txt`, summaries.join("\n\n---\n\n"));
          }

          // Load before-stats if available
          let beforeStats = afterStats;
          try {
            const { readFile } = await import("node:fs/promises");
            const raw = await readFile(`${targetDir}/before-stats.json`, "utf8");
            beforeStats = JSON.parse(raw);
          } catch {
            // no before-stats, use after-stats (degenerate)
          }

          const report = generateReport(beforeStats, afterStats, summaries, targetDir);
          await safeWrite(`${targetDir}/report.md`, report);
        } else {
          await safeWrite(`${targetDir}/after-error.json`, JSON.stringify({ error: result.error }, null, 2));
        }
      } catch (err) {
        await safeWrite(`${targetDir}/after-error.json`, JSON.stringify({ error: String(err) }, null, 2));
      }

      await appendLine(
        join(DEBUG_DIR, "log"),
        `${new Date().toISOString()} compacted sessionID=${sessionID}${runDir ? ` runDir=${runDir}` : ""}`,
      );
    },
  };
};

export default ThinkingCompactionPlugin;