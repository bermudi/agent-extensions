import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { Box, Container } from "@earendil-works/pi-tui";
import type { Model } from "@earendil-works/pi-ai";
import cleanTui, {
  __clearSummaryCache,
  __setSummaryBackoffForTesting,
  __setSummaryBackendForTesting,
  __setSummaryEnabled,
  __setSummaryLogPathForTesting,
  __setSummaryModelRegistryForTesting,
  __setSummaryRequestTimeoutForTesting,
  __setSummarySwapMaxAgeForTesting,
  __setSummaryUiForTesting,
  convertSummaryResponse,
  setCleanTuiActive,
} from "./clean-tui";
import { PiHarness, type Theme } from "pi-harness";
import { homedir } from "node:os";
import { join } from "node:path";
import { setSummaryModel, __setConfigPathForTesting } from "./goodies";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

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

describe("clean-tui pi-codex integration flag", () => {
  const FLAG = Symbol.for("bermudis-pi-goodies.clean-tui.active.v1");
  const globals = globalThis as Record<symbol, unknown>;

  test("loading the extension sets the flag; setCleanTuiActive(false) clears it", () => {
    delete globals[FLAG];
    const h = freshHarness(); // freshHarness loads clean-tui
    expect(globals[FLAG]).toBe(true);
    setCleanTuiActive(false);
    expect(globals[FLAG]).toBeUndefined();
  });
});

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

  test("replayed tool-only assistant messages chain into one burst", () => {
    // Burst boundaries are visible prose and thinking blocks, not the message
    // edge: messages carrying only tool calls (no text, no thinking block)
    // produce calls with no boundary between them — same block.
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
    expect(textOf(a.lastCallComponent)).toContain("read ×2");
    expect(b.lastCallComponent instanceof Container).toBe(true);
  });

  test("replayed thinking blocks between tool calls split bursts", () => {
    // The reported bug (OpenAI models): the Responses API emits a reasoning
    // item before every tool call, and reasoning text is often absent — the
    // persisted block arrives empty. Each block is a boundary, so the calls
    // no longer merge into one burst that hides the later call above the
    // thinking row it chronologically follows.
    const toolCall = (id: string, name: string) => ({
      type: "toolCall",
      id,
      name,
      arguments: {},
    });
    const withBlocks = (...blocks: unknown[]) => ({
      type: "message",
      message: { role: "assistant", content: blocks },
    });

    const h = freshHarness();
    h.ctx.sessionManager.branch = [
      withBlocks({ type: "thinking", thinking: "" }, toolCall("a", "read")),
      withBlocks({ type: "thinking", thinking: "" }, toolCall("b", "read")),
    ];
    h.emit("session_start", { reason: "resume" });
    const a = h.row("read", "a");
    const b = h.row("read", "b");
    a.setArgs({ path: "/tmp/a.ts" });
    b.setArgs({ path: "/tmp/b.ts" });
    expect(textOf(a.lastCallComponent)).not.toContain("×2");
    expect(b.lastCallComponent instanceof Container).toBe(false);

    // Reasoning interleaved between the calls of ONE message splits them too
    // (OpenAI Responses output items stream one by one into a single message).
    const h2 = freshHarness();
    h2.ctx.sessionManager.branch = [
      withBlocks(
        { type: "thinking", thinking: "" },
        toolCall("c", "read"),
        { type: "thinking", thinking: "" },
        toolCall("d", "read"),
      ),
    ];
    h2.emit("session_start", { reason: "resume" });
    const c = h2.row("read", "c");
    const d = h2.row("read", "d");
    c.setArgs({ path: "/tmp/c.ts" });
    d.setArgs({ path: "/tmp/d.ts" });
    expect(textOf(c.lastCallComponent)).not.toContain("×2");
    expect(d.lastCallComponent instanceof Container).toBe(false);

    // Parallel calls after a single thinking block still group: the block is
    // a boundary only where it actually sits between two calls.
    const h3 = freshHarness();
    h3.ctx.sessionManager.branch = [
      withBlocks(
        { type: "thinking", thinking: "planning the two reads" },
        toolCall("e", "read"),
        toolCall("f", "read"),
      ),
    ];
    h3.emit("session_start", { reason: "resume" });
    const e = h3.row("read", "e");
    const f = h3.row("read", "f");
    e.setArgs({ path: "/tmp/e.ts" });
    f.setArgs({ path: "/tmp/f.ts" });
    expect(textOf(e.lastCallComponent)).toContain("read ×2");
    expect(f.lastCallComponent instanceof Container).toBe(true);
  });

  test("replayed prose between messages keeps their bursts apart", () => {
    // pi streams a message's prose before its tools render, so merging across
    // text would drag later calls above the text that chronologically
    // precedes them. Assistant text and typed user text both break the run.
    const assistantWithText = (
      text: string,
      ...toolCalls: Array<{ id: string; name: string }>
    ) => ({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text },
          ...toolCalls.map((tc) => ({
            type: "toolCall",
            id: tc.id,
            name: tc.name,
            arguments: {},
          })),
        ],
      },
    });

    const h = freshHarness();
    h.ctx.sessionManager.branch = [
      assistantMessage({ id: "a", name: "read" }),
      assistantWithText("Now look elsewhere.", { id: "b", name: "read" }),
    ];
    h.emit("session_start", { reason: "resume" });
    const a = h.row("read", "a");
    const b = h.row("read", "b");
    a.setArgs({ path: "/tmp/a.ts" });
    b.setArgs({ path: "/tmp/b.ts" });
    expect(textOf(a.lastCallComponent)).not.toContain("×2");
    expect(textOf(b.lastCallComponent)).not.toContain("×2");

    const h2 = freshHarness();
    h2.ctx.sessionManager.branch = [
      assistantMessage({ id: "a", name: "read" }),
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "stop, do something else" }],
        },
      },
      assistantMessage({ id: "b", name: "read" }),
    ];
    h2.emit("session_start", { reason: "resume" });
    const ua = h2.row("read", "a");
    const ub = h2.row("read", "b");
    ua.setArgs({ path: "/tmp/a.ts" });
    ub.setArgs({ path: "/tmp/b.ts" });
    expect(textOf(ua.lastCallComponent)).not.toContain("×2");
    expect(textOf(ub.lastCallComponent)).not.toContain("×2");
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
    h.emit("message_update", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Now check something else." }],
      },
    });
    const c = h.row("read", "c");
    c.setArgs({ path: "/tmp/c.ts" });
    expect(textOf(a.lastCallComponent)).toContain("×2");
    expect(textOf(a.lastCallComponent)).not.toContain("×3");
    expect(textOf(c.lastCallComponent)).not.toContain("×2");

    // agent_start alone does not break a burst — visible prose does.
    // (Every real run begins with an assistant message; this pins the rule.)
    h.emit("agent_start");
    const d = h.row("read", "d");
    d.setArgs({ path: "/tmp/d.ts" });
    expect(textOf(c.lastCallComponent)).toContain("×2");
  });

  test("live: back-to-back tool-only assistant messages chain into one burst", () => {
    // Messages carrying only tool calls — no prose, no thinking block — never
    // bump the segment, so their calls chain into one block; the next
    // message's prose ends the chain.
    const h = freshHarness();
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");

    h.emit("message_start", { message: { role: "assistant" } });
    const a = h.row("bash", "a");
    a.setArgs({ command: "echo one" });

    h.emit("message_start", { message: { role: "assistant" } });
    const b = h.row("bash", "b");
    b.setArgs({ command: "echo two" });
    expect(textOf(a.lastCallComponent)).toContain("bash ×2");
    expect(b.lastCallComponent instanceof Container).toBe(true);

    h.emit("message_update", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "All done." }],
      },
    });
    h.emit("message_start", { message: { role: "assistant" } });
    const c = h.row("bash", "c");
    c.setArgs({ command: "echo three" });
    expect(textOf(a.lastCallComponent)).toContain("bash ×2");
    expect(textOf(a.lastCallComponent)).not.toContain("×3");
    expect(textOf(c.lastCallComponent)).not.toContain("×2");
  });

  test("live: a thinking block between tool calls splits the burst", () => {
    // The reported bug (OpenAI models): the Responses API emits a reasoning
    // item before every tool call, often with no reasoning text — the block
    // arrives empty. It must still end the open burst: a merged block would
    // render the later call inside the box above the thinking row it follows.
    const h = freshHarness();
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");

    h.emit("message_start", { message: { role: "assistant" } });
    const a = h.row("bash", "a");
    a.setArgs({ command: "echo one" });

    h.emit("message_start", { message: { role: "assistant" } });
    h.emit("message_update", {
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "" }],
      },
    });
    const b = h.row("bash", "b");
    b.setArgs({ command: "echo two" });
    expect(textOf(a.lastCallComponent)).not.toContain("×2");
    expect(textOf(b.lastCallComponent)).not.toContain("×2");
    expect(b.lastCallComponent instanceof Container).toBe(false);
  });

  test("live: reasoning interleaved between calls of one message splits them", () => {
    const h = freshHarness();
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");

    h.emit("message_start", { message: { role: "assistant" } });
    const a = h.row("bash", "a");
    a.setArgs({ command: "echo one" });
    // A second reasoning item streams into the same message between the calls.
    h.emit("message_update", {
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "a", name: "bash", arguments: {} },
          { type: "thinking", thinking: "" },
        ],
      },
    });
    const b = h.row("bash", "b");
    b.setArgs({ command: "echo two" });
    expect(textOf(a.lastCallComponent)).not.toContain("×2");
    expect(textOf(b.lastCallComponent)).not.toContain("×2");
  });

  test("live: parallel calls after one thinking block still group", () => {
    const h = freshHarness();
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");

    h.emit("message_start", { message: { role: "assistant" } });
    h.emit("message_update", {
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "planning two reads" }],
      },
    });
    const a = h.row("read", "a");
    const b = h.row("read", "b");
    a.setArgs({ path: "/tmp/a.ts" });
    b.setArgs({ path: "/tmp/b.ts" });
    expect(textOf(a.lastCallComponent)).toContain("read ×2");
    expect(b.lastCallComponent instanceof Container).toBe(true);
  });

  test("live: a typed user message closes the open burst", () => {
    const h = freshHarness();
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");

    h.emit("message_start", { message: { role: "assistant" } });
    const a = h.row("bash", "a");
    a.setArgs({ command: "echo one" });

    h.emit("message_start", {
      message: {
        role: "user",
        content: [{ type: "text", text: "actually, check this too" }],
      },
    });
    h.emit("message_start", { message: { role: "assistant" } });
    const b = h.row("bash", "b");
    b.setArgs({ command: "echo two" });
    expect(textOf(a.lastCallComponent)).not.toContain("×2");
    expect(textOf(b.lastCallComponent)).not.toContain("×2");
  });

  test("live: text between tool calls of one message splits them", () => {
    // Interleaved text-and-tools in a single message: the second call must
    // not be dragged into a burst rendered above the text.
    const h = freshHarness();
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");

    h.emit("message_start", { message: { role: "assistant" } });
    const a = h.row("bash", "a");
    a.setArgs({ command: "echo one" });
    h.emit("message_update", {
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "a", name: "bash", arguments: {} },
          { type: "text", text: "Now the second step." },
        ],
      },
    });
    const b = h.row("bash", "b");
    b.setArgs({ command: "echo two" });
    expect(textOf(a.lastCallComponent)).not.toContain("×2");
    expect(textOf(b.lastCallComponent)).not.toContain("×2");
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
    h.emit("message_update", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Replacing a.ts with an edit." }],
      },
    });
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

  const cleanupFns: Array<() => void> = [];
  afterEach(() => {
    while (cleanupFns.length) cleanupFns.pop()!();
    __setSummaryBackendForTesting(undefined);
    __setSummaryModelRegistryForTesting(undefined);
    __setSummaryEnabled(false);
  });

  /** Swap in a scripted backend (in place of the provider call). */
  function scriptedBackend(
    impl: (cmd: string, signal: AbortSignal) => Promise<string> | string,
  ): string[] {
    const calls: string[] = [];
    __setSummaryBackendForTesting({
      summarize: async (cmd, signal) => {
        calls.push(cmd);
        return impl(cmd, signal);
      },
    });
    return calls;
  }

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
    cleanupFns.push(() => {
      setSummaryModel(undefined);
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

  /** Redirect the summary log to scratch storage; returns its path. */
  function useScratchSummaryLog(): string {
    const tmpDir = mkdtempSync(join(tmpdir(), "goodies-log-"));
    const logPath = join(tmpDir, "goodies.log");
    __setSummaryLogPathForTesting(logPath);
    cleanupFns.push(() => __setSummaryLogPathForTesting(undefined));
    return logPath;
  }

  test("long command triggers AI summary and swaps display", async () => {
    scriptedBackend(() => "Appends reboot log to migration file");
    enableSummariesForTest();
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
  });

  test("summary swap is height-neutral at 110 columns (flicker regression)", async () => {
    // Regression (observed on 0.11.4 in a 110-col ghostty window): the solo
    // bash header was capped at 120 chars while summaries are capped at 80,
    // so an arriving summary collapsed a 2-line wrapped header to 1 line.
    // Total transcript height dropping below pi-tui's high-water mark
    // triggers clearOnShrink: a full clear-screen + scrollback wipe — a
    // visible flash per summarized command while the agent works. The
    // width-capped raw header (BASH_BULLET_WIDTH) keeps the swap from ever
    // shrinking: summaries render uncapped and can only add rows.
    scriptedBackend(() => "Typechecks the extension sources");
    enableSummariesForTest();
    const h = new PiHarness();
    cleanTui(h.api);
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const row = h.row("bash", "flicker");
    // 81–120 chars: the band 0.11.x summarizes (floor 80) but pre-0.11 did
    // not (floor 120). At 110 cols with the old 120-char header cap this
    // 112-char command wrapped to two lines until the summary collapsed it.
    const cmd =
      "cd ~/build/agent-extensions/pi-packages/bermudis-pi-goodies && rm -rf node_modules/.cache && bun run typecheck";
    expect(cmd.length).toBeGreaterThan(105);
    expect(cmd.length).toBeLessThanOrEqual(120);
    row.setArgs({ command: cmd });
    const before = (row.lastCallComponent as Box).render(110).length;
    await new Promise((r) => setTimeout(r, 20));
    expect(textOf(row.lastCallComponent)).toContain(
      "Typechecks the extension sources",
    );
    const after = (row.lastCallComponent as Box).render(110).length;
    expect(after).toBe(before);
  });

  test("summary swaps a row that finished while its summary was in flight", async () => {
    // Fast commands used to never show summaries: the row finished before the
    // ~2s summary landed, and finished rows kept raw text forever (anti-
    // flicker rule). Rows that finish DURING the flight are at most one
    // summary latency old at landing — still at the viewport tail — so they
    // swap. This is the exact burst residue: 2 of 4 summarized, 2 raw.
    scriptedBackend(() => "Typechecks the extension sources");
    enableSummariesForTest();
    const h = new PiHarness();
    cleanTui(h.api);
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const cmd =
      "cd ~/build/agent-extensions/pi-packages/bermudis-pi-goodies && bun run typecheck && bun run test";
    const row = h.row("bash", "fast");
    row.setArgs({ command: cmd }); // request fires here
    row.setResult({ content: [{ type: "text", text: "132 pass" }] }); // finishes mid-flight
    await new Promise((r) => setTimeout(r, 20));
    expect(textOf(row.lastCallComponent)).toContain(
      "Typechecks the extension sources",
    );
    expect(textOf(row.lastCallComponent)).not.toContain("&& bun run");
  });

  test("expanding swaps the summary out for the full raw command", async () => {
    // The compact header shows the AI summary INSTEAD of the command, so on
    // its own it hides what actually ran. ctrl+o must reveal the full raw
    // command — the summary yields while the row is expanded and returns on
    // collapse (observed: ctrl+o showed output only, command still hidden).
    scriptedBackend(() => "Runs pi with a restricted tool set");
    enableSummariesForTest();
    const h = new PiHarness();
    cleanTui(h.api);
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const cmd = "echo " + "x".repeat(90); // >80: summarizable, single line
    const row = h.row("bash", "expand-swap");
    row.setArgs({ command: cmd });
    row.setResult({ content: [{ type: "text", text: "ran fine" }] });
    await new Promise((r) => setTimeout(r, 20));
    const collapsed = textOf(row.lastCallComponent);
    expect(collapsed).toContain("Runs pi with a restricted tool set");
    expect(collapsed).not.toContain(cmd);
    row.setExpanded(true);
    const expanded = textOf(row.lastCallComponent);
    expect(expanded).toContain(cmd);
    expect(expanded).not.toContain("Runs pi with a restricted tool set");
    // Collapsing restores the compact summary view.
    row.setExpanded(false);
    expect(textOf(row.lastCallComponent)).toContain(
      "Runs pi with a restricted tool set",
    );
  });

  test("summaries never swap rows that finished long before the landing", async () => {
    // The 0.11.x flicker regression: invalidating finished rows far above the
    // viewport (replayed history, old rows) triggers pi's fullRender(true) —
    // clear screen + scrollback wipe. The freshness window bounds the swap to
    // rows still at the viewport tail; with the window at zero, even a
    // just-finished row keeps raw text, proving the guard bites.
    __setSummarySwapMaxAgeForTesting(0);
    cleanupFns.push(() => __setSummarySwapMaxAgeForTesting(10_000));
    scriptedBackend(() => "Typechecks the extension sources");
    enableSummariesForTest();
    const h = new PiHarness();
    cleanTui(h.api);
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const cmd =
      "cd ~/build/agent-extensions/pi-packages/bermudis-pi-goodies && bun run typecheck && bun run test";
    const done = h.row("bash", "done");
    done.setArgs({ command: cmd });
    done.setResult({ content: [{ type: "text", text: "132 pass" }] });
    const updatesAfterResult = done.updates;
    await new Promise((r) => setTimeout(r, 20));
    // Summary arrived (cache populated) but must NOT have re-rendered the
    // finished row.
    expect(done.updates).toBe(updatesAfterResult);
    expect(textOf(done.lastCallComponent)).toContain("&& bun run");
    expect(textOf(done.lastCallComponent)).not.toContain(
      "Typechecks the extension sources",
    );
    // A future row for the same command still gets the summary immediately:
    // it bursts with the finished row (same command), renders as a follower,
    // and its render hop refreshes the leader — whose bullets now show the
    // cached summary. No network, no finished-row invalidation.
    const fresh = h.row("bash", "fresh");
    fresh.setArgs({ command: cmd });
    expect(textOf(done.lastCallComponent)).toContain(
      "Typechecks the extension sources",
    );
  });

  test("summary is normalized to one line and not capped", async () => {
    scriptedBackend(
      () =>
        '"Runs GLM model  with four   reasoning levels and shows token usage plus verbose error diagnostics"',
    );
    enableSummariesForTest();
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
    expect(text).toContain("verbose error diagnostics"); // uncapped: tail survives
    expect(text.length).toBeGreaterThan(80);
  });

  test("bash bullets keep up to 100 chars of the command", () => {
    const h = freshHarness();
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");

    // A real burst: both rows render as bullets under one "bash ×2" header.
    // 100-char command fits whole; 105-char command ellipsizes to 99 + "…".
    const cmdA = "echo " + "a".repeat(95); // 100 chars — fits whole
    const cmdB = "echo " + "b".repeat(100); // 105 chars — 99 chars + ellipsis
    const a = h.row("bash", "a");
    a.setArgs({ command: cmdA });
    const b = h.row("bash", "b");
    b.setArgs({ command: cmdB });
    b.setResult({ content: ["ok"] });
    a.setResult({ content: ["ok"] });

    const text = textOf(a.lastCallComponent);
    expect(text).toContain("a".repeat(95));
    expect(text).toContain("b".repeat(94) + "…");
  });

  test("unset summary-model means off: zero requests, zero noise", async () => {
    // The feature costs nothing until the user picks a model — no network,
    // no resolution work, and no error spam about a config they never made.
    const calls = scriptedBackend(() => "should never run");
    const logged = captureConsoleError();
    // Scratch config, but NO setSummaryModel call: exactly what fresh installs
    // look like. (Without the scratch redirect this test would read the real
    // ~/.pi/agent/goodies.json — on machines where summary-model is set, the
    // "off" premise silently breaks. Found the hard way.)
    useScratchConfig();
    __clearSummaryCache();
    __setSummaryEnabled(true);
    const h = new PiHarness();
    cleanTui(h.api);
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const row = h.row("bash", "off");
    row.setArgs({ command: heredoc });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(0);
    expect(logged).toHaveLength(0); // off is a state, not an error
    expect(textOf(row.lastCallComponent)).toContain("(+3 lines)");
  });

  test("every summary request lands in the log as structured JSONL", async () => {
    // console.error vanishes in TUI mode, so the log is the durable record —
    // one summary_request event per attempt (success or failure), queryable
    // with jq. Two distinct commands → two failed requests; the load line is
    // structured too.
    const logPath = useScratchSummaryLog();
    const logged = captureConsoleError();
    // Zero backoff so a second command re-requests instead of being blocked.
    __setSummaryBackoffForTesting(0, 0);
    cleanupFns.push(() => __setSummaryBackoffForTesting(30_000, 15 * 60_000));
    scriptedBackend(() => {
      throw new Error("summary request failed: HTTP 429 (kilo/x)");
    });
    enableSummariesForTest();
    const h = new PiHarness();
    cleanTui(h.api); // writes the load event
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const row = h.row("bash", "log-a");
    row.setArgs({ command: heredoc });
    const row2 = h.row("bash", "log-b");
    row2.setArgs({ command: `${heredoc}\n# variant` });
    await new Promise((r) => setTimeout(r, 50));
    const events = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const load = events[0];
    expect(load.type).toBe("load");
    expect(load.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(load.summaryModel).toBe("test/model");
    const failures = events.filter(
      (e) => e.type === "summary_request" && e.outcome === "failed",
    );
    expect(failures).toHaveLength(2); // one per distinct command
    for (const f of failures) {
      expect(f.error).toContain("HTTP 429 (kilo/x)");
      expect(typeof f.ts).toBe("string");
    }
    expect(failures[0].cmd).toBeUndefined(); // raw command is never logged
    expect(failures[0].digest).not.toBe(failures[1].digest); // distinct cmds
    // The raw command text must not appear anywhere in the log — it can carry
    // inline tokens, passwords, and private URLs. "MIGRATION-LOG" is a real
    // sentinel from this test's heredoc, so this would fail against the old
    // cmd.slice(0,200) logging.
    const rawLog = readFileSync(logPath, "utf-8");
    expect(rawLog).not.toContain("MIGRATION-LOG");
    expect(rawLog).not.toContain("First reboot verification");
    // Console stays short (pi's TUI prints stderr inline — a full error body
    // once plastered a screen-width JSON blob across the transcript); the
    // file carries the detail.
    const consoleLine = logged.find((l) => l.includes("[clean-tui]"));
    expect(consoleLine).toContain("HTTP 429 (kilo/x)");
    expect(consoleLine).toContain("details in ~/.pi/agent/goodies.log");
  });

  test("failures show a pause widget; recovery clears it", async () => {
    // pi's TUI prints extension stderr inline, so console.error plastered a
    // screen-width error blob across the transcript. With a UI present the
    // failure surfaces as a widget line above the editor instead, and the
    // first success clears it. Console stays quiet while the widget lives.
    const widgets: Array<[string, string[] | undefined]> = [];
    __setSummaryUiForTesting({
      hasUI: true,
      setWidget: (key, content) => widgets.push([key, content]),
    });
    cleanupFns.push(() => __setSummaryUiForTesting(undefined));
    __setSummaryBackoffForTesting(0, 0);
    cleanupFns.push(() => __setSummaryBackoffForTesting(30_000, 15 * 60_000));
    let fail = true;
    scriptedBackend(() => {
      if (fail) throw new Error("summary request failed: HTTP 429 (kilo/x)");
      return "Recovers the summary stream";
    });
    enableSummariesForTest();
    const h = new PiHarness();
    cleanTui(h.api);
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const row = h.row("bash", "widget");
    row.setArgs({ command: heredoc });
    await new Promise((r) => setTimeout(r, 20));
    const shown = widgets.at(-1);
    expect(shown?.[0]).toBe("bermudis-pi-goodies.summaries");
    expect(shown?.[1]?.[0]).toContain("⏸ summaries");
    expect(shown?.[1]?.[0]).toContain("HTTP 429");
    // Recovery: first success clears the widget.
    fail = false;
    row.setArgs({ command: heredoc }); // re-render retries (backoff 0)
    await new Promise((r) => setTimeout(r, 20));
    expect(widgets.at(-1)?.[1]).toBeUndefined();
    expect(textOf(row.lastCallComponent)).toContain(
      "Recovers the summary stream",
    );
  });

  test("session_start wires the widget from a realistic context", async () => {
    // Regression: the capture used to store ctx.ui itself, whose type has no
    // hasUI flag — summaryUi.hasUI was always undefined, so every TUI failure
    // took the console.error branch and flashed raw stderr across the
    // terminal. The widget test above injects a fake UI directly and could
    // never catch it; this one goes through the real session_start path with
    // a context shaped like production's (hasUI on the context, setWidget on
    // ctx.ui).
    useScratchSummaryLog();
    const logged = captureConsoleError();
    __setSummaryBackoffForTesting(0, 0);
    cleanupFns.push(() => __setSummaryBackoffForTesting(30_000, 15 * 60_000));
    scriptedBackend(() => {
      throw new Error("summary request failed: HTTP 429 (kilo/x)");
    });
    enableSummariesForTest();
    const h = new PiHarness();
    const widgets: Array<[string, string[] | undefined]> = [];
    (h.ctx.ui as { setWidget?: unknown }).setWidget = (
      key: string,
      content: string[] | undefined,
    ) => {
      widgets.push([key, content]);
    };
    cleanTui(h.api);
    // summaryUi is module-level and persists across tests — drop it, or later
    // tests inherit hasUI: true and their console-branch assertions break.
    cleanupFns.push(() => __setSummaryUiForTesting(undefined));
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const row = h.row("bash", "capture");
    row.setArgs({ command: heredoc });
    await new Promise((r) => setTimeout(r, 20));
    const shown = widgets.at(-1);
    expect(shown?.[0]).toBe("bermudis-pi-goodies.summaries");
    expect(shown?.[1]?.[0]).toContain("⏸ summaries");
    // No raw stderr flash: the console branch stays quiet when a UI exists.
    expect(logged.some((l) => l.includes("[clean-tui] summary failed"))).toBe(
      false,
    );
  });

  test("a stalled summary request times out, logs, and frees the slot", async () => {
    // A hung provider request used to hold its concurrency slot forever and
    // queue-block everything behind it — with nothing in the log, because
    // nothing "failed". The timeout turns the stall into a visible failure.
    const logPath = useScratchSummaryLog();
    const logged = captureConsoleError();
    __setSummaryRequestTimeoutForTesting(30);
    cleanupFns.push(() => __setSummaryRequestTimeoutForTesting(20_000));
    __setSummaryBackoffForTesting(0, 0); // retry immediately after timeout
    cleanupFns.push(() => __setSummaryBackoffForTesting(30_000, 15 * 60_000));
    let hang = true;
    scriptedBackend(() => {
      if (hang) return new Promise<string>(() => {}); // never settles
      return "Recovered after the timeout";
    });
    enableSummariesForTest();
    const h = new PiHarness();
    cleanTui(h.api);
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const row = h.row("bash", "hang");
    row.setArgs({ command: heredoc });
    await new Promise((r) => setTimeout(r, 60)); // > 30ms timeout
    const events = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const failures = events.filter(
      (e) => e.type === "summary_request" && e.outcome === "failed",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toContain("timed out after 30ms");
    // Slot freed: a re-render retries and the summary lands.
    hang = false;
    row.setArgs({ command: heredoc });
    await new Promise((r) => setTimeout(r, 20));
    expect(textOf(row.lastCallComponent)).toContain(
      "Recovered after the timeout",
    );
    // The hung promise never settled, so nothing else may have leaked —
    // in particular no unhandled rejection from the raced loser.
    expect(logged.filter((l) => l.includes("timed out"))).toHaveLength(1);
  });

  test("a per-request AbortError frees the slot without logging a failure", async () => {
    // Regression: the old guard `if (!signal.aborted && err.name !==
    // "AbortError") pendingSummaries.delete(cmd)` skipped the delete when the
    // error was an AbortError but the SESSION was not aborted (a per-request
    // abort/timeout that raced the provider promise). The command stayed in
    // pendingSummaries forever, permanently burning a concurrency slot with
    // zero log output. The fix: always delete unless the session itself was
    // aborted (session_start clears via .clear()).
    const logPath = useScratchSummaryLog();
    __setSummaryBackoffForTesting(0, 0);
    cleanupFns.push(() => __setSummaryBackoffForTesting(30_000, 15 * 60_000));
    let firstCall = true;
    scriptedBackend(() => {
      if (firstCall) {
        firstCall = false;
        // Simulate a per-request abort: the provider rejects with AbortError
        // (as pi-ai does when stopReason === "aborted"), NOT a session switch.
        const err = new Error("aborted");
        err.name = "AbortError";
        return Promise.reject(err);
      }
      return "Recovered after abort";
    });
    enableSummariesForTest();
    const h = new PiHarness();
    cleanTui(h.api);
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const row = h.row("bash", "aborted");
    row.setArgs({ command: heredoc });
    await new Promise((r) => setTimeout(r, 30));
    // The slot must have been freed — a re-render retries and the summary
    // lands. If the slot was burned, the second call never fires and the
    // text stays as the raw command.
    row.setArgs({ command: heredoc });
    await new Promise((r) => setTimeout(r, 30));
    expect(textOf(row.lastCallComponent)).toContain("Recovered after abort");
    // An AbortError from a per-request abort is NOT a provider failure —
    // it must not appear in the structured log.
    const events = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const failures = events.filter(
      (e) => e.type === "summary_request" && e.outcome === "failed",
    );
    expect(failures).toHaveLength(0);
  });

  test("replayed history never requests summaries", async () => {
    // Startup/-c//resume replays fire no events until a live run begins;
    // render-side requests must stay suppressed during that window too.
    const calls = scriptedBackend(() => "should never run in replay");
    enableSummariesForTest();
    const h = new PiHarness();
    cleanTui(h.api);
    h.emit("session_start", { reason: "resume" });
    // Deliberately NO agent_start: still inside replay.
    const row = h.row("bash", "replay");
    row.setArgs({ command: heredoc });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(0);
    expect(textOf(row.lastCallComponent)).toContain("(+3 lines)");
  });

  test("unknown summary-model fails once, quietly keeps the heuristic", async () => {
    // A typo'd or removed model must degrade to heuristic hints with a single
    // diagnostic — not a crash and not a render-driven failure storm.
    __setSummaryModelRegistryForTesting({
      find: () => undefined,
      getAvailable: () => [],
      async getApiKeyAndHeaders() {
        throw new Error("must not reach auth for an unresolved model");
      },
    });
    // Defensive belt: any accidental network attempt explodes loudly.
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("no network expected");
    }) as typeof fetch;
    cleanupFns.push(() => {
      globalThis.fetch = origFetch;
    });
    useScratchConfig();
    setSummaryModel("zai/no-such-model");
    const logged = captureConsoleError();
    __clearSummaryCache();
    __setSummaryEnabled(true);
    const h = new PiHarness();
    cleanTui(h.api);
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const row = h.row("bash", "typo");
    row.setArgs({ command: heredoc });
    await new Promise((r) => setTimeout(r, 20));
    // More churn renders must not multiply diagnostics...
    row.setArgs({ command: heredoc });
    await new Promise((r) => setTimeout(r, 20));
    expect(textOf(row.lastCallComponent)).toContain("(+3 lines)");
    const failures = logged.filter((l) => l.includes("[clean-tui]"));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("zai/no-such-model");
  });

  test("summaries ride the user's provider stack end-to-end (mocked wire)", async () => {
    // The single wire-level test: legacy bare-id config resolves through a
    // model registry, auth comes from getApiKeyAndHeaders, and the actual LLM
    // call goes through pi-ai's completeSimple against a mocked transport.
    const logPath = useScratchSummaryLog();
    const origFetch = globalThis.fetch;
    let wireCount = 0;
    let wire: { url: string; auth: string | null; body: any } | undefined;
    globalThis.fetch = (async (url: any, init: any) => {
      wireCount++;
      wire = {
        url: String(url),
        auth: (init.headers as Headers)?.get?.("authorization") ?? null,
        body: JSON.parse(init.body),
      };
      const sse = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" } }] })}`,
        `data: ${JSON.stringify({
          choices: [
            {
              index: 0,
              delta: { content: "Appends reboot log to migration file" },
            },
          ],
        })}`,
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}`,
        "data: [DONE]",
      ].join("\n\n");
      return new Response(sse + "\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    cleanupFns.push(() => {
      globalThis.fetch = origFetch;
    });
    const integrationModel: Model<"openai-completions"> = {
      id: "grok-4-fast-non-reasoning",
      name: "Grok Fast",
      api: "openai-completions",
      provider: "kilo",
      baseUrl: "https://mock.local/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8000,
      maxTokens: 100,
    };
    __setSummaryModelRegistryForTesting({
      find: (provider, id) =>
        provider === "kilo" && id === "grok-4-fast-non-reasoning"
          ? integrationModel
          : undefined,
      getAvailable: () => [integrationModel],
      async getApiKeyAndHeaders(model) {
        authedFor.push(`${model.provider}/${model.id}`);
        return { ok: true, apiKey: "test-key" };
      },
    });
    useScratchConfig();
    setSummaryModel("grok-4-fast-non-reasoning"); // legacy bare id — must fall back
    const authedFor: string[] = [];
    __clearSummaryCache();
    __setSummaryEnabled(true);
    const h = new PiHarness();
    cleanTui(h.api);
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const row = h.row("bash", "wire");
    row.setArgs({ command: heredoc });
    await new Promise((r) => setTimeout(r, 40));
    expect(textOf(row.lastCallComponent)).toContain(
      "Appends reboot log to migration file",
    );
    expect(wire).toBeDefined();
    expect(wire!.url).toBe("https://mock.local/v1/chat/completions");
    expect(wire!.auth).toBe("Bearer test-key");
    expect(wire!.body.model).toBe("grok-4-fast-non-reasoning"); // resolved id
    expect(wire!.body.max_completion_tokens).toBe(512);
    // No reasoning parameter at all: pi's own agent maps "off" to undefined,
    // and several pi-ai APIs enable thinking on any truthy value.
    for (const key of Object.keys(wire!.body))
      expect(key.toLowerCase()).not.toContain("reason");
    expect(authedFor).toEqual(["kilo/grok-4-fast-non-reasoning"]);
    expect(wire!.body.messages[0].content[0].text).toContain(
      "Summarize this shell command in less than 13 words",
    );
    expect(wire!.body.messages[0].content[0].text).toContain(
      'cat >> "PsVita/Archive/MIGRATION-LOG.md"',
    );
    // Cached: further renders don't refetch.
    row.setArgs({ command: heredoc });
    await new Promise((r) => setTimeout(r, 10));
    expect(wireCount).toBe(1);
    // Request accounting: exactly one structured event for the one wire call,
    // with outcome and duration — re-renders add no lines.
    const events = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.type === "summary_request");
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("ok");
    expect(typeof events[0].ms).toBe("number");
    // The raw command is redacted from the log: only a digest + length are
    // recorded, never the command text (which can carry secrets).
    expect(events[0].cmd).toBeUndefined();
    expect(typeof events[0].digest).toBe("string");
    expect(typeof events[0].len).toBe("number");
    expect(readFileSync(logPath, "utf-8")).not.toContain("MIGRATION-LOG");
  });

  test("reasoning-only models get their lowest effort, not the API default", async () => {
    // Groq's gpt-oss maps off and minimal to null: thinking cannot be
    // disabled, and with no reasoning parameter the endpoint runs its
    // API-default (medium) effort — which burns the shared completion budget
    // and returns an empty answer. The summary request must pin the lowest
    // supported effort ("low" here, via clampThinkingLevel) and raise the
    // cap so reasoning + answer both fit.
    const origFetch = globalThis.fetch;
    let wire: { body: any } | undefined;
    globalThis.fetch = (async (_url: any, init: any) => {
      wire = { body: JSON.parse(init.body) };
      const sse = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" } }] })}`,
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: { content: "Appends reboot log" } }],
        })}`,
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}`,
        "data: [DONE]",
      ].join("\n\n");
      return new Response(sse + "\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    cleanupFns.push(() => {
      globalThis.fetch = origFetch;
    });
    const reasoningModel: Model<"openai-completions"> = {
      id: "openai/gpt-oss-20b",
      name: "GPT OSS 20B",
      api: "openai-completions",
      provider: "groq",
      baseUrl: "https://mock.local/v1",
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: null,
        max: null,
      },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8000,
      maxTokens: 100,
      compat: { supportsReasoningEffort: true },
    };
    __setSummaryModelRegistryForTesting({
      find: (provider, id) =>
        provider === "groq" && id === "openai/gpt-oss-20b"
          ? reasoningModel
          : undefined,
      getAvailable: () => [reasoningModel],
      async getApiKeyAndHeaders(model) {
        return { ok: true, apiKey: "test-key" };
      },
    });
    useScratchConfig();
    setSummaryModel("groq/openai/gpt-oss-20b");
    __clearSummaryCache();
    __setSummaryEnabled(true);
    const h = new PiHarness();
    cleanTui(h.api);
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const row = h.row("bash", "wire-reasoning");
    row.setArgs({ command: heredoc });
    await new Promise((r) => setTimeout(r, 40));
    expect(textOf(row.lastCallComponent)).toContain("Appends reboot log");
    expect(wire).toBeDefined();
    expect(wire!.body.reasoning_effort).toBe("low");
    expect(wire!.body.max_completion_tokens).toBe(512);
  });

  test("429 engages a backoff instead of retrying on every render", async () => {
    // Regression: a failed summary was neither cached nor penalized, so every
    // bash re-render re-fired the request — a single 429 turned into a
    // render-driven retry storm that kept the rate limiter hot all session.
    __setSummaryBackoffForTesting(100, 60_000);
    captureConsoleError();
    let calls = 0;
    let succeed = false;
    const attempted = scriptedBackend(() => {
      calls++;
      if (!succeed)
        throw new Error("summary request failed: HTTP 429 (kilo/x)");
      return "Lists agent settings and extensions";
    });
    enableSummariesForTest();
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
    expect(attempted.filter((c) => c === cmd)).toHaveLength(1);
    expect(textOf(row.lastCallComponent)).not.toContain(
      "Lists agent settings and extensions",
    );
    // After the cooldown the next render retries and recovers. The row
    // finished during the failed first flight, so the recovered summary now
    // swaps it directly (finished-during-flight rule, freshness window
    // covers the short cooldown); verify via the original row's text:
    succeed = true;
    await new Promise((r) => setTimeout(r, 120));
    row.setArgs({ command: cmd });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(2);
    const recovered = h.row("bash", "recovered");
    recovered.setArgs({ command: cmd });
    expect(textOf(row.lastCallComponent)).toContain(
      "Lists agent settings and extensions",
    );
    // Cached: further renders don't refetch.
    row.setArgs({ command: cmd });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(2);
  });

  test("a success resets the failure streak", async () => {
    // Without a reset, one old 429 would double every future cooldown forever.
    __setSummaryBackoffForTesting(100, 60_000);
    captureConsoleError();
    let calls = 0;
    let fail = true;
    scriptedBackend(() => {
      calls++;
      if (fail) throw new Error(`summary request failed: HTTP 429 (#${calls})`);
      return `summary ${calls}`;
    });
    enableSummariesForTest();
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
  });

  test("an explicit Retry-After hint extends the pause", async () => {
    // Provider layers surface Retry-After as a retryAfterMs hint on the thrown
    // error; the shared backoff honors it over its computed cooldown.
    __setSummaryBackoffForTesting(20, 60_000);
    captureConsoleError();
    let calls = 0;
    let succeed = false;
    scriptedBackend(() => {
      calls++;
      if (!succeed)
        throw Object.assign(
          new Error(`summary request failed: HTTP 429 (#${calls})`),
          { retryAfterMs: 1000 },
        );
      return "Recovers after retry-after";
    });
    enableSummariesForTest();
    const h = new PiHarness();
    cleanTui(h.api);
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const cmd = "echo " + "y".repeat(90);
    const row = h.row("bash", "ra");
    row.setArgs({ command: cmd });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
    // Tiny base backoff (20ms) has long passed, but Retry-After holds.
    await new Promise((r) => setTimeout(r, 150));
    row.setArgs({ command: cmd });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
    succeed = true;
    await new Promise((r) => setTimeout(r, 950));
    row.setArgs({ command: cmd });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(2);
  });

  test("at most 2 summary requests run concurrently", async () => {
    // A parallel-call burst renders N distinct long commands at once; without
    // a cap each render fans out its own provider request simultaneously.
    // Rows beyond the cap queue and drain as slots free.
    captureConsoleError();
    let started = 0;
    let active = 0;
    let peak = 0;
    const resolvers: Array<(v: string) => void> = [];
    __setSummaryBackendForTesting({
      summarize: async (cmd) => {
        started++;
        active++;
        peak = Math.max(peak, active);
        await new Promise<string>((resolve) => resolvers.push(resolve));
        active--;
        return `s(${cmd.length})`;
      },
    });
    enableSummariesForTest();
    const h = new PiHarness();
    cleanTui(h.api);
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const [rowP, rowQ, rowR, rowS] = ["p", "q", "r", "s"].map((id) =>
      h.row("bash", id),
    );
    const cmdOf = (tag: string) => `echo ${"z".repeat(85)}-${tag}`;
    // Visible prose is the burst boundary; emit text between rows so these
    // four commands render solo instead of chaining into one burst.
    const nextSegment = () => {
      h.emit("message_start", { message: { role: "assistant" } });
      h.emit("message_update", {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "next step" }],
        },
      });
    };
    // First two start; the third and fourth hit the in-flight cap...
    nextSegment();
    rowP.setArgs({ command: cmdOf("p") });
    nextSegment();
    rowQ.setArgs({ command: cmdOf("q") });
    expect(started).toBe(2);
    expect(peak).toBe(2);
    // ...so their later re-renders queue one at a time as slots free up.
    // The freed slot becomes visible only after the success microtask drains.
    const settle = () => new Promise((r) => setTimeout(r, 0));
    resolvers[0]("sp"); // p resolves → slot frees
    await settle();
    nextSegment();
    rowR.setArgs({ command: cmdOf("r") }); // r's re-render admits it
    await settle();
    expect(started).toBe(3);
    expect(peak).toBe(2);
    resolvers[1]("sq");
    await settle();
    nextSegment();
    rowS.setArgs({ command: cmdOf("s") });
    await settle();
    expect(started).toBe(4);
    expect(peak).toBe(2); // never more than two concurrent provider calls
    resolvers[2]("sr");
    resolvers[3]("ss");
    await settle();
    await settle(); // one hop for the result, one for the re-render
    expect(textOf(rowR.lastCallComponent)).toContain("s(92)");
  });

  test("burst rows beyond the inflight cap queue and still get summaries", async () => {
    // A 4-command burst renders faster than summaries complete: rows 3-4 hit
    // the cap at first render. Dropping them left raw rows forever (their
    // components may never re-render — the observed burst residue);
    // queueing drains them as slots free instead.
    captureConsoleError();
    const resolvers: Array<(v: string) => void> = [];
    __setSummaryBackendForTesting({
      summarize: async (cmd) =>
        new Promise<string>((resolve) => resolvers.push(resolve)),
    });
    enableSummariesForTest();
    const h = new PiHarness();
    cleanTui(h.api);
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const rows = ["b1", "b2", "b3", "b4"].map((id) => h.row("bash", id));
    const cmdOf = (tag: string) => `echo ${"y".repeat(85)}-${tag}`;
    // All four render back-to-back (one textless segment → one burst).
    for (const [i, row] of rows.entries())
      row.setArgs({ command: cmdOf(`v${i}`) });
    // Cap: exactly two requests out; the other two queued, not dropped.
    expect(resolvers).toHaveLength(2);
    // Settling the first two drains the queue in render order.
    resolvers[0]("s v0");
    resolvers[1]("s v1");
    await new Promise((r) => setTimeout(r, 10));
    expect(resolvers).toHaveLength(4);
    resolvers[2]("s v2");
    resolvers[3]("s v3");
    await new Promise((r) => setTimeout(r, 20));
    const leader = textOf(rows[0].lastCallComponent);
    expect(leader).toContain("s v2");
    expect(leader).toContain("s v3");
  });

  test("streaming args fire one request per row, only when args complete", async () => {
    // pi re-renders each row while the JSON args stream in. Every partial
    // command longer than the threshold used to fire its own request —
    // truncated, undisplayable, queue-blocking — so the complete command's
    // request landed after the freshness window had closed. Bursts
    // summarized their first row only (the reported "works for the first
    // cmd only").
    captureConsoleError();
    const resolvers: Array<(v: string) => void> = [];
    __setSummaryBackendForTesting({
      summarize: async () =>
        new Promise<string>((resolve) => resolvers.push(resolve)),
    });
    enableSummariesForTest();
    const h = new PiHarness();
    cleanTui(h.api);
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const rows = ["s1", "s2"].map((id) => h.row("bash", id));
    const cmdOf = (tag: string) => `echo ${"y".repeat(130)}-${tag}`;
    for (const [i, row] of rows.entries()) {
      const full = cmdOf(`v${i}`);
      for (const cut of [20, 45, 70, 100, 130, full.length])
        row.setArgs(
          { command: full.slice(0, cut) },
          { argsComplete: cut === full.length },
        );
    }
    // Exactly one request per row — for the complete command only.
    expect(resolvers).toHaveLength(2);
    resolvers[0]("s v0");
    resolvers[1]("s v1");
    await new Promise((r) => setTimeout(r, 10));
    const leader = textOf(rows[0].lastCallComponent);
    expect(leader).toContain("s v0");
    expect(leader).toContain("s v1");
  });

  test("switching sessions abandons in-flight summaries without side effects", async () => {
    // Render-side work outlives turns, so each session carries its own abort
    // controller. The dangerous ordering is a stale provider response landing
    // AFTER the fresh session already re-requested the same command: it must
    // neither delete the new request's dedup marker nor poison its cache.
    const logged = captureConsoleError();
    let started = 0;
    const resolvers: Array<(v: string) => void> = [];
    __setSummaryBackendForTesting({
      summarize: (_cmd, _signal) =>
        new Promise<string>((resolve) => {
          started++;
          resolvers.push(resolve); // deliberately ignores abort: emulates a
          // provider whose response raced past the cancellation.
        }),
    });
    enableSummariesForTest();
    const h = new PiHarness();
    cleanTui(h.api);
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const cmd = "echo " + "k".repeat(90);
    const row = h.row("bash", "abandon");
    row.setArgs({ command: cmd });
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toBe(1);
    h.emit("session_start", { reason: "resume" }); // switches away mid-flight
    h.emit("agent_start"); // the resumed session's first live run ends replay
    // Fresh session re-requests the same command while the stale request is
    // still pending.
    const row2 = h.row("bash", "renewed");
    row2.setArgs({ command: cmd });
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toBe(2);
    // NOW the stale response lands. It must stay fully inert.
    resolvers[0]("stale answer");
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toBe(2); // dedup marker intact → no duplicate request
    // And a genuinely fresh result still flows end-to-end post-switch.
    resolvers[1]("fresh summary");
    await new Promise((r) => setTimeout(r, 10));
    expect(textOf(row2.lastCallComponent)).toContain("fresh summary");
    expect(textOf(row2.lastCallComponent)).not.toContain("stale answer");
    expect(logged.filter((l) => l.includes("[clean-tui]"))).toHaveLength(0);
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

  test("expanding reveals a long single-line command the collapsed header ellipsizes", () => {
    // Regression: soloExpanded only revealed the full command for MULTI-line
    // commands. A single-line command past the bullet cap was ellipsized in
    // the header and never rendered anywhere — ctrl+o showed only the output
    // (observed on `timeout 30 pi -p -- --no-session --tools read,...`).
    const h = freshHarness();
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const cmd =
      "timeout 30 pi -p -- --no-session --tools read,find,grep,ls --message explain the wiki verification loop in detail";
    expect(cmd.length).toBeGreaterThan(100); // past the bullet cap (BASH_BULLET_WIDTH)
    const row = h.row("bash", "longline");
    row.setArgs({ command: cmd });
    row.setResult({ content: [{ type: "text", text: "output line" }] });

    const collapsed = textOf(row.lastCallComponent);
    expect(collapsed).toContain("…"); // capped first view
    expect(collapsed).not.toContain(cmd); // tail hidden

    row.setExpanded(true);
    const expanded = textOf(row.lastCallComponent);
    expect(expanded).toContain(cmd); // full command, uncapped
    expect(expanded).toContain("output line");
  });

  test("expanded grouped details reveal each call's full command", () => {
    // The details block capped commands at 40 chars — a grouped burst's
    // expanded view still never showed the actual commands.
    const h = freshHarness();
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const cmd = "echo " + "y".repeat(120) + "-tail-marker";
    const a = h.row("bash", "a");
    const b = h.row("bash", "b");
    a.setArgs({ command: cmd });
    b.setArgs({ command: "echo hi" });
    a.setResult({ content: [{ type: "text", text: "one" }] });
    b.setResult({ content: [{ type: "text", text: "two" }] });
    a.setExpanded(true);
    expect(textOf(a.lastCallComponent)).toContain(cmd);
  });

  test("a failed leader does not paint the whole burst box red", () => {
    // Regression (twice): aggregating any-error over the burst painted every
    // row red for one failure, and b80a14d's "follow the leader's status"
    // still did when the leader itself was the failed call (e.g. `skills add
    // -g ...` failing as the first of four bash calls). The shared box never
    // takes the error color; the failed call is marked on its own bullet.
    const taggingTheme: Theme = {
      fg: (_c, t) => t,
      bg: (c, t) => `<${c}>${t}`,
      bold: (t) => t,
    };
    const h = new PiHarness({ theme: taggingTheme });
    cleanTui(h.api);
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const a = h.row("bash", "a");
    const b = h.row("bash", "b");
    a.setArgs({ command: "skills add -g content-retrieval" });
    b.setArgs({ command: "skills update content-retrieval -g -y" });
    a.setResult({ content: ["error: add expects a repo"], isError: true });
    b.setResult({ content: ["updated"] });
    const box = a.lastCallComponent as Box;
    const bg = (box as unknown as { bgFn?: (s: string) => string }).bgFn?.(
      "probe",
    );
    expect(bg).toBe("<toolSuccessBg>probe");
    // The failure is still visible — on the failing call's own bullet.
    expect(textOf(box)).toContain("skills add -g content-retrieval");
  });

  test("a failed leader does not paint the whole burst red (every non-bash tool)", () => {
    // The "one failed row paints the whole burst red" bug was fixed twice for
    // bash but the other six tools still shipped `isGrouped ? entries.some(e =>
    // e.isError)`. After extracting the shared skeleton, every burst tool
    // carries the single correct rule: the grouped box never takes the error
    // color, whichever call failed. This guards against the divergence class
    // regressing for any tool.
    const taggingTheme: Theme = {
      fg: (_c, t) => t,
      bg: (c, t) => `<${c}>${t}`,
      bold: (t) => t,
    };
    const cases: Array<{ tool: string; args: Record<string, string> }> = [
      { tool: "read", args: { path: "/tmp/a.ts" } },
      { tool: "write", args: { path: "/tmp/a.ts", content: "x" } },
      { tool: "edit", args: { path: "/tmp/a.ts" } },
      { tool: "find", args: { pattern: "*.ts", path: "." } },
      { tool: "grep", args: { pattern: "foo", path: "." } },
      { tool: "ls", args: { path: "." } },
    ];
    for (const { tool, args } of cases) {
      const h = new PiHarness({ theme: taggingTheme });
      cleanTui(h.api);
      h.emit("session_start", { reason: "startup" });
      h.emit("agent_start");
      const a = h.row(tool, `a-${tool}`);
      const b = h.row(tool, `b-${tool}`);
      a.setArgs(args);
      b.setArgs(args);
      a.setResult({ content: ["boom"], isError: true });
      b.setResult({ content: ["ok"] });
      // Grouping must hold (else the failed solo row would go toolErrorBg) AND
      // the box must not take the error color (the bug being guarded against).
      expect(textOf(a.lastCallComponent)).toContain(`${tool} ×2`);
      const bg = (
        a.lastCallComponent as unknown as { bgFn?: (s: string) => string }
      ).bgFn?.("probe");
      expect(bg).toBe("<toolSuccessBg>probe");
    }
  });

  test("a failed grouped non-bash bullet renders its text in the error color", () => {
    // Regression: formatReadBullet/formatWriteBullet/formatEditBullet/
    // formatFindBullet/formatGrepBullet/formatLsBullet all ignored
    // entry.isError, so a failed grouped call appeared successful — its bullet
    // text stayed the normal accent color. Only formatBashBullet inspected
    // isError. Now every grouped bullet marks failures in red on the bullet
    // itself (the box background stays success, per the test above).
    const colorTheme: Theme = {
      fg: (c, t) => `<${c}>${t}`,
      bg: (c, t) => `<${c}>${t}`,
      bold: (t) => t,
    };
    const cases: Array<{
      tool: string;
      args: Record<string, string>;
      probe: string;
    }> = [
      {
        tool: "read",
        args: { path: "/tmp/missing.ts" },
        probe: "/tmp/missing.ts",
      },
      {
        tool: "write",
        args: { path: "/tmp/readonly.ts", content: "x" },
        probe: "/tmp/readonly.ts",
      },
      {
        tool: "edit",
        args: { path: "/tmp/missing.ts" },
        probe: "/tmp/missing.ts",
      },
      { tool: "find", args: { pattern: "*.ts", path: "." }, probe: "*.ts" },
      { tool: "grep", args: { pattern: "foo", path: "." }, probe: "/foo/" },
      { tool: "ls", args: { path: "." }, probe: "." },
    ];
    for (const { tool, args, probe } of cases) {
      const h = new PiHarness({ theme: colorTheme });
      cleanTui(h.api);
      h.emit("session_start", { reason: "startup" });
      h.emit("agent_start");
      const a = h.row(tool, `a-${tool}`);
      const b = h.row(tool, `b-${tool}`);
      a.setArgs(args);
      b.setArgs(args);
      a.setResult({ content: ["boom"], isError: true });
      b.setResult({ content: ["ok"] });
      const text = textOf(a.lastCallComponent);
      // The failed bullet's main text is wrapped in <error>; the successful
      // one's is wrapped in <accent>. Both appear in the same grouped header.
      expect(text).toContain(`<error>${probe}`);
      expect(text).toContain(`<accent>${probe}`);
    }
  });

  test("burst box stays pending until every call in the burst lands", () => {
    const taggingTheme: Theme = {
      fg: (_c, t) => t,
      bg: (c, t) => `<${c}>${t}`,
      bold: (t) => t,
    };
    const h = new PiHarness({ theme: taggingTheme });
    cleanTui(h.api);
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start");
    const a = h.row("bash", "a");
    const b = h.row("bash", "b");
    a.setArgs({ command: "echo one" });
    b.setArgs({ command: "echo two" });
    a.setResult({ content: ["one"] });
    // Leader finished, follower has not: the shared box is still running.
    let bg = (
      a.lastCallComponent as unknown as { bgFn?: (s: string) => string }
    ).bgFn?.("probe");
    expect(bg).toBe("<toolPendingBg>probe");
    b.setResult({ content: ["two"] });
    bg = (
      a.lastCallComponent as unknown as { bgFn?: (s: string) => string }
    ).bgFn?.("probe");
    expect(bg).toBe("<toolSuccessBg>probe");
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

describe("convertSummaryResponse — production error conversion", () => {
  // Every failure test in the suite throws from a test seam (scriptedBackend),
  // so the backoff/log/widget edifice is tested against error shapes no
  // production path is verified to emit. This table test exercises the actual
  // production code (convertSummaryResponse, extracted from summarizeViaProvider)
  // that converts pi-ai response stopReasons into the Error shapes the rest of
  // the pipeline consumes.

  const LABEL = "kilo/grok-4-fast";

  test("stopReason 'aborted' throws AbortError (not a provider failure)", () => {
    expect(() =>
      convertSummaryResponse({ stopReason: "aborted", content: [] }, LABEL),
    ).toThrow("summary request aborted");
    try {
      convertSummaryResponse({ stopReason: "aborted", content: [] }, LABEL);
    } catch (err) {
      expect((err as Error).name).toBe("AbortError");
    }
  });

  test("stopReason 'error' with errorMessage throws error containing message + label", () => {
    expect(() =>
      convertSummaryResponse(
        {
          stopReason: "error",
          errorMessage: "HTTP 429 Too Many Requests",
          content: [],
        },
        LABEL,
      ),
    ).toThrow("HTTP 429 Too Many Requests (kilo/grok-4-fast)");
  });

  test("stopReason 'error' without errorMessage falls back to 'request failed'", () => {
    expect(() =>
      convertSummaryResponse({ stopReason: "error", content: [] }, LABEL),
    ).toThrow(`request failed (${LABEL})`);
  });

  test("errorMessage is truncated to SUMMARY_ERROR_SNIPPET_CHARS (200)", () => {
    const longMsg = "X".repeat(500);
    try {
      convertSummaryResponse(
        { stopReason: "error", errorMessage: longMsg, content: [] },
        LABEL,
      );
      throw new Error("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      // The error body is truncated to 200 chars before the label suffix.
      const body = msg.slice(0, msg.indexOf(` (${LABEL})`));
      expect(body.length).toBe(200);
      expect(body).toBe("X".repeat(200));
    }
  });

  test("stopReason 'stop' with text content returns the joined text", () => {
    expect(
      convertSummaryResponse(
        {
          stopReason: "stop",
          content: [
            { type: "text", text: "Appends reboot log" },
            { type: "text", text: "to migration file" },
          ],
        },
        LABEL,
      ),
    ).toBe("Appends reboot log\nto migration file");
  });

  test("stopReason 'stop' with empty content throws empty-summary error", () => {
    expect(() =>
      convertSummaryResponse({ stopReason: "stop", content: [] }, LABEL),
    ).toThrow(
      `empty summary — is ${LABEL} a thinking model that cannot disable thinking?`,
    );
  });

  test("stopReason 'stop' with whitespace-only content throws empty-summary error", () => {
    expect(() =>
      convertSummaryResponse(
        {
          stopReason: "stop",
          content: [{ type: "text", text: "   \n  \t  " }],
        },
        LABEL,
      ),
    ).toThrow(
      `empty summary — is ${LABEL} a thinking model that cannot disable thinking?`,
    );
  });

  test("stopReason 'stop' with only non-text blocks (thinking) throws empty-summary error", () => {
    // A reasoning model that burns the whole budget on thinking emits no text
    // content — the exact failure the empty-summary error diagnoses.
    expect(() =>
      convertSummaryResponse(
        {
          stopReason: "stop",
          content: [
            { type: "thinking", text: "reasoning about the command..." },
          ],
        },
        LABEL,
      ),
    ).toThrow(
      `empty summary — is ${LABEL} a thinking model that cannot disable thinking?`,
    );
  });

  test("stopReason 'length' with text content returns text (not an error)", () => {
    // "length" means the model hit max_tokens — the partial text is still
    // usable for a summary. Only "aborted" and "error" are failure stopReasons.
    expect(
      convertSummaryResponse(
        {
          stopReason: "length",
          content: [{ type: "text", text: "Runs the test" }],
        },
        LABEL,
      ),
    ).toBe("Runs the test");
  });

  test("stopReason 'toolUse' with text content returns text", () => {
    expect(
      convertSummaryResponse(
        {
          stopReason: "toolUse",
          content: [{ type: "text", text: "Partial answer" }],
        },
        LABEL,
      ),
    ).toBe("Partial answer");
  });

  test("text content with mixed text and non-text blocks returns only the text parts", () => {
    expect(
      convertSummaryResponse(
        {
          stopReason: "stop",
          content: [
            { type: "thinking", text: "internal reasoning" },
            { type: "text", text: "Cleans the build" },
            { type: "toolCall", text: "ignored" },
          ],
        },
        LABEL,
      ),
    ).toBe("Cleans the build");
  });
});
