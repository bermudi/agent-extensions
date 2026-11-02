import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseSmokeArgs } from "./live-smoke.ts";

const scratch = await mkdtemp(join(tmpdir(), "fusion-smoke-"));

describe("parseSmokeArgs", () => {
  test("accepts piz and devin with a model and an existing directory", async () => {
    expect(await parseSmokeArgs(["piz", "GLM-5.3", scratch])).toEqual({
      harness: "piz",
      model: "GLM-5.3",
      cwd: resolve(scratch),
    });
    expect(await parseSmokeArgs(["devin", "swe-2-medium", scratch])).toEqual({
      harness: "devin",
      model: "swe-2-medium",
      cwd: resolve(scratch),
    });
  });

  test("rejects bad harness, blank fields, wrong arg counts", async () => {
    for (const args of [
      ["bogus", "m", scratch],
      ["", "m", scratch],
      ["piz", " ", scratch],
      ["piz", "m", " "],
      ["piz"],
      ["piz", "m"],
      [],
      ["piz", "m", scratch, "extra"],
    ]) {
      await expect(parseSmokeArgs(args)).rejects.toThrow();
    }
  });

  test("rejects a missing path and a regular file as cwd", async () => {
    await expect(
      parseSmokeArgs(["piz", "m", join(scratch, "nope")]),
    ).rejects.toThrow();
    const file = join(scratch, "f.txt");
    await writeFile(file, "x");
    await expect(parseSmokeArgs(["devin", "m", file])).rejects.toThrow();
  });
});

describe("live-smoke script", () => {
  test("invalid args exit nonzero with usage on stderr and create nothing", async () => {
    const dir = resolve(import.meta.dir, "..");
    const proc = Bun.spawnSync({
      cmd: [
        process.execPath,
        "run",
        "scripts/live-smoke.ts",
        "bogus",
        "m",
        scratch,
      ],
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr.toString()).toMatch(/[Uu]sage/);
    expect(await Bun.file(join(scratch, "b.txt")).exists()).toBe(false);
    expect(await Bun.file(join(scratch, "c.txt")).exists()).toBe(false);
  });
});
