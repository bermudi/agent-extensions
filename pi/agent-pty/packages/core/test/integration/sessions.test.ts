import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { DaemonHarness } from "../helpers.js";

describe("session management", () => {
  const harness = new DaemonHarness();

  beforeAll(async () => {
    await harness.start();
  });

  afterAll(async () => {
    await harness.stop();
  });

  test("spawn happy path", async () => {
    const res = await harness.spawnShell("happy");
    expect(res.ok).toBe(true);
    expect(res.name).toBe("happy");
    expect(typeof res.pid).toBe("number");
    expect(res.pid).toBeGreaterThan(0);
  });

  test("spawned session appears in list-sessions", async () => {
    const list = await harness.cmd("list-sessions");
    expect(list.ok).toBe(true);
    const sessions = list.sessions as Array<{ name: string; command: string }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.name).toBe("happy");
    expect(sessions[0]!.command).toBe("bash");
  });

  test("duplicate name rejected", async () => {
    const res = await harness.cmd("spawn", {
      name: "happy",
      command: "bash",
      args: ["--norc", "--noprofile"],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already exists/);
  });

  test("missing name error", async () => {
    const res = await harness.cmd("spawn", { command: "bash" });
    expect(res.ok).toBe(false);
  });

  test("missing command error", async () => {
    const res = await harness.cmd("spawn", { name: "x" });
    expect(res.ok).toBe(false);
  });

  test("kill removes session", async () => {
    await harness.cmd("kill", { name: "happy" });
    const list = await harness.cmd("list-sessions");
    expect(list.ok).toBe(true);
    expect(list.sessions).toHaveLength(0);
  });

  test("kill terminates child process", async () => {
    const spawnRes = await harness.cmd("spawn", {
      name: "sleepy",
      command: "sleep",
      args: ["1000"],
    });
    expect(spawnRes.ok).toBe(true);
    const pid = spawnRes.pid as number;

    await harness.cmd("kill", { name: "sleepy" });

    // Process should be dead
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("kill non-existent session", async () => {
    const res = await harness.cmd("kill", { name: "ghost" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/);
  });

  test("spawn without cwd defaults to daemon cwd", async () => {
    const res = await harness.cmd("spawn", {
      name: "no-cwd",
      command: "pwd",
    });
    expect(res.ok).toBe(true);

    const list = await harness.cmd("list-sessions");
    const sessions = list.sessions as Array<{ name: string; cwd: string }>;
    const s = sessions.find((x) => x.name === "no-cwd");
    expect(s).toBeDefined();
    expect(s!.cwd).toBe(process.cwd());

    await harness.cmd("kill", { name: "no-cwd" });
  });

  test("spawn with explicit cwd", async () => {
    const target = "/tmp";
    const res = await harness.cmd("spawn", {
      name: "with-cwd",
      command: "pwd",
      cwd: target,
    });
    expect(res.ok).toBe(true);

    const list = await harness.cmd("list-sessions");
    const sessions = list.sessions as Array<{ name: string; cwd: string }>;
    const s = sessions.find((x) => x.name === "with-cwd");
    expect(s).toBeDefined();
    expect(s!.cwd).toBe(target);

    await harness.cmd("kill", { name: "with-cwd" });
  });
});
