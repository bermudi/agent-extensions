import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { DaemonHarness } from "../helpers.js";
import { spawn, type Subprocess } from "bun";
import { resolve } from "path";

async function cli(
  sockPath: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd: ["bun", resolve(import.meta.dir, "../../../cli/src/index.ts"), ...args],
    env: { ...process.env, AGENT_PTY_SOCK: sockPath },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

describe("CLI end-to-end", () => {
  const harness = new DaemonHarness();

  beforeAll(async () => {
    await harness.start();
  });

  afterAll(async () => {
    await harness.stop();
  });

  test("CLI spawn command", async () => {
    const { stdout, exitCode } = await cli(
      harness.sockPath,
      "spawn",
      "--name",
      "cli-spawn",
      "sleep",
      "1000",
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.name).toBe("cli-spawn");
  });

  test("CLI type and snapshot", async () => {
    await cli(harness.sockPath, "spawn", "--name", "cli-type", "bash", "--norc", "--noprofile");
    // Wait for prompt via wait-for
    await cli(harness.sockPath, "wait-for", "-s", "cli-type", "\\$", "-r");

    await cli(harness.sockPath, "type", "-s", "cli-type", "echo CLI_OK");
    await cli(harness.sockPath, "key", "-s", "cli-type", "enter");

    const { stdout } = await cli(harness.sockPath, "snapshot", "-s", "cli-type");
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.text).toContain("CLI_OK");
    expect(typeof parsed.at).toBe("string");
  });

  test("CLI scroll command", async () => {
    const { stdout } = await cli(harness.sockPath, "scroll", "-s", "cli-type", "--lines", "5");
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.lines)).toBe(true);
  });

  test("CLI wait-for with --since", async () => {
    const { stdout: snapOut } = await cli(harness.sockPath, "snapshot", "-s", "cli-type");
    const snap = JSON.parse(snapOut);

    // This should time out because the pattern is already on screen
    const { stdout: wfOut } = await cli(
      harness.sockPath,
      "wait-for",
      "-s",
      "cli-type",
      "CLI_OK",
      "--since",
      String(snap.snapshotId),
      "-t",
      "300",
    );
    const wf = JSON.parse(wfOut);
    expect(wf.matched).toBe(false);
    expect(wf.timedOut).toBe(true);
  });

  test("CLI kill and remove", async () => {
    const { stdout: killOut } = await cli(harness.sockPath, "kill", "-s", "cli-type");
    const killRes = JSON.parse(killOut);
    expect(killRes.ok).toBe(true);
    expect(killRes.killedAt).toBeDefined();

    // Still in list
    const { stdout: listOut } = await cli(harness.sockPath, "list-sessions");
    const list = JSON.parse(listOut);
    expect(list.sessions.some((s: { name: string }) => s.name === "cli-type")).toBe(true);

    const { stdout: remOut } = await cli(harness.sockPath, "remove", "-s", "cli-type");
    const rem = JSON.parse(remOut);
    expect(rem.ok).toBe(true);

    const { stdout: list2 } = await cli(harness.sockPath, "list-sessions");
    const parsed2 = JSON.parse(list2);
    expect(parsed2.sessions.some((s: { name: string }) => s.name === "cli-type")).toBe(false);
  });

  test("CLI unknown command exits non-zero", async () => {
    const { exitCode, stderr } = await cli(harness.sockPath, "fly-to-moon");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command");
  });
});
