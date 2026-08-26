import { describe, expect, test, afterEach } from "bun:test";
import { Box, Container } from "@earendil-works/pi-tui";
import type { Model } from "@earendil-works/pi-ai";
import cleanTui, {
  __clearSummaryCache,
  __setSummaryBackoffForTesting,
  __setSummaryBackendForTesting,
  __setSummaryEnabled,
  __setSummaryModelRegistryForTesting,
  setCleanTuiActive,
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

  test("replayed textless assistant messages chain into one burst", () => {
    // Burst boundary is visible prose, not the message edge: a model that
    // calls one tool per assistant message (thinking + toolCall, no text)
    // produces calls with no prose between them — same block.
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

  test("live: back-to-back textless assistant messages chain into one burst", () => {
    // Regression guard for the glm-5.3-flash shape: the model calls one tool
    // per assistant message (thinking + toolCall, no prose). No text between
    // the calls, so they belong in one block; the next message's prose ends
    // the chain.
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
    // visible flash per summarized command while the agent works. Equal
    // caps (header uses BASH_BULLET_WIDTH) keep the swap height-neutral.
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

  test("summary arrival never re-renders finished rows (scrollback flicker)", async () => {
    // Regression (0.11.x, tall transcripts, any width): a landing summary
    // invalidated EVERY row that ever ran the command — including replayed
    // rows from before a /resume, far above pi's viewport. pi's diff
    // renderer turns any change above the viewport into fullRender(true):
    // clear screen + scrollback wipe (the reported "flicker while pi is
    // working"). Only still-executing rows refresh now; finished ones keep
    // the raw command text, and the cache still serves future rows.
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

  test("summary is normalized to one line and capped at 80 chars", async () => {
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
    expect(text.length).toBeLessThanOrEqual(120); // 80-char summary cap
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

  test("unset summary-model means off: zero requests, zero noise", async () => {
    // The feature costs nothing until the user picks a model — no network,
    // no resolution work, and no error spam about a config they never made.
    const calls = scriptedBackend(() => "should never run");
    const logged = captureConsoleError();
    // No setSummaryModel call here: exactly what fresh installs look like.
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
    expect(wire!.body.max_completion_tokens).toBe(30);
    // No reasoning parameter at all: pi's own agent maps "off" to undefined,
    // and several pi-ai APIs enable thinking on any truthy value.
    for (const key of Object.keys(wire!.body))
      expect(key.toLowerCase()).not.toContain("reason");
    expect(authedFor).toEqual(["kilo/grok-4-fast-non-reasoning"]);
    expect(wire!.body.messages[0].content[0].text).toContain(
      "Summarize this shell command in 5-8 words",
    );
    expect(wire!.body.messages[0].content[0].text).toContain(
      'cat >> "PsVita/Archive/MIGRATION-LOG.md"',
    );
    // Cached: further renders don't refetch.
    row.setArgs({ command: heredoc });
    await new Promise((r) => setTimeout(r, 10));
    expect(wireCount).toBe(1);
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
    // After the cooldown the next render retries and recovers. The row has
    // finished, so the arrival must NOT re-render it (scrollback-flicker
    // rule) — verify the cache took the summary via a fresh row instead:
    // same command bursts with the original row, and the follower's render
    // hop refreshes the leader, whose bullets show the recovered summary.
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
    // Rows beyond the cap bounce and retry on later re-renders, exactly like
    // real pi repaints them.
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
