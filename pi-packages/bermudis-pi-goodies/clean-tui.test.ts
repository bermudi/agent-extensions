import { describe, expect, test } from "bun:test";
import { Box, Container } from "@earendil-works/pi-tui";
import cleanTui, {
  __clearSummaryCache,
  __setSummaryBackoffForTesting,
  __setSummaryEnabled,
  __setSummaryKeyFileForTesting,
} from "./clean-tui";
import { PiHarness } from "pi-harness";
import { homedir } from "node:os";
import { join } from "node:path";
import { setSummaryModel, __setConfigPathForTesting } from "./goodies";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

function textOf(component: unknown): string {
  // Box children are Text components holding a raw `text` string
  const box = component as { children?: Array<{ text?: string }> } | undefined;
  return box?.children?.map((c) => c.text ?? "").join("\n") ?? "";
}

/** A replayed assistant message entry carrying tool calls (session format). */
function assistantMessage(...toolCalls: Array<{ id: string; name: string }>) {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: toolCalls.map((tc) => ({
        type: "toolCall",
        id: tc.id,
        name: tc.name,
        arguments: {},
      })),
    },
  };
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

  test("consecutive same-tool calls group during replay (same assistant message)", () => {
    const h = freshHarness();
    h.ctx.sessionManager.branch = [
      assistantMessage(
        { id: "a", name: "read" },
        { id: "b", name: "read" },
        { id: "c", name: "read" },
      ),
    ];
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
    h2.ctx.sessionManager.branch = [
      assistantMessage(
        { id: "r1", name: "read" },
        { id: "sh", name: "bash" },
        { id: "r2", name: "read" },
      ),
    ];
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

  test("replayed same-tool calls in different assistant messages do not group", () => {
    // Assistant messages are burst boundaries: pi streams a message's prose
    // before its tools render, so merging across messages would drag later
    // calls above the text that chronologically precedes them.
    const h = freshHarness();
    h.ctx.sessionManager.branch = [
      assistantMessage({ id: "a", name: "read" }),
      assistantMessage({ id: "b", name: "read" }),
    ];
    h.emit("session_start", { reason: "resume" });

    const a = h.row("read", "a");
    const b = h.row("read", "b");
    a.setArgs({ path: "/tmp/a.ts" });
    b.setArgs({ path: "/tmp/b.ts" });
    expect(textOf(a.lastCallComponent)).not.toContain("×2");
    expect(textOf(b.lastCallComponent)).not.toContain("×2");
  });

  test("a replayed image read splits its burst once the result lands", () => {
    const h = freshHarness();
    h.ctx.sessionManager.branch = [
      assistantMessage(
        { id: "a", name: "read" },
        { id: "img", name: "read" },
        { id: "b", name: "read" },
      ),
    ];
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

  test("live bursts group within one assistant message", () => {
    // Regression guard for the mega-burst: bursts must break at assistant
    // messages, not accumulate across an entire agent run.
    const h = freshHarness();
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");

    // Assistant message 1 streams (thinking + two parallel reads).
    h.emit("message_start", { message: { role: "assistant" } });
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

    // Assistant message 2 (text + another read): its tools start a fresh
    // burst instead of being dragged into message 1's block.
    h.emit("message_start", { message: { role: "assistant" } });
    const c = h.row("read", "c");
    c.setArgs({ path: "/tmp/c.ts" });
    expect(textOf(a.lastCallComponent)).toContain("×2");
    expect(textOf(a.lastCallComponent)).not.toContain("×3");
    expect(textOf(c.lastCallComponent)).not.toContain("×2");

    // agent_start alone does not break a burst — assistant messages do.
    // (Every real run begins with an assistant message; this pins the rule.)
    h.emit("agent_start");
    const d = h.row("read", "d");
    d.setArgs({ path: "/tmp/d.ts" });
    expect(textOf(c.lastCallComponent)).toContain("×2");
  });

  test("the user example: 2x read, prose, edit", () => {
    // Message 1: thinking + two parallel reads. Message 2: text + an edit.
    // Display must interleave: [read ×2] prose [edit] — never
    // [read ×2 + edit] above the prose.
    const h = freshHarness();
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");

    h.emit("message_start", { message: { role: "assistant" } });
    const r1 = h.row("read", "r1");
    const r2 = h.row("read", "r2");
    r1.setArgs({ path: "/tmp/a.ts" });
    r2.setArgs({ path: "/tmp/b.ts" });
    r1.setResult({ content: ["ok"] });
    r2.setResult({ content: ["ok"] });
    expect(textOf(r1.lastCallComponent)).toContain("read ×2");

    h.emit("message_start", { message: { role: "assistant" } });
    const e = h.row("edit", "e1");
    e.setArgs({ path: "/tmp/a.ts" });
    e.setResult({ content: ["ok"] });
    expect(textOf(r1.lastCallComponent)).not.toContain("edit");
    expect(textOf(e.lastCallComponent)).toContain("edit");
    expect(textOf(e.lastCallComponent)).not.toContain("×2");
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
      // A summary replaces the heuristic hint entirely — no redundant
      // "(+N lines)" next to a sentence that already describes the command.
      expect(textOf(row.lastCallComponent)).not.toContain("(+3 lines)");
      expect(seenAuth).toBe("Bearer test-key");
    } finally {
      globalThis.fetch = origFetch;
      if (origKey === undefined) delete process.env.ONEMIN_API_KEY;
      else process.env.ONEMIN_API_KEY = origKey;
      __setSummaryEnabled(false);
      __clearSummaryCache();
    }
  });

  test("summary is normalized to one line and capped at 80 chars", async () => {
    const origFetch = globalThis.fetch;
    const origKey = process.env.ONEMIN_API_KEY;
    process.env.ONEMIN_API_KEY = "test-key";
    globalThis.fetch = async () =>
      ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  '"Runs GLM model  with four   reasoning levels and shows token usage plus verbose error diagnostics"',
              },
            },
          ],
        }),
      }) as any;
    try {
      __clearSummaryCache();
      __setSummaryEnabled(true);
      const h = new PiHarness();
      cleanTui(h.api);
      h.emit("session_start", { reason: "startup" });
      h.emit("agent_start");
      const row = h.row("bash", "norm");
      row.setArgs({ command: heredoc });
      await new Promise((r) => setTimeout(r, 20));
      const text = textOf(row.lastCallComponent);
      expect(text).toContain("Runs GLM model with four");
      expect(text).not.toContain('"');
      expect(text).not.toContain("  "); // collapsed whitespace
      expect(text.length).toBeLessThanOrEqual(120); // 80-char summary cap
    } finally {
      globalThis.fetch = origFetch;
      if (origKey === undefined) delete process.env.ONEMIN_API_KEY;
      else process.env.ONEMIN_API_KEY = origKey;
      __setSummaryEnabled(false);
      __clearSummaryCache();
    }
  });

  test("bash bullets keep up to 80 chars of the command", () => {
    const h = freshHarness();
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");

    // A real burst: both rows render as bullets under one "bash ×2" header.
    // 80-char command fits whole; 85-char command ellipsizes at 80 columns.
    const cmdA = "echo " + "a".repeat(74); // 79 chars — fits whole
    const cmdB = "echo " + "b".repeat(80); // 85 chars — ellipsizes at 80
    const a = h.row("bash", "a");
    a.setArgs({ command: cmdA });
    const b = h.row("bash", "b");
    b.setArgs({ command: cmdB });
    b.setResult({ content: ["ok"] });
    a.setResult({ content: ["ok"] });

    const text = textOf(a.lastCallComponent);
    expect(text).toContain("a".repeat(74));
    expect(text).toContain("b".repeat(75) + "…");
  });

  test("summary model is configurable via goodies config", async () => {
    const origFetch = globalThis.fetch;
    const origKey = process.env.ONEMIN_API_KEY;
    process.env.ONEMIN_API_KEY = "test-key";
    // Redirect the goodies config to a temp file so we don't touch the real one.
    const tmpDir = mkdtempSync(join(tmpdir(), "goodies-cfg-"));
    __setConfigPathForTesting(join(tmpDir, "goodies.json"));
    let seenModel: string | undefined;
    globalThis.fetch = async (_url: any, init: any) => {
      seenModel = JSON.parse(init?.body ?? "{}").model;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "some summary" } }],
        }),
      } as any;
    };
    try {
      __clearSummaryCache();
      __setSummaryEnabled(true);
      setSummaryModel("openai/gpt-oss-20b");
      const h = new PiHarness();
      cleanTui(h.api);
      h.emit("session_start", { reason: "startup" });
      h.emit("agent_start");
      const row = h.row("bash", "cfg");
      row.setArgs({ command: heredoc });
      await new Promise((r) => setTimeout(r, 20));
      expect(seenModel).toBe("openai/gpt-oss-20b");
    } finally {
      globalThis.fetch = origFetch;
      if (origKey === undefined) delete process.env.ONEMIN_API_KEY;
      else process.env.ONEMIN_API_KEY = origKey;
      setSummaryModel(undefined);
      __setSummaryEnabled(false);
      __clearSummaryCache();
      __setConfigPathForTesting(
        join(homedir(), ".pi", "agent", "goodies.json"),
      );
    }
  });

  test("429 engages a backoff instead of retrying on every render", async () => {
    // Regression: a failed summary was neither cached nor penalized, so every
    // bash re-render re-fired the request — a single 429 turned into a
    // render-driven retry storm that kept the rate limiter hot all session.
    const origFetch = globalThis.fetch;
    const origKey = process.env.ONEMIN_API_KEY;
    const origErr = console.error;
    process.env.ONEMIN_API_KEY = "test-key";
    __setSummaryBackoffForTesting(100, 60_000);
    let calls = 0;
    let succeed = false;
    globalThis.fetch = async () => {
      calls++;
      if (!succeed)
        return { ok: false, status: 429, headers: { get: () => null } } as any;
      return {
        ok: true,
        json: async () => ({
          choices: [
            { message: { content: "Lists agent settings and extensions" } },
          ],
        }),
      } as any;
    };
    console.error = () => {}; // expected failure log stays out of test output
    try {
      __clearSummaryCache();
      __setSummaryEnabled(true);
      const h = new PiHarness();
      cleanTui(h.api);
      h.emit("session_start", { reason: "startup" });
      h.emit("agent_start");
      const cmd = "echo " + "x".repeat(90);
      const row = h.row("bash", "rl");
      row.setArgs({ command: cmd });
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toBe(1);
      // Re-renders during the backoff window must not re-fire the request.
      row.setResult({ content: ["ok"] });
      row.setArgs({ command: cmd });
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toBe(1);
      expect(textOf(row.lastCallComponent)).not.toContain(
        "Lists agent settings and extensions",
      );
      // After the cooldown the next render retries and recovers.
      succeed = true;
      await new Promise((r) => setTimeout(r, 120));
      row.setArgs({ command: cmd });
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toBe(2);
      expect(textOf(row.lastCallComponent)).toContain(
        "Lists agent settings and extensions",
      );
      // Cached: further renders don't refetch.
      row.setArgs({ command: cmd });
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = origFetch;
      if (origKey === undefined) delete process.env.ONEMIN_API_KEY;
      else process.env.ONEMIN_API_KEY = origKey;
      __setSummaryEnabled(false);
      __clearSummaryCache();
      __setSummaryBackoffForTesting(30_000, 15 * 60_000);
      console.error = origErr;
    }
  });

  test("a success resets the failure streak", async () => {
    // Without a reset, one old 429 would double every future cooldown forever.
    const origFetch = globalThis.fetch;
    const origKey = process.env.ONEMIN_API_KEY;
    const origErr = console.error;
    process.env.ONEMIN_API_KEY = "test-key";
    __setSummaryBackoffForTesting(100, 60_000);
    let calls = 0;
    let fail = true;
    globalThis.fetch = async () => {
      calls++;
      if (fail)
        return { ok: false, status: 429, headers: { get: () => null } } as any;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: `summary ${calls}` } }],
        }),
      } as any;
    };
    console.error = () => {};
    try {
      __clearSummaryCache();
      __setSummaryEnabled(true);
      const h = new PiHarness();
      cleanTui(h.api);
      h.emit("session_start", { reason: "startup" });
      h.emit("agent_start");
      const cmdA = "echo " + "a".repeat(90);
      const cmdB = "echo " + "b".repeat(90);
      const rowA = h.row("bash", "a");
      rowA.setArgs({ command: cmdA });
      await new Promise((r) => setTimeout(r, 10)); // failure 1 → paused 100ms
      fail = false;
      await new Promise((r) => setTimeout(r, 120));
      rowA.setArgs({ command: cmdA }); // retry succeeds → streak reset
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toBe(2);
      // A fresh failure now waits the BASE cooldown (100ms), not 2×base.
      fail = true;
      const rowB = h.row("bash", "b");
      rowB.setArgs({ command: cmdB });
      await new Promise((r) => setTimeout(r, 10)); // failure 2
      fail = false;
      await new Promise((r) => setTimeout(r, 120));
      rowB.setArgs({ command: cmdB }); // retry succeeds only if streak was reset
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toBe(4);
    } finally {
      globalThis.fetch = origFetch;
      if (origKey === undefined) delete process.env.ONEMIN_API_KEY;
      else process.env.ONEMIN_API_KEY = origKey;
      __setSummaryEnabled(false);
      __clearSummaryCache();
      __setSummaryBackoffForTesting(30_000, 15 * 60_000);
      console.error = origErr;
    }
  });

  test("an explicit Retry-After header extends the pause", async () => {
    const origFetch = globalThis.fetch;
    const origKey = process.env.ONEMIN_API_KEY;
    const origErr = console.error;
    process.env.ONEMIN_API_KEY = "test-key";
    __setSummaryBackoffForTesting(20, 60_000);
    let calls = 0;
    let succeed = false;
    globalThis.fetch = async () => {
      calls++;
      if (!succeed)
        return {
          ok: false,
          status: 429,
          headers: {
            get: (name: string) => (name === "retry-after" ? "1" : null),
          },
        } as any;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "Recovers after retry-after" } }],
        }),
      } as any;
    };
    console.error = () => {};
    try {
      __clearSummaryCache();
      __setSummaryEnabled(true);
      const h = new PiHarness();
      cleanTui(h.api);
      h.emit("session_start", { reason: "startup" });
      h.emit("agent_start");
      const cmd = "echo " + "y".repeat(90);
      const row = h.row("bash", "ra");
      row.setArgs({ command: cmd });
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toBe(1);
      // Tiny base backoff (20ms) has long passed, but Retry-After: 1 holds.
      await new Promise((r) => setTimeout(r, 150));
      row.setArgs({ command: cmd });
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toBe(1);
      succeed = true;
      await new Promise((r) => setTimeout(r, 950));
      row.setArgs({ command: cmd });
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = origFetch;
      if (origKey === undefined) delete process.env.ONEMIN_API_KEY;
      else process.env.ONEMIN_API_KEY = origKey;
      __setSummaryEnabled(false);
      __clearSummaryCache();
      __setSummaryBackoffForTesting(30_000, 15 * 60_000);
      console.error = origErr;
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
