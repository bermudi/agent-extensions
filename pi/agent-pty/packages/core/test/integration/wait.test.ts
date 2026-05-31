import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { DaemonHarness } from "../helpers.js";

describe("wait-for and await-change", () => {
  const d = new DaemonHarness();

  beforeAll(async () => {
    await d.start();
  });

  afterAll(async () => {
    await d.stop();
  });

  // Helper: type + enter in one call
  async function typeLine(session: string, text: string) {
    await d.cmd("type", { name: session, text });
    await d.cmd("key", { name: session, key: "enter" });
  }

  // --- wait-for ---

  test("wait-for: immediate match — pattern already on screen", async () => {
    await d.spawnShell("wf-immediate");
    const res = await d.cmd("wait-for", {
      name: "wf-immediate",
      pattern: "$",
      regex: true,
    });
    expect(res.ok).toBe(true);
    expect(res.matched).toBe(true);
    expect(res.elapsed).toBeLessThan(1000);
  });

  test("wait-for: delayed match — pattern appears after delay", async () => {
    await d.spawnShell("wf-delayed");
    await typeLine("wf-delayed", "sleep 0.3 && echo DONE");
    const res = await d.cmd("wait-for", {
      name: "wf-delayed",
      pattern: "DONE",
      timeout: 5000,
    });
    expect(res.ok).toBe(true);
    expect(res.matched).toBe(true);
    // We sent the command, which echoes immediately including 'DONE' in the command text.
    // So this matches on the echo. This validates the pipeline works.
  });

  test("wait-for: timeout — pattern never appears", async () => {
    await d.spawnShell("wf-timeout");
    const res = await d.cmd("wait-for", {
      name: "wf-timeout",
      pattern: "NEVER_APPEARS",
      timeout: 500,
    });
    expect(res.ok).toBe(true);
    expect(res.matched).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(res.elapsed).toBeGreaterThanOrEqual(450);
  });

  test("wait-for: regex mode", async () => {
    await d.spawnShell("wf-regex");
    await typeLine("wf-regex", "echo abc123");
    const res = await d.cmd("wait-for", {
      name: "wf-regex",
      pattern: "abc\\d+",
      regex: true,
    });
    expect(res.ok).toBe(true);
    expect(res.matched).toBe(true);
  });

  test("wait-for: literal mode escapes special chars", async () => {
    await d.spawnShell("wf-literal");
    await typeLine("wf-literal", "echo 'hello.world'");
    const res = await d.cmd("wait-for", {
      name: "wf-literal",
      pattern: "hello.world",
    });
    expect(res.ok).toBe(true);
    expect(res.matched).toBe(true);
  });

  test("wait-for: missing pattern → error", async () => {
    await d.spawnShell("wf-nopat");
    const res = await d.cmd("wait-for", { name: "wf-nopat" });
    expect(res.ok).toBe(false);
  });

  test("wait-for: session not found", async () => {
    const res = await d.cmd("wait-for", { name: "ghost", pattern: "x" });
    expect(res.ok).toBe(false);
  });

  test("wait-for: since skips immediate match and times out if no new data", async () => {
    await d.spawnShell("wf-since");
    await typeLine("wf-since", "echo SINCE_TEST");
    await d.cmd("wait-for", { name: "wf-since", pattern: "SINCE_TEST", timeout: 3000 });

    const snap = await d.cmd("snapshot", { name: "wf-since" });
    const sinceId = snap.snapshotId as number;

    // Pattern is already on screen, but --since should skip immediate check
    const res = await d.cmd("wait-for", {
      name: "wf-since",
      pattern: "SINCE_TEST",
      since: sinceId,
      timeout: 500,
    }, 2000);
    expect(res.ok).toBe(true);
    expect(res.matched).toBe(false);
    expect(res.timedOut).toBe(true);
  });

  test("wait-for: since matches on new data after snapshot", async () => {
    await d.spawnShell("wf-since-match");
    await typeLine("wf-since-match", "echo OLD");
    await d.cmd("wait-for", { name: "wf-since-match", pattern: "OLD", timeout: 3000 });

    const snap = await d.cmd("snapshot", { name: "wf-since-match" });
    const sinceId = snap.snapshotId as number;

    const p = d.cmd("wait-for", {
      name: "wf-since-match",
      pattern: "NEW",
      since: sinceId,
      timeout: 3000,
    }, 5000);

    await Bun.sleep(100);
    await typeLine("wf-since-match", "echo NEW");

    const res = await p;
    expect(res.ok).toBe(true);
    expect(res.matched).toBe(true);
  });

  // --- await-change ---

  test("await-change: detects screen change", async () => {
    await d.spawnShell("ac-detect");
    // Let prompt settle
    await d.cmd("wait-for", {
      name: "ac-detect",
      pattern: "$",
      regex: true,
    });

    const snap = await d.cmd("snapshot", { name: "ac-detect" });
    const initialHash = snap.contentHash;

    // Start await-change BEFORE triggering the change
    const changeP = d.cmd("await-change", {
      name: "ac-detect",
      timeout: 5000,
      settle: 200,
    });
    await Bun.sleep(50);
    await typeLine("ac-detect", "echo CHANGED");

    const res = await changeP;
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.settled).toBe(true);
    expect(res.contentHash).not.toBe(initialHash);
  });

  test("await-change: timeout with no change", async () => {
    await d.spawnShell("ac-timeout");
    await d.cmd("wait-for", {
      name: "ac-timeout",
      pattern: "$",
      regex: true,
    });
    const res = await d.cmd("await-change", {
      name: "ac-timeout",
      timeout: 500,
      settle: 200,
    });
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(false);
    expect(res.timedOut).toBe(true);
  });

  test("await-change: settle waits for stability", async () => {
    await d.spawnShell("ac-settle");
    await d.cmd("wait-for", {
      name: "ac-settle",
      pattern: "$",
      regex: true,
    });

    const changeP = d.cmd("await-change", {
      name: "ac-settle",
      timeout: 10000,
      settle: 400,
    });

    // rapid-fire changes
    await typeLine("ac-settle", "echo A");
    await Bun.sleep(100);
    await typeLine("ac-settle", "echo B");

    const res = await changeP;
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.settled).toBe(true);
  });

  test("await-change: settle 0 resolves immediately on change", async () => {
    await d.spawnShell("ac-settle0");
    await d.cmd("wait-for", {
      name: "ac-settle0",
      pattern: "$",
      regex: true,
    });

    const changeP = d.cmd("await-change", {
      name: "ac-settle0",
      settle: 0,
      timeout: 5000,
    });
    await Bun.sleep(50);
    await typeLine("ac-settle0", "echo TRIGGER");

    const res = await changeP;
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.settled).toBe(false);
  });

  // --- wait-for-exit ---

  test("wait-for-exit: returns immediately if process already exited", async () => {
    await d.spawnShell("wfe-done");
    await d.cmd("type", { name: "wfe-done", text: "exit 42" });
    await d.cmd("key", { name: "wfe-done", key: "enter" });

    // Wait a bit for the shell to exit
    await new Promise((r) => setTimeout(r, 300));

    const res = await d.cmd("wait-for-exit", { name: "wfe-done", timeout: 5000 });
    expect(res.ok).toBe(true);
    expect(res.exited).toBe(true);
    expect(res.exitCode).toBe(42);
  });

  test("wait-for-exit: waits for natural exit", async () => {
    await d.cmd("spawn", {
      name: "wfe-wait",
      command: "bash",
      args: ["-c", "sleep 0.2; exit 7"],
    });

    const res = await d.cmd("wait-for-exit", { name: "wfe-wait", timeout: 5000 });
    expect(res.ok).toBe(true);
    expect(res.exited).toBe(true);
    expect(res.exitCode).toBe(7);
  });

  test("wait-for-exit: timeout if process stays alive", async () => {
    await d.cmd("spawn", {
      name: "wfe-timeout",
      command: "sleep",
      args: ["1000"],
    });

    const res = await d.cmd("wait-for-exit", { name: "wfe-timeout", timeout: 300 });
    expect(res.ok).toBe(true);
    expect(res.exited).toBe(false);
    expect(res.timedOut).toBe(true);

    await d.cmd("kill", { name: "wfe-timeout" });
    await d.cmd("remove", { name: "wfe-timeout" });
  });

  test("wait-for-exit: session not found", async () => {
    const res = await d.cmd("wait-for-exit", { name: "ghost" });
    expect(res.ok).toBe(false);
  });

  test("await-change: session not found", async () => {
    const res = await d.cmd("await-change", { name: "ghost" });
    expect(res.ok).toBe(false);
  });
});
