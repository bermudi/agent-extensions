import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { DaemonHarness } from "../helpers.js";

describe("PTY interaction", () => {
  const harness = new DaemonHarness();

  beforeAll(async () => {
    await harness.start();
  });

  afterAll(async () => {
    await harness.stop();
  });

  test("type text and verify echo", async () => {
    const s = "echo-test";
    await harness.spawnShell(s);

    await harness.cmd("type", { name: s, text: "hello" });
    await harness.cmd("key", { name: s, key: "enter" });

    const res = await harness.cmd("wait-for", {
      name: s,
      pattern: "hello",
      timeout: 3000,
    });
    expect(res.ok).toBe(true);
    expect(res.matched).toBe(true);
    await harness.cmd("kill", { name: s });
  });

  test("snapshot returns correct structure", async () => {
    const s = "snap";
    await harness.spawnShell(s);
    const res = await harness.cmd("snapshot", { name: s });
    expect(res.ok).toBe(true);
    expect(typeof res.snapshotId).toBe("number");
    expect(typeof res.text).toBe("string");
    expect(res.size).toEqual({ cols: 80, rows: 24 });
    expect(res).toHaveProperty("cursor");
    expect(typeof res.contentHash).toBe("string");

    await harness.cmd("kill", { name: s });
  });

  test("full format returns grid", async () => {
    const s = "grid";
    await harness.spawnShell(s);
    const res = await harness.cmd("snapshot", { name: s, format: "full" });
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.grid)).toBe(true);
    expect(res.grid).toHaveLength(24);
    const grid = res.grid as string[][];
    expect(grid[0]).toHaveLength(80);

    await harness.cmd("kill", { name: s });
  });

  test("VT escape sequences stripped", async () => {
    const s = "vt";
    await harness.spawnShell(s);
    await harness.cmd("type", {
      name: s,
      text: "printf '\\033[31mRED\\033[0m'",
    });
    await harness.cmd("key", { name: s, key: "enter" });

    await harness.cmd("wait-for", {
      name: s,
      pattern: "RED",
      timeout: 3000,
    });

    const res = await harness.cmd("snapshot", { name: s });
    const text = res.text as string;
    expect(text).toContain("RED");
    expect(text).not.toContain("\x1b");

    await harness.cmd("kill", { name: s });
  });

  test("key sends escape sequences", async () => {
    const s = "keys";
    await harness.spawnShell(s);
    const res = await harness.cmd("key", { name: s, key: "up" });
    expect(res.ok).toBe(true);
    expect(res.sent).toBe("\x1b[A");

    await harness.cmd("kill", { name: s });
  });

  test("ctrl-c terminates foreground process", async () => {
    const s = "ctrlc";
    await harness.spawnShell(s);

    await harness.cmd("type", { name: s, text: "sleep 1000" });
    await harness.cmd("key", { name: s, key: "enter" });
    await harness.cmd("key", { name: s, key: "ctrl-c" });

    const res = await harness.cmd("wait-for", {
      name: s,
      pattern: "\\$",
      regex: true,
      timeout: 3000,
    });
    expect(res.ok).toBe(true);
    expect(res.matched).toBe(true);

    await harness.cmd("kill", { name: s });
  });

  test("snapshot on non-existent session", async () => {
    const res = await harness.cmd("snapshot", { name: "ghost" });
    expect(res.ok).toBe(false);
  });
});
