import { describe, expect, test } from "bun:test";
import { Box, Container } from "@earendil-works/pi-tui";
import cleanTui, {
  __clearSummaryCache,
  __setSummaryEnabled,
  __setSummaryKeyFileForTesting,
} from "./clean-tui";
import { PiHarness } from "pi-harness";
import { homedir } from "node:os";
import { join } from "node:path";

function textOf(component: unknown): string {
  // Box children are Text components holding a raw `text` string
  const box = component as { children?: Array<{ text?: string }> } | undefined;
  return box?.children?.map((c) => c.text ?? "").join("\n") ?? "";
}

function freshHarness(): PiHarness {
  __clearSummaryCache();
  __setSummaryEnabled(false);
  const h = new PiHarness();
  cleanTui(h.api);
  return h;
}

describe("clean-tui resume/replay", () => {
  test("replayed history stays fast (regression: /resume freeze)", () => {
    const h = freshHarness();
    h.emit("session_start", { reason: "resume" });

    const start = Date.now();
    const N = 2000;
    for (let i = 0; i < N; i++) {
      // Alternate tools so bursts stay size 1 — this exercises the replay
      // path without one pathological mega-burst dominating the timing.
      const row = h.row(i % 2 ? "read" : "bash", `t${i}`);
      if (i % 2) row.setArgs({ path: `/tmp/f${i}.ts` });
      else row.setArgs({ command: `echo ${i}` });
      row.setResult({ content: ["ok"] });
    }
    const elapsed = Date.now() - start;
    // Cubic revalidation used to make this take minutes; bounded local
    // revalidation keeps replay linear.
    expect(elapsed).toBeLessThan(5000);
    expect(h.totalFallbacks).toBe(0);
  });

  test("consecutive same-tool calls group during replay", () => {
    const h = freshHarness();
    h.emit("session_start", { reason: "resume" });

    const a = h.row("read", "a");
    const b = h.row("read", "b");
    const c = h.row("read", "c");
    a.setArgs({ path: "/tmp/a.ts" });
    b.setArgs({ path: "/tmp/b.ts" });
    c.setArgs({ path: "/tmp/c.ts" });
    a.setResult({ content: ["ok"] });
    b.setResult({ content: ["ok"] });
    c.setResult({ content: ["ok"] });

    // Followers hide; the leader shows one burst block for all three.
    expect(b.lastCallComponent instanceof Container).toBe(true);
    expect(c.lastCallComponent instanceof Container).toBe(true);
    expect(textOf(a.lastCallComponent)).toContain("read ×3");

    // A different tool in between breaks the run.
    const h2 = freshHarness();
    h2.emit("session_start", { reason: "resume" });
    const r1 = h2.row("read", "r1");
    const sh = h2.row("bash", "sh");
    const r2 = h2.row("read", "r2");
    r1.setArgs({ path: "/tmp/1.ts" });
    sh.setArgs({ command: "echo hi" });
    r2.setArgs({ path: "/tmp/2.ts" });
    expect(textOf(r1.lastCallComponent)).not.toContain("×2");
    expect(textOf(r2.lastCallComponent)).not.toContain("×2");
  });

  test("a replayed image read splits its burst once the result lands", () => {
    const h = freshHarness();
    h.emit("session_start", { reason: "resume" });
    const a = h.row("read", "a");
    const img = h.row("read", "img");
    const b = h.row("read", "b");
    a.setArgs({ path: "/tmp/a.ts" });
    img.setArgs({ path: "/tmp/pic.png" });
    b.setArgs({ path: "/tmp/b.ts" });
    a.setResult({ content: ["ok"] });
    img.setResult({ content: [{ type: "image", data: "base64..." }] });
    b.setResult({ content: ["ok"] });

    // The image row must render solo (its image shows via pi's image layer);
    // the two text reads must not claim it in their headers.
    expect(img.lastCallComponent instanceof Container).toBe(false);
    expect(textOf(a.lastCallComponent)).not.toContain("×3");
    expect(textOf(b.lastCallComponent)).not.toContain("×3");
  });

  test("sequential calls across model round-trips still group (turn_start per round)", () => {
    // Regression: pi fires turn_start per model round-trip, not per user
    // message. An agent run with 3 sequential reads fires turn_start 3 times;
    // grouping keyed on turn boundaries never grouped anything live.
    const h = freshHarness();
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");

    const rows = ["a", "b", "c"].map((id) => {
      h.emit("turn_start"); // each tool call is its own model round-trip
      const row = h.row("read", id);
      row.setArgs({ path: `/tmp/${id}.ts` });
      row.setResult({ content: ["ok"] });
      h.emit("turn_end");
      return row;
    });

    expect(rows[1].lastCallComponent instanceof Container).toBe(true);
    expect(rows[2].lastCallComponent instanceof Container).toBe(true);
    expect(textOf(rows[0].lastCallComponent)).toContain("read ×3");
  });

  test("live bursts group within one agent run", () => {
    const h = freshHarness();
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");

    const a = h.row("read", "a");
    const b = h.row("read", "b");
    a.setArgs({ path: "/tmp/a.ts" });
    b.setArgs({ path: "/tmp/b.ts" });
    // Second call joins the burst as a hidden follower and refreshes its leader.
    expect(b.lastCallComponent instanceof Container).toBe(true);
    expect(textOf(a.lastCallComponent)).toContain("×2");

    a.setResult({ content: ["ok"] });
    b.setResult({ content: ["ok"] });
    expect(a.lastCallComponent instanceof Box).toBe(true);
    expect(textOf(a.lastCallComponent)).toContain("×2");

    // A different tool breaks the burst.
    const c = h.row("bash", "c");
    c.setArgs({ command: "echo hi" });
    expect(textOf(c.lastCallComponent)).not.toContain("×2");

    // A new agent run starts a fresh burst.
    h.emit("agent_start");
    const d = h.row("read", "d");
    d.setArgs({ path: "/tmp/c.ts" });
    expect(textOf(d.lastCallComponent)).not.toContain("×2");
  });
});

