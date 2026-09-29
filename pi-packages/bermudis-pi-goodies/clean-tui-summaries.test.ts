import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { PiHarness } from "pi-harness";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import cleanTui, {
  __clearSummaryCache,
  __setSummaryBackendForTesting,
  __setSummaryEnabled,
  __setSummaryLogPathForTesting,
} from "./clean-tui";
import { summaryCache } from "./clean-tui-summaries";
import { setSummaryModel, __setConfigPathForTesting } from "./goodies";

// Every cleanTui() load appends a line to the summary log; keep all tests off
// the real ~/.pi/agent/goodies.log by pointing at throwaway storage per test.
beforeEach(() => {
  __setSummaryLogPathForTesting(
    join(
      tmpdir(),
      `goodies-log-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    ),
  );
});
afterEach(() => __setSummaryLogPathForTesting(undefined));

// Regression tests for the empty-summary guard: model output that only
// normalizes to nothing must never enter summaryCache — a cached "" renders
// as the command's whole summary line (blanking it) and, worse,
// requestSummary's summaryCache.has(cmd) guard would suppress every future
// re-request for that command. See summarizeWithRetries's normalize-to-empty
// failure in clean-tui-summaries.ts.
describe("clean-tui-summaries empty-output guard", () => {
  const heredoc = [
    "cat >> \"PsVita/Archive/MIGRATION-LOG.md\" << 'EOF'",
    "### First reboot verification — PASS",
    "detail",
    "EOF",
  ].join("\n");

  const cleanupFns: Array<() => void> = [];
  afterEach(() => {
    while (cleanupFns.length) cleanupFns.pop()!();
    __setSummaryBackendForTesting(undefined);
    __setSummaryEnabled(false);
    // Also resets the failure backoff the empty-summary path engages.
    __clearSummaryCache();
  });

  /** Swap in a scripted backend (in place of the provider call). */
  function scriptedBackend(
    impl: (cmd: string) => Promise<string> | string,
  ): string[] {
    const calls: string[] = [];
    __setSummaryBackendForTesting({
      summarize: async (cmd) => {
        calls.push(cmd);
        return impl(cmd);
      },
    });
    return calls;
  }

  /** Keep headless failure lines out of the test output; returns them. */
  function captureConsoleError(): string[] {
    const origErr = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => logged.push(args.join(" "));
    cleanupFns.push(() => {
      console.error = origErr;
    });
    return logged;
  }

  /** Redirect goodies config to scratch storage; auto-restores. */
  function useScratchConfig(): void {
    const tmpDir = mkdtempSync(join(tmpdir(), "goodies-cfg-"));
    __setConfigPathForTesting(join(tmpDir, "goodies.json"));
    // Restore ONLY the path. Clearing the config here would run after the real
    // path is restored when a test stacks two of these helpers (cleanups unwind
    // LIFO), wiping the user's actual ~/.pi/agent/goodies.json.
    cleanupFns.push(() => {
      __setConfigPathForTesting(
        join(homedir(), ".pi", "agent", "goodies.json"),
      );
    });
  }

  /** Feature-on baseline: scratch config with a placeholder model set. */
  function enableSummariesForTest(): void {
    useScratchConfig();
    // Value is arbitrary — the scripted backend bypasses resolution.
    setSummaryModel("test/model");
    __clearSummaryCache();
    __setSummaryEnabled(true);
  }

  function textOf(component: unknown): string {
    // Box children are Text components holding a raw `text` string
    const box = component as
      { children?: Array<{ text?: string }> } | undefined;
    return box?.children?.map((c) => c.text ?? "").join("\n") ?? "";
  }

  test("whitespace-only model output is not cached; the row keeps its fallback", async () => {
    const logged = captureConsoleError();
    const calls = scriptedBackend(() => "   \n  ");
    enableSummariesForTest();
    const h = new PiHarness();
    cleanTui(h.api);
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const row = h.row("bash", "blank");
    row.setArgs({ command: heredoc });
    // Fallback renders before the (non-)summary lands.
    expect(textOf(row.lastCallComponent)).toContain("(+3 lines)");
    await new Promise((r) => setTimeout(r, 20));
    // One attempt, no retries: the empty-summary failure is deterministic.
    expect(calls).toHaveLength(1);
    // Nothing cached — an entry here would blank the row AND block re-requests.
    expect(summaryCache.has(heredoc)).toBe(false);
    expect(summaryCache.size).toBe(0);
    // The row never swapped: raw-text fallback still in place.
    expect(textOf(row.lastCallComponent)).toContain("(+3 lines)");
    expect(textOf(row.lastCallComponent)).toContain("MIGRATION-LOG.md");
    // The failure surfaces (never silent) via the ordinary failure path.
    expect(logged.filter((l) => l.includes("empty summary"))).toHaveLength(1);
  });

  test("quote-only model output is not cached either", async () => {
    // '""' slips past convertSummaryResponse's blank-answer check (its
    // text.trim() is non-empty) — it only dies at the normalize-to-empty
    // guard, which is exactly the shape the real provider backend can hit.
    captureConsoleError();
    const calls = scriptedBackend(() => '""');
    enableSummariesForTest();
    const h = new PiHarness();
    cleanTui(h.api);
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const row = h.row("bash", "quoted");
    row.setArgs({ command: heredoc });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1);
    expect(summaryCache.has(heredoc)).toBe(false);
    expect(textOf(row.lastCallComponent)).toContain("(+3 lines)");
    expect(textOf(row.lastCallComponent)).not.toContain("Appends");
  });

  test("normal output is still cached and swaps the row (regression guard)", async () => {
    const calls = scriptedBackend(() => "Appends reboot log to migration file");
    enableSummariesForTest();
    const h = new PiHarness();
    cleanTui(h.api);
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const row = h.row("bash", "ok");
    row.setArgs({ command: heredoc });
    // initially shows heuristic
    expect(textOf(row.lastCallComponent)).toContain("(+3 lines)");
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1);
    // Cached under the full command key, normalized.
    expect(summaryCache.get(heredoc)).toBe(
      "Appends reboot log to migration file",
    );
    // And the row swaps to the summary.
    expect(textOf(row.lastCallComponent)).toContain(
      "Appends reboot log to migration file",
    );
  });
});
