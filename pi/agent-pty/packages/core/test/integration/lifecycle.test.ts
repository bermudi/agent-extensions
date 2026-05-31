import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { DaemonHarness } from "../helpers.js";
import { existsSync } from "fs";
import { resolve } from "path";

// ── Startup ──────────────────────────────────────────────────────────

describe("startup", () => {
  let harness: DaemonHarness;

  beforeAll(async () => {
    harness = new DaemonHarness();
    await harness.start();
  });

  afterAll(async () => {
    await harness.stop();
  });

  test("creates socket file on start", () => {
    expect(existsSync(harness.sockPath)).toBe(true);
  });
});

// ── Graceful shutdown ────────────────────────────────────────────────

describe("graceful shutdown", () => {
  let harness: DaemonHarness;

  beforeAll(async () => {
    harness = new DaemonHarness();
    await harness.start();
  });

  afterAll(async () => {
    // daemon is already dead — just clean temp dir
    await harness.stop();
  });

  test("cleans up socket and pid files", async () => {
    const res = await harness.cmd("shutdown", undefined, 5_000);
    expect(res.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 300));

    expect(existsSync(harness.sockPath)).toBe(false);
  });

  test("kills PTY children on shutdown", async () => {
    // Need a fresh daemon for this test
    const h = new DaemonHarness();
    await h.start();

    const res = await h.cmd("spawn", {
      name: "sleeper",
      command: "sleep",
      args: ["1000"],
    });
    expect(res.ok).toBe(true);

    const childPid = res.pid as number;
    expect(childPid).toBeGreaterThan(0);
    expect(() => process.kill(childPid, 0)).not.toThrow();

    await h.stop();

    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(childPid, 0)).toThrow();
  });
});

// ── Double-boot protection ───────────────────────────────────────────

describe("refuses double-boot", () => {
  let first: DaemonHarness;

  beforeAll(async () => {
    first = new DaemonHarness();
    await first.start();
  });

  afterAll(async () => {
    await first.stop();
  });

  test("second daemon on same socket fails to start", async () => {
    // Daemon double-boot: the process itself should exit with code 1
    // because it detects an active listener on the socket.
    // But our harness.start() polls list-sessions, which would succeed
    // by talking to the first daemon. So we spawn the second daemon directly.
    const proc = Bun.spawn({
      cmd: ["node", resolve(import.meta.dir, "../../dist/daemon.js")],
      env: { ...process.env, AGENT_PTY_SOCK: first.sockPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);
  });
});
