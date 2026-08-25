import { describe, expect, test } from "bun:test";
import { Box, Container } from "@earendil-works/pi-tui";
import cleanTui from "./clean-tui";
import { PiHarness } from "pi-harness";

function textOf(component: unknown): string {
  // Box children are Text components holding a raw `text` string
  const box = component as { children?: Array<{ text?: string }> } | undefined;
  return box?.children?.map((c) => c.text ?? "").join("\n") ?? "";
}

function freshHarness(): PiHarness {
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
