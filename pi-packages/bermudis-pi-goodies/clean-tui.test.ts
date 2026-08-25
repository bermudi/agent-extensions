import { describe, expect, test } from "bun:test";
import { Box, Container } from "@earendil-works/pi-tui";
import cleanTui, {
  __clearSummaryCache,
  __setSummaryEnabled,
} from "./clean-tui";
import { PiHarness } from "pi-harness";

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
  test("replayed history renders solo and stays fast (regression: /resume freeze)", () => {
    const h = freshHarness();
    h.emit("session_start", { reason: "resume" });

    const start = Date.now();
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const row = h.row("read", `t${i}`);
      row.setArgs({ path: `/tmp/f${i}.ts` });
      row.setResult({ content: ["ok"] });
      // No turn_start fires during replay, so every row must be solo —
      // never a hidden follower of a cross-history mega-burst.
      expect(row.lastCallComponent instanceof Container).toBe(false);
    }
    const elapsed = Date.now() - start;
    // Cubic revalidation used to make this take minutes; solo replay is linear.
    expect(elapsed).toBeLessThan(5000);
  });

  test("live bursts still group after turn_start", () => {
    const h = freshHarness();
    h.emit("session_start", { reason: "startup" });
    h.emit("turn_start");

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

    // A new turn starts a fresh burst.
    h.emit("turn_start");
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
    h.emit("turn_start");

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
    globalThis.fetch = async () =>
      ({
        ok: true,
        json: async () => ({
          choices: [
            { message: { content: "Appends reboot log to migration file" } },
          ],
        }),
      }) as any;
    try {
      __clearSummaryCache();
      __setSummaryEnabled(true);
      const h = new PiHarness();
      cleanTui(h.api);
      h.emit("session_start", { reason: "startup" });
      h.emit("turn_start");
      const row = h.row("bash", "ai");
      row.setArgs({ command: heredoc });
      // initially shows heuristic
      expect(textOf(row.lastCallComponent)).toContain("(+3 lines)");
      // wait for async summary to arrive and invalidate
      await new Promise((r) => setTimeout(r, 20));
      expect(textOf(row.lastCallComponent)).toContain(
        "Appends reboot log to migration file",
      );
    } finally {
      globalThis.fetch = origFetch;
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
    h.emit("turn_start");
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
    h.emit("turn_start");
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
    h.emit("turn_start");
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