describe("clean-tui render reentrancy", () => {
  // Rows use pi's faithful semantics: ctx.invalidate() synchronously re-runs
  // updateDisplay(), which calls renderCall always and renderResult when a
  // result is present. Regression guard for infinite render churn.
  test("invalidation between burst rows settles instead of looping forever", () => {
    const h = freshHarness();
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");

    const rows = ["a", "b", "c"].map((id) => {
      const row = h.row("read", id);
      row.setArgs({ path: `/tmp/${id}.ts` });
      return row;
    });
    for (const row of rows) row.setResult({ content: ["ok"] });

    expect(h.totalFallbacks).toBe(0); // no swallowed renderer errors
    expect(h.totalUpdates).toBeLessThan(100);
  });
});

describe("clean-tui AI summary", () => {
  const heredoc = [
    "cat >> \"PsVita/Archive/MIGRATION-LOG.md\" << 'EOF'",
    "### First reboot verification — PASS",
    "detail",
    "EOF",
  ].join("\n");

  test("long command triggers AI summary and swaps display", async () => {
    const origFetch = globalThis.fetch;
    const origKey = process.env.ONEMIN_API_KEY;
    process.env.ONEMIN_API_KEY = "test-key";
    let seenAuth: string | undefined;
    globalThis.fetch = async (_url: any, init: any) => {
      seenAuth = init?.headers?.Authorization;
      return {
        ok: true,
        json: async () => ({
          choices: [
            { message: { content: "Appends reboot log to migration file" } },
          ],
        }),
      } as any;
    };
    try {
      __clearSummaryCache();
      __setSummaryEnabled(true);
      const h = new PiHarness();
      cleanTui(h.api);
      h.emit("session_start", { reason: "startup" });
      h.emit("agent_start");
      const row = h.row("bash", "ai");
      row.setArgs({ command: heredoc });
      // initially shows heuristic
      expect(textOf(row.lastCallComponent)).toContain("(+3 lines)");
      // wait for async summary to arrive and invalidate
      await new Promise((r) => setTimeout(r, 20));
      expect(textOf(row.lastCallComponent)).toContain(
        "Appends reboot log to migration file",
      );
      expect(seenAuth).toBe("Bearer test-key");
    } finally {
      globalThis.fetch = origFetch;
      if (origKey === undefined) delete process.env.ONEMIN_API_KEY;
      else process.env.ONEMIN_API_KEY = origKey;
      __setSummaryEnabled(false);
      __clearSummaryCache();
    }
  });

  test("missing API key logs once and keeps the heuristic hint", async () => {
    const origFetch = globalThis.fetch;
    const origKey = process.env.ONEMIN_API_KEY;
    const origErr = console.error;
    delete process.env.ONEMIN_API_KEY;
    let fetchCalled = 0;
    globalThis.fetch = async () => {
      fetchCalled++;
      throw new Error("should not be called without a key");
    };
    const logged: string[] = [];
    console.error = (...args: any[]) => logged.push(args.join(" "));
    // Point at a file that does not exist so the real key file is not read.
    __setSummaryKeyFileForTesting("/nonexistent/ONEMIN_API_KEY");
    try {
      __clearSummaryCache();
      __setSummaryEnabled(true);
      const h = new PiHarness();
      cleanTui(h.api);
      h.emit("session_start", { reason: "startup" });
      h.emit("agent_start");
      const row = h.row("bash", "nokey");
      row.setArgs({ command: heredoc });
      await new Promise((r) => setTimeout(r, 20));
      expect(fetchCalled).toBe(0); // no request without a key
      expect(textOf(row.lastCallComponent)).toContain("(+3 lines)"); // hint stays
      expect(logged.some((l) => l.includes("ONEMIN_API_KEY"))).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
      console.error = origErr;
      if (origKey !== undefined) process.env.ONEMIN_API_KEY = origKey;
      __setSummaryKeyFileForTesting(
        join(homedir(), ".pi", "agent", "ONEMIN_API_KEY"),
      );
      __setSummaryEnabled(false);
      __clearSummaryCache();
    }
  });
});

