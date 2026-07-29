/**
 * external-changes
 *
 * Injects a diff of changes that happened *outside* the session into the
 * next agent turn. Flow:
 *
 *   user: implement X
 *   agent: ... tools ... done!        <- agent_settled captures baseline
 *   <user edits files externally>
 *   user: now implement Y
 *   agent: <- before_agent_start computes diff(baseline, now) and injects it
 *
 * Uses `agent_settled` (fires after all retries/compactions/follow-ups have
 * settled) rather than `agent_end` so the baseline reflects the true end of
 * the agent's work, not an intermediate state before a retry.
 *
 * Baseline = (HEAD oid, stash-create ref). `git stash create` snapshots the
 * working tree + index without touching them; if the tree is clean the
 * baseline is just HEAD. At the next turn we report:
 *   - `git diff <baseline>`      -> tracked working-tree changes since baseline
 *   - `git log baselineHead..HEAD` -> new commits made externally
 *   - untracked files list       -> new files git doesn't track yet
 *
 * Silent when there is nothing to report. No-ops outside a git repo.
 */

import type { ExtensionAPI, ExecResult } from "@earendil-works/pi-coding-agent";

const MAX_DIFF_BYTES = 20_000;
const MAX_DIFF_LINES = 400;
const TRUNCATION_NOTE =
  "(diff truncated — run `git diff` yourself for the full output)";

/**
 * Minimal surface the git helpers depend on. `ExtensionAPI` satisfies this,
 * and tests can pass a mock that shells out to real git. Decoupling the git
 * logic from the pi lifecycle makes the core diff computation unit-testable
 * without driving a full agent turn through the test harness.
 */
export interface GitRunner {
  exec(
    command: string,
    args: string[],
    options?: { cwd?: string; timeout?: number; signal?: AbortSignal },
  ): Promise<ExecResult>;
}

export interface Baseline {
  head: string; // commit oid at baseline time (HEAD)
  stash: string; // `git stash create` ref, or "" if tree was clean
  untracked: Set<string>; // untracked files at baseline time
}

async function git(
  runner: GitRunner,
  args: string[],
  cwd: string,
  timeout = 5000,
): Promise<ExecResult> {
  return runner.exec("git", args, { cwd, timeout });
}

export async function isGitRepo(
  runner: GitRunner,
  cwd: string,
): Promise<boolean> {
  const r = await git(runner, ["rev-parse", "--is-inside-work-tree"], cwd);
  return r.code === 0 && r.stdout.trim() === "true";
}

async function headOid(
  runner: GitRunner,
  cwd: string,
): Promise<string | undefined> {
  const r = await git(runner, ["rev-parse", "HEAD"], cwd);
  if (r.code !== 0) return undefined;
  return r.stdout.trim() || undefined;
}

async function listUntracked(
  runner: GitRunner,
  cwd: string,
): Promise<Set<string>> {
  const r = await git(
    runner,
    ["status", "--porcelain", "--untracked-files=all"],
    cwd,
  );
  if (r.code !== 0) return new Set();
  const out = new Set<string>();
  for (const line of r.stdout.split("\n")) {
    if (line.length < 3) continue;
    const status = line.slice(0, 2);
    if (status !== "??") continue;
    const raw = line.slice(3).trim().replace(/^"|"$/g, "");
    if (raw) out.add(raw);
  }
  return out;
}

export async function captureBaseline(
  runner: GitRunner,
  cwd: string,
): Promise<Baseline | undefined> {
  const head = await headOid(runner, cwd);
  if (!head) return undefined; // no commits yet, or not a repo
  const stashR = await git(runner, ["stash", "create"], cwd);
  const stash = stashR.code === 0 ? stashR.stdout.trim() : "";
  const untracked = await listUntracked(runner, cwd);
  return { head, stash, untracked };
}

/** Diff the working tree against the baseline. Returns "" if no changes. */
export async function diffSinceBaseline(
  runner: GitRunner,
  cwd: string,
  baseline: Baseline,
): Promise<string> {
  const ref = baseline.stash || baseline.head;
  const r = await git(runner, ["diff", "--no-color", ref], cwd, 10_000);
  if (r.code !== 0) return "";
  return r.stdout;
}

/** New commits made externally (HEAD moved since baseline). */
export async function newCommitsSinceBaseline(
  runner: GitRunner,
  cwd: string,
  baseline: Baseline,
): Promise<string> {
  if (!baseline.head) return "";
  const r = await git(
    runner,
    ["log", "--no-color", "--oneline", `${baseline.head}..HEAD`],
    cwd,
  );
  if (r.code !== 0) return "";
  return r.stdout.trim();
}

/** Untracked files that appeared since baseline. */
export async function newUntrackedSinceBaseline(
  runner: GitRunner,
  cwd: string,
  baseline: Baseline,
): Promise<string[]> {
  const current = await listUntracked(runner, cwd);
  const fresh: string[] = [];
  for (const f of current) if (!baseline.untracked.has(f)) fresh.push(f);
  fresh.sort();
  return fresh;
}

function truncate(diff: string): string {
  if (!diff) return "";
  if (diff.length <= MAX_DIFF_BYTES) return diff;
  const lines = diff.split("\n");
  if (lines.length <= MAX_DIFF_LINES) return diff;
  return lines.slice(0, MAX_DIFF_LINES).join("\n") + `\n${TRUNCATION_NOTE}`;
}

export function buildMessage(
  diff: string,
  commits: string,
  untracked: string[],
): string | undefined {
  const parts: string[] = [];

  if (commits) {
    parts.push(
      `New commits made outside this session since the last agent run:\n${commits}`,
    );
  }
  if (diff.trim()) {
    parts.push(
      `Uncommitted changes made outside this session since the last agent run (git diff against the prior baseline):\n\`\`\`diff\n${truncate(
        diff,
      )}\n\`\`\``,
    );
  }
  if (untracked.length > 0) {
    parts.push(
      `New untracked files added outside this session:\n${untracked
        .map((f) => `- ${f}`)
        .join("\n")}`,
    );
  }

  if (parts.length === 0) return undefined;
  return [
    "<external-changes>",
    "The following changes were made outside this session between agent runs. Take them into account before acting on the user's request.",
    ...parts,
    "</external-changes>",
  ].join("\n");
}

/**
 * Compute the drift message for the current working tree relative to a
 * previously captured baseline. Returns `undefined` when there is nothing
 * to report. Exported so tests can exercise the full pipeline against a
 * real git repo without driving an agent turn.
 */
export async function computeDrift(
  runner: GitRunner,
  cwd: string,
  baseline: Baseline,
): Promise<string | undefined> {
  const [diff, commits, untracked] = await Promise.all([
    diffSinceBaseline(runner, cwd, baseline),
    newCommitsSinceBaseline(runner, cwd, baseline),
    newUntrackedSinceBaseline(runner, cwd, baseline),
  ]);
  return buildMessage(diff, commits, untracked);
}

export default function (pi: ExtensionAPI) {
  let baseline: Baseline | undefined;

  const capture = async (cwd: string) => {
    try {
      baseline = await captureBaseline(pi, cwd);
    } catch {
      baseline = undefined;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    if (!(await isGitRepo(pi, ctx.cwd))) {
      baseline = undefined;
      return;
    }
    await capture(ctx.cwd);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!(await isGitRepo(pi, ctx.cwd))) {
      baseline = undefined;
      return;
    }
    await capture(ctx.cwd);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!baseline) return;
    if (!(await isGitRepo(pi, ctx.cwd))) {
      baseline = undefined;
      return;
    }

    const content = await computeDrift(pi, ctx.cwd, baseline);
    if (!content) return;

    return {
      message: {
        customType: "external-changes",
        content,
        display: true,
      },
    };
  });
}