describe("clean-tui massive commands", () => {
  const heredoc = [
    "cat >> \"PsVita/Archive/MIGRATION-LOG.md\" << 'EOF'",
    "### First reboot verification — PASS",
    "Fresh log proves things worked",
    ...Array.from({ length: 20 }, (_, i) => `detail line ${i}`),
    "EOF",
  ].join("\n");

  test("multi-line heredoc collapses to first line + hint when collapsed", () => {
    const h = freshHarness();
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const row = h.row("bash", "big");
    row.setArgs({ command: heredoc });
    row.setResult({ content: ["(no output)"] });
    const text = textOf(row.lastCallComponent);
    expect(text).toContain(
      "cat >> \"PsVita/Archive/MIGRATION-LOG.md\" << 'EOF'",
    );
    expect(text).toContain("(+23 lines)");
    expect(text).not.toContain("detail line 5"); // body hidden
    expect(text.split("\n")).toHaveLength(1); // exactly one display line
  });

  test("expanding reveals the full command and output", () => {
    const h = freshHarness();
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const row = h.row("bash", "big");
    row.setArgs({ command: heredoc });
    row.setResult({ content: [{ type: "text", text: "done" }] });
    row.setExpanded(true);
    const text = textOf(row.lastCallComponent);
    expect(text).toContain("detail line 19"); // full command visible
    expect(text).toContain("done"); // output still shown
  });

  test("burst bullets stay single-line for multi-line commands", () => {
    const h = freshHarness();
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const a = h.row("bash", "a");
    const b = h.row("bash", "b");
    a.setArgs({ command: heredoc });
    b.setArgs({ command: "echo hi" });
    a.setResult({ content: ["ok"] });
    b.setResult({ content: ["ok"] });
    const text = textOf(a.lastCallComponent);
    expect(text).toContain("bash ×2");
    expect(text).toContain("(+23 lines)");
    expect(text).not.toContain("detail line 5");
  });
});
